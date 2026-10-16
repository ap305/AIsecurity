"""Reference numerical acceptance using production RPC in separate processes.

Local acceptance does not claim Docker filesystem/network-isolation validation.
It never deserializes submitted checkpoints in the grading process.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time


def run(build, rpc, output, source_id, phase, timeout=1800):
    build, rpc, output = Path(build).resolve(), Path(rpc).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((build / 'manifest.json').read_text(encoding='utf8'))
    question = next(q for q in manifest['questions'] if q['sourceId'] == source_id)
    package = build / 'packages' / source_id
    children, logs = [], []
    env = dict(os.environ, PYTHONUTF8='1', PYTHONPATH=str(rpc), MPLBACKEND='Agg',
               OMP_NUM_THREADS='1', MKL_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1',
               HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', NO_PROXY='127.0.0.1,localhost')

    def worker(role):
        work = output / role
        work.mkdir()
        public = work / 'public'
        shutil.copytree(package / 'public', public)
        source = (public / 'bootstrap.py').read_text(encoding='utf8')
        (public / 'bootstrap.py').write_text(source.replace("'/materials/weights.bin'", repr(str(work / 'weights.bin'))), encoding='utf8')
        pid = ('A' if role == 'attack' else 'D') + source_id[1:]
        shutil.copyfile(build / 'references' / (pid + '.py'), work / 'code.py')
        weight = package / 'fixtures' / (role + '.pt')
        if weight.exists():
            shutil.copyfile(weight, work / 'weights.bin')
        config = dict(token=secrets.token_hex(24), maxRequestBytes=134217728, maxResponseBytes=134217728,
                      maxArrayBytes=67108864, maxObjects=128, maxCalls=100000, timeoutSeconds=timeout,
                      bootstrap=str(public / 'bootstrap.py'))
        (work / 'config.json').write_text(json.dumps(config), encoding='utf8')
        source = (rpc / 'worker-template.py').read_text(encoding='utf8')
        for a, b in [("'/worker/config.json'", repr(str(work / 'config.json'))), ("'/materials/code.py'", repr(str(work / 'code.py'))),
                     ("'/materials'", repr(str(work))), ("'/worker/public'", repr(str(public)))]:
            source = source.replace(a, b)
        source = source.replace("http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()",
                                "server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()")
        # Local reference diagnosis only; production worker responses remain
        # redacted and the publisher's code is the sole test submission here.
        source = source.replace('except BaseException as error:\n            with self.condition:',
                                'except BaseException as error:\n            import traceback; traceback.print_exc()\n            with self.condition:')
        (work / 'server.py').write_text(source, encoding='utf8')
        log = (work / 'worker.log').open('w', encoding='utf8'); logs.append(log)
        child = subprocess.Popen([sys.executable, '-B', '-I', str(work / 'server.py')], cwd=work, env=env,
                                 stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf8')
        children.append(child)
        port = child.stdout.readline().strip()
        if not port.isdigit():
            raise RuntimeError('worker startup failed: ' + role)
        return dict(config, url='http://127.0.0.1:' + port, protocolVersion=2, deadline=time.time() * 1000 + timeout * 1000)

    try:
        evaluation = dict(question['definition']['evaluation'], successThreshold=.5, baselineThreshold=0)
        context = {'submissionId': 'tabular-reference-' + source_id, 'attemptId': 'local-rpc', 'questionVersion': 1,
                   'evaluationVersion': 'v3-261012-tabular-rpc-v1', 'phase': phase, 'role': question['role'],
                   'parameters': evaluation, 'student': worker(question['role'])}
        if phase == 'opponent':
            context['opponent'] = worker('defense' if question['role'] == 'attack' else 'attack')
            context['opponent']['submissionId'] = 'reference-opponent-' + source_id
        context_path, result_path = output / 'context.json', output / 'result.json'
        context_path.write_text(json.dumps(context), encoding='utf8')
        with (output / 'grader.log').open('w', encoding='utf8') as log:
            subprocess.run([sys.executable, '-B', str(package / 'grade.py'), str(context_path), str(result_path)], cwd=package,
                           env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=timeout + 30)
        result = json.loads(result_path.read_text(encoding='utf8'))
        print(json.dumps({'id': source_id, 'phase': phase, 'status': result['status'], 'metrics': result.get('metrics')}, ensure_ascii=False), flush=True)
        if result['status'] != 'completed':
            raise RuntimeError('reference failed: inspect private grader.log')
        return result
    finally:
        for child in children:
            child.terminate()
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill(); child.communicate()
        for log in logs:
            log.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', required=True)
    parser.add_argument('--rpc', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--phase', choices=['baseline', 'opponent'], required=True)
    parser.add_argument('--timeout', type=int, default=1800)
    args = parser.parse_args()
    run(args.build, args.rpc, args.output, args.id, args.phase, args.timeout)

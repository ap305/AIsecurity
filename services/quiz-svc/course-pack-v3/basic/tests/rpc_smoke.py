"""Run reviewed references via the production RPC in separate local processes.

This checks numerical integration, not Docker mount/network isolation. Export
the production RPC source using legacy-conversion/ml/tests/export_rpc.ts first.
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
from offline_harness import configure as offline_environment, entrypoint as offline_entrypoint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--rpc', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--template', action='store_true')
    parser.add_argument('--bad-weights', action='store_true')
    parser.add_argument('--timeout', type=int, default=1200)
    args = parser.parse_args()
    args.build, args.rpc, args.output = args.build.resolve(), args.rpc.resolve(), args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((args.build / 'manifest.json').read_text(encoding='utf8'))
    question = next(q for q in manifest['questions'] if q['sourceId'] == args.id)
    package = args.build / 'packages' / args.id
    work = args.output / 'worker'
    work.mkdir()
    public = work / 'public'
    shutil.copytree(package / 'public', public)
    # Rewrite only fixed container paths in this ephemeral local test copy.
    bootstrap = (public / 'bootstrap.py').read_text(encoding='utf8')
    bootstrap = bootstrap.replace("'/materials/weights.bin'", repr(str(work / 'weights.bin')))
    (public / 'bootstrap.py').write_text(bootstrap, encoding='utf8')
    code = question['answerTemplate'] if args.template else Path(question['selfTest']['codePath']).read_text(encoding='utf8')
    (work / 'code.py').write_text(code, encoding='utf8')
    if question['selfTest'].get('weightFixture'):
        shutil.copyfile(package / question['selfTest']['weightFixture'], work / 'weights.bin')
    if args.bad_weights:
        (work / 'weights.bin').write_bytes(b'not-a-torch-checkpoint')
    config = {'token': secrets.token_hex(24), 'maxRequestBytes': 134217728, 'maxResponseBytes': 134217728,
              'maxArrayBytes': 67108864, 'maxObjects': 128, 'maxCalls': 50000, 'timeoutSeconds': args.timeout,
              'bootstrap': str(public / 'bootstrap.py')}
    (work / 'config.json').write_text(json.dumps(config), encoding='utf8')
    source = (args.rpc / 'worker-template.py').read_text(encoding='utf8')
    source = source.replace("'/worker/config.json'", repr(str(work / 'config.json')))
    source = source.replace("'/materials/code.py'", repr(str(work / 'code.py')))
    source = source.replace("'/materials'", repr(str(work)))
    source = source.replace("'/worker/public'", repr(str(public)))
    source = source.replace("http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()",
                            "server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()")
    (work / 'server.py').write_text(source, encoding='utf8')
    env = dict(os.environ, PYTHONUTF8='1', MPLBACKEND='Agg', PYTHONPATH=str(args.rpc),
               OMP_NUM_THREADS='1', MKL_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1',
               HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', NO_PROXY='127.0.0.1,localhost')
    offline_environment(env, args.output)
    worker_entry = offline_entrypoint(work / 'server.py', work / 'offline-worker.py')
    grader_entry = offline_entrypoint(package / 'grade.py', args.output / 'offline-grader.py')
    with (work / 'worker.log').open('w', encoding='utf8') as worker_log:
        child = subprocess.Popen([sys.executable, '-B', '-I', str(worker_entry)], cwd=work,
                                 stdout=subprocess.PIPE, stderr=worker_log, text=True, encoding='utf8', env=env)
        try:
            port = child.stdout.readline().strip()
            if not port.isdigit():
                raise RuntimeError('worker did not start; inspect private worker.log')
            context = {'submissionId': 'basic-reference-' + args.id, 'attemptId': 'local-rpc',
                       'questionVersion': 1, 'evaluationVersion': 'v3-261012-basic-rpc-v1', 'phase': 'basic',
                       'parameters': question['definition']['evaluation'], 'student': dict(config, url='http://127.0.0.1:' + port,
                                                         protocolVersion=2,
                                                         deadline=time.time() * 1000 + args.timeout * 1000)}
            context_path, result_path = args.output / 'context.json', args.output / 'result.json'
            context_path.write_text(json.dumps(context), encoding='utf8')
            with (args.output / 'grader.log').open('w', encoding='utf8') as log:
                subprocess.run([sys.executable, '-B', str(grader_entry), str(context_path), str(result_path)],
                               cwd=package, env=env, stdout=log, stderr=subprocess.STDOUT,
                               check=True, timeout=args.timeout + 30)
            result = json.loads(result_path.read_text(encoding='utf8'))
            service = Path(__file__).resolve().parents[3]
            subprocess.run(['node', str(service / 'node_modules/tsx/dist/cli.mjs'),
                            str(Path(__file__).with_name('validate_result.ts')), str(context_path), str(result_path)],
                           cwd=service, env=env, check=True, timeout=60)
            print(json.dumps({'id': args.id, 'template': args.template, 'status': result['status'],
                              'score': result.get('score'), 'metrics': result.get('metrics')}, ensure_ascii=True))
            if args.bad_weights and result['status'] != 'student_error':
                raise RuntimeError('malformed weights were not rejected as student_error')
            if not args.template and not args.bad_weights and result['status'] != 'completed':
                raise RuntimeError('reference did not complete')
            if args.template and result['status'] == 'completed' and result.get('score') == 100:
                raise RuntimeError('unfinished student template unexpectedly received full marks')
        finally:
            child.terminate()
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()


if __name__ == '__main__':
    main()

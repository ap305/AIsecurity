"""Validate real production RPC and frozen teacher calculations in subprocesses."""
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--rpc', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--phase', choices=['baseline', 'opponent'], default='opponent')
    parser.add_argument('--template', action='store_true')
    args = parser.parse_args()
    args.build, args.rpc, args.output = args.build.resolve(), args.rpc.resolve(), args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((args.build / 'manifest.json').read_text(encoding='utf8'))
    question = next(q for q in manifest['questions'] if q['sourceId'] == args.id)
    pkg = next(p for p in manifest['packages'] if p['key'] == question['packageKey'])
    package = args.build / pkg['directory']
    environment = json.loads((package / 'manifest.json').read_text(encoding='utf8'))
    children, logs = [], []
    env = dict(os.environ, PYTHONUTF8='1', PYTHONPATH=str(args.rpc), OMP_NUM_THREADS='1', MKL_NUM_THREADS='1',
               OPENBLAS_NUM_THREADS='1', NO_PROXY='127.0.0.1,localhost')
    def worker(material, template=False):
        work = args.output / ('worker-' + secrets.token_hex(4))
        work.mkdir()
        public = work / 'public'
        shutil.copytree(package / 'public', public)
        source = (public / 'bootstrap.py').read_text(encoding='utf8').replace("'/materials/weights.bin'", repr(str(work / 'weights.bin')))
        (public / 'bootstrap.py').write_text(source, encoding='utf8')
        (work / 'code.py').write_text(question['answerTemplate'] if template else (args.build / material['codePath']).read_text(encoding='utf8'), encoding='utf8')
        if material.get('weightFixture'):
            shutil.copyfile(package / material['weightFixture'], work / 'weights.bin')
        config = dict(environment['rpc'], token=secrets.token_hex(24), timeoutSeconds=3600, bootstrap=str(public / 'bootstrap.py'))
        (work / 'config.json').write_text(json.dumps(config), encoding='utf8')
        source = (args.rpc / 'worker-template.py').read_text(encoding='utf8')
        for old, new in [('/worker/config.json', work / 'config.json'), ('/materials/code.py', work / 'code.py'),
                         ('/materials', work), ('/worker/public', public)]:
            source = source.replace(repr(old), repr(str(new)))
        source = source.replace("http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()",
                 "server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()")
        (work / 'server.py').write_text(source, encoding='utf8')
        log = (work / 'stderr.log').open('w', encoding='utf8')
        logs.append(log)
        child = subprocess.Popen([sys.executable, '-B', '-I', str(work / 'server.py')], cwd=work,
                       stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf8', env=env)
        children.append(child)
        port = child.stdout.readline().strip()
        if not port.isdigit():
            raise RuntimeError('Worker failed to start; inspect local log')
        return dict(config, url='http://127.0.0.1:' + port, protocolVersion=2, deadline=time.time()*1000+3600000,
                    submissionId=work.name)
    try:
        context = {'submissionId': 'reference-' + args.id, 'attemptId': 'local-rpc', 'questionVersion': 1,
                   'evaluationVersion': question['definition']['evaluation']['version'], 'phase': args.phase,
                   'role': question['role'], 'parameters': dict(question['definition']['evaluation'], calibrationMode=True),
                   'student': worker(question['selfTest'], args.template)}
        if args.phase == 'opponent':
            context['opponent'] = worker(question['selfTest']['opponent'])
        context_path, result_path = args.output / 'context.json', args.output / 'result.json'
        context_path.write_text(json.dumps(context), encoding='utf8')
        with (args.output / 'grader.log').open('w', encoding='utf8') as file:
            subprocess.run([sys.executable, '-B', str(package / 'grade.py'), str(context_path), str(result_path)],
                           cwd=package, env=env, stdout=file, stderr=subprocess.STDOUT, timeout=3630, check=True)
        result = json.loads(result_path.read_text(encoding='utf8'))
        print(json.dumps(dict(id=args.id, template=args.template, **result), ensure_ascii=False))
        assert result['status'] == ('student_error' if args.template else 'completed'), 'Unexpected evaluation status'
    finally:
        for child in children:
            child.terminate()
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()
        for log in logs:
            log.close()


if __name__ == '__main__':
    main()

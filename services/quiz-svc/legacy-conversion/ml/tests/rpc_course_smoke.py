"""Run actual v2 references/data through production RPC in separate local Python processes.

This is a functional integration test, not a substitute for Docker sandbox verification.
The official fixed dependency image is required for authoritative calibration values.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--rpc', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--scenario', required=True)
    parser.add_argument('--role', choices=['attack', 'defense'], required=True)
    parser.add_argument('--phase', choices=['baseline', 'opponent'], default='baseline')
    parser.add_argument('--evaluation-version', default='course-v2-rpc-v1')
    parser.add_argument('--isolated-worker', action='store_true',
                        help='Use the production Python -I mode (dependencies must be installed in the image).')
    args = parser.parse_args()
    args.build, args.rpc, args.output = args.build.resolve(), args.rpc.resolve(), args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    package = args.build / 'packages' / args.scenario
    worker_source = (args.rpc / 'worker-template.py').read_text(encoding='utf8')
    children = []
    logs = []
    def worker(role):
        directory = args.output / role
        directory.mkdir()
        (directory / 'code.py').write_text((args.build / 'references' / args.scenario / (role + '.py')).read_text(encoding='utf8'), encoding='utf8')
        config = dict(token=secrets.token_hex(16), maxRequestBytes=128*1024*1024,
                      maxResponseBytes=128*1024*1024, maxArrayBytes=64*1024*1024,
                      maxObjects=64, maxCalls=10000, timeoutSeconds=1200,
                      bootstrap=str(package / 'public' / 'bootstrap.py'))
        (directory / 'config.json').write_text(json.dumps(config), encoding='utf8')
        source = worker_source.replace("'/worker/config.json'", repr(str(directory / 'config.json')))
        source = source.replace("'/materials/code.py'", repr(str(directory / 'code.py')))
        source = source.replace("'/materials'", repr(str(directory)))
        source = source.replace("'/worker/public'", repr(str(package / 'public')))
        source = source.replace("http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()",
                                "server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()")
        (directory / 'server.py').write_text(source, encoding='utf8')
        log = (directory / 'worker.log').open('w', encoding='utf8')
        logs.append(log)
        worker_command = [sys.executable, '-B']
        if args.isolated_worker:
            worker_command.append('-I')
        worker_command.append(str(directory / 'server.py'))
        child = subprocess.Popen(worker_command, cwd=directory,
                                 stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf8')
        children.append(child)
        line = child.stdout.readline().strip()
        if not line.isdigit():
            raise RuntimeError('worker startup failed; inspect ' + str(directory / 'worker.log'))
        return dict(config, url='http://127.0.0.1:' + line, protocolVersion=2,
                    deadline=time.time()*1000+1200000, submissionId='official-' + role)
    try:
        context = dict(submissionId='official-' + args.role, attemptId='local-integration',
                       questionVersion=1, evaluationVersion=args.evaluation_version, phase=args.phase,
                       role=args.role, student=worker(args.role), parameters={'calibrationMode': True})
        if args.phase == 'opponent':
            context['opponent'] = worker('defense' if args.role == 'attack' else 'attack')
        context_path, result_path = args.output / 'context.json', args.output / 'result.json'
        context_path.write_text(json.dumps(context), encoding='utf8')
        env = dict(os.environ, PYTHONPATH=str(args.rpc) + os.pathsep + os.environ.get('PYTHONPATH', ''),
                   PYTHONUTF8='1', OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2', MKL_NUM_THREADS='2')
        with (args.output / 'grader.log').open('w', encoding='utf8') as log:
            subprocess.run([sys.executable, '-B', str(package / 'grade.py'), str(context_path), str(result_path)],
                           cwd=package, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1220)
        result = json.loads(result_path.read_text(encoding='utf8'))
        print(json.dumps(result, ensure_ascii=False))
        if result['status'] != 'completed':
            raise RuntimeError('reference did not complete; inspect grader.log and worker.log')
        expected = 'qualificationMetric' if args.phase == 'baseline' else 'successMetric'
        if expected not in result['metrics']:
            raise RuntimeError('missing phase metric ' + expected)
    finally:
        for child in children:
            child.terminate()
            try:
                child.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()
        for log in logs:
            log.close()


if __name__ == '__main__':
    main()

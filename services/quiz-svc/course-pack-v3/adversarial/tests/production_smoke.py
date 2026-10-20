"""Published grade.py + full evaluation object + real worker/gateway HTTP.

The gateway serves explicit protocol fixtures, not real-model calibration.
"""
from __future__ import annotations
import argparse
import http.server
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time


class ModelFixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        number = self.path.strip('/').split('/')[0]
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if not isinstance(payload.get('messages'), list):
            self.send_error(400)
            return
        with self.server.fixture_lock:
            self.server.fixture_attempts += 1
            attempt = self.server.fixture_attempts
        if attempt > 1000:
            self.send_error(429)
            return
        if attempt <= self.server.fixture_503_count:
            self.send_error(503)
            return
        if number == '02':
            content = '{}'
        elif number == '03':
            content = json.dumps({key: 1 for key in ('overall', 'quality', 'semantic_consistency', 'factual_consistency', 'fluency', 'completeness', 'relevance')})
        elif number == '08':
            content = '{"J_goal":0,"J_unsafe":0,"J_refusal":1,"J_relevance":0,"J_actionable":0,"appropriate":1,"over_refusal":0}'
        elif number in ('27', '28'):
            content = '{"correct":1,"reason":"protocol fixture"}'
        else:
            content = 'Protocol fixture completed'
        body = json.dumps({'choices': [{'message': {'content': content, 'tool_calls': []}}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--rpc', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--block-openai-import', action='store_true')
    parser.add_argument('--inject-http503', action='store_true', help='Two explicit 503 responses per question; verify actual-attempt metrics and unchanged call budget')
    args = parser.parse_args()
    args.build, args.rpc, args.output = (p.resolve() for p in (args.build, args.rpc, args.output))
    args.output.mkdir(parents=True, exist_ok=False)
    dependency_guard = args.output / 'dependency-guard'
    if args.block_openai_import:
        dependency_guard.mkdir()
        (dependency_guard / 'sitecustomize.py').write_text('''import sys
class BlockOpenAI:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'openai' or fullname.startswith('openai.'):
            raise ImportError('Production image intentionally has no OpenAI SDK')
sys.meta_path.insert(0, BlockOpenAI())
''', encoding='utf8')
    manifest = json.loads((args.build / 'manifest.json').read_text(encoding='utf8'))
    template = (args.rpc / 'worker-template.py').read_text(encoding='utf8')
    gateway = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ModelFixture)
    gateway.fixture_lock = threading.Lock()
    gateway.fixture_attempts = 0
    gateway.fixture_503_count = 0
    thread = threading.Thread(target=gateway.serve_forever, daemon=True)
    thread.start()
    envelopes, gateway_evidence = [], []
    try:
        for question in manifest['questions']:
            gateway.fixture_attempts = 0
            gateway.fixture_503_count = 2 if args.inject_http503 else 0
            number = question['sourceId'][1:]
            package_row = next(p for p in manifest['packages'] if p['key'] == question['packageKey'])
            package = args.build / package_row['directory']
            environment = json.loads((package / 'manifest.json').read_text(encoding='utf8'))
            directory = args.output / question['sourceId']
            directory.mkdir()
            children, logs = [], []
            def worker(material):
                work = directory / ('worker-' + secrets.token_hex(4))
                work.mkdir()
                (work / 'code.py').write_text((args.build / material['codePath']).read_text(encoding='utf8'), encoding='utf8')
                config = dict(environment['rpc'], token=secrets.token_hex(16), timeoutSeconds=3600,
                              bootstrap=str(package / 'public' / 'bootstrap.py'))
                (work / 'config.json').write_text(json.dumps(config), encoding='utf8')
                source = template
                for old, new in (('/worker/config.json', work / 'config.json'), ('/materials/code.py', work / 'code.py'),
                                 ('/materials', work), ('/worker/public', package / 'public')):
                    source = source.replace(repr(old), repr(str(new)))
                source = source.replace("http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()",
                    "server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()")
                (work / 'worker.py').write_text(source, encoding='utf8')
                log = (work / 'worker.log').open('w', encoding='utf8')
                logs.append(log)
                child = subprocess.Popen([sys.executable, '-B', str(work / 'worker.py')], stdout=subprocess.PIPE, stderr=log,
                                         text=True, encoding='utf8')
                children.append(child)
                port = child.stdout.readline().strip()
                if not port.isdigit():
                    raise RuntimeError('Worker startup failed')
                return dict(config, url='http://127.0.0.1:' + port, protocolVersion=2, deadline=time.time()*1000+3600000,
                            submissionId=work.name)
            try:
                # One published role per pair exercises baseline; the other
                # exercises opponent. Both workers always use the current package.
                phase = 'opponent' if question['role'] == 'attack' else 'baseline'
                context = {'submissionId': question['id'], 'attemptId': 'production-protocol', 'questionVersion': 1,
                           'evaluationVersion': question['definition']['evaluation']['version'], 'phase': phase,
                           'role': question['role'], 'parameters': dict(question['definition']['evaluation'], calibrationMode=True),
                           'modelGateway': {'url': f'http://127.0.0.1:{gateway.server_port}/{number}', 'token': 'local-fixture'},
                           'student': worker(question['selfTest'])}
                if phase == 'opponent':
                    context['opponent'] = worker(question['selfTest']['opponent'])
                (directory / 'context.json').write_text(json.dumps(context), encoding='utf8')
                python_path = os.pathsep.join([str(dependency_guard), str(args.rpc)]) if args.block_openai_import else str(args.rpc)
                env = dict(os.environ, PYTHONPATH=python_path, PYTHONUTF8='1', NO_PROXY='127.0.0.1,localhost',
                           OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1')
                with (directory / 'grade.log').open('w', encoding='utf8') as log:
                    subprocess.run([sys.executable, '-B', str(package / 'grade.py'), str(directory / 'context.json'), str(directory / 'result.json')],
                                   cwd=package, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=3600, check=True)
                result = json.loads((directory / 'result.json').read_text(encoding='utf8'))
                if result['status'] != 'completed':
                    raise AssertionError(question['sourceId'] + ': ' + result['status'])
                if result['metrics']['modelCalls'] != gateway.fixture_attempts or not 0 < gateway.fixture_attempts <= 1000:
                    raise AssertionError('Gateway metric must count every actual received POST against the unchanged budget')
                if args.inject_http503 and gateway.fixture_attempts < 3:
                    raise AssertionError('Injected failures were not followed by a real successful response')
                if number == '03' and question['definition']['evaluation'].get('judgeRubric') == 'relative-preservation-v1':
                    assert result['metrics']['samples'] == 40
                    assert context['parameters']['judgePromptSha256'] == '7a72acbae45604ed6e1181374fcab78474ea0ea9783346f078c92ae065b9d522'
                gateway_evidence.append({'question': question['sourceId'], 'receivedPostAttempts': gateway.fixture_attempts,
                    'metricModelCalls': result['metrics']['modelCalls'], 'injected503Responses': gateway.fixture_503_count,
                    'budget': 1000, 'realModelCalibration': False})
                # Do not include local tokens or worker paths in the evidence list.
                binding = {key: context[key] for key in ('submissionId', 'attemptId', 'questionVersion', 'evaluationVersion', 'phase', 'role', 'parameters')}
                if phase == 'opponent':
                    binding['opponent'] = {'submissionId': context['opponent']['submissionId']}
                envelopes.append({'input': binding, 'result': result})
                print(json.dumps({'question': question['sourceId'], 'phase': phase, 'status': result['status']}), flush=True)
            finally:
                for child in children:
                    child.terminate()
                    try:
                        child.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill(); child.communicate()
                for log in logs:
                    log.close()
        (args.output / 'result-envelopes.json').write_text(json.dumps(envelopes, indent=2), encoding='utf8')
        (args.output / 'gateway-attempts.json').write_text(json.dumps(gateway_evidence, indent=2), encoding='utf8')
        print(json.dumps({'completed': len(envelopes), 'fullEvaluationParameters': True, 'publishedGradeEntrypoint': True,
                          'openaiSdkImportBlocked': args.block_openai_import, 'injected503PerQuestion': gateway.fixture_503_count,
                          'everyAttemptCounted': True, 'realModelCalibration': False}))
    finally:
        gateway.shutdown()
        gateway.server_close()


if __name__ == '__main__':
    main()

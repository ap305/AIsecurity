import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PLATFORM_STUDENT_CLIENT_SOURCE } from '../src/services/composeJudge.js'
import { EVALUATION_EXAMPLE_ROOT } from '../src/lib/evaluationPackage.js'

function runPython(source: string): unknown {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-errors-'))
  try {
    fs.writeFileSync(path.join(root, 'platform_student.py'), PLATFORM_STUDENT_CLIENT_SOURCE)
    fs.writeFileSync(path.join(root, 'probe.py'), source)
    return JSON.parse(
      execFileSync(
        process.env.EVALUATION_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
        ['-B', path.join(root, 'probe.py'), EVALUATION_EXAMPLE_ROOT],
        { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } },
      ),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('RPC distinguishes real HTTP student failures from infrastructure and invalid protocol responses', () => {
  const result = runPython(`import http.server, threading, json
from platform_student import invoke
status, body = 200, b'{"result":42}'
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self, *args): pass
 def do_POST(self):
  self.rfile.read(int(self.headers['Content-Length']))
  self.send_response(status); self.end_headers(); self.wfile.write(body)
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
worker = dict(url='http://127.0.0.1:'+str(server.server_port), token='private-token', timeoutSeconds=2, maxRequestBytes=1024, maxResponseBytes=1024)
results = []
for status, body in [(200,b'{"result":42}'), (422,b'{"error":"student_code_error"}'), (403,b'private-token'), (500,b'private-token'), (200,b'not json'), (200,b'{}'), (200,b'{"error":"fake"}')]:
 try: results.append(invoke(worker, 'solve'))
 except Exception as error: results.append(type(error).__name__)
server.shutdown(); server.server_close()
print(json.dumps(results))
`)
  assert.deepEqual(result, [42, 'StudentExecutionError', ...Array(5).fill('EvaluationInfrastructureError')])
})

test('RPC classifies DNS, socket timeout and expired deadline without exposing transport details', () => {
  const result = runPython(`import http.client, json, socket, time, urllib.error
import platform_student as client
worker = dict(url='http://private-host', token='private-token', timeoutSeconds=2, maxRequestBytes=1024, maxResponseBytes=1024)
results = []
for failure in [urllib.error.URLError(socket.gaierror(-3, 'private-host')), TimeoutError('private-token'), urllib.error.URLError(TimeoutError('private-token')), http.client.IncompleteRead(b'private-token')]:
 def fail(*args, **kwargs): raise failure
 client.urllib.request.urlopen = fail
 try: client.invoke(worker, 'solve')
 except Exception as error: results.append([type(error).__name__, str(error)])
worker['deadline'] = time.time()*1000-1000
try: client.invoke(worker, 'solve')
except Exception as error: results.append([type(error).__name__, str(error)])
print(json.dumps(results))
`)
  assert.deepEqual(
    (result as string[][]).map((row) => row[0]),
    [
      'EvaluationInfrastructureError',
      'EvaluationTimeoutError',
      'EvaluationTimeoutError',
      'EvaluationInfrastructureError',
      'EvaluationTimeoutError',
    ],
  )
  assert.doesNotMatch(JSON.stringify(result), /private-host|private-token/)
})

for (const name of ['basic-algorithm', 'model-inference', 'attack-defense']) {
  test(`${name} does not attribute infrastructure errors to students or award error scores`, () => {
    const result = runPython(`import json, pathlib, runpy, sys, urllib.error
import platform_student as client
root = pathlib.Path(__file__).parent
examples = pathlib.Path(sys.argv[1])
context = dict(submissionId='s', attemptId='a', questionVersion=1, evaluationVersion='v1', phase='baseline' if '${name}'=='attack-defense' else 'basic', role='attack', student=dict(url='http://private-host', token='private-token', timeoutSeconds=2, maxRequestBytes=1024, maxResponseBytes=1024))
input_file, output_file = root/'context.json', root/'result.json'
input_file.write_text(json.dumps(context))
results = []
for failure in [urllib.error.URLError('private-token'), TimeoutError('private-token'), urllib.error.HTTPError('http://private-host', 422, 'private-token', {}, None)]:
 def fail(*args, **kwargs): raise failure
 client.urllib.request.urlopen = fail
 sys.argv = ['main.py', str(input_file), str(output_file)]
 runpy.run_path(str(examples/'${name}'/'main.py'), run_name='__main__')
 results.append(json.loads(output_file.read_text(encoding='utf8')))
print(json.dumps(results))
`)
    assert.deepEqual(
      (result as { status: string }[]).map((row) => row.status),
      ['system_error', 'timeout', 'student_error'],
    )
    for (const row of result as Record<string, unknown>[]) assert.equal('score' in row, false)
    assert.doesNotMatch(JSON.stringify(result), /private-host|private-token/)
  })
}

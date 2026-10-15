import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { PLATFORM_STUDENT_CLIENT_SOURCE, PLATFORM_STUDENT_WORKER_SOURCE } from '../../../src/services/studentRpc.js'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.EVALUATION_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')

test('Bot adapters execute official fragments through real worker RPC and keep private authority in grader', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-rpc-'))
  try {
    fs.writeFileSync(path.join(temporary, 'platform_student.py'), PLATFORM_STUDENT_CLIENT_SOURCE)
    fs.writeFileSync(path.join(temporary, 'worker-template.py'), PLATFORM_STUDENT_WORKER_SOURCE)
    fs.writeFileSync(path.join(temporary, 'paths.json'), JSON.stringify({ source, temporary }))
    fs.writeFileSync(path.join(temporary, 'run.py'), String.raw`import json, pathlib, secrets, shutil, subprocess, sys, time
root=pathlib.Path(__file__).parent
paths=json.loads((root/'paths.json').read_text())
sys.path.insert(0,paths['source'])
import build, runtime
from platform_student import invoke, expose
source=pathlib.Path(paths['source'])
build.build(source/'sources',source/'sources/questions.json',root/'packages')
children=[]
def start(scenario,code):
    package=root/'packages'/scenario/'package'
    directory=root/('worker-'+secrets.token_hex(4)); directory.mkdir()
    shutil.copytree(package/'public',directory/'public')
    (directory/'code.py').write_text(code,encoding='utf8')
    config=dict(token=secrets.token_hex(16),maxRequestBytes=1048576,maxResponseBytes=1048576,maxArrayBytes=1048576,maxObjects=16,maxCalls=1000,timeoutSeconds=25,bootstrap=str(directory/'public/bootstrap.py'))
    (directory/'config.json').write_text(json.dumps(config))
    worker=(root/'worker-template.py').read_text(encoding='utf8').replace("'/worker/config.json'",repr(str(directory/'config.json'))).replace("'/materials/code.py'",repr(str(directory/'code.py'))).replace("'/materials'",repr(str(directory))).replace("'/worker/public'",repr(str(directory/'public')))
    worker=worker.replace("http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()","server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()")
    (directory/'worker.py').write_text(worker,encoding='utf8')
    child=subprocess.Popen([sys.executable,'-B',str(directory/'worker.py')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    children.append(child)
    port=child.stdout.readline().strip()
    if not port: raise RuntimeError(child.stderr.read())
    assert not (directory/'course').exists()
    return dict(config,url='http://127.0.0.1:'+port,protocolVersion=2,deadline=time.time()*1000+25000)
try:
    results={}
    for scenario in build.SCENARIOS:
        package=root/'packages'/scenario/'package'
        course=runtime.load_course(package/'course')
        attack_worker=start(scenario,(package/'baselines/attack.py').read_text(encoding='utf8'))
        defense_worker=start(scenario,(package/'baselines/defense.py').read_text(encoding='utf8'))
        attack=runtime.remote_function(attack_worker,scenario,'attack')
        defense=runtime.remote_function(defense_worker,scenario,'defense')
        agent=None if scenario=='chatops' else (course.dataset.MockSupportBotAgent() if scenario=='supportbot' else course.MockAgent())
        match=runtime.scenario_matches(course,scenario,1,42)[0]
        naked=runtime.run_pair(course,scenario,attack,runtime.no_defense,agent,match)
        guarded=runtime.run_pair(course,scenario,attack,defense,agent,match)
        fpr=runtime.defense_fpr(course,scenario,defense)['false_positive_rate']
        results[scenario]=[naked,guarded,fpr]
    course=runtime.load_course(root/'packages/chatops/package/course')
    leaking=start('chatops','def defend(env,*args):\n return env.attacker_user\n')
    try: runtime.defense_fpr(course,'chatops',runtime.remote_function(leaking,'chatops','defense'))
    except runtime.CourseFailure as e: results['privateTarget']=e.status
    breaking=start('chatops','def attack(env):\n raise RuntimeError("bad student")\n')
    try: runtime.run_pair(course,'chatops',runtime.remote_function(breaking,'chatops','attack'),runtime.no_defense,None,runtime.scenario_matches(course,'chatops',1,42)[0])
    except runtime.CourseFailure as e: results['exception']=e.status
    print(json.dumps(results))
finally:
    for child in children:
        child.terminate()
        try: child.communicate(timeout=3)
        except subprocess.TimeoutExpired: child.kill(); child.communicate()
`)
    const result = JSON.parse(execFileSync(python, ['-B', path.join(temporary, 'run.py')], {
      encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' },
    }))
    assert.deepEqual(result, {
      chatops: [true, false, 0], supportbot: [true, false, 0], agendabot: [true, false, 0], webbot: [true, false, 0],
      privateTarget: 'student_error', exception: 'student_error',
    })
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

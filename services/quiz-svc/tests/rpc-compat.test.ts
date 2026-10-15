import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PLATFORM_STUDENT_CLIENT_SOURCE, PLATFORM_STUDENT_WORKER_SOURCE } from '../src/services/studentRpc.js'

const harness = String.raw`import pathlib, subprocess, sys, json, time, secrets
from platform_student import invoke, construct, call_method, release, expose, RemoteObject
root=pathlib.Path(__file__).parent
children=[]
def start_worker(code, settings=None, bootstrap=None, public_files=None):
    directory=root/('worker-'+secrets.token_hex(4)); directory.mkdir()
    public=directory/'public'; public.mkdir()
    for name,content in (public_files or {}).items(): (public/name).write_text(content,encoding='utf8')
    (directory/'code.py').write_text(code,encoding='utf8')
    config=dict(token=secrets.token_hex(16),maxRequestBytes=128*1024*1024,maxResponseBytes=128*1024*1024,maxArrayBytes=64*1024*1024,maxObjects=8,maxCalls=100,timeoutSeconds=20)
    config.update(settings or {})
    if bootstrap:
        (public/'bootstrap.py').write_text(bootstrap,encoding='utf8')
        config['bootstrap']=str(public/'bootstrap.py')
    (directory/'config.json').write_text(json.dumps(config))
    source=(root/'worker-template.py').read_text(encoding='utf8').replace("'/worker/config.json'",repr(str(directory/'config.json'))).replace("'/materials/code.py'",repr(str(directory/'code.py'))).replace("'/materials'",repr(str(directory))).replace("'/worker/public'",repr(str(public)))
    source=source.replace("http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()","server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()")
    (directory/'server.py').write_text(source,encoding='utf8')
    child=subprocess.Popen([sys.executable,'-I','-B',str(directory/'server.py')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    children.append(child)
    line=child.stdout.readline()
    if not line.strip(): raise RuntimeError('worker startup failed: '+child.stderr.read())
    return dict(config,url='http://127.0.0.1:'+line.strip(),protocolVersion=2,deadline=time.time()*1000+20000)
def cleanup():
    for child in children:
        child.terminate()
        try: child.communicate(timeout=3)
        except subprocess.TimeoutExpired: child.kill(); child.communicate()
`

function run(source: string, timeout = 30000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-compat-'))
  try {
    fs.writeFileSync(path.join(root, 'platform_student.py'), PLATFORM_STUDENT_CLIENT_SOURCE)
    fs.writeFileSync(path.join(root, 'worker-template.py'), PLATFORM_STUDENT_WORKER_SOURCE)
    fs.writeFileSync(path.join(root, 'case.py'), source)
    fs.writeFileSync(
      path.join(root, 'probe.py'),
      `${harness}\ntry:\n    exec(compile((root/'case.py').read_text(encoding='utf8'),'case.py','exec'))\nfinally:\n    cleanup()\n`,
    )
    return JSON.parse(
      execFileSync(
        process.env.EVALUATION_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
        ['-B', path.join(root, 'probe.py')],
        { encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } },
      ),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('Solution instance and synchronous environment callbacks preserve state across isolated invocations', () => {
  const result = run(`worker=start_worker('''class Solution:
 def __init__(self,work_dir): self.count=0
 def attack(self,env):
  self.count+=1
  accepted=env.set_page(env.attacker_email)
  return {'count':self.count,'accepted':accepted,'balance':env.query('balance'),'orders':env._orders}
''')
events=[]
def set_page(value): events.append(value); return value.endswith('@example.test')
def query(value): return 7+len(events)
env=expose(values={'attacker_email':'a@example.test','_orders':[1,2]},methods={'set_page':set_page,'query':query})
one=invoke(worker,'attack',[env]); two=invoke(worker,'attack',[env])
print(json.dumps([one,two,events]))`)
  assert.deepEqual(result, [
    { count: 1, accepted: true, balance: 8, orders: [1, 2] },
    { count: 2, accepted: true, balance: 9, orders: [1, 2] },
    ['a@example.test', 'a@example.test'],
  ])
})

test('construct, self-return, returned model handles and release keep executable objects inside worker', () => {
  const result = run(`worker=start_worker('''class Model:
 def __init__(self,bias): self.bias=bias
 def predict(self,value): return value+self.bias
class Defense:
 def __init__(self): self.bias=0
 def train(self,value): self.bias=value; return self
 def fit(self,value): return Model(value)
 def __call__(self,value): return self.bias+value
''')
obj=construct(worker,'Defense')
self_obj=call_method(obj,'train',[4]); model=call_method(obj,'fit',[9])
answer=[obj.identifier==self_obj.identifier,call_method(model,'predict',[3]),call_method(obj,'__call__',[5])]
release(model)
try: call_method(model,'predict',[1])
except Exception as error: answer.append(type(error).__name__)
try: call_method(obj,'__getattribute__',['__dict__'])
except Exception as error: answer.append(type(error).__name__)
print(json.dumps(answer))`)
  assert.deepEqual(result, [true, 12, 9, 'StudentExecutionError', 'StudentExecutionError'])
})

test('safe numpy codec roundtrips a real MNIST-sized batch beyond the former 16 MiB ceiling', () => {
  const result = run(
    `import numpy as np
worker=start_worker('''def echo(value): return value
''')
value=np.arange(8000*28*28,dtype=np.float32).reshape(8000,1,28,28)
copy=invoke(worker,'echo',[value])
small=np.array([1,65535],dtype='>u2')
small_copy=invoke(worker,'echo',[small])
empty=invoke(worker,'echo',[np.empty((0,3),dtype=np.float64)])
errors=[]
for bad in [np.array([object()],dtype=object),np.array([float('nan')]),np.array(['unsafe']),np.array([complex(1,2)])]:
 try: invoke(worker,'echo',[bad])
 except Exception as error: errors.append(type(error).__name__)
print(json.dumps([copy.dtype.str,list(copy.shape),bool(np.array_equal(copy,value)),small_copy.dtype.str,small_copy.tolist(),list(empty.shape),errors]))`,
    60000,
  )
  assert.deepEqual(result, [
    '<f4',
    [8000, 1, 28, 28],
    true,
    '>u2',
    [1, 65535],
    [0, 3],
    Array(4).fill('EvaluationInfrastructureError'),
  ])
})

test('ndarray decoder rejects forged shapes, oversized allocations, object dtype and non-finite payloads', () => {
  const result = run(`import base64, struct
from platform_student import _decode,_Budget
cases=[
 {'$rpc':'ndarray','dtype':'|O8','shape':[1],'data':'AAAAAAAAAAA='},
 {'$rpc':'ndarray','dtype':'<f4','shape':[999999999,999999999],'data':''},
 {'$rpc':'ndarray','dtype':'<f4','shape':[-1],'data':''},
 {'$rpc':'ndarray','dtype':'<f4','shape':[True],'data':'AAAAAA=='},
 {'$rpc':'ndarray','dtype':'<f4','shape':[2],'data':'AAAAAA=='},
 {'$rpc':'ndarray','dtype':'<f4','shape':[1],'data':base64.b64encode(struct.pack('<f',float('inf'))).decode()},
 {'$rpc':'dict','items':[['x',1],['x',2]]},
 {'$rpc':'pickle','data':'payload'},
]
result=[]
for value in cases:
 try: _decode(value,_Budget(1024)); result.append('accepted')
 except (ValueError,TypeError): result.append('rejected')
print(json.dumps(result))`)
  assert.deepEqual(result, Array(8).fill('rejected'))
})

test('grader enforces callback capability, nonce and replay boundaries against forged worker responses', () => {
  const result = run(`import platform_student as client
worker=dict(url='unused',token='secret',timeoutSeconds=1,maxRequestBytes=4096,maxResponseBytes=4096,protocolVersion=2,maxCalls=2)
def find_cap(value):
 if isinstance(value,dict):
  if value.get('$rpc')=='callback': return value['id']
  for v in value.values():
   found=find_cap(v)
   if found: return found
 if isinstance(value,list):
  for v in value:
   found=find_cap(v)
   if found: return found
seen=[]; result=[]
for mode in ['wrong_nonce','unknown_cap','unknown_method','replay','limit']:
 state={}
 def fake_post(w,path,payload):
  if path.endswith('cancel'): return {'state':'cancelled'}
  if path.endswith('start'): state.update(nonce=payload['nonce'],cap=find_cap(payload),count=0)
  state['count']+=1
  identifier=('f'*32 if mode=='replay' else format(state['count'],'032x'))
  callback={'id':identifier,'capability':state['cap'] if mode!='unknown_cap' else '0'*32,'method':'allowed' if mode!='unknown_method' else 'secret','arguments':client._encode({'args':[],'kwargs':{}},client._Budget(1024))}
  return {'nonce':state['nonce'] if mode!='wrong_nonce' else '0'*32,'state':'callback','callback':callback}
 client._post=fake_post
 before=len(seen)
 try: invoke(worker,'attack',[expose(methods={'allowed':lambda:seen.append(mode)})])
 except Exception as error: result.append([mode,type(error).__name__,len(seen)-before])
print(json.dumps(result))`)
  assert.deepEqual(result, [
    ['wrong_nonce', 'EvaluationInfrastructureError', 0],
    ['unknown_cap', 'EvaluationInfrastructureError', 0],
    ['unknown_method', 'EvaluationInfrastructureError', 0],
    ['replay', 'EvaluationInfrastructureError', 1],
    ['limit', 'EvaluationInfrastructureError', 2],
  ])
})

test('public bootstrap supports old code fragments without giving workers grader modules', () => {
  const result = run(`bootstrap='''import pathlib, types
def load_student(code_path,work_dir):
 module=types.ModuleType('course_student')
 module.PUBLIC_FACTOR=3
 exec(compile(pathlib.Path(code_path).read_text(),code_path,'exec'),module.__dict__)
 module.course_invoke=lambda value:module.attack(value)
 return module
'''
worker=start_worker('def attack(value): return value*PUBLIC_FACTOR',bootstrap=bootstrap)
print(json.dumps(invoke(worker,'course_invoke',[7])))`)
  assert.equal(result, 21)
})

test('public helpers importing pdb load standard-library code before legacy student fragments', () => {
  const result = run(`helper='''import pdb, code
assert hasattr(code,'InteractiveInterpreter')
class GradientPatchBaseline:
 def value(self): return 250
EPOCHS=8
'''
bootstrap='''import pathlib, types, sys
from public_patch_helper import GradientPatchBaseline, EPOCHS
def load_student(code_path,work_dir):
 module=types.ModuleType('student_code')
 module.GradientPatchBaseline=GradientPatchBaseline
 module.EPOCHS=EPOCHS
 exec(compile(pathlib.Path(code_path).read_text(),code_path,'exec'),module.__dict__)
 module.probe=lambda:[module.course_value(),sys.flags.isolated,work_dir not in sys.path]
 return module
'''
fragments=['''class GradientPatchAttack(GradientPatchBaseline): pass
def course_value(): return GradientPatchAttack().value()
''','''class ResNet18Classifier:
 def __init__(self,epochs=EPOCHS): self.epochs=epochs
def course_value(): return ResNet18Classifier().epochs
''']
answers=[]
for fragment in fragments:
 worker=start_worker(fragment,bootstrap=bootstrap,public_files={'public_patch_helper.py':helper})
 answers.append(invoke(worker,'probe'))
print(json.dumps(answers))`)
  assert.deepEqual(result, [
    [250, 1, true],
    [8, 1, true],
  ])
})

test('absolute student loading preserves explicit public helper imports without shadowing stdlib code', () => {
  const result = run(`worker=start_worker('''import pdb, code, public_math_helper
def solve(value): return [value*public_math_helper.FACTOR,__name__,hasattr(code,'InteractiveInterpreter')]
''',public_files={'public_math_helper.py':'FACTOR=3'})
print(json.dumps(invoke(worker,'solve',[7])))`)
  assert.deepEqual(result, [21, 'student_code', true])
})

test('RPC deadlines and object quotas are enforced by real worker processes', () => {
  const result = run(`worker=start_worker('''import time
class Model: pass
def slow(): time.sleep(2); return 1
''',settings={'maxObjects':1})
construct(worker,'Model')
result=[]
try: construct(worker,'Model')
except Exception as error: result.append(type(error).__name__)
worker['deadline']=time.time()*1000+150
started=time.monotonic()
try: invoke(worker,'slow')
except Exception as error: result.append(type(error).__name__)
result.append(time.monotonic()-started<1)
print(json.dumps(result))`)
  assert.deepEqual(result, ['StudentExecutionError', 'EvaluationTimeoutError', true])
})

test('remote handles and environment capabilities cannot cross workers or expose unlisted state', () => {
  const result = run(`code='''class Model: pass
def echo(value): return value
def steal(env): return env.hidden
def mutate(env): return env.forbidden()
'''
one=start_worker(code); two=start_worker(code)
obj=construct(one,'Model')
result=[]
try: invoke(two,'echo',[obj])
except Exception as error: result.append(type(error).__name__)
for fn in ['steal','mutate']:
 try: invoke(one,fn,[expose(values={'public':1})])
 except Exception as error: result.append(type(error).__name__)
try: expose(values={'__class__':'danger'})
except Exception as error: result.append(type(error).__name__)
print(json.dumps(result))`)
  assert.deepEqual(result, [
    'EvaluationInfrastructureError',
    'StudentExecutionError',
    'StudentExecutionError',
    'ValueError',
  ])
})

// Both ends use a data-only codec. No pickle, dynamic imports, or object constructors are accepted on the wire.
const CODEC = String.raw`import base64, math, re
_numpy_module = None
_numpy_checked = False
def _numpy():
    global _numpy_module, _numpy_checked
    if not _numpy_checked:
        _numpy_checked = True
        try:
            import numpy
            _numpy_module = numpy
        except ImportError: pass
    return _numpy_module

class _Budget:
    def __init__(self, limit):
        self.limit = limit
        self.arrays = 0
        self.nodes = 0
    def visit(self, depth):
        self.nodes += 1
        if depth > 48 or self.nodes > 1000000: raise ValueError('RPC structure limit')
    def array(self, size):
        self.arrays += size
        if size < 0 or self.arrays > self.limit: raise ValueError('RPC array limit')

def _encode(value, budget, handle=None, callback=None, depth=0):
    budget.visit(depth)
    if value is None or isinstance(value, (str, bool, int)): return value
    if isinstance(value, float):
        if not math.isfinite(value): raise ValueError('Non-finite RPC number')
        return value
    if isinstance(value, (list, tuple)):
        items = [_encode(x, budget, handle, callback, depth+1) for x in value]
        return {'$rpc':'tuple','items':items} if isinstance(value, tuple) else items
    if isinstance(value, dict):
        if any(not isinstance(k, str) for k in value): raise ValueError('RPC keys must be strings')
        return {'$rpc':'dict','items':[[k,_encode(v,budget,handle,callback,depth+1)] for k,v in value.items()]}
    np = _numpy()
    if np is not None and isinstance(value, np.generic):
        if value.dtype.kind not in 'biuf': raise ValueError('Unsupported numpy scalar')
        return _encode(value.item(), budget, handle, callback, depth+1)
    if np is not None and isinstance(value, np.ndarray):
        if value.dtype.kind not in 'biuf' or value.dtype.itemsize not in (1,2,4,8) or value.ndim > 8:
            raise ValueError('Unsupported ndarray dtype or shape')
        budget.array(value.nbytes)
        if value.dtype.kind == 'f' and not np.isfinite(value).all(): raise ValueError('Non-finite array')
        return {'$rpc':'ndarray','dtype':value.dtype.str,'shape':list(value.shape),'data':base64.b64encode(value.tobytes(order='C')).decode('ascii')}
    if callback is not None:
        encoded = callback(value, budget, depth)
        if encoded is not None: return encoded
    if handle is not None:
        encoded = handle(value)
        if encoded is not None: return {'$rpc':'handle','id':encoded}
    raise ValueError('Unsupported RPC value')

def _decode(value, budget, handle=None, callback=None, depth=0):
    budget.visit(depth)
    if value is None or isinstance(value, (str, bool, int)): return value
    if isinstance(value, float):
        if not math.isfinite(value): raise ValueError('Non-finite RPC number')
        return value
    if isinstance(value, list): return [_decode(x,budget,handle,callback,depth+1) for x in value]
    if not isinstance(value, dict): raise ValueError('Invalid RPC value')
    kind = value.get('$rpc')
    if kind in ('dict','tuple'):
        if set(value) != {'$rpc','items'} or not isinstance(value['items'],list): raise ValueError('Invalid RPC container')
        if kind == 'tuple': return tuple(_decode(x,budget,handle,callback,depth+1) for x in value['items'])
        result = {}
        for item in value['items']:
            if not isinstance(item,list) or len(item)!=2 or not isinstance(item[0],str) or item[0] in result:
                raise ValueError('Invalid RPC dictionary')
            result[item[0]] = _decode(item[1],budget,handle,callback,depth+1)
        return result
    if kind == 'ndarray':
        if set(value) != {'$rpc','dtype','shape','data'}: raise ValueError('Invalid ndarray fields')
        dtype, shape, data = value['dtype'], value['shape'], value['data']
        if not isinstance(dtype,str) or not re.fullmatch(r'[<>=|](?:b1|[iu][1248]|f[248])',dtype): raise ValueError('Unsupported ndarray dtype')
        if not isinstance(shape,list) or len(shape)>8 or any(type(n) is not int or n<0 or n>budget.limit for n in shape): raise ValueError('Invalid ndarray shape')
        count = 1
        for n in shape: count *= n
        size = count * int(dtype[-1])
        budget.array(size)
        if not isinstance(data,str) or len(data) != 4*((size+2)//3): raise ValueError('Invalid ndarray size')
        raw = base64.b64decode(data,validate=True)
        if len(raw)!=size: raise ValueError('Invalid ndarray payload')
        np = _numpy()
        if np is None: raise ValueError('numpy required for ndarray')
        result = np.frombuffer(raw,dtype=np.dtype(dtype)).reshape(shape).copy()
        if result.dtype.kind=='f' and not np.isfinite(result).all(): raise ValueError('Non-finite array')
        return result
    if kind=='handle' and set(value)=={'$rpc','id'} and handle is not None:
        if not isinstance(value['id'],str) or not re.fullmatch(r'[a-f0-9]{32}',value['id']): raise ValueError('Invalid object handle')
        return handle(value['id'])
    if kind=='callback' and callback is not None: return callback(value,budget,depth)
    raise ValueError('Unknown RPC type')
`

export const PLATFORM_STUDENT_CLIENT_SOURCE =
  CODEC +
  String.raw`
import http.client, json, secrets, socket, time, urllib.request, urllib.error
class StudentExecutionError(RuntimeError): pass
class EvaluationInfrastructureError(RuntimeError): pass
class EvaluationTimeoutError(TimeoutError): pass

class RemoteObject:
    def __init__(self, worker, identifier):
        self.worker, self.identifier = worker, identifier

class _Exposed:
    def __init__(self, values, methods):
        self.values, self.methods = dict(values), dict(methods)

def expose(values=None, methods=None):
    values, methods = values or {}, methods or {}
    if not isinstance(values,dict) or not isinstance(methods,dict): raise ValueError('Invalid environment capability')
    if set(values)&set(methods): raise ValueError('Duplicate environment member')
    for name in list(values)+list(methods):
        if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',name) or name.startswith('__') or name.startswith('_rpc_'):
            raise ValueError('Invalid environment member')
    if any(not callable(fn) for fn in methods.values()): raise ValueError('Environment methods must be callables')
    return _Exposed(values,methods)

def _post(worker, endpoint, payload):
    try: body = json.dumps(payload,allow_nan=False,separators=(',',':')).encode()
    except (ValueError,TypeError): raise EvaluationInfrastructureError('invalid invocation data') from None
    if len(body)>worker['maxRequestBytes']: raise EvaluationInfrastructureError('student invocation too large')
    timeout = worker['timeoutSeconds']
    if 'deadline' in worker:
        timeout = min(timeout,(worker['deadline']/1000)-time.time())
        if timeout<=0: raise EvaluationTimeoutError('evaluation deadline expired')
    request = urllib.request.Request(worker['url']+endpoint,data=body,headers={'Content-Type':'application/json','Authorization':'Bearer '+worker['token']},method='POST')
    try:
        with urllib.request.urlopen(request,timeout=timeout) as response: data=response.read(worker['maxResponseBytes']+1)
    except urllib.error.HTTPError as error:
        error.close()
        if error.code==422: raise StudentExecutionError('student execution failed') from None
        if error.code==408: raise EvaluationTimeoutError('student invocation timed out') from None
        raise EvaluationInfrastructureError('student service rejected invocation') from None
    except (TimeoutError,socket.timeout): raise EvaluationTimeoutError('student invocation timed out') from None
    except urllib.error.URLError as error:
        if isinstance(error.reason,(TimeoutError,socket.timeout)): raise EvaluationTimeoutError('student invocation timed out') from None
        raise EvaluationInfrastructureError('student service unavailable') from None
    except (OSError,http.client.HTTPException): raise EvaluationInfrastructureError('student service unavailable') from None
    if len(data)>worker['maxResponseBytes']: raise EvaluationInfrastructureError('student response too large')
    try: result=json.loads(data)
    except (ValueError,UnicodeError): raise EvaluationInfrastructureError('invalid student response') from None
    if not isinstance(result,dict) or 'error' in result: raise EvaluationInfrastructureError('invalid student response')
    return result

def _rpc(worker, operation, name=None, args=None, kwargs=None, target=None):
    nonce, capabilities, seen = secrets.token_hex(16), {}, set()
    limit = worker.get('maxArrayBytes',64*1024*1024)
    def encode_handle(obj):
        if isinstance(obj,RemoteObject):
            if obj.worker is not worker: raise ValueError('Object belongs to another worker')
            return obj.identifier
    def encode_callback(obj,budget,depth):
        if not isinstance(obj,_Exposed): return None
        cap = secrets.token_hex(16)
        capabilities[cap] = obj.methods
        return {'$rpc':'callback','id':cap,'values':_encode(obj.values,budget,encode_handle,encode_callback,depth+1),'methods':list(obj.methods)}
    try:
        encoded = _encode({'args':args or [],'kwargs':kwargs or {}},_Budget(limit),encode_handle,encode_callback)
    except (ValueError,TypeError,OverflowError): raise EvaluationInfrastructureError('unsupported invocation data') from None
    response = _post(worker,'/rpc/start',{'nonce':nonce,'operation':operation,'name':name,'target':target,'arguments':encoded})
    calls = 0
    try:
        while True:
            if response.get('nonce')!=nonce: raise EvaluationInfrastructureError('invalid invocation nonce')
            state = response.get('state')
            if state=='done':
                try: return _decode(response['result'],_Budget(limit),lambda identifier:RemoteObject(worker,identifier))
                except (KeyError,ValueError,TypeError,OverflowError): raise EvaluationInfrastructureError('invalid student result') from None
            if state=='student_error': raise StudentExecutionError('student execution failed')
            if state=='timeout': raise EvaluationTimeoutError('student invocation timed out')
            if state=='callback':
                item = response.get('callback')
                if not isinstance(item,dict): raise EvaluationInfrastructureError('invalid environment callback')
                callback_id, cap, method = item.get('id'),item.get('capability'),item.get('method')
                calls += 1
                if calls>worker.get('maxCalls',4096) or not isinstance(callback_id,str) or not re.fullmatch(r'[a-f0-9]{32}',callback_id) or callback_id in seen:
                    raise EvaluationInfrastructureError('environment callback limit or replay')
                seen.add(callback_id)
                if not isinstance(cap,str) or not isinstance(method,str) or cap not in capabilities or method not in capabilities[cap]: raise EvaluationInfrastructureError('environment callback not authorized')
                try:
                    arguments = _decode(item['arguments'],_Budget(limit))
                    if not isinstance(arguments,dict) or not isinstance(arguments.get('args'),list) or not isinstance(arguments.get('kwargs'),dict): raise ValueError('Invalid callback arguments')
                except (KeyError,ValueError,TypeError): raise EvaluationInfrastructureError('invalid environment arguments') from None
                # Only this grader-owned table is executable. Worker-supplied names never resolve arbitrary attributes.
                answer = capabilities[cap][method](*arguments['args'],**arguments['kwargs'])
                try: encoded_answer = _encode(answer,_Budget(limit))
                except (ValueError,TypeError,OverflowError): raise EvaluationInfrastructureError('unsupported environment result') from None
                response = _post(worker,'/rpc/resume',{'nonce':nonce,'callbackId':callback_id,'result':encoded_answer})
            elif state=='pending': response = _post(worker,'/rpc/poll',{'nonce':nonce})
            else: raise EvaluationInfrastructureError('invalid invocation state')
    except BaseException:
        # Container cleanup is authoritative. This bounded best-effort cancellation unblocks a waiting callback.
        try:
            cancel_worker = dict(worker,timeoutSeconds=min(1,worker['timeoutSeconds']))
            _post(cancel_worker,'/rpc/cancel',{'nonce':nonce})
        except BaseException: pass
        raise

def invoke(worker, function, args=None, kwargs=None):
    if worker.get('protocolVersion')==2: return _rpc(worker,'invoke',function,args,kwargs)
    response = _post(worker,'/invoke',{'function':function,'args':args or [],'kwargs':kwargs or {}})
    if 'result' not in response: raise EvaluationInfrastructureError('invalid student response')
    return response['result']

def construct(worker, class_name, args=None, kwargs=None):
    result = _rpc(worker,'construct',class_name,args,kwargs)
    if not isinstance(result,RemoteObject): raise EvaluationInfrastructureError('constructor did not return an object')
    return result

def call_method(obj, method, args=None, kwargs=None):
    if not isinstance(obj,RemoteObject): raise ValueError('Expected a remote object')
    return _rpc(obj.worker,'method',method,args,kwargs,target=obj.identifier)

def release(obj):
    if not isinstance(obj,RemoteObject): raise ValueError('Expected a remote object')
    return _rpc(obj.worker,'release',target=obj.identifier)
`

export const PLATFORM_STUDENT_WORKER_SOURCE =
  CODEC +
  String.raw`
import contextlib, http.server, importlib.util, json, os, pathlib, secrets, sys, threading, time
config = json.loads(pathlib.Path('/worker/config.json').read_text())
module = None
solution = None
objects = {}
state_lock = threading.Lock()
execution_lock = threading.Lock()
active = None
calls = 0
limit = config.get('maxArrayBytes',64*1024*1024)

def _load_module():
    global module
    if module is None:
        # Student code is loaded explicitly below; adding /materials here would
        # let its code.py shadow the standard-library module imported by pdb/torch.
        sys.path.insert(0,'/worker/public')
        bootstrap = config.get('bootstrap')
        if bootstrap:
            spec=importlib.util.spec_from_file_location('platform_public_bootstrap',bootstrap)
            loader=importlib.util.module_from_spec(spec); sys.modules[spec.name]=loader; spec.loader.exec_module(loader)
            module=loader.load_student('/materials/code.py','/materials')
        else:
            spec=importlib.util.spec_from_file_location('student_code','/materials/code.py')
            module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module)
    return module

def _keep(obj):
    for identifier,stored in objects.items():
        if stored is obj: return identifier
    if len(objects)>=config.get('maxObjects',64): raise ValueError('Object limit')
    identifier=secrets.token_hex(16); objects[identifier]=obj; return identifier

def _get(identifier):
    if identifier not in objects: raise ValueError('Unknown object')
    return objects[identifier]

class _EnvironmentProxy:
    def __init__(self, invocation, cap, values, methods):
        self._rpc_invocation, self._rpc_cap = invocation, cap
        self._rpc_values, self._rpc_methods = values, methods
    def __getattr__(self,name):
        if name in self._rpc_values: return self._rpc_values[name]
        if name in self._rpc_methods:
            return lambda *args,**kwargs:self._rpc_invocation.callback(self._rpc_cap,name,list(args),kwargs)
        raise AttributeError(name)

class _Invocation:
    def __init__(self,payload):
        self.nonce=payload['nonce']; self.payload=payload
        self.condition=threading.Condition(); self.state='pending'; self.result=None
        self.request=None; self.reply=None; self.cancelled=False; self.callback_count=0
        self.deadline=time.monotonic()+config.get('timeoutSeconds',120)
    def callback(self,cap,method,args,kwargs):
        with self.condition:
            self.callback_count+=1
            if self.callback_count>config.get('maxCalls',4096): raise ValueError('Callback limit')
            self.request={'id':secrets.token_hex(16),'capability':cap,'method':method,'arguments':_encode({'args':args,'kwargs':kwargs},_Budget(limit))}
            self.reply=None; self.state='callback'; self.condition.notify_all()
            while self.reply is None and not self.cancelled:
                remaining=self.deadline-time.monotonic()
                if remaining<=0: raise TimeoutError('Callback timeout')
                self.condition.wait(min(remaining,1))
            if self.cancelled: raise RuntimeError('Invocation cancelled')
            result=self.reply; self.request=None; self.reply=None; self.state='pending'
            return _decode(result['result'],_Budget(limit))
    def decode_callback(self,value,budget,depth):
        if set(value)!={'$rpc','id','values','methods'} or not isinstance(value['id'],str) or not re.fullmatch(r'[a-f0-9]{32}',value['id']): raise ValueError('Invalid environment capability')
        values=_decode(value['values'],budget,_get,self.decode_callback,depth+1)
        methods=value['methods']
        if not isinstance(values,dict) or not isinstance(methods,list) or len(set(methods))!=len(methods): raise ValueError('Invalid environment members')
        for name in list(values)+methods:
            if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',name) or name.startswith('__') or name.startswith('_rpc_'): raise ValueError('Invalid environment name')
        if set(values)&set(methods): raise ValueError('Duplicate environment member')
        return _EnvironmentProxy(self,value['id'],values,methods)
    def run(self):
        global solution
        try:
            with execution_lock,open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
                operation=self.payload['operation']; name=self.payload.get('name')
                if operation!='release' and (not isinstance(name,str) or not (re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}',name) or operation=='method' and name=='__call__')): raise ValueError('Invalid method')
                arguments=_decode(self.payload['arguments'],_Budget(limit),_get,self.decode_callback)
                args,kwargs=arguments['args'],arguments['kwargs']
                if not isinstance(args,list) or not isinstance(kwargs,dict): raise ValueError('Invalid arguments')
                if operation=='release':
                    obj=_get(self.payload['target']); del objects[self.payload['target']]; answer=None
                elif operation=='method': answer=getattr(_get(self.payload['target']),name)(*args,**kwargs)
                else:
                    loaded=_load_module()
                    if operation=='construct':
                        cls=getattr(loaded,name)
                        if not isinstance(cls,type): raise ValueError('Not a class')
                        answer=cls(*args,**kwargs)
                    elif operation=='invoke':
                        fn=getattr(loaded,name,None)
                        if fn is None:
                            if solution is None: solution=getattr(loaded,'Solution')('/materials')
                            fn=getattr(solution,name)
                        answer=fn(*args,**kwargs)
                    else: raise ValueError('Invalid operation')
                encoded=_encode(answer,_Budget(limit),_keep)
            with self.condition: self.result=encoded; self.state='done'; self.condition.notify_all()
        except BaseException as error:
            with self.condition:
                self.state='timeout' if isinstance(error,TimeoutError) else 'student_error'
                self.condition.notify_all()
    def response(self):
        with self.condition:
            if self.state=='pending': self.condition.wait(min(0.25,max(0,self.deadline-time.monotonic())))
            if time.monotonic()>=self.deadline and self.state not in ('done','student_error'):
                self.cancelled=True; self.state='timeout'; self.condition.notify_all()
            result={'nonce':self.nonce,'state':self.state}
            if self.state=='done': result['result']=self.result
            if self.state=='callback': result['callback']=self.request
            return result

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send_json(self,value,status=200):
        data=json.dumps(value,allow_nan=False,separators=(',',':')).encode()
        if len(data)>config['maxResponseBytes']:
            self.send_error(413); return
        self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        global active,calls
        if self.headers.get('Authorization')!='Bearer '+config['token']:
            self.send_error(403); return
        try:
            size=int(self.headers.get('Content-Length','0'))
            if size<=0 or size>config['maxRequestBytes']:
                self.send_error(413); return
            payload=json.loads(self.rfile.read(size))
            if not isinstance(payload,dict): self.send_error(400); return
            if self.path=='/invoke':
                name=payload.get('function','')
                if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}',name): self.send_error(400); return
                with execution_lock,open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
                    answer=getattr(_load_module(),name)(*payload.get('args',[]),**payload.get('kwargs',{}))
                    data={'result':answer}
                self.send_json(data); return
            nonce=payload.get('nonce')
            if not isinstance(nonce,str) or not re.fullmatch(r'[a-f0-9]{32}',nonce): self.send_error(400); return
            with state_lock:
                if self.path=='/rpc/start':
                    if active is not None:
                        self.send_error(409); return
                    calls+=1
                    if calls>config.get('maxCalls',4096): self.send_error(429); return
                    active=_Invocation(payload)
                    threading.Thread(target=active.run,daemon=True).start()
                elif self.path not in ('/rpc/poll','/rpc/resume','/rpc/cancel'):
                    self.send_error(404); return
                invocation=active
                if invocation is None or invocation.nonce!=nonce: self.send_error(409); return
            if self.path=='/rpc/cancel':
                with invocation.condition:
                    invocation.cancelled=True; invocation.state='student_error'; invocation.condition.notify_all()
                self.send_json({'nonce':nonce,'state':'cancelled'}); return
            if self.path=='/rpc/resume':
                with invocation.condition:
                    if invocation.state!='callback' or invocation.reply is not None or payload.get('callbackId')!=invocation.request['id'] or 'result' not in payload:
                        self.send_error(409); return
                    invocation.reply=payload; invocation.state='pending'; invocation.condition.notify_all()
            response=invocation.response()
            if response['state'] in ('done','student_error','timeout'):
                with state_lock:
                    if active is invocation: active=None
            self.send_json(response)
        except BaseException:
            try: self.send_json({'error':'student_code_error'},422)
            except BaseException: pass
http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()
`

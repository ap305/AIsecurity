"""Real production RPC, separate local processes; no Docker isolation claim."""
from __future__ import annotations
import argparse
import contextlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'basic' / 'tests'))
from offline_harness import configure as offline_environment, entrypoint as offline_entrypoint


@contextlib.contextmanager
def worker(package, specification, rpc, work, timeout, environment, code_override=None):
    work.mkdir()
    public = work / 'public'
    shutil.copytree(package / 'public',public)
    path = public / 'bootstrap.py'
    path.write_text(path.read_text(encoding='utf8').replace("'/materials/weights.bin'",repr(str(work / 'weights.bin'))),encoding='utf8')
    code = code_override if code_override is not None else Path(specification['codePath']).read_text(encoding='utf8')
    (work / 'code.py').write_text(code,encoding='utf8')
    if specification.get('weightFixture'):
        shutil.copyfile(package / specification['weightFixture'],work / 'weights.bin')
    config={'token':secrets.token_hex(24),'maxRequestBytes':134217728,'maxResponseBytes':134217728,
            'maxArrayBytes':67108864,'maxObjects':256,'maxCalls':50000,'timeoutSeconds':timeout,
            'bootstrap':str(public / 'bootstrap.py')}
    (work / 'config.json').write_text(json.dumps(config),encoding='utf8')
    source=(rpc / 'worker-template.py').read_text(encoding='utf8')
    for old,new in [("'/worker/config.json'",repr(str(work/'config.json'))),
                    ("'/materials/code.py'",repr(str(work/'code.py'))),("'/materials'",repr(str(work))),
                    ("'/worker/public'",repr(str(public)))]:
        source=source.replace(old,new)
    source=source.replace("http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()",
                          "server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()")
    (work/'server.py').write_text(source,encoding='utf8')
    worker_entry=offline_entrypoint(work/'server.py',work/'offline-worker.py')
    with (work/'worker.log').open('w',encoding='utf8') as log:
        child=subprocess.Popen([sys.executable,'-B','-I',str(worker_entry)],cwd=work,
                               stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf8',env=environment)
        try:
            port=child.stdout.readline().strip()
            if not port.isdigit(): raise RuntimeError('worker failed to start')
            yield dict(config,url='http://127.0.0.1:'+port,protocolVersion=2,deadline=time.time()*1000+timeout*1000)
        finally:
            child.terminate()
            try: child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--build',type=Path,required=True)
    parser.add_argument('--rpc',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--id',required=True)
    parser.add_argument('--phase',choices=['baseline','opponent'],default='baseline')
    parser.add_argument('--template',action='store_true')
    parser.add_argument('--timeout',type=int,default=1200)
    parser.add_argument('--success-threshold',type=float)
    args=parser.parse_args()
    args.build,args.rpc,args.output=args.build.resolve(),args.rpc.resolve(),args.output.resolve()
    args.output.mkdir(parents=True,exist_ok=False)
    manifest=json.loads((args.build/'manifest.json').read_text(encoding='utf8'))
    q=next(q for q in manifest['questions'] if q['sourceId']==args.id)
    package=args.build/'packages'/q['packageKey']
    env=dict(os.environ,PYTHONUTF8='1',MPLBACKEND='Agg',PYTHONPATH=str(args.rpc),
             OMP_NUM_THREADS='1',MKL_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',
             HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',NO_PROXY='127.0.0.1,localhost')
    offline_environment(env,args.output)
    grader_entry=offline_entrypoint(package/'grade.py',args.output/'offline-grader.py')
    with contextlib.ExitStack() as stack:
        student=stack.enter_context(worker(package,q['selfTest'],args.rpc,args.output/'student',args.timeout,env,
                                           q['answerTemplate'] if args.template else None))
        context={'submissionId':'media-'+args.id,'attemptId':'local-rpc','questionVersion':1,
                 'evaluationVersion':'v3-261012-media-rpc-v1','phase':args.phase,'role':q['role'],
                 'parameters':dict(q['definition']['evaluation'], calibrationMode=args.success_threshold is None,
                                   successThreshold=args.success_threshold),'student':student}
        if args.phase=='opponent':
            context['opponent']=stack.enter_context(worker(package,q['selfTest']['opponent'],args.rpc,
                                                            args.output/'opponent',args.timeout,env))
            context['opponent']['submissionId']='actual-opponent-' + args.id
        context_path,result_path=args.output/'context.json',args.output/'result.json'
        context_path.write_text(json.dumps(context),encoding='utf8')
        with (args.output/'grader.log').open('w',encoding='utf8') as log:
            subprocess.run([sys.executable,'-B',str(grader_entry),str(context_path),str(result_path)],
                           cwd=package,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=args.timeout+30)
        result=json.loads(result_path.read_text(encoding='utf8'))
        service=Path(__file__).resolve().parents[3]
        subprocess.run(['node',str(service/'node_modules/tsx/dist/cli.mjs'),
                        str(Path(__file__).resolve().parents[2]/'basic/tests/validate_result.ts'),str(context_path),str(result_path)],
                       cwd=service,env=env,check=True,timeout=60)
        print(json.dumps({'id':args.id,'phase':args.phase,'template':args.template,'status':result['status'],
                          'score':result.get('score'),'success':result.get('success'),
                          'metrics':{k:v for k,v in result.get('metrics',{}).items() if k in
                                     ('qualificationMetric','successMetric','legalityGate','sourceScore','mean_ssim')}},ensure_ascii=True))
        if not args.template and result['status']!='completed': raise RuntimeError('reference did not complete')
        if args.template and result['status']=='completed' and result.get('score')==100:
            raise RuntimeError('unfinished template received full marks')


if __name__=='__main__': main()

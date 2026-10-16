"""Extract only our generated safe archive; exercise public local training.

References are copied into the private smoke directory as student completions,
never into the published resource bundle. Tests use real CPU model fitting.
"""
from __future__ import annotations
import argparse
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--build',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--id',required=True)
    parser.add_argument('--fit',action='store_true')
    args=parser.parse_args()
    args.build,args.output=args.build.resolve(),args.output.resolve()
    args.output.mkdir(parents=True,exist_ok=False)
    manifest=json.loads((args.build/'manifest.json').read_text(encoding='utf8'))
    q=next(q for q in manifest['questions'] if q['sourceId']==args.id)
    resource=next(r for r in q['resources'] if r['filename'].endswith('.zip'))
    with zipfile.ZipFile(resource['sourcePath']) as archive:
        for name in archive.namelist():
            target=(args.output/name).resolve()
            if not target.is_relative_to(args.output): raise ValueError('unsafe generated resource path')
        archive.extractall(args.output)
    for path in args.output.rglob('*.py'):
        ast.parse(path.read_text(encoding='utf8'))
    shutil.copyfile(q['selfTest']['codePath'],args.output/'submission'/'blank.py')
    env=dict(os.environ,PYTHONUTF8='1',OMP_NUM_THREADS='2',MKL_NUM_THREADS='2',OPENBLAS_NUM_THREADS='2',MPLBACKEND='Agg')
    # All dependency imports, the exact public synthesize contract, and every
    # public training data loader are exercised even without a long fit.
    probe="""import sys,pathlib,importlib.util
root=pathlib.Path.cwd()
sys.path[:0]=[str(root),str(root/'backend/code')]
import judge_runtime,dataset
role=ROLE
mod=judge_runtime.synthesize_role_module(role,(root/'submission/blank.py').read_text(encoding='utf8'),(root/('backend/code/'+role+'-backend.py')).read_text(encoding='utf8'))
data=dataset.load_benchmark(cache_dir=str(root/'backend/code/data'))
print('public-loader-and-submission-import-ok',type(data).__name__)
""".replace('ROLE',repr(q['role']))
    with (args.output/'check.log').open('w',encoding='utf8') as log:
        subprocess.run([sys.executable,'-c',probe],cwd=args.output,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
        if args.fit:
            subprocess.run([sys.executable,str(args.output/'student/local_train_media.py'),'--problem',args.id],
                           cwd=args.output,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=900)
            if not (args.output/'submission/model.pt').is_file(): raise ValueError('local training produced no weights')
    print(json.dumps({'id':args.id,'publicWorkflow':'passed','realLocalFit':args.fit}))


if __name__=='__main__': main()

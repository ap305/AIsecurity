"""Verify public basic packages import and export real parameter formats.

Previously trained reference fixtures only populate private smoke results;
they are never added to the student's downloadable archive. This validates
the local training output -> platform model.pt step, not retraining metrics.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--build',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--id', help='Verify one source question, such as B17')
    args=parser.parse_args()
    args.build,args.output=args.build.resolve(),args.output.resolve()
    args.output.mkdir(parents=True,exist_ok=False)
    manifest=json.loads((args.build/'manifest.json').read_text(encoding='utf8'))
    selected = [q for q in manifest['questions'] if not args.id or q['sourceId'] == args.id]
    if not selected:
        raise ValueError('Requested question is missing from the build')
    for question in selected:
        sid=question['sourceId']
        target=args.output/sid
        target.mkdir()
        resource=next(r for r in question['resources'] if r['filename'].endswith('.zip'))
        with zipfile.ZipFile(resource['sourcePath']) as archive:
            for name in archive.namelist():
                if not (target/name).resolve().is_relative_to(target): raise ValueError('unsafe public resource path')
            archive.extractall(target)
        env=dict(os.environ,PYTHONUTF8='1',MPLBACKEND='Agg',OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',
                 HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1')
        with (target/'workflow.log').open('w',encoding='utf8') as log:
            subprocess.run([sys.executable,'-c','import student, dataset; import local_train_basic; print("public-import-ok")'],
                           cwd=target,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=120)
            fixture=question['selfTest'].get('weightFixture')
            if fixture:
                package=args.build/'packages'/question['packageKey']
                # This program imports only the trusted public checkpoint parser
                # and the reviewed exporter; student.py is not executed here.
                prepare="""import pathlib,sys,torch,numpy as np
import local_train_basic as exporter
sys.path.insert(0, PACKAGE)
import checkpoints
source=checkpoints.load(FIXTURE,required=True)
sid=SID
spec=exporter.SPECS[sid]
results=pathlib.Path('results');results.mkdir(exist_ok=True)
if spec['kind']=='models':
    for name,filename in spec['names'].items(): torch.save(source.as_state_dict(name),results/filename)
elif spec['kind']=='qtable': np.save(results/spec['input'],source.tensor('q_table').numpy())
elif spec['kind']=='lstm':
    obj={'model_state_dict':source.as_state_dict()}
    raw=source.raw if isinstance(source.raw,dict) else {}
    for key in ('char_to_idx','idx_to_char'):
        obj[key]=source.metadata.get(key,raw.get(key))
    torch.save(obj,results/spec['input'])
else: torch.save(source.as_state_dict(),results/spec['input'])
exporter.main(['--problem',sid,'--out','model.pt'])
output=checkpoints.load('model.pt',required=True)
assert output is not None
print('public-export-ok')
""".replace('PACKAGE',repr(str(package/'public'))).replace('FIXTURE',repr(str(package/fixture))).replace('SID',repr(sid))
                subprocess.run([sys.executable,'-c',prepare],cwd=target,env=env,stdout=log,stderr=subprocess.STDOUT,
                               check=True,timeout=180)
        print(json.dumps({'id':sid,'publicImport':'passed','trainedParameterExport':'passed' if fixture else 'not-required-or-fixture-pending'}))


if __name__=='__main__': main()

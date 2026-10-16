"""Revalidate preserved real inference results through the current formatter/TS contract.

This is a protocol replay, not a repeat of model inference. Original files are
preserved and the report explicitly distinguishes both kinds of evidence.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--artifact-root',type=Path,required=True)
parser.add_argument('--pattern',action='append',required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
args.output.mkdir(parents=True,exist_ok=False)
spec=importlib.util.spec_from_file_location('current_result_contract',ROOT/'result_contract.py')
contract=importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
service=ROOT.parents[1]
entries=[]
seen=set()
for pattern in args.pattern:
    for path in sorted(args.artifact_root.glob(pattern)):
        if path.resolve() in seen: continue
        seen.add(path.resolve())
        original=json.loads(path.read_text(encoding='utf8'))
        context=json.loads((path.parent/'context.json').read_text(encoding='utf8'))
        if original['status']!='completed': continue
        target=args.output/path.parent.name
        target.mkdir()
        result={key:context[key] for key in ('submissionId','attemptId','questionVersion','evaluationVersion','phase')}
        if context['phase']=='opponent':
            context['opponent']['submissionId']='protocol-replay-opponent'
            result['opponentSubmissionId']=context['opponent']['submissionId']
            context['parameters']['calibrationMode']=True
        result.update(contract.completed(context,original))
        for filename,data in [('context.json',context),('result.json',result)]:
            (target/filename).write_text(json.dumps(data,ensure_ascii=False,allow_nan=False),encoding='utf8')
        checked=subprocess.run(['node',str(service/'node_modules/tsx/dist/cli.mjs'),str(ROOT/'tests/validate_result.ts'),
                                str((target/'context.json').resolve()),str((target/'result.json').resolve())],
                               cwd=service,text=True,capture_output=True,check=True,timeout=60)
        entries.append({'original':str(path.resolve()),'phase':context['phase'],'protocolReplay':'passed',
                        'metrics':len(result['metrics'])})
(args.output/'report.json').write_text(json.dumps(entries,indent=2),encoding='utf8')
print(json.dumps({'realResultsReplayed':len(entries),'protocol':'passed'}))

"""Record actual local measurements and validate them with the production parser."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser=argparse.ArgumentParser()
parser.add_argument('--build',type=Path,required=True)
parser.add_argument('--artifacts',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--result-prefix',default='course-v3-media-production')
parser.add_argument('--recheck-prefix')
parser.add_argument('--recheck-ids',default='')
args=parser.parse_args()
source=Path(__file__).resolve().parents[1]
service=source.parents[1]
manifest=json.loads((args.build/'manifest.json').read_text(encoding='utf8'))
report={'schemaVersion':1,'scope':'real local grader and worker processes; production TypeScript result parser',
        'dockerCalibrationStillRequired':True,'questions':[]}
for question in manifest['questions']:
    sid=question['sourceId']
    phases={}
    evidence={}
    prefix=args.recheck_prefix if sid in args.recheck_ids.split(',') else args.result_prefix
    if not prefix: raise ValueError('missing selected result prefix')
    for phase in ('baseline','opponent'):
        directory=(args.artifacts/(prefix+'-'+phase+'-'+sid)).resolve()
        result=json.loads((directory/'result.json').read_text(encoding='utf8'))
        subprocess.run(['node',str(service/'node_modules/tsx/dist/cli.mjs'),
                        str(source.parent/'basic/tests/validate_result.ts'),str(directory/'context.json'),str(directory/'result.json')],
                       cwd=service,capture_output=True,check=True,timeout=60)
        assert result['status']=='completed' and result['metrics']['legalityGate']==1
        phases[phase]=result['metrics']
        evidence[phase]=directory.name
    measured=phases['opponent']['successMetric']
    floor=question['minimumPositiveSuccessThreshold']
    if measured==0 and not (isinstance(floor,(int,float)) and floor>0):
        raise ValueError('zero continuous reference cannot be calibrated automatically')
    package=next(p for p in manifest['packages'] if p['key']==question['packageKey'])
    package_root=Path(package['directory'])
    entry={'id':question['id'],'referenceCodeSha256':question['selfTest']['codeSha256'],
           'sourceProblemSha256':question['sourceProblemSha256'],
           'baselineThreshold':phases['baseline']['qualificationMetric'],
           'successThreshold':measured if measured>0 else floor,
           'minimumPositiveSuccessThreshold':floor,'measurements':phases,'resultEvidence':evidence}
    if (package_root/'evaluation-order.json').is_file():
        entry['privateOrderFileSha256']=hashlib.sha256((package_root/'evaluation-order.json').read_bytes()).hexdigest()
    if question['selfTest'].get('weightFixture'):
        package=next(p for p in manifest['packages'] if p['key']==question['packageKey'])
        with (Path(package['directory'])/question['selfTest']['weightFixture']).open('rb') as stream:
            entry['referenceWeightSha256']=hashlib.file_digest(stream,'sha256').hexdigest()
    report['questions'].append(entry)
report['a11ReferenceCorrection']={'method':'pure JPEG, quality100, 4:4:4; no new attack method',
      'originalQuality85':{'meanSsim':0.8893531387067387,'qualified':False},
      'quality95DefaultSubsampling':{'meanSsim':0.8995605913897048,'qualified':False},
      'quality95Subsampling0':{'meanSsim':0.9139228685637185,'qualified':False},
      'quality100Subsampling0':{'meanSsim':0.9941593166684871,'qualified':True,'successes':0,'samples':48},
      'zeroDoesNotWinThreshold':1/48}
report['runtimeSourceSha256']={path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in
                            [source/'grade.py',source/'adapter.py',source/'bootstrap.py',source/'blind_detection.py',
                             source/'blind_watermark.py',source.parent/'basic/result_contract.py']}
args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({'verifiedQuestions':len(report['questions']),'report':str(args.output)}))

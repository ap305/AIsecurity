"""Nonexecuting builder for eight media roles in four shared immutable packages."""
from __future__ import annotations
import argparse
import ast
import importlib.util
import io
import hashlib
import json
import secrets
from pathlib import Path
import zipfile
import numpy as np

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('course_basic_builder', ROOT.parent / 'basic' / 'build.py')
basic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(basic)
copy_file, files_under, sha, write_json = basic.copy_file, basic.files_under, basic.sha, basic.write_json
PACK_ID = 'V3-261012'


def source_without_cli(path):
    tree = ast.parse(path.read_text(encoding='utf8'))
    tree.body = [node for node in tree.body if not (isinstance(node, ast.If) and '__name__' in ast.unparse(node.test))]
    return ast.unparse(tree) + '\n'


def public_dataset(course, number):
    """Public training code cannot regenerate or load the formal fixed test set."""
    path = course / 'backend' / 'code' / 'dataset.py'
    tree = ast.parse(source_without_cli(path))
    if number == '05':
        excluded = {'_make_background', '_make_object', '_gen_one', 'generate_benchmark', 'load_benchmark'}
        tree.body = [node for node in tree.body if not isinstance(node, ast.FunctionDef) or node.name not in excluded]
        # Cached public train contains no hidden targets. Training implementation
        # still uses the original detector/render/optimization utility functions.
        extra = '''
SPLIT_SIZES = {'attack_train':120,'attack_val':30,'defense_train':160,'defense_val':60,'hidden_test':0}
def load_benchmark(cache_dir='data', **kwargs):
    return _load_benchmark_from_npz(os.path.join(cache_dir,'training.npz'), SPLIT_SIZES)
'''
    elif number == '11':
        tree.body = [node for node in tree.body if not isinstance(node, ast.FunctionDef) or node.name in ('load_npz', 'save_npz')]
        extra = '''
def load_benchmark(cache_dir='data', **kwargs):
    train = load_npz(os.path.join(cache_dir,'train.npz'))
    test = {k: v[::5] for k,v in train.items()}
    return train,test
'''
    elif number == '12':
        # Publish no part of the formal deterministic generator. A changed
        # default seed is insufficient: submissions could call it with 42.
        return '''"""Independent public practice audio; no formal-data generator."""
import os
import numpy as np
SAMPLE_RATE=16000
LABEL_BONAFIDE=0
LABEL_SPOOF=1
def _read(path):
    with np.load(path,allow_pickle=False) as data:
        return {key:data[key] for key in data.files}
def load_benchmark(cache_dir='data', **kwargs):
    return _read(os.path.join(cache_dir,'training.npz')),_read(os.path.join(cache_dir,'validation.npz'))
'''
    else:
        # Exact unwatermarked originals are private grading material even
        # without labels: reconstructing them would erase any watermark.
        return '''"""Independent public practice images; no formal-data generator."""
import os
import numpy as np
DEFAULT_N=48
DEFAULT_SIZE=512
def load_npz(path):
    with np.load(path,allow_pickle=False) as data:
        return {'images':data['images'],'sample_ids':data['sample_ids']}
def save_npz(path,images,sample_ids):
    os.makedirs(os.path.dirname(path) or '.',exist_ok=True)
    np.savez_compressed(path,images=np.asarray(images,dtype=np.uint8),sample_ids=np.asarray(sample_ids))
def load_benchmark(cache_dir='data',n=48,**kwargs):
    data=load_npz(os.path.join(cache_dir,'training.npz'))
    return {key:value[:n] for key,value in data.items()}
def to_samples(dataset):
    return [{'sample_id':str(sid),'image':image} for sid,image in zip(dataset['sample_ids'],dataset['images'])]
'''
    return ast.unparse(tree) + '\n' + extra


LOCAL_RUNTIME = '''from pathlib import Path
import types,sys
class SubmissionError(Exception): pass
class ConfigurationError(Exception): pass
def read_text(path): return Path(path).read_text(encoding='utf8')
def synthesize_role_module(role, blank, backend, **kwargs):
    module=types.ModuleType(role)
    sys.modules[role]=module
    exec(compile(backend,'public_helper','exec'),module.__dict__)
    exec(compile(blank,'student_submission','exec'),module.__dict__)
    return module
'''


def verify_public_assets(courses, directory):
    """Reject accidental re-publication of formal images/audio in derived NPZs."""
    def signatures(path, key):
        with np.load(path,allow_pickle=False) as data:
            values=data[key]
            if not np.isfinite(values).all():
                raise ValueError('nonfinite public sample data')
            return {hashlib.sha256(np.ascontiguousarray(value).tobytes()).digest() for value in values}
    private_images=signatures(courses['A10']/'backend/code/data/synth_images.npz','images')
    public_images=signatures(directory/'media10-training.npz','images')
    private_audio=signatures(courses['A12']/'backend/code/data/synth_cache.npz','audios')
    training_audio=signatures(directory/'media12-training.npz','audios')
    validation_audio=signatures(directory/'media12-validation.npz','audios')
    if (private_images & public_images or private_audio & (training_audio | validation_audio)
            or training_audio & validation_audio):
        raise ValueError('public practice data overlaps formal or validation samples')


def resource_zip(course, number, role, target, public, public_assets=None):
    code = course / 'backend' / 'code'
    changes = [{'action':'exclude-private-test-assets-and-reference-code'},
               {'action':'derive-training-only-dataset-loader','sourceNumber':number}]
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr('judge_runtime.py', LOCAL_RUNTIME)
        archive.writestr('backend/code/dataset.py', public_dataset(course, number))
        archive.write(public / (role + '_helper.py'), 'backend/code/' + role + '-backend.py')
        if number == '05' and role == 'defense':
            # The local defense trainer needs only the three disclosed simple
            # patch generators, never the attack solution or hidden patch.
            tree = ast.parse((code / 'attack-backend.py').read_text(encoding='utf8'))
            classes = [node for node in tree.body if isinstance(node, ast.ClassDef) and
                       node.name in ('RandomNoiseAttack','CheckerboardAttack','GrayPatchAttack')]
            simple = 'from __future__ import annotations\nimport numpy as np\nfrom dataset import init_patch, PATCH_SIZE\n'
            simple += '\n'.join(ast.unparse(node) for node in classes)
            simple += "\nATTACKS={'random_noise':RandomNoiseAttack,'checkerboard':CheckerboardAttack,'gray_patch':GrayPatchAttack}\n"
            archive.writestr('backend/code/attack.py',simple)
        requirements = course / 'requirements.txt'
        if not requirements.exists():
            requirements = code / 'requirements.txt'
        if requirements.exists():
            archive.write(requirements,'requirements.txt')
        for filename in ('blank.py','local_train_media.py','export_weights.py'):
            if (course / 'student' / filename).is_file():
                archive.write(course / 'student' / filename, 'student/' + filename)
        archive.write(course / 'student' / 'blank.py', 'submission/blank.py')
        if number == '05':
            with np.load(code / 'data' / 'benchmark.npz', allow_pickle=False) as data:
                count = 370
                payload = {key: data[key][:count] for key in ('images','boxes','cids','counts')}
                payload['split_sizes'] = np.array([120,30,160,60,0], dtype=np.int64)
                payload['split_names'] = data['split_names']
            buffer = io.BytesIO()
            np.savez_compressed(buffer, **payload)
            archive.writestr('backend/code/data/training.npz', buffer.getvalue())
            changes.append({'path':'data/benchmark.npz','action':'publish-first-370-training-validation-only','hiddenRows':80})
        elif number == '11':
            archive.write(code / 'data' / 'train.npz', 'backend/code/data/train.npz')
            changes.append({'path':'data/test.npz','action':'exclude-formal-test;local-test-derived-from-train'})
        elif number == '12':
            for name in ('training','validation'):
                origin = Path(public_assets) / ('media12-'+name+'.npz')
                archive.write(origin,'backend/code/data/'+name+'.npz')
            changes.append({'path':'data/synth_cache.npz','action':'exclude-entire-mixed-cache-and-generator;publish-independent-prepared-seed1042-data'})
        elif number == '10':
            archive.write(Path(public_assets)/'media10-training.npz','backend/code/data/training.npz')
            changes.append({'path':'data/synth_images.npz','action':'exclude-fixed-images-and-generator;publish-independent-prepared-seed1042-data'})
        archive.writestr('平台本地实验说明.txt', '编辑 submission/blank.py，再运行 student/local_train_media.py。\n'
                         '模型训练只在本地完成。此包不含正式测试数据、隐藏标签或教师答案。\n'
                         '本地自测数据和指标不代表正式评分。\n' + json.dumps(changes, ensure_ascii=False, indent=2))
    return changes


def build(source_root, output, image, reference_weights=None, private_order_seeds=None, practice_cache_root=None):
    source_root, output = Path(source_root), Path(output)
    if output.exists() and any(output.iterdir()):
        raise ValueError('immutable output must be empty')
    output.mkdir(parents=True, exist_ok=True)
    order_seeds = (json.loads(Path(private_order_seeds).read_text(encoding='utf8')) if private_order_seeds
                   else {'MEDIA'+number:secrets.token_hex(32) for number in ('05','10','11','12')})
    if set(order_seeds) != {'MEDIA05','MEDIA10','MEDIA11','MEDIA12'} or any(
            not isinstance(seed,str) or len(seed)!=64 or any(c not in '0123456789abcdef' for c in seed)
            for seed in order_seeds.values()):
        raise ValueError('private order configuration must contain exactly four 256-bit package seeds')
    write_json(output / 'private-order-seeds.json', order_seeds)
    courses = {p.name[:3]:p for p in (source_root / '题目' / '对抗').iterdir() if p.is_dir()}
    public_assets = (Path(practice_cache_root) if practice_cache_root else
                     Path(reference_weights) / 'public-assets' if reference_weights else None)
    if public_assets is None or not all((public_assets/name).is_file() for name in
            ('media10-training.npz','media12-training.npz','media12-validation.npz')):
        raise ValueError('prepare independent media10/media12 public NPZ assets and pass practice_cache_root')
    verify_public_assets(courses,public_assets)
    result = {'schemaVersion':1,'packId':PACK_ID,'packages':[],'questions':[]}
    for number in ('05','10','11','12'):
        key = 'MEDIA' + number
        package = output / 'packages' / key
        public = package / 'public'
        public.mkdir(parents=True)
        course = courses['A' + number]
        for name in ('attack','defense','dataset','test'):
            copy_file(course / 'backend' / 'code' / (name + '.py'), package / 'backend' / 'code' / (name + '.py'))
        for path in files_under(course / 'backend' / 'code' / 'data'):
            copy_file(path, package / 'backend' / 'code' / 'data' / path.relative_to(course / 'backend' / 'code' / 'data'))
        for role in ('attack','defense'):
            src = courses[('A' if role == 'attack' else 'D') + number]
            (public / (role + '_helper.py')).write_text(source_without_cli(src / 'backend' / 'code' / (role + '-backend.py')), encoding='utf8')
            for path in files_under(src / 'backend' / 'weights'):
                if path.suffix == '.pt' and path.name != 'reference_submission.pt':
                    target = package / 'backend' / 'weights' / path.name
                    if target.exists() and sha(target) != sha(path):
                        raise ValueError('paired teacher assets differ')
                    copy_file(path, target)
            copy_file(src / 'problem.json', package / (role + '.json'))
        # Public worker dataset has structures and training-only loaders but no
        # dataset files are mounted in either student worker.
        (public / 'dataset.py').write_text(public_dataset(course, number), encoding='utf8')
        for name in ('basic_codec','basic_adapter','judge_runtime'):
            original = {'basic_codec':'codec.py','basic_adapter':'adapter.py','judge_runtime':'judge_runtime.py'}[name]
            copy_file(ROOT.parent / 'basic' / original, package / (name + '.py'))
            if name != 'basic_adapter':
                copy_file(ROOT.parent / 'basic' / original, public / (name + '.py'))
        copy_file(source_root / '公共后端' / 'checkpoints.py', public / 'checkpoints.py')
        copy_file(source_root / '公共后端' / 'checkpoints.py', package / 'checkpoints.py')
        copy_file(source_root / '公共后端' / 'media_evaluator.py', package / 'media_evaluator.py')
        copy_file(ROOT / 'adapter.py', package / 'media_adapter.py')
        copy_file(ROOT / 'blind_detection.py', package / 'blind_detection.py')
        copy_file(ROOT / 'blind_watermark.py', package / 'blind_watermark.py')
        copy_file(ROOT / 'bootstrap.py', public / 'bootstrap.py')
        copy_file(ROOT / 'grade.py', package / 'grade.py')
        copy_file(ROOT.parent / 'basic' / 'result_contract.py', package / 'result_contract.py')
        write_json(package / 'course.json', {'number':number})
        # Frozen per-package secret is grader-only and deliberately excluded
        # from worker files and every downloadable student resource.
        write_json(package / 'evaluation-order.json', {'seed':order_seeds[key]})
        write_json(public / 'course.json', {'number':number,'symbols':{
            role:json.loads((package / (role + '.json')).read_text(encoding='utf8'))['entry']['symbols']
            for role in ('attack','defense')}})
        env = {'schemaVersion':1,'protocol':'platform-rpc-v1','name':'v3 媒体攻防 ' + number,
               'image':image,'entrypoint':'grade.py','phases':['baseline','opponent'],'network':'none',
               'resources':{'cpus':4,'memoryMb':6144,'pids':256,'timeoutMs':3600000,'tmpMb':512},
               'materials':{'requiresWeights':False,'maxWeightBytes':500*1024*1024,'maxCodeBytes':1048576},
               'rpc':{'maxRequestBytes':134217728,'maxResponseBytes':134217728,'maxArrayBytes':67108864,
                      'maxCalls':50000,'maxObjects':256},
               'worker':{'bootstrap':'public/bootstrap.py','files':['public/' + p.relative_to(public).as_posix() for p in files_under(public)]}}
        write_json(package / 'manifest.json', env)
        (package / 'compose.yaml').write_text('services:\n  evaluator:\n    image: ' + json.dumps(image) + '\n', encoding='utf8')
        for role in ('attack','defense'):
            sid = ('A' if role == 'attack' else 'D') + number
            src = courses[sid]
            problem = json.loads((src / 'problem.json').read_text(encoding='utf8'))
            qid = PACK_ID + '-' + sid
            reference = output / 'references' / (sid + '.py')
            reference.parent.mkdir(exist_ok=True)
            reference_code = source_without_cli(src / 'backend' / 'code' / (role + '.py'))
            if sid == 'A11':
                # Original quality85 reference violates its own SSIM>=0.92
                # qualification. Keep the same JPEG method with quality100;
                # measured qualification must still pass the unchanged gate.
                reference_code += '''
class JPEGReencodeAttack(BaselineJPEGAttack):
    def __init__(self, quality=85, seed=42):
        super().__init__(quality=85, seed=seed)
        self.quality = 100
    def apply(self, image):
        buffer = io.BytesIO()
        to_pil(image).save(buffer, format='JPEG', quality=self.quality, subsampling=0)
        buffer.seek(0)
        return from_pil(Image.open(buffer))
'''
            reference.write_text(reference_code, encoding='utf8')
            test = {'codePath':str(reference.resolve()),'codeSha256':sha(reference)}
            missing = []
            if problem['weights']['required']:
                weight = Path(reference_weights) / (sid + '.pt') if reference_weights else src / 'backend' / 'weights' / 'reference_submission.pt'
                if not weight.is_file():
                    weight = src / 'backend' / 'weights' / 'reference_submission.pt'
                if weight.is_file():
                    fixture = 'fixtures/' + sid + '.pt'
                    copy_file(weight, package / fixture)
                    test['weightFixture'] = fixture
                else:
                    missing.append('selfTest:reference_submission.pt')
            resources_dir = output / 'resources' / qid
            resources_dir.mkdir(parents=True)
            resources = []
            def resource(origin, name):
                target = resources_dir / name
                copy_file(origin,target)
                resources.append({'sourcePath':str(target.resolve()),'filename':name,'sha256':sha(target)})
            resource(src / 'student' / 'blank.py','blank.py')
            resource(src / '题目说明.md','题目说明-原始.md')
            zipped = resources_dir / '学生本地实验包.zip'
            transformations = resource_zip(src,number,role,zipped,public,public_assets)
            resources.append({'sourcePath':str(zipped.resolve()),'filename':zipped.name,'sha256':sha(zipped)})
            content = (src / '题目说明.md').read_text(encoding='utf8')
            for asset in files_under(src / 'assets') if (src / 'assets').exists() else []:
                flat = 'asset-' + asset.name
                resource(asset,flat)
                content = content.replace(asset.relative_to(src).as_posix(),f'/api/questions/{qid}/resources/{flat}')
            prefix = ('> 平台提交：编辑完整 `blank.py`，' + ('上传本地训练导出的 `model.pt`。' if problem['weights']['required'] else '无需模型权重。') +
                      '先通过固定参考基线，之后与实际对手逐个对抗，榜单按击败对手比例计分；等于门槛通过，正常对抗失败计0。原文0–100分用于基线校准诊断。\n\n')
            if number == '05':
                prefix += '> 每个合格目标独立贴片；攻击基线 AttackGain≥0.40 且 HideRate≥0.50。对手阶段目标隐藏且对方未检出为攻击成功；防御检出为成功，干净图误报率须≤0.10。\n\n'
            if sid == 'A11':
                prefix += '> 攻击保真资格保持原要求：合法率≥0.80且平均SSIM≥0.92。平台纯JPEG参考使用quality100、4:4:4以满足原保真门槛，实测0/48次成功；零参考基线不代表对抗获胜，实际对手阶段仍至少成功1/48。参数仅描述参考，学生可自主实现符合保真约束的算法。\n\n'
            if sid == 'D11':
                prefix += '> 实际对手阶段按干净AUC与对该攻击的鲁棒AUC平均值比较正式校准门槛。攻击题的1/48成功样本下限不用于本防御题的AUC比较。\n\n'
            definition = {'kind':'model' if problem['weights']['required'] else 'algorithm',
                          'weights':{'enabled':bool(problem['weights']['required']),'required':bool(problem['weights']['required']),
                                     'extensions':['.pt','.pth'],'maxBytes':500*1024*1024,
                                     'description':json.dumps(problem['weights'],ensure_ascii=False),'device':'cpu',
                                     'loadInterface':'isolated worker checkpoint; /materials/weights.bin'},
                          'teacherApi':{'enabled':False},'llm':{'enabled':False},
                          'evaluation':{'version':'v3-261012-media-rpc-v1','timeoutMs':3600000,'maxScore':100,
                                        'baselineMetric':'qualificationMetric','baselineThreshold':None,
                                        'successMetric':'successMetric','successThreshold':None,'repetitions':1,
                                        'parameters':{'sourceId':sid,'role':role,'legalityMetric':'legalityGate'}}}
            result['questions'].append({'id':qid,'sourceId':sid,'title':problem['title'] + ('（攻击）' if role == 'attack' else '（防御）'),'moduleCode':'AI_MEDIA_V3',
                   'number':int(number),'difficulty':'L3','type':'code','category':'adversarial',
                   'scenarioId':PACK_ID + '-' + number,'role':role,'content':prefix + content,
                   'answerTemplate':(src / 'student' / 'blank.py').read_text(encoding='utf8'),
                   'definition':definition,'packageKey':key,'selfTest':test,'resources':resources,'missingAssets':missing,
                   'resourceTransformations':transformations,'sourceProblemSha256':sha(src / 'problem.json'),
                   'requiresCalibration':True,'calibrationRequired':True,
                   'minimumPositiveSuccessThreshold': {'A05':1/152,'D05':1/152,'A11':1/48,
                        'A10':1/(2*48*48),'D10':1/(4*48*48),'D11':1/(4*48*48),'A12':None,'D12':None}[sid],
                   'zeroReferencePolicy':'reject-calibration-if-zero-continuous' if number == '12' else 'positive-discrete-floor'})
        test_materials = {q['role']:dict(q['selfTest']) for q in result['questions'][-2:]}
        for question in result['questions'][-2:]:
            other_role = 'defense' if question['role'] == 'attack' else 'attack'
            question['selfTest']['opponent'] = test_materials[other_role]
        result['packages'].append({'key':key,'directory':str(package.resolve()),
                  'files':[{'path':p.relative_to(package).as_posix(),'sha256':sha(p)} for p in files_under(package)]})
    write_json(output / 'manifest.json', result)
    write_json(output / 'questions.json', result['questions'])
    return result


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--image',required=True)
    parser.add_argument('--reference-weights')
    parser.add_argument('--private-order-seeds')
    parser.add_argument('--practice-cache-root')
    args=parser.parse_args()
    result=build(args.source,args.output,args.image,args.reference_weights,args.private_order_seeds,args.practice_cache_root)
    print(json.dumps({'questions':len(result['questions']),'packages':len(result['packages']),
                      'missing':{q['sourceId']:q['missingAssets'] for q in result['questions'] if q['missingAssets']}}))

"""Build private ML graders and curated public learning resources."""
from __future__ import annotations
import argparse
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent
MARKER = '# [IMPORTANT] Replace this line with real attack/defense code.'


def sha(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')


def copy(source, target):
    if source.is_symlink() or not source.is_file():
        raise ValueError('Expected a regular source file')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def safe_source(path, replace_slot=False):
    text = path.read_text(encoding='utf-8-sig')
    if replace_slot:
        if text.count(MARKER) != 1:
            raise ValueError('Missing unique course slot')
        text = text.replace(MARKER, '__COURSE_SLOT__ = True')
    tree = ast.parse(text)
    tree.body = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef,
                                                           ast.ClassDef, ast.Assign, ast.AnnAssign))]
    return ast.unparse(tree) + '\n'


def public_dataset(path):
    tree = ast.parse(safe_source(path))
    names = {'images_to_flat', 'images_to_tensor', 'to_image_format', 'make_permutation', 'apply_mapping'}
    tree.body = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign)) or
                 isinstance(n, ast.FunctionDef) and n.name in names]
    return ast.unparse(tree) + '''
def _private_data(*args, **kwargs):
    raise RuntimeError('Grader datasets are private; use the published local practice archive')
load_benchmark = load_npz = save_npz = train_victim_model = _private_data
'''


def filled_source(course, role, number):
    # References contain full reviewed definitions. Original command-line entry
    # blocks are excluded and never executed by self-tests.
    source = safe_source(course / 'backend' / 'code' / (role + '.py'))
    if number == '01' and role == 'defense':
        # Match v3's public interface: use the supplied warmup model; only the
        # trusted fixed trainer retrains the paired classification models.
        tree = ast.parse(source)
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'defend')
        for index, node in enumerate(fn.body):
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'warmup_model' for t in node.targets):
                fn.body[index] = ast.parse('warmup_model = load_warmup_model(num_classes=num_classes, device=device)').body[0]
        fn.body = [n for n in fn.body if not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Call) and
                     isinstance(n.value.func, ast.Name) and n.value.func.id == 'train_model')]
        source = ast.unparse(ast.fix_missing_locations(tree)) + '\n'
    return source


def build(source_root, output, image):
    import numpy as np
    source_root, output = Path(source_root).resolve(), Path(output).resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError('Immutable build output must be empty')
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'schemaVersion': 1, 'packId': 'V3-261012', 'packages': [], 'questions': []}
    courses = source_root / '题目' / '对抗'
    for number in ('01', '04', '06', '07'):
        pair = {role: next(courses.glob(prefix + number + '-*')) for role, prefix in [('attack', 'A'), ('defense', 'D')]}
        package = output / 'packages' / ('ML' + number)
        public = package / 'public'
        teacher = package / 'teacher'
        for src, name in [('runtime.py', 'ml_runtime.py'), ('bridge.py', 'ml_bridge.py'), ('grade.py', 'grade.py')]:
            copy(ROOT / src, package / name)
        copy(ROOT / 'bootstrap.py', public / 'bootstrap.py')
        for destination in (package, public):
            copy(ROOT.parent / 'basic' / 'codec.py', destination / 'course_codec.py')
        for destination in (teacher, public):
            copy(source_root / '公共后端' / 'checkpoints.py', destination / 'checkpoints.py')
            copy(ROOT.parent / 'basic' / 'judge_runtime.py', destination / 'judge_runtime.py')
        source_course = pair['attack']
        code = source_course / 'backend' / 'code'
        dataset_source = public_dataset(code / 'dataset.py')
        write(public / 'dataset.py', dataset_source)
        write(teacher / 'dataset.py', dataset_source)
        symbols = {}
        for role, course in pair.items():
            problem = json.loads((course / 'problem.json').read_text(encoding='utf8'))
            symbols[role] = problem['entry']['symbols']
            write(public / (role + '_backend.py'), safe_source(course / 'backend' / 'code' / (role + '-backend.py'), True))
            reference = filled_source(course, role, number)
            if number == '01' and role == 'defense':
                # Full trusted reference also needs the v3 public warmup loader.
                framework = safe_source(course / 'backend' / 'code' / 'defense-backend.py', True)
                reference = framework.replace('__COURSE_SLOT__ = True', reference.replace('from __future__ import annotations', ''))
            write(teacher / (role + '.py'), reference)
            write(output / 'references' / (problem['id'] + '.py'), reference)
            fixture = course / 'backend' / 'weights' / 'reference_submission.pt'
            if fixture.exists():
                copy(fixture, package / 'fixtures' / (role + '.pt'))
        if number == '01':
            framework = ast.parse(safe_source(pair['defense'] / 'backend' / 'code' / 'defense-backend.py', True))
            keep = {'build_model', '_to_tensor', '_normalize', '_device', 'predict', 'train_model'}
            framework.body = [n for n in framework.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.Assign)) or
                              isinstance(n, ast.FunctionDef) and n.name in keep]
            for destination in (teacher, public):
                write(destination / 'architecture.py', ast.unparse(framework) + '\n')
        write(public / 'course.json', {'number': number, 'symbols': symbols})
        if number == '04':
            import os
            spec = importlib.util.spec_from_file_location('build_dataset04', code / 'dataset.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if not (code / 'data' / 'mnist_cache.npz').is_file():
                raise ValueError('Real MNIST data is required')
            module._load_mnist = module._load_mnist_cache
            bench = module.load_benchmark(cache_dir=str(code / 'data'), seed=42)
            (package / 'data').mkdir(parents=True)
            np.savez_compressed(package / 'data' / 'hidden.npz', **bench['hidden_test'])
            copy(source_course / 'backend' / 'weights' / 'victim.pt', teacher / 'victim.pt')
        else:
            for name in ('train', 'test'):
                copy(code / 'data' / (name + '.npz'), package / 'data' / (name + '.npz'))
            copy(source_course / 'backend' / 'weights' / 'clean.pt', teacher / 'clean.pt')
        # Bind calibration to the exact private data, public frameworks, trusted
        # algorithms, reference checkpoints and adapters, not just problem.json.
        hasher = hashlib.sha256()
        for role, course in pair.items():
            hasher.update((role + '/problem.json\0').encode() + (course / 'problem.json').read_bytes())
        for file in sorted(package.rglob('*')):
            if file.is_file() and '__pycache__' not in file.parts and file.suffix != '.pyc':
                hasher.update(file.relative_to(package).as_posix().encode() + b'\0' + file.read_bytes())
        digest = hasher.hexdigest()
        frozen = {'number': number, 'sourceDigest': digest, 'seed': 42, 'training': number in ('01', '06')}
        write(package / 'frozen.json', frozen)
        with np.load(package / 'data' / ('hidden.npz' if number == '04' else 'test.npz'), allow_pickle=False) as hidden:
            hidden_count = len(hidden['images'])
            eligible_count = int(np.count_nonzero(hidden['labels'] != 0)) if number == '07' else hidden_count
        if hidden_count <= 0 or eligible_count <= 0:
            raise ValueError('Frozen hidden sample counts must be positive')
        worker_files = ['public/' + p.relative_to(public).as_posix() for p in sorted(public.rglob('*')) if p.is_file()]
        timeout = 3600000
        write(package / 'manifest.json', {
            'schemaVersion': 1, 'protocol': 'platform-rpc-v1', 'name': 'v3机器学习对抗' + number,
            'image': image, 'entrypoint': 'grade.py', 'phases': ['baseline', 'opponent'], 'network': 'none',
            'resources': {'cpus': 4, 'memoryMb': 6144, 'pids': 256, 'timeoutMs': timeout, 'tmpMb': 512},
            'materials': {'requiresWeights': False, 'maxWeightBytes': 524288000, 'maxCodeBytes': 1048576},
            'rpc': {'maxRequestBytes': 268435456, 'maxResponseBytes': 268435456, 'maxArrayBytes': 134217728,
                    'maxCalls': 5000, 'maxObjects': 32},
            'worker': {'bootstrap': 'public/bootstrap.py', 'files': worker_files}})
        write(package / 'compose.yaml', 'services:\n  evaluator:\n    image: ' + json.dumps(image) + '\n')
        for role, course in pair.items():
            problem = json.loads((course / 'problem.json').read_text(encoding='utf8'))
            sid, qid = problem['id'], 'V3-261012-' + problem['id']
            required = number == '07' or (number == '04' and role == 'attack') or (number == '01' and role == 'defense')
            resource_dir = output / 'resources' / qid
            resource_dir.mkdir(parents=True)
            archive = resource_dir / '学生本地实验包.zip'
            # Original teacher datasets, hidden labels, solutions and checkpoints
            # are excluded. Local practice is derived only from training inputs.
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
                for name in ('blank.py',):
                    origin = course / 'student' / name
                    if origin.exists():
                        bundle.write(origin, name)
                bundle.write(ROOT / 'local_train.py', 'local_train.py')
                bundle.writestr('course.json', json.dumps({'number': number, 'role': role}))
                if number == '01':
                    bundle.write(public / 'architecture.py', 'architecture.py')
                for actor in ('attack', 'defense'):
                    bundle.writestr(actor + '-backend.py', (public / (actor + '_backend.py')).read_text(encoding='utf8').replace('__COURSE_SLOT__ = True', MARKER))
                # Local dataset loader below never downloads or falls back silently.
                if number == '04':
                    import io
                    buf = io.BytesIO()
                    np.savez_compressed(buf, train_images=bench['victim_train']['images'], train_labels=bench['victim_train']['labels'], query_images=bench['query_pool']['images'])
                    bundle.writestr('data/practice.npz', buf.getvalue())
                    local = dataset_source + '''
def load_benchmark(**kwargs):
    data = np.load('data/practice.npz', allow_pickle=False)
    train = {'images': data['train_images'], 'labels': data['train_labels']}
    return {'victim_train': train, 'query_pool': {'images': data['query_images']},
            'hidden_test': {'images': train['images'][:512], 'labels': train['labels'][:512]}}
'''
                    tree = ast.parse(safe_source(code / 'dataset.py'))
                    local += '\n' + ast.unparse(next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'train_victim_model')) + '\n'
                else:
                    bundle.write(code / 'data' / 'train.npz', 'data/train.npz')
                    local = dataset_source + '''
def load_npz(path):
    data = np.load(path, allow_pickle=False)
    return {'images': data['images'], 'labels': data['labels']}
def save_npz(path, images, labels):
    np.savez_compressed(path, images=images, labels=labels)
def load_benchmark(**kwargs):
    train = load_npz('data/train.npz')
    if train['images'].dtype == np.uint8:
        train['images'] = train['images'].astype(np.float32) / 255.
    return train, {'images': train['images'][:512], 'labels': train['labels'][:512]}
'''
                bundle.writestr('dataset.py', local)
                bundle.writestr('requirements.txt', 'numpy==1.26.4\nscikit-learn==1.6.1\njoblib==1.4.2\ntorch==2.5.1\n')
                bundle.writestr('README-平台适配.txt', '安装requirements后填写blank.py，运行python local_train.py --code blank.py --out model.pt。\n本地测试取自训练集，仅用于调试，不等于正式成绩。正式测试标签和教师模型不在本资料中。\n01/06为授权的固定预算配对重训；04/07为实际对手推理。仅D01、A04、A07、D07需要上传model.pt，其余角色仅交代码。\n')
            template = (course / 'student' / 'blank.py').read_text(encoding='utf8')
            copy(course / 'student' / 'blank.py', resource_dir / 'blank.py')
            reference = output / 'references' / (sid + '.py')
            opponent_id = ('D' if role == 'attack' else 'A') + number
            self_test = {'codePath': reference.relative_to(output).as_posix(), 'codeSha256': sha(reference),
                         'opponent': {'codePath': 'references/' + opponent_id + '.py', 'codeSha256': sha(output / 'references' / (opponent_id + '.py'))}}
            if required:
                self_test['weightFixture'] = 'fixtures/' + role + '.pt'
            other_required = number == '07' or number == '04' and role == 'defense' or number == '01' and role == 'attack'
            if other_required:
                self_test['opponent']['weightFixture'] = 'fixtures/' + ('defense' if role == 'attack' else 'attack') + '.pt'
            policy = ('训练数据和种子42冻结。01：CNN、Adam、2轮、batch128、学习率0.001；06：MLP(256,128)、最多40轮、固定早停。'
                      '对干净、攻击、清洗后三组数据分别用可信实现训练，单次最多1小时、4 CPU、6GB内存；超时不计分。'
                      if number in ('01', '06') else '只做推理：04比较本次学生模型与对手防御后的教师响应一致度及服务保真；07将学生触发器送入对手预处理及模型。')
            prefix = ('> 本平台使用基线准入＋学生对手池胜率。先与官方参考对手评测准入，再对抗学生对手。'
                      '等于门槛通过；正常失败计入分母；无对手得100%；异常不计分。\n\n' + policy + '\n\n' +
                      ('本角色需上传模型权重。' if required else '本角色无需上传模型权重，提交完整填空代码即可。') +
                      '此段说明优先于下方原题包中“仅官方参照/服务器不训练”的旧口径。\n\n')
            if number == '07':
                prefix += ('平台当前触发器接口：mask和pattern均为(1,28,28)，mask为0/1且激活面积为1～25个像素，'
                           'pattern取有限值[0,1]，目标标签固定为0。投毒索引必须唯一且不超过训练样本数的5%，'
                           '返回训练数据仅可在声明的索引应用该触发器并将标签改为0；n_modified与索引数量一致。'
                           '攻击模型的干净准确率相对冻结干净参考下降不得超过3个百分点。'
                           '防御预处理必须保留图像数量、顺序、形状和传入的占位标签，输出像素取有限值[0,1]。'
                           '本段为平台实际接口限制；原文的2×2触发器是参考构型，不限制所有提交的位置或形状。\n\n')
            if number == '06' and role == 'defense':
                prefix += ('平台当前防御接口：输入N个训练样本，返回恰好2N个样本；每个样本形状不变，'
                           '像素取有限值[0,1]。返回标签必须按原标签数组重复拼接两次，即[labels, labels]，'
                           '不得改标签或变更该排列。增强算法可自行设计，原文的平移是参考实现；'
                           '原文中宽泛的清洗或标签纠正建议须以本段实际接口约束为准。\n\n')
            content = (course / '题目说明.md').read_text(encoding='utf8')
            if (course / 'assets').exists():
                for asset in sorted((course / 'assets').rglob('*')):
                    if asset.is_file():
                        name = 'asset-' + asset.relative_to(course / 'assets').as_posix().replace('/', '-')
                        copy(asset, resource_dir / name)
                        content = content.replace(asset.relative_to(course).as_posix(), f'/api/questions/{qid}/resources/{name}')
            positive_floor = (None if number == '04' else
                              1. / eligible_count if role == 'attack' else
                              1. / (eligible_count * hidden_count))
            floor_reason = ('Continuous Jensen-Shannon/fidelity metric has no discrete positive quantum; reject a zero reference until a documented floor is supplied.'
                            if number == '04' else
                            'Conservative positive lower bound from integer hidden-sample counts, not an exact precision step; only applies to an exactly zero reference.')
            manifest['questions'].append({
                'id': qid, 'sourceId': sid, 'title': problem['title'] + (' · 攻击' if role == 'attack' else ' · 防御'),
                'moduleCode': 'AI_SECURITY_V3', 'number': int(number), 'difficulty': 'L3', 'category': 'adversarial',
                'scenarioId': 'V3-261012-ML' + number, 'role': role, 'content': prefix + content,
                'answerTemplate': template, 'packageKey': 'ML' + number, 'selfTest': self_test,
                'definition': {'kind': 'model' if required else 'algorithm',
                    'weights': {'enabled': required, 'required': required, 'extensions': ['.pt', '.pth'], 'maxBytes': 524288000,
                                'description': '按本题公开模型接口导出参数', 'device': 'cpu', 'loadInterface': '/materials/weights.bin'},
                    'teacherApi': {'enabled': False}, 'llm': {'enabled': False},
                    'evaluation': {'version': 'v3-261012-ml-rpc-v1', 'timeoutMs': timeout, 'maxScore': 100,
                                   'baselineMetric': 'qualificationMetric', 'baselineThreshold': 0, 'successMetric': 'successMetric',
                                   'successThreshold': 1, 'repetitions': 1,
                                   **frozen}},
                'resources': [{'sourcePath': p.relative_to(output).as_posix(), 'filename': p.name, 'sha256': sha(p)} for p in sorted(resource_dir.iterdir())],
                'requiresCalibration': True, 'resourceTransformations': ['formal hidden labels and all teacher weights excluded'],
                'minimumPositiveSuccessThreshold': positive_floor, 'minimumPositiveSuccessReason': floor_reason,
                'hiddenSampleCount': hidden_count, 'eligibleSampleCount': eligible_count,
                'legalityGate': 'Invalid contracts are student_error; ordinary legal-behavior gate uses qualificationMetric=-1',
            })
        manifest['packages'].append({'key': 'ML' + number, 'directory': package.relative_to(output).as_posix(),
                                     'files': [{'path': p.relative_to(package).as_posix(), 'sha256': sha(p)} for p in sorted(package.rglob('*')) if p.is_file()]})
    write(output / 'manifest.json', manifest)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    result = build(args.source, args.output, args.image)
    print(json.dumps({'questions': len(result['questions']), 'packages': len(result['packages'])}))

"""Reproducible, nonexecuting builder for the 17 archived basic courses.

Public API: build(source_root, output, image, reference_weights=None) -> manifest.
The output must be empty. It includes packages, private self-test source and
explicit public resources, plus a manifest consumed by the common importer.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import io
import json
import pathlib
import re
import random
import shutil
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
PACK_ID = 'V3-261012'


def sha(path):
    with pathlib.Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def copy_file(source, target):
    if source.is_symlink() or not source.is_file():
        raise ValueError(f'course asset must be a regular file: {source}')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def reference_source(course, problem):
    """Merge reviewed definitions statically; never import archive code to build."""
    refs = problem['reference_modules']
    nodes = []
    for name in refs + ['test']:
        source = (course / 'backend' / 'code' / (name + '.py')).read_text(encoding='utf8')
        tree = ast.parse(source)
        for node in tree.body:
            if isinstance(node, ast.ImportFrom) and node.module in ['__future__'] + refs:
                continue
            if isinstance(node, ast.Import):
                node.names = [item for item in node.names if item.name not in refs]
                if not node.names:
                    continue
            if isinstance(node, ast.If) and '__name__' in ast.unparse(node.test):
                continue
            # Preserve definitions/constants/decorators. Never retain executable
            # top-level loops or eval/test invocations from a teacher CLI.
            if isinstance(node, (ast.Import, ast.ImportFrom, ast.ClassDef, ast.FunctionDef, ast.Assign, ast.AnnAssign)):
                nodes.append(node)
    tree = ast.Module(body=nodes, type_ignores=[])
    return 'from __future__ import annotations\n' + ast.unparse(tree) + '\n'


def gan_teacher_source(course):
    tree = ast.parse((course / 'backend' / 'code' / 'gan.py').read_text(encoding='utf8'))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Discriminator')
    return 'import torch\nimport torch.nn as nn\nIMAGE_SIZE = 28\n' + ast.unparse(cls) + '\n'


def files_under(directory):
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError('course links are forbidden')
        if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
            yield path


def resource_zip(course, target):
    """Derive a local-training bundle; never publish formal test labels.

Author-provided student/ is only a candidate list: several source bundles
contain the same test data as the grader, so those need explicit derivation.
"""
    import csv
    import numpy as np
    source_id = course.name[:3]
    excluded = set()
    replacements = {}
    changes = []
    student = course / 'student'
    pairs = {'B01': ('data/train.csv', 'data/test.csv'),
             'B03': ('data/train.npz', 'data/test.npz'),
             'B05': ('data/rnn_train.npz', 'data/rnn_test.npz'),
             'B12': ('data/AGNews/train.csv', 'data/AGNews/test.csv'),
             'B14': ('data/train.npz', 'data/test.npz'),
             'B15': ('data/train.npz', 'data/test.npz'),
             'B16': ('data/train.npz', 'data/test.npz'),
             'B17': ('data/AGNews/train.csv', 'data/AGNews/test.csv')}
    if source_id in pairs:
        training, testing = pairs[source_id]
        excluded.add(testing)
        if training.endswith('.npz'):
            with np.load(student / training, allow_pickle=False) as data:
                if set(data.files) not in ({'images', 'labels'}, {'sequences', 'labels'}):
                    raise ValueError('unexpected fields in public training NPZ')
                arrays = {key: data[key] for key in data.files}
                if any(array.dtype.kind not in 'biuf' for array in arrays.values()):
                    raise ValueError('public training NPZ must contain numerical data only')
                selection = np.arange(0, len(arrays['labels']), 5)[:1000]
                buffer = io.BytesIO()
                np.savez_compressed(buffer, **{key: value[selection] for key, value in arrays.items()})
                replacements[testing] = buffer.getvalue()
        else:
            with (student / training).open(encoding='utf8', newline='') as stream:
                rows = list(csv.reader(stream))
            buffer = io.StringIO(newline='')
            csv.writer(buffer).writerows([rows[0]] + rows[1::5][:1000])
            replacements[testing] = buffer.getvalue().encode('utf8')
        changes.append({'path': testing, 'action': 'replace-formal-test-with-training-subset', 'source': training})
    if source_id == 'B05':
        excluded.add('data/sequence_dataset.csv')
        changes.append({'path': 'data/sequence_dataset.csv', 'action': 'exclude-mixed-training-test-source'})
    if source_id == 'B06':
        relative = 'data/tiny_shakespeare.txt'
        text = (student / relative).read_text(encoding='utf8')[:300000]
        blocks = [text[i:i + 1000] for i in range(0, len(text), 1000) if len(text[i:i + 1000]) >= 101]
        random.Random(42).shuffle(blocks)
        replacements[relative] = ''.join(blocks[:int(len(blocks) * .9)]).encode('utf8')
        excluded.add(relative)
        changes.append({'path': relative, 'action': 'retain-original-training-blocks-only', 'seed': 42, 'blockSize': 1000})
    if source_id == 'B11':
        import torch
        relative = 'data/Cora/cora.npz'
        with np.load(student / relative, allow_pickle=False) as data:
            if set(data.files) != {'x', 'adj', 'y'}:
                raise ValueError('unexpected Cora cache fields')
            arrays = {key: data[key] for key in data.files}
        generator = torch.Generator().manual_seed(42)
        indices = torch.randperm(len(arrays['y']), generator=generator).numpy()
        mask = np.zeros(len(indices), dtype=np.bool_)
        mask[indices[:int(len(indices) * .6)]] = True
        arrays['y'] = np.where(mask, arrays['y'], 0)
        buffer = io.BytesIO()
        np.savez_compressed(buffer, **arrays, label_mask=mask)
        replacements[relative] = buffer.getvalue()
        excluded.update({relative, 'data/Cora/cora/cora.content'})
        changes.append({'path': relative, 'action': 'retain-training-labels-only', 'mask': 'label_mask', 'seed': 42})
        changes.append({'path': 'data/Cora/cora/cora.content', 'action': 'exclude-all-node-label-source'})
    notice = ('平台本地实验资料\n\n正式评分测试集、测试标签和后台参考答案未公开。\n'
              '本包 test 命名文件是从训练集抽取的本地自测数据，其指标不代表平台正式评分。\n'
              'GCN仅label_mask为真的训练节点含有效标签，其余标签为占位0；本地validation/test指标不具评分意义。\n'
              'LSTM只提供原正式划分的训练文本块，可在本地再划分验证。\n\n' +
              json.dumps(changes, ensure_ascii=False, indent=2) + '\n')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for source in files_under(student):
            relative = source.relative_to(student).as_posix()
            if relative not in excluded:
                archive.write(source, relative)
        for relative, content in replacements.items():
            archive.writestr(relative, content)
        if changes:
            archive.writestr('平台资料与数据划分说明.txt', notice)
        requirement = course / 'requirements.txt'
        if requirement.is_file():
            archive.write(requirement, 'requirements.txt')
    return changes


def build(source_root, output, image, reference_weights=None):
    source_root, output = pathlib.Path(source_root), pathlib.Path(output)
    reference_weights = pathlib.Path(reference_weights) if reference_weights else None
    if output.exists() and any(output.iterdir()):
        raise ValueError('build output must be empty; immutable packages cannot be overwritten')
    output.mkdir(parents=True, exist_ok=True)
    courses = sorted((source_root / '题目' / '基础').iterdir())
    if {p.name[:3] for p in courses if p.is_dir()} != {f'B{i:02}' for i in range(1, 18)}:
        raise ValueError('source must contain exactly the 17 declared basic courses')
    manifest = {'schemaVersion': 1, 'packId': PACK_ID, 'packages': [], 'questions': []}
    shared = source_root / '公共后端'
    for course in courses:
        if not course.is_dir():
            continue
        problem = json.loads((course / 'problem.json').read_text(encoding='utf8'))
        source_id = problem['id']
        question_id = f'{PACK_ID}-{source_id}'
        package = output / 'packages' / source_id
        public = package / 'public'
        public.mkdir(parents=True)
        for origin, name in [('codec.py', 'basic_codec.py'), ('adapter.py', 'basic_adapter.py'),
                             ('grade.py', 'grade.py'), ('judge_runtime.py', 'judge_runtime.py'),
                             ('result_contract.py', 'result_contract.py')]:
            copy_file(ROOT / origin, package / name)
        for origin, name in [('codec.py', 'basic_codec.py'), ('bootstrap.py', 'bootstrap.py'),
                             ('judge_runtime.py', 'judge_runtime.py')]:
            copy_file(ROOT / origin, public / name)
        copy_file(shared / 'checkpoints.py', public / 'checkpoints.py')
        copy_file(shared / 'basic_evaluator.py', package / 'basic_evaluator.py')
        copy_file(course / 'student' / 'dataset.py', public / 'dataset.py')
        write_json(public / 'course.json', {'id': source_id})
        write_json(package / 'problem.json', problem)
        # Private grader sources: original dataset and named reference models.
        for name in ['dataset'] + problem['reference_modules']:
            copy_file(course / 'backend' / 'code' / (name + '.py'), package / 'backend' / 'code' / (name + '.py'))
        data = course / 'backend' / 'code' / 'data'
        if data.exists():
            for file in files_under(data):
                # Offline normalized caches are already included; openml download
                # caches are redundant and are never a fallback during grading.
                if 'openml' not in file.relative_to(data).parts:
                    copy_file(file, package / 'backend' / 'code' / 'data' / file.relative_to(data))
        missing = []
        for relative in problem.get('teacher_assets', []):
            origin = course / relative
            if origin.is_file():
                copy_file(origin, package / relative)
                if source_id == 'B17':
                    copy_file(origin, public / 'bert' / origin.name)
            else:
                missing.append(relative)
        if source_id == 'B08':
            (public / 'gan_teacher.py').write_text(gan_teacher_source(course), encoding='utf8')
        reference = output / 'references' / (source_id + '.py')
        reference.parent.mkdir(exist_ok=True)
        reference.write_text(reference_source(course, problem), encoding='utf8')
        self_test = {'codePath': str(reference.resolve()), 'codeSha256': sha(reference)}
        if problem['weights']['required']:
            supplied = reference_weights / (source_id + '.pt') if reference_weights else None
            original = course / 'backend' / 'weights' / 'reference_submission.pt'
            weight = supplied if supplied and supplied.is_file() else original
            if weight.is_file():
                copy_file(weight, package / 'fixtures' / 'reference.pt')
                self_test['weightFixture'] = 'fixtures/reference.pt'
            else:
                missing.append('selfTest:reference_submission.pt')
        worker_files = ['public/' + file.relative_to(public).as_posix() for file in files_under(public)]
        environment = {
            'schemaVersion': 1, 'protocol': 'platform-rpc-v1', 'name': problem['title'] + ' · v3基础实验',
            'image': image, 'entrypoint': 'grade.py', 'phases': ['basic'], 'network': 'none',
            'resources': {'cpus': 4, 'memoryMb': 6144 if source_id in ('B04', 'B11', 'B17') else 4096,
                          'pids': 256, 'timeoutMs': 3600000, 'tmpMb': 512},
            'materials': {'requiresWeights': bool(problem['weights']['required']),
                          'maxWeightBytes': 500 * 1024 * 1024, 'maxCodeBytes': 1048576},
            'rpc': {'maxRequestBytes': 134217728, 'maxResponseBytes': 134217728, 'maxArrayBytes': 67108864,
                    'maxCalls': 50000, 'maxObjects': 128},
            'worker': {'bootstrap': 'public/bootstrap.py', 'files': worker_files},
        }
        write_json(package / 'manifest.json', environment)
        (package / 'compose.yaml').write_text('services:\n  evaluator:\n    image: ' + json.dumps(image) + '\n', encoding='utf8')
        resources_dir = output / 'resources' / question_id
        resources_dir.mkdir(parents=True)
        resources = []
        def resource(origin, filename):
            target = resources_dir / filename
            copy_file(origin, target)
            resources.append({'sourcePath': str(target.resolve()), 'filename': filename, 'sha256': sha(target)})
        resource(course / 'student' / 'student.py', 'student.py')
        resource(course / '题目说明.md', '题目说明-原始.md')
        zip_path = resources_dir / '学生本地实验包.zip'
        resource_changes = resource_zip(course, zip_path)
        resources.append({'sourcePath': str(zip_path.resolve()), 'filename': zip_path.name, 'sha256': sha(zip_path)})
        content = (course / '题目说明.md').read_text(encoding='utf8')
        for asset in files_under(course / 'assets') if (course / 'assets').exists() else []:
            flat = 'asset-' + asset.name
            resource(asset, flat)
            content = content.replace(asset.relative_to(course).as_posix(), f'/api/questions/{question_id}/resources/{flat}')
        prefix = ('> 平台提交方式：在线编辑完整 `student.py`，' +
                  ('上传本地训练后导出的 `model.pt`。' if problem['weights']['required'] else '本题无需上传模型参数。') +
                  '平台独立隔离运行学生代码，按本页0–100分口径执行推理/数值评测；训练在本地完成。\n\n')
        definition = {'kind': 'model' if problem['weights']['required'] else 'algorithm',
                      'weights': {'enabled': bool(problem['weights']['required']), 'required': bool(problem['weights']['required']),
                                  'extensions': ['.pt', '.pth'], 'maxBytes': 500 * 1024 * 1024,
                                  'description': json.dumps(problem['weights'], ensure_ascii=False),
                                  'device': 'cpu', 'loadInterface': 'strict=True state_dict; /materials/weights.bin'},
                      'teacherApi': {'enabled': False}, 'llm': {'enabled': False},
                      'evaluation': {'version': 'v3-261012-basic-rpc-v1', 'timeoutMs': 3600000, 'maxScore': 100,
                                     'baselineMetric': 'qualificationMetric', 'baselineThreshold': 0,
                                     'successMetric': 'successMetric', 'successThreshold': 0.5, 'repetitions': 1,
                                     'parameters': {'sourceId': source_id}}}
        manifest['questions'].append({
            'id': question_id, 'sourceId': source_id, 'title': problem['title'], 'moduleCode': 'AI_BASIC_V3',
            'number': int(source_id[1:]), 'difficulty': 'L2', 'type': 'code', 'category': 'basic', 'scenarioId': None,
            'role': None, 'content': prefix + content,
            'answerTemplate': (course / 'student' / 'student.py').read_text(encoding='utf8'),
            'definition': definition, 'packageKey': source_id, 'selfTest': self_test, 'resources': resources,
            'missingAssets': missing, 'sourceProblemSha256': sha(course / 'problem.json'),
            'resourceTransformations': resource_changes,
        })
        files = [{'path': file.relative_to(package).as_posix(), 'sha256': sha(file)} for file in files_under(package)]
        manifest['packages'].append({'key': source_id, 'directory': str(package.resolve()), 'files': files})
    write_json(output / 'manifest.json', manifest)
    write_json(output / 'questions.json', manifest['questions'])
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--reference-weights')
    args = parser.parse_args()
    result = build(args.source, args.output, args.image, args.reference_weights)
    print(json.dumps({'questions': len(result['questions']), 'packages': len(result['packages']),
                      'missing': {q['id']: q['missingAssets'] for q in result['questions'] if q['missingAssets']}}, ensure_ascii=False))

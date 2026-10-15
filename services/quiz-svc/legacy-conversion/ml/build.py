#!/usr/bin/env python
"""Reproducibly build six isolated evaluation packages and the twelve course question records."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import pathlib
import shutil

from catalog import SCENARIOS, default_roles
from runtime.patch_runtime import PATCH_EXECUTION_PROFILE

ROOT = pathlib.Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf8')


def public_dataset(source, scenario):
    """Retain only the public tensor/model/rendering API; no loader or hidden-data generator."""
    allowed = {'_TinyNet', 'TinyDetector', 'sample_params', 'render_patch_torch', 'render_patch',
               'init_patch', 'AttackEnv', 'to_image_format'} if scenario == 'patch_attack' else set()
    tree = ast.parse(source)
    nodes = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign)):
            nodes.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in allowed:
            nodes.append(node)
    module = ast.Module(body=nodes, type_ignores=[])
    # Selected assignment lists/dicts contain constants only in these original datasets.
    code = ast.unparse(module)
    disabled = ['load_benchmark', 'load_npz', 'save_npz', 'build_detector', 'save_patch', 'load_patch']
    code += '\n\ndef _grader_owned_data(*args, **kwargs):\n    raise RuntimeError("training inputs are supplied by the grader; hidden assets are unavailable")\n'
    code += '\n'.join(f'{name} = _grader_owned_data' for name in disabled) + '\n'
    return code


def public_backend(source):
    """Remove CLI blocks, retaining original public helper names including underscore helpers."""
    tree = ast.parse(source)
    tree.body = [node for node in tree.body if not (isinstance(node, ast.If) and '__name__' in ast.unparse(node.test))]
    return ast.unparse(tree) + '\n'


def enforce_pretrained(source):
    """The original helper silently falls back to random weights; migration fails closed."""
    tree = ast.parse(source)
    for index, node in enumerate(tree.body):
        if isinstance(node, ast.FunctionDef) and node.name == '_build_resnet18':
            replacement = '''def _build_resnet18(pretrained=True):
    import torchvision
    if not pretrained:
        raise RuntimeError('official reference requires ImageNet pretrained ResNet18')
    net = torchvision.models.resnet18(weights=torchvision.models.ResNet18_Weights.IMAGENET1K_V1)
    net.fc = nn.Linear(net.fc.in_features, 1)
    return net
'''
            tree.body[index] = ast.parse(replacement).body[0]
    return ast.unparse(tree) + '\n'


def extract_reference(source, symbols):
    tree = ast.parse(source)
    selected = [ast.get_source_segment(source, node) for node in tree.body
                if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in symbols]
    if len(selected) != len(symbols):
        raise ValueError(f'missing reference symbols: {symbols}')
    return '\n\n'.join(selected) + '\n'


def asset_directory(root, scenario):
    options = [root / scenario / 'v2' / 'code' / 'data', root / scenario / 'data', root / scenario]
    return next((path for path in options if path.is_dir()), options[0])


def build(asset_root, output, image, policy=None, allow_missing_assets=False):
    if output.exists() and any(output.iterdir()):
        raise ValueError('output must be a new or empty directory; never overwrite an installed package')
    output.mkdir(parents=True, exist_ok=True)
    policy = policy or {}
    all_questions, manifest_index = [], []
    for scenario, spec in SCENARIOS.items():
        source = ROOT / 'sources' / scenario
        package = output / 'packages' / scenario
        public = package / 'public'
        public.mkdir(parents=True)
        (package / 'data').mkdir()
        source_hashes = {file.name: digest(file) for file in sorted(source.iterdir()) if file.is_file()}
        source_digest = hashlib.sha256(json.dumps(source_hashes, sort_keys=True).encode()).hexdigest()
        for original, target in [('attack.py', 'attack.py'), ('defense.py', 'defense.py'),
                                 ('dataset.py', 'dataset.py'), ('test.py', 'original_test.py')]:
            code = (source / original).read_text(encoding='utf8')
            if scenario == 'patch_attack' and original == 'defense.py':
                code = enforce_pretrained(code)
            (package / target).write_text(code, encoding='utf8')
        for file in (ROOT / 'runtime').glob('*.py'):
            if file.name == 'patch_runtime.py' and scenario != 'patch_attack':
                continue
            if file.name != 'bootstrap.py':
                shutil.copyfile(file, package / file.name)
        shutil.copyfile(ROOT / 'runtime' / 'bootstrap.py', public / 'bootstrap.py')
        if scenario == 'patch_attack':
            shutil.copyfile(ROOT / 'runtime' / 'patch_runtime.py', public / 'patch_runtime.py')
        (public / 'dataset.py').write_text(public_dataset((source / 'dataset.py').read_text(encoding='utf8'), scenario), encoding='utf8')
        for role in ('attack', 'defense'):
            code = public_backend((source / (role + '-backend.py')).read_text(encoding='utf8'))
            if scenario == 'patch_attack' and role == 'defense':
                code = enforce_pretrained(code)
            (public / (role + '_helpers.py')).write_text(code, encoding='utf8')
        write_json(public / 'course.json', {'scenario': scenario})
        assets, missing = {}, []
        directory = asset_directory(asset_root, scenario)
        for name in spec['data']:
            origin = directory / name
            if not origin.is_file():
                if not allow_missing_assets:
                    raise FileNotFoundError(f'fixed course asset missing: {origin}')
                missing.append(name)
                continue
            shutil.copyfile(origin, package / 'data' / name)
            assets[name] = {'sha256': digest(origin), 'bytes': origin.stat().st_size}
            if scenario == 'patch_attack' and name == 'detector.pt':
                shutil.copyfile(origin, public / name)
        roles = default_roles(scenario)
        measured = policy.get(scenario, {})
        for role in ('attack', 'defense'):
            for stage in ('qualification', 'success'):
                update = measured.get(role, {}).get(stage)
                if update is None:
                    continue
                current = roles[role][stage]
                if update.get('metric') != current['metric']:
                    raise ValueError(f'{scenario}/{role}/{stage}: calibrated metric differs from source contract')
                if current['threshold'] is not None and update.get('threshold') != current['threshold']:
                    raise ValueError(f'{scenario}/{role}/{stage}: explicit course threshold cannot be replaced')
                value = update.get('threshold')
                if not isinstance(value, (int, float)) or not __import__('math').isfinite(value):
                    raise ValueError('calibration threshold must be finite')
                current.update(update)
        provenance = {'source': 'server managed/v2', 'sourceDigest': source_digest, 'sourceFiles': source_hashes,
                      'assets': assets, 'missingAssets': missing, 'seed': 42, 'image': image,
                      'changes': ['isolated student/opponent RPC', 'explicit no-fallback assets',
                                  'audio disjoint train/test cache', 'independent poison/trigger validation',
                                  'published >= threshold policy', 'pair-only dynamic opponent scoring']}
        if scenario == 'patch_attack':
            provenance['changes'].append('independent paired evaluation of every eligible detection target')
            provenance['changes'].append('fixed deterministic single-thread Torch CPU execution in grader and workers')
            provenance['detectionProtocol'] = 'each-eligible-target-independent-v2'
            provenance['executionProfile'] = PATCH_EXECUTION_PROFILE.copy()
        config = {'scenario': scenario, 'roles': roles, 'provenance': provenance}
        write_json(package / 'course.json', config)
        worker_files = ['public/' + file.name for file in sorted(public.iterdir()) if file.is_file()]
        manifest = {'schemaVersion': 1, 'protocol': 'platform-rpc-v1', 'name': spec['title'] + ' · 原课程v2迁移',
                    'image': image, 'entrypoint': 'grade.py', 'phases': ['baseline', 'opponent'], 'network': 'none',
                    'resources': {'cpus': 4, 'memoryMb': 4096 if scenario == 'patch_attack' else 2048,
                                  'pids': 256, 'timeoutMs': 1200000, 'tmpMb': 512},
                    'materials': {'requiresWeights': False, 'maxCodeBytes': 1048576, 'maxWeightBytes': 1048576},
                    'rpc': {'maxRequestBytes': 134217728, 'maxResponseBytes': 134217728},
                    'worker': {'bootstrap': 'public/bootstrap.py', 'files': worker_files}}
        write_json(package / 'manifest.json', manifest)
        (package / 'compose.yaml').write_text('services:\n  evaluator:\n    image: ' + json.dumps(image) + '\n', encoding='utf8')
        manifest_index.append({'scenarioId': scenario, 'packageDirectory': str(package.resolve()),
                               'sourceDigest': source_digest, 'missingAssets': missing})
        reference_dir = output / 'references' / scenario
        reference_dir.mkdir(parents=True)
        for index, role in enumerate(('attack', 'defense')):
            symbols = spec['slots'][index]
            reference = extract_reference((source / (role + '.py')).read_text(encoding='utf8'), symbols)
            ref_path = reference_dir / (role + '.py')
            ref_path.write_text(reference, encoding='utf8')
            template = (source / (role + '-blank.py')).read_text(encoding='utf8')
            rule = roles[role]
            calibration = {'baseline': 'fixed' if spec['roles'][role]['qualification'][1] is not None else 'reference',
                           'opponent': 'fixed' if spec['roles'][role]['success'][1] is not None else 'reference'}
            if calibration['baseline'] == 'fixed':
                calibration['baselineThreshold'] = rule['qualification']['threshold']
            if calibration['opponent'] == 'fixed':
                calibration['successThreshold'] = rule['success']['threshold']
            required = any(rule[phase]['threshold'] is None for phase in ('qualification', 'success'))
            title = spec['title'] + (' · 攻击' if role == 'attack' else ' · 防御')
            content = '# ' + title + '\n\n' + spec['summary'] + '\n\n' + spec['roles'][role]['rules']
            content += '\n\n## 提交接口\n\n填写下面原v2接口；np与原公开backend工具已提供，无需访问评测数据文件。\n\n```python\n' + template + '\n```\n'
            content += '\n## 计分\n\n通过固定基线资格后进入对应角色算法池。每次仅与指定有效对手对抗；正常失败计入分母，无对手按100%。资格与对抗比较均包含等于。'
            content += '\n\n<!-- FROZEN_COURSE_THRESHOLDS -->'
            definition = {'kind': 'algorithm', 'role': role, 'scenarioId': scenario,
                          'weights': {'enabled': False, 'required': False, 'extensions': ['.bin'], 'maxBytes': 1048576, 'description': ''},
                          'teacherApi': {'enabled': False}, 'llm': {'enabled': False},
                          'evaluation': {'version': 'course-v2-rpc-patch-target-cpu1-v3' if scenario == 'patch_attack' else 'course-v2-rpc-v1', 'timeoutMs': 1200000, 'maxScore': 100,
                                         'baselineMetric': 'qualificationMetric', 'baselineThreshold': rule['qualification']['threshold'],
                                         'successMetric': 'successMetric', 'successThreshold': rule['success']['threshold'],
                                         'repetitions': 1, 'parameters': {'scenario': scenario, 'seed': 42}}}
            all_questions.append({'questionId': spec['ids'][index], 'scenarioId': scenario, 'role': role,
                                  'category': 'adversarial', 'title': title, 'content': content,
                                  'thresholdContentPlaceholder': '<!-- FROZEN_COURSE_THRESHOLDS -->',
                                  'answerTemplate': template, 'solution': reference, 'definition': definition,
                                  'packageDirectory': str(package.resolve()), 'referenceCodePath': str(ref_path.resolve()),
                                  'calibrationRequired': required, 'calibration': calibration,
                                  'metrics': {'qualification': rule['qualification']['metric'], 'success': rule['success']['metric']},
                                  'policy': rule, 'provenance': provenance, 'publishable': not required and not missing})
    write_json(output / 'questions.json', all_questions)
    write_json(output / 'packages.json', manifest_index)
    return all_questions


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--asset-root', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--policy', type=pathlib.Path)
    parser.add_argument('--allow-missing-assets', action='store_true', help='source inspection only: generated records are not publishable')
    args = parser.parse_args()
    rules = json.loads(args.policy.read_text(encoding='utf8')) if args.policy else None
    questions = build(args.asset_root, args.output, args.image, rules, args.allow_missing_assets)
    print(json.dumps({'questions': len(questions), 'publishable': sum(q['publishable'] for q in questions),
                      'questionsFile': str((args.output / 'questions.json').resolve())}))

"""Immutable privacy/recommendation packs with audited public data derivation.

build(source_root, output, image) returns an importer manifest fragment. The
MF pair 31 uses the explicitly authorized, bounded trusted pair training.
No submitted or reference solution is executed during package construction.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import io
import json
from pathlib import Path
import secrets
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent
NUMBERS = ('23', '24', '25', '26', '30', '31')
MARKER = '# [IMPORTANT] Replace this line with real attack/defense code.'


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def copy(source, target):
    if not source.is_file() or source.is_symlink():
        raise ValueError('asset must be a regular file: ' + str(source))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def files_under(path):
    for file in sorted(path.rglob('*')):
        if file.is_symlink():
            raise ValueError('asset links are forbidden')
        if file.is_file() and '__pycache__' not in file.parts and file.suffix != '.pyc':
            yield file


def skeleton(path):
    source = path.read_text(encoding='utf-8-sig')
    if source.count(MARKER) != 1:
        raise ValueError('expected one submission slot: ' + str(path))
    tree = ast.parse(source.replace(MARKER, '__COURSE_SLOT__ = None'))
    tree.body = [node for node in tree.body if not (isinstance(node, ast.If) and '__name__' in ast.unparse(node.test))]
    return ast.unparse(tree) + '\n'


def private_ordering(data, number, rng):
    """Freeze a private row order while preserving samples and their true labels."""
    import numpy as np
    data = {key: value.copy() for key, value in data.items()}
    if number == '23':
        order = rng.permutation(len(data['candidate_membership']))
        for key in ('candidate_images', 'candidate_labels', 'candidate_membership'):
            data[key] = data[key][order]
    elif number == '26':
        order = rng.permutation(len(data['release_train']))
        inverse = np.empty_like(order)
        inverse[order] = np.arange(len(order))
        target_order = rng.permutation(len(data['target_true_index']))
        data['release_train'] = data['release_train'][order]
        data['target_true_index'] = inverse[data['target_true_index'][target_order]].astype(np.int32)
    else:
        raise ValueError('unsupported private ordering')
    return data


def practice24_selection(data):
    import numpy as np
    clients = data['client_0']
    picked = clients[np.random.RandomState(42).choice(len(clients), size=8, replace=False)]
    private = {data['train_images'][i].tobytes() for i in picked}
    safe = [i for i, image in enumerate(data['train_images']) if image.tobytes() not in private]
    if len(safe) < 20:
        raise ValueError('insufficient independent public practice data')
    return np.random.default_rng(10424).permutation(np.asarray(safe))[:len(safe) // 2]


def public_dataset(course, number):
    """Publish local loaders and schemas, never formal split generators/seeds."""
    source = (course / 'backend' / 'code' / 'dataset.py').read_text(encoding='utf8')
    if number not in ('23', '24', '25', '26'):
        return source
    tree = ast.parse(source)
    if number == '23':
        functions = {'to_image_format', '_unpack'}
        constants = set()
        prefix = 'import os\nimport numpy as np\nCACHE_DIR = "data"\nCACHE_NAME = "mnist_splits.npz"\n'
        loader = '''
def load_benchmark(cache_dir=CACHE_DIR, seed=None, use_cache=True, label_noise=None):
    """Load the bundled local practice splits; formal memberships are private."""
    filename = os.path.join(cache_dir, CACHE_NAME)
    if not os.path.isfile(filename):
        raise FileNotFoundError('Local practice cache missing; extract the complete student bundle')
    with np.load(filename, allow_pickle=False) as data:
        return _unpack(data)
'''
    elif number == '24':
        import numpy as np
        with np.load(next((course / 'backend' / 'code' / 'data').glob('*.npz')), allow_pickle=False) as original:
            local_count = len(practice24_selection(original))
        functions = {'_to_uint8_images', '_to_float_tensor', 'normalize', 'denormalize', 'local_batch_order', 'sample_attack_batch'}
        constants = {'MNIST_MEAN', 'MNIST_STD', 'IMG_SIZE', 'N_CLIENTS'}
        prefix = ('import os\nimport numpy as np\nDEFAULT_SEED = 10424\n'
                  'CACHE_DIR = "data"\nCACHE_NAME = "mnist_fl.npz"\nN_TRAIN = ' + str(local_count) + '\n')
        loader = '''
def load_benchmark(cache_dir=CACHE_DIR, seed=None, n_clients=None, use_cache=True):
    """Read only the bundled independent local clients, never formal targets."""
    with np.load(os.path.join(cache_dir, CACHE_NAME), allow_pickle=False) as data:
        count = int(data['n_clients'])
        return {**{key: data[key].copy() for key in ('train_images', 'train_labels', 'test_images', 'test_labels')},
                'client_indices': [data['client_' + str(i)].astype(np.int64) for i in range(count)],
                'n_clients': count, 'seed': DEFAULT_SEED, 'source': 'local-practice-only', 'load_seconds': 0.0}
'''
    elif number == '25':
        functions = {'class_names', '_channel_shape', '_as_float_images', 'normalize', 'denormalize', 'to_tensor'}
        constants = {'CIFAR_MEAN', 'CIFAR_STD', 'N_CLASSES', 'IMG_SIZE', 'N_CHANNELS', 'CLASS_NAMES'}
        prefix = 'import os\nimport numpy as np\nCACHE_DIR = "data"\nCACHE_NAME = "cifar10_subset.npz"\n'
        loader = '''
def load_benchmark(cache_dir=CACHE_DIR, seed=None, n_train=None, n_test=None, forget_ratio=None, use_cache=True, allow_download=False):
    """Read local training and practice validation data; no official downloads."""
    with np.load(os.path.join(cache_dir, CACHE_NAME), allow_pickle=False) as data:
        result = {key: data[key].copy() for key in ('x_train', 'y_train', 'x_test', 'y_test', 'forget_index')}
    mask = np.zeros(len(result['x_train']), dtype=bool)
    mask[result['forget_index']] = True
    result.update(forget_mask=mask, retain_index=np.flatnonzero(~mask), seed=10425,
                  meta={'source': 'local-practice-only', 'n_train': len(mask), 'n_test': len(result['x_test'])})
    return result
'''
    else:
        functions = {'normalize_cell', '_as_str_frame', 'as_str_matrix', 'missing_rate', 'positive_rate',
                     'resolve_cache_dir', 'cache_path', 'read_npz', '_bench_from_npz', 'to_str_num', '_num_token',
                     '_to_float', 'format_interval', 'format_valueset', 'parse_cell', 'interval_midpoint', 'enc_feature_names'}
        constants = {'COLUMNS', 'NUMERIC_COLUMNS', 'CATEGORICAL_COLUMNS', 'LABEL', 'LABEL_POSITIVE', 'LABEL_NEGATIVE',
                     'QI_PRIMARY', 'QI_EXTENDED', 'SENSITIVE', 'DEFENSE_DIMS', 'MODEL_FEATURES', 'TARGET_COLUMNS',
                     'MODULE_DIR', 'DEFAULT_CACHE_DIR', 'CACHE_FILENAME', 'MISSING', '_MISSING_TOKENS'}
        prefix = 'from __future__ import annotations\nimport os\nimport json\nimport math\nimport re\nimport numpy as np\nimport pandas as pd\n'
        loader = '''
def load_benchmark(allow_download=False, cache_dir=None, seed=None, verbose=False):
    """Load an independent local table; formal row mappings are not distributed."""
    data = read_npz(cache_path(cache_dir))
    if data is None:
        raise FileNotFoundError('Local practice cache missing; extract the complete student bundle')
    return _bench_from_npz(data, cache_dir)
'''
    kept = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in functions:
            kept.append(node)
        elif isinstance(node, ast.ClassDef) and number == '26' and node.name == 'AdultEncoder':
            kept.append(node)
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in constants:
            kept.append(node)
    tree.body = kept
    return '# Public local-practice interfaces only. Formal split construction is private.\n' + prefix + ast.unparse(tree) + '\n' + loader


def local_training_data(course, number):
    """Derived local practice data never contain the formal hidden test labels."""
    import numpy as np
    source = next((course / 'backend' / 'code' / 'data').glob('*.npz'))
    with np.load(source, allow_pickle=False) as original:
        if number in ('30', '31'):
            # Original item titles are pickled object arrays. Only the numeric
            # ratings are needed; local display labels are explicit placeholders.
            ratings = original['R'].copy()
            data = {'R': ratings, 'titles': np.asarray(['item-' + str(i) for i in range(ratings.shape[1])]),
                    'source': np.asarray('platform-local-training-only'), 'sha256': np.asarray(sha(source)), 'seed': np.asarray(42)}
        else:
            data = {key: original[key].copy() for key in original.files}
    if number == '23':
        # Official member/nonmember/candidate IDs and labels are private. Build
        # every local split solely from the explicitly public auxiliary pool.
        images, labels = data['public_images'], data['public_labels']
        midpoint = len(images) // 2
        for prefix, selection in [('member', slice(0, midpoint)), ('nonmember', slice(midpoint, None)),
                                  ('clean_test', slice(midpoint, midpoint + min(1000, midpoint)))]:
            data[prefix + '_images'], data[prefix + '_labels'] = images[selection], labels[selection]
            if prefix + '_labels_clean' in data:
                data[prefix + '_labels_clean'] = labels[selection]
        data['candidate_images'], data['candidate_labels'] = images.copy(), labels.copy()
        data['candidate_membership'] = np.concatenate([np.ones(midpoint, dtype=np.int64), np.zeros(len(images) - midpoint, dtype=np.int64)])
    elif number == '24':
        # Remove private reconstruction images including duplicate pixels. Use
        # an independent subset, so comparison against all public MNIST images
        # cannot reveal exactly which eight records were removed.
        rng = np.random.default_rng(10424)
        selection = practice24_selection(data)
        images, labels = data['train_images'][selection], data['train_labels'][selection]
        test = rng.permutation(len(images))[:min(5000, len(images))]
        clients = np.array_split(rng.permutation(len(images)), 10)
        data = {'train_images': images, 'train_labels': labels, 'test_images': images[test], 'test_labels': labels[test],
                'cache_version': np.asarray(1), 'seed': np.asarray(10424), 'n_clients': np.asarray(10),
                **{'client_' + str(i): values for i, values in enumerate(clients)}}
    elif number == '25':
        selection = np.arange(len(data['x_test'])) % len(data['x_train'])
        data['x_test'], data['y_test'] = data['x_train'][selection], data['y_train'][selection]
    elif number == '26':
        # Use only the independent utility table for local experiments; the
        # formal release rows and target-to-release mapping stay private.
        local = data['clean_test'].copy()
        split = max(1, int(len(local) * .8))
        data['release_train'], data['clean_test'] = local[:split], local[split:]
        data['target_true_index'] = np.arange(min(100, split), dtype=np.int64)
        meta = {'version': 1, 'source': 'platform-local-training-only', 'n_release': split,
                'n_test': len(local) - split, 'n_target': min(100, split)}
        data['meta'] = np.asarray(json.dumps(meta, ensure_ascii=False))
    elif number in ('30', '31'):
        ratings = data['R']
        rng = np.random.default_rng(42)
        training = np.full_like(ratings, np.nan)
        for user in range(len(ratings)):
            observed = np.flatnonzero(~np.isnan(ratings[user]))
            order = rng.permutation(len(observed))
            chosen = observed[order[:max(1, int(round(.8 * len(observed))))]]
            training[user, chosen] = ratings[user, chosen]
        data['R'] = training
        data['source'] = np.asarray('platform-local-training-only')
    buffer = io.BytesIO()
    np.savez_compressed(buffer, **data)
    return source.name, buffer.getvalue()


def public_bundle(source_root, course, problem, path):
    number = problem['id'][1:]
    data_name, data = local_training_data(course, number)
    notice = ('本包仅用于本地训练和接口自测。所有 test / candidate 字段均为本地练习划分，'
              '不代表正式评分数据或成绩。正式隐藏目标、成员标记、测试标签、教师模型和参考答案不公开。\n'
              '解压后进入 student 目录，填写 blank.py，再按题目说明运行 local_train_*.py。\n'
              '平台在线提交只需 blank.py；要求模型的题目另上传导出的 model.pt。\n')
    if number == '31':
        notice += '31附带教学必需的公开clean-MF规划代理和固定投毒训练矩阵，来源及哈希由资源清单记录；正式测试标签、poisoned/robust参考解仍由后台持有。\n'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name in ('blank.py', 'export_weights.py', 'local_train_privacy.py', 'local_train_reco30.py', 'local_train_reco31.py'):
            file = course / 'student' / name
            if file.is_file():
                archive.write(file, 'student/' + name)
        for name in ('dataset.py', 'attack-backend.py', 'defense-backend.py'):
            if name == 'dataset.py':
                archive.writestr('backend/code/' + name, public_dataset(course, number))
            else:
                archive.write(course / 'backend' / 'code' / name, 'backend/code/' + name)
        for name in ('judge_runtime.py', 'checkpoints.py'):
            archive.write(source_root / '公共后端' / name, name)
        archive.writestr('problem.json', json.dumps(problem, ensure_ascii=False))
        archive.writestr('backend/code/data/' + data_name, data)
        if number == '31':
            # These two assets are explicit learning interfaces in the source
            # local trainer. They contain a public planning proxy and training
            # ratings only, never hidden test labels or a robust solution.
            archive.write(course / 'backend' / 'weights' / 'clean.pt', 'student/teacher_clean.pt')
            defense_course = next((source_root / '题目' / '对抗').glob('D31-*'))
            archive.write(defense_course / 'backend' / 'weights' / 'fixed_poison.npz', 'student/fixed_poison.npz')
        archive.writestr('平台本地实验说明.txt', notice)
        requirements = course / 'requirements.txt'
        if requirements.is_file():
            archive.write(requirements, 'requirements.txt')


PAIR_NOTES = {
    '23': '攻击算法真实查询对手上传的差分隐私模型。攻击分=clip((MIA AUC−0.5)/0.4,0,1)；防御分=0.7×同一攻击的隐私泄露降低率+0.3×干净准确率保留率。',
    '24': '对手的梯度保护函数实际变换固定梯度，再交给攻击者反演；攻击者无法读取隐藏原图/标签。攻击分=clip(SSIM/0.8,0,1)×标签恢复率；防御分=0.7×同一攻击的SSIM降低率+0.3×上传全局模型准确率保留率。',
    '25': '遗忘验证算法真实查询对手上传的遗忘模型，后台根据真实逐样本损失重算AUC。攻击分=clip((验证AUC−0.5)/0.4,0,1)；防御分=0.7×同一攻击的泄露降低率+0.3×保留集准确率保留率。入池仍沿用原题的金标准遗忘质量公式。',
    '26': '对手的切分函数实际生成满足k匿名的发布表，攻击者的距离函数对该表进行重识别。攻击分沿用原题AttackScore；防御分=0.7×同一攻击的重识别降低率+0.3×(1−NCP)。真实映射只由后台持有。',
    '30': '攻击者真实生成伪画像并注入，防御者上传的已拟合检测器真实清理该矩阵，后台用确定性ItemKNN重算。攻击分=clip((清理后目标曝光率−干净曝光率)/0.30,0,1)，被删除真实用户仍在固定分母中；防御分=0.7×检测质量+0.3×NDCG保留率。',
    '31': '入池保留原上传MF的离线基线。配对阶段按授权增加固定预算可信重训：攻击算法以冻结干净MF规划3轮、最多改写1000条真实评分；其实际投毒矩阵进入可信MF训练。防御者的mad_scale/robust_weights通过隔离RPC生成真实损失权重。干净/投毒普通MF各训练1次，鲁棒MF训练3轮；每次维度32、学习率0.0005、正则0.05、batch2048、80epochs，总计最多400epochs，随机种子42/43/44，CPU4核、内存6144MB、最长3600秒。攻击分=clip((防御后曝光率−干净曝光率)/0.25,0,1)；防御分=0.7×操纵降低率+0.3×NDCG保留率。后台重算预算、指标并记录真实训练数据哈希；两份上传MF不能代替真实配对结果。',
}


def positive_success_floor(course, number, role):
    """Zero reference performance must never turn normal failure into a win."""
    import numpy as np
    if role == 'attack' and number in ('23', '25'):
        filename = 'mnist_splits.npz' if number == '23' else 'cifar10_subset.npz'
        with np.load(course / 'backend' / 'code' / 'data' / filename, allow_pickle=False) as data:
            if number == '23':
                labels = data['candidate_membership']
                positive, negative = int((labels == 1).sum()), int((labels == 0).sum())
            else:
                positive, negative = len(data['forget_index']), len(data['x_test'])
        # Pairwise AUC has a half-point step when ties occur. Normalization is
        # (AUC-.5)/.4, so this is one positive normalized AUC half-step.
        return 1 / (.8 * positive * negative), {'kind': 'normalized-auc-half-step', 'positiveSamples': positive, 'negativeSamples': negative, 'aucNormalization': .4}
    if role == 'attack' and number in ('30', '31'):
        with np.load(course / 'backend' / 'code' / 'data' / 'ml100k.npz', allow_pickle=False) as data:
            users = data['R'].shape[0]
        scale = .3 if number == '30' else .25
        return 1 / (users * scale), {'kind': 'one-target-exposure-over-public-user-upper-bound', 'users': users, 'normalization': scale}
    return None, {'kind': 'continuous', 'zeroReferenceRequiresExplicitSuccessRule': True}


def build(source_root, output, image):
    source_root, output = Path(source_root), Path(output)
    if output.exists() and any(output.iterdir()):
        raise ValueError('output must be empty; published content is immutable')
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'schemaVersion': 1, 'packId': 'V3-261012', 'packages': [], 'questions': []}
    for number in NUMBERS:
        courses = {role: next((source_root / '题目' / '对抗').glob(prefix + number + '-*')) for role, prefix in [('attack', 'A'), ('defense', 'D')]}
        problems = {role: json.loads((course / 'problem.json').read_text(encoding='utf8')) for role, course in courses.items()}
        private_data = None
        if number in ('23', '26'):
            import numpy as np
            private_source = next((courses['attack'] / 'backend' / 'code' / 'data').glob('*.npz'))
            with np.load(private_source, allow_pickle=False) as original:
                # OS entropy is used only at build time. The resulting data bytes
                # are frozen in private package files and covered by its digest.
                private_data = private_ordering({key: original[key] for key in original.files}, number,
                                               np.random.default_rng(secrets.randbits(256)))
        for role, course in courses.items():
            problem = problems[role]
            source_id, question_id = problem['id'], 'V3-261012-' + problem['id']
            package, resources = output / 'packages' / source_id, output / 'resources' / question_id
            public = package / 'public'
            public.mkdir(parents=True)
            for origin, target in [('codec.py', 'tabular_codec.py'), ('runtime.py', 'tabular_runtime.py'), ('grade.py', 'grade.py')]:
                copy(ROOT / origin, package / target)
            copy(ROOT.parent / 'basic' / 'judge_runtime.py', package / 'judge_runtime.py')
            copy(ROOT.parent / 'basic' / 'judge_runtime.py', public / 'judge_runtime.py')
            copy(ROOT / 'codec.py', public / 'tabular_codec.py')
            copy(ROOT / 'bootstrap.py', public / 'bootstrap.py')
            for dest in (package, public):
                copy(source_root / '公共后端' / 'checkpoints.py', dest / 'checkpoints.py')
            evaluator_name = 'privacy_evaluator.py' if number not in ('30', '31') else 'reco' + number + '_evaluator.py'
            copy(source_root / '公共后端' / evaluator_name, package / evaluator_name)
            # Trusted references and data are private; both role frameworks are
            # needed even for a fixed-role question's opponent worker.
            for file in (course / 'backend' / 'code').glob('*.py'):
                copy(file, package / 'backend' / 'code' / file.name)
            for relative in set(asset for p in problems.values() for asset in p['teacher_assets']):
                origin = next((c / relative for c in courses.values() if (c / relative).is_file()), None)
                if origin is None:
                    raise ValueError('missing trusted asset: ' + relative)
                copy(origin, package / relative)
            if private_data is not None:
                target = package / 'backend' / 'code' / 'data' / private_source.name
                np.savez_compressed(target, **private_data)
                write_json(package / 'private_data_provenance.json', {
                    'sourceSha256': sha(private_source), 'frozenSha256': sha(target),
                    'preparation': 'private row permutation only; original samples and truth preserved',
                })
                if number == '26':
                    dataset_file = package / 'backend' / 'code' / 'dataset.py'
                    text = dataset_file.read_text(encoding='utf8')
                    old = 'idx = np.sort(data["target_true_index"].astype(np.int32))'
                    if text.count(old) != 1:
                        raise ValueError('private target loader contract changed')
                    dataset_file.write_text(text.replace(old, 'idx = data["target_true_index"].astype(np.int32)'), encoding='utf8')
            # A25's reference evaluator also uses the unlearned diagnostic.
            extra = courses['defense'] / 'backend' / 'weights' / 'unlearned.pt'
            if extra.is_file():
                copy(extra, package / 'backend' / 'weights' / extra.name)
            (public / 'dataset.py').write_text(public_dataset(course, number), encoding='utf8')
            for participant_role in ('attack', 'defense'):
                text = skeleton(courses[participant_role] / 'backend' / 'code' / (participant_role + '-backend.py'))
                (public / (participant_role + '_backend.py')).write_text(text, encoding='utf8')
                if participant_role == 'defense':
                    (public / 'architecture.py').write_text(text, encoding='utf8')
            write_json(public / 'course.json', {'number': number, 'entries': {r: p['entry']['symbols'] for r, p in problems.items()}})
            write_json(package / 'problem.json', problem)
            self_tests = {}
            for participant_role, participant_problem in problems.items():
                pid = participant_problem['id']
                ref = output / 'references' / (pid + '.py')
                if not ref.exists():
                    copy(source_root / '开发工具' / '参考提交' / pid / 'blank.py', ref)
                fixture = {'codePath': ref.relative_to(output).as_posix(), 'codeSha256': sha(ref)}
                if participant_problem['weights']['required']:
                    copy(courses[participant_role] / 'backend' / 'weights' / 'reference_submission.pt', package / 'fixtures' / (participant_role + '.pt'))
                    fixture['weightFixture'] = 'fixtures/' + participant_role + '.pt'
                self_tests[participant_role] = fixture
            self_test = dict(self_tests[role], opponent=self_tests['defense' if role == 'attack' else 'attack'])
            environment = {
                'schemaVersion': 1, 'protocol': 'platform-rpc-v1', 'name': problem['title'] + ' · ' + role,
                'image': image, 'entrypoint': 'grade.py', 'phases': ['baseline', 'opponent'], 'network': 'none',
                'resources': {'cpus': 4, 'memoryMb': 6144, 'pids': 256, 'timeoutMs': 3600000, 'tmpMb': 512},
                'materials': {'requiresWeights': bool(problem['weights']['required']), 'maxWeightBytes': 500 * 1024 * 1024, 'maxCodeBytes': 1048576},
                'rpc': {'maxRequestBytes': 134217728, 'maxResponseBytes': 134217728, 'maxArrayBytes': 67108864, 'maxCalls': 100000, 'maxObjects': 128},
                'worker': {'bootstrap': 'public/bootstrap.py', 'files': ['public/' + p.relative_to(public).as_posix() for p in files_under(public)]},
            }
            write_json(package / 'manifest.json', environment)
            (package / 'compose.yaml').write_text('services:\n  evaluator:\n    image: ' + json.dumps(image) + '\n', encoding='utf8')
            resources.mkdir(parents=True)
            outputs = []
            for filename, origin in [('blank.py', course / 'student' / 'blank.py'), ('题目说明-原始.md', course / '题目说明.md')]:
                copy(origin, resources / filename)
            public_bundle(source_root, course, problem, resources / '学生本地实验包.zip')
            content = (course / '题目说明.md').read_text(encoding='utf8')
            for asset in files_under(course / 'assets') if (course / 'assets').exists() else []:
                filename = 'asset-' + asset.name
                copy(asset, resources / filename)
                content = content.replace(asset.relative_to(course).as_posix(), f'/api/questions/{question_id}/resources/{filename}')
            for resource in files_under(resources):
                outputs.append({'sourcePath': resource.relative_to(output).as_posix(), 'filename': resource.name, 'sha256': sha(resource)})
            prefix = ('> 平台提交：在线填写 `blank.py`，' + ('另上传本地训练完成的 `model.pt`。' if problem['weights']['required'] else '无需模型参数。') +
                      ('本题仅配对阶段执行下述固定预算可信训练，' if number == '31' else '正式评测不训练模型，') +
                      '双方提交在独立worker执行。基线达到官方参考实测门槛（包含等于）才入池。\n\n'
                      '**平台配对口径**：' + PAIR_NOTES[number] + '\n\n'
                      '最终题目成绩为对手胜率；无对手为100%；正常失败计入分母，异常/未过基线不计分。'
                      '单个对手是否获胜以本题经校准的 successMetric 门槛判断。下方原题0–100分用于算法指标说明。\n\n')
            if number in ('23', '26'):
                prefix += '正式评测保留原始样本与标签，只对样本顺序作私有固定置换以保护成员关系/行映射；该顺序随题目版本冻结。公开工具仅含独立本地练习划分。\n\n'
            required = bool(problem['weights']['required'])
            positive_floor, granularity = positive_success_floor(course, number, role)
            definition = {'kind': 'model' if required else 'algorithm',
                'weights': {'enabled': required, 'required': required, 'extensions': ['.pt', '.pth'], 'maxBytes': 500 * 1024 * 1024,
                            'description': json.dumps(problem['weights'], ensure_ascii=False), 'device': 'cpu', 'loadInterface': '/materials/weights.bin; offline trained only'},
                'teacherApi': {'enabled': False}, 'llm': {'enabled': False},
                'evaluation': {'version': 'v3-261012-tabular-rpc-v1', 'timeoutMs': 3600000, 'maxScore': 100,
                    'baselineMetric': 'qualificationMetric', 'baselineThreshold': None, 'successMetric': 'successMetric', 'successThreshold': None,
                    'repetitions': 1, 'parameters': {'sourceId': source_id,
                        **({'trustedTraining': {'maxEpochs': 400, 'epochsPerFit': 80, 'fits': 5, 'dim': 32, 'lr': .0005, 'reg': .05, 'batch': 2048, 'seeds': [42, 43, 44], 'maxChanges': 1000}} if number == '31' else {})}}}
            manifest['questions'].append({'id': question_id, 'sourceId': source_id, 'title': problem['title'] + ('（攻击）' if role == 'attack' else '（防御）'),
                'moduleCode': 'AI_PRIVACY_V3' if number not in ('30', '31') else 'AI_RECO_V3', 'number': int(number), 'difficulty': 'L3',
                'category': 'adversarial', 'scenarioId': 'V3-261012-' + number, 'role': role, 'content': prefix + content,
                'answerTemplate': (course / 'student' / 'blank.py').read_text(encoding='utf8'), 'definition': definition,
                'packageKey': source_id, 'selfTest': self_test, 'resources': outputs, 'requiresCalibration': True,
                'minimumPositiveSuccessThreshold': positive_floor, 'successGranularity': granularity,
                'publicAssetAllowlist': ['student/teacher_clean.pt', 'student/fixed_poison.npz'] if number == '31' else []})
            manifest['packages'].append({'key': source_id, 'directory': package.relative_to(output).as_posix(),
                'files': [{'path': p.relative_to(package).as_posix(), 'sha256': sha(p)} for p in files_under(package)]})
    write_json(output / 'manifest.json', manifest)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--image', default='python:3.11-slim')
    args = parser.parse_args()
    result = build(args.source, args.output, args.image)
    print(json.dumps({'questions': len(result['questions']), 'requiresCalibration': True}))

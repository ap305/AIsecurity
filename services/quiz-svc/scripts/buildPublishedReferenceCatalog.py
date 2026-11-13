"""Export reviewed AST excerpts from the currently published, digest-bound packages.

This does not import/evaluate any package code, execute a judge, change a package,
or read datasets/checkpoints. The output is a deployment artifact, never a new
scoring contract. Basic questions have no qualification phase and are excluded.
"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

DIGEST = re.compile(r'^[0-9a-f]{64}$')
PACKAGE_ID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
QUESTION_ID = re.compile(r'^V3-261012-([AD])(\d{2})$')
NUMBERS = set(range(1, 32)) - {29}
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_PUBLIC_BYTES = 256 * 1024


def identity(question_id):
    match = QUESTION_ID.fullmatch(question_id)
    if not match or int(match[2]) not in NUMBERS:
        raise ValueError('unsupported published question identity')
    return match[1], match[2]


def selection_plan(question_id):
    role, number = identity(question_id)
    if number in ('01', '04', '06', '07'):
        evaluator = 'evaluate_poison' if number in ('01', '06') else 'evaluate' + number
        return [('ml_runtime.py', ['run', 'Reference', evaluator], '实际资格评测：固定参考对侧与当前提交')]
    if number in ('02', '08', '09', '13'):
        nodes = ['evaluate', 'evaluate_pair'] + (['references_02'] if number == '02' else [])
        plan = [('prompt_runtime.py', nodes, '实际资格分支及原指标计算')]
        if number == '02' and role == 'A':
            plan.append(('course/test.py', ['_prompt_nodefense'], 'A02 实际资格对侧：NoDefense'))
        else:
            other = 'attack' if role == 'D' else 'defense'
            plan.append((f'course/{other}.py', ['attack' if other == 'attack' else 'defend'], '实际资格使用的官方对侧算法'))
            if number == '02':
                plan.append(('course/test.py', ['_scoremin_payload', '_noop_payload'], 'D02 额外资格对照：ScoreMin 与无注入'))
        return plan
    if 14 <= int(number) <= 22:
        other = 'attack' if role == 'D' else 'defense'
        return [('bot_runtime.py', ['evaluate', 'run_pair', 'no_defense', 'defense_false_positive'], '实际 Bot 资格评测及正常行为误伤检查'),
                (f'course/{other}.py', ['attack' if other == 'attack' else 'defend'], '实际资格使用的官方对侧算法')]
    if number == '03':
        plan = [('class_runtime.py', ['evaluate_watermark', 'official_watermark_attack'], '实际水印资格评测与冻结参考调用')]
        plan.append(('course/defense.py', ['WatermarkDefense', 'WatermarkDetector'], '官方水印生成与检测参考（私有输入不含在内）'))
        if role == 'D':
            plan.append(('course/attack.py', ['attack'], '实际资格使用的官方攻击算法'))
        return plan
    if number == '28' and role == 'A':
        return [('class_runtime.py', ['extraction_run', 'evaluate_extraction#a28_unprotected'], 'A28 实际资格：仅无防御环境，不调用官方防御')]
    if number in ('27', '28'):
        plan = [('class_runtime.py', ['extraction_run', 'evaluate_extraction'], '实际提取资格评测：私有语料由受信环境提供')]
        if role == 'D':
            name = 'AdaptiveRolePlayExtraction' if number == '27' else 'EnumerativeCitationProbe'
            plan.append(('course/attack.py', [name], '资格评测实际调用的官方攻击类'))
            if number == '28':
                plan.append(('citation_reference.py', ['repair_reference', 'install_trusted_reference'], '当前包的官方引用攻击修补逻辑'))
        else:
            plan.append(('course/defense.py', ['GuardedPromptWithLeakFilter'], '当前包官方防御类：原方法与下方累计过滤修补共同生效'))
            plan.append(('cumulative_reference.py', ['repair_reference', 'install_trusted_reference'], '当前包实际安装的累计输出过滤修补'))
        return plan
    if number in ('05', '10', '11', '12'):
        plan = [('media_adapter.py', ['configure', 'evaluate'], '实际媒体资格入口与原始评分转换')]
        if number == '05':
            plan[0][1].extend(['patch05', 'independent05', 'defense05'])
            plan.append(('media_evaluator.py', ['_handler_05', '_map_a05' if role == 'A' else '_map_d05'], '实际贴片资格指标'))
        elif number == '10':
            plan.append(('media_evaluator.py', ['_handler_10', '_map_a10' if role == 'A' else '_map_d10'], '实际图片水印资格指标'))
        else:
            name = ('image_' if number == '11' else 'audio_') + ('attack' if role == 'A' else 'defense') + number
            plan.append(('blind_detection.py', [name], '实际混排检测资格算法（私有排列与标签不公开）'))
        return plan
    if number in ('23', '24', '25', '26', '30', '31'):
        evaluator = 'privacy_evaluator.py' if int(number) <= 26 else f'reco{number}_evaluator.py'
        return [('tabular_runtime.py', ['configured', 'evaluate'], '实际资格入口：原评测器与提交 RPC 适配'),
                (evaluator, [f'_handler_{role.lower()}{number}'], '该角色实际资格算法与指标计算')]
    raise ValueError('qualification plan is missing')


def confined_file(root, relative):
    if not isinstance(relative, str) or relative.startswith('/') or '\\' in relative or any(p in ('', '.', '..') for p in relative.split('/')):
        raise ValueError('unsafe package path')
    current = root
    for part in relative.split('/'):
        current = current / part
        if current.is_symlink():
            raise ValueError('package symlinks are not allowed')
    resolved = current.resolve(strict=True)
    if root.resolve() not in resolved.parents or not resolved.is_file():
        raise ValueError('source is outside the current package')
    if resolved.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError('source exceeds read limit')
    return resolved


def a28_unprotected(node):
    for item in node.body:
        if not isinstance(item, ast.If):
            continue
        comparisons = {term.left.id: term.comparators[0].value
                       for term in ast.walk(item.test)
                       if isinstance(term, ast.Compare) and isinstance(term.left, ast.Name)
                       and len(term.ops) == 1 and isinstance(term.ops[0], ast.Eq)
                       and isinstance(term.comparators[0], ast.Constant)}
        if comparisons != {'number': '28', 'role': 'attack', 'phase': 'baseline'}:
            continue
        calls = [term for statement in item.body for term in ast.walk(statement)
                 if isinstance(term, ast.Call) and isinstance(term.func, ast.Name) and term.func.id == 'extraction_run']
        if len(calls) != 1 or len(calls[0].args) < 4 or not isinstance(calls[0].args[3], ast.Constant) or calls[0].args[3].value is not None:
            raise ValueError('A28 unprotected baseline does not use guard=None')
        if item.orelse or not any(isinstance(statement, ast.Return) for statement in item.body):
            raise ValueError('A28 unprotected baseline must return before protected branches')
        return item
    raise ValueError('A28 current unprotected qualification branch is missing')


def extract_nodes(source, names):
    tree = ast.parse(source)
    declarations = {node.name: node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    segments = []
    for name in names:
        key, _, selector = name.partition('#')
        node = declarations.get(key)
        if node is None:
            raise ValueError('required reviewed AST node is missing: ' + key)
        if selector:
            if selector != 'a28_unprotected':
                raise ValueError('unsupported AST selector')
            node = a28_unprotected(node)
        start = min([node.lineno] + [decorator.lineno for decorator in getattr(node, 'decorator_list', [])])
        segments.append(''.join(source.splitlines(keepends=True)[start - 1:node.end_lineno]).rstrip())
    return '\n\n'.join(segments)


def explanation(question_id):
    role, number = identity(question_id)
    specific = {
        '02': 'A02 资格对侧为 NoDefense；D02 使用 ScoreMax、ScoreMin 和无注入清洁对照。平台对手阶段另行使用学生对手。',
        '03': '采用当前包冻结的水印生成、检测、参考攻击与质量门槛；正式自然文本、检测排列及模型资产不包含在代码片段内。',
        '27': '资格中同时区分无防御清洁门、官方防御与正常任务效用；正式机密片段正文、系统提示输入和任务答案不公开。',
        '28': 'A28 资格只在无防御环境中运行，不使用官方检索屏蔽或输出过滤。D28 资格使用当前修补后的官方攻击类及正常问答效用门。',
    }.get(number, '')
    if number in ('01', '04', '06', '07'):
        specific = '资格对侧来自当前包的 teacher 参考实现，涉及固定参考模型或配对训练；所示为运行入口和资格评测核心，不包含模型权重。'
    elif number in ('05', '10', '11', '12'):
        specific = '资格使用当前包固定检测模型、参考攻击池和原始指标；实际学生对手仅在 opponent 阶段引入。所示片段包含适配关系，不是单个可提交参考答案。'
    elif number in ('23', '24', '25', '26', '30', '31'):
        specific = '资格沿用当前包该角色原始评测器，通过 RPC 调用学生实现；模型、固定数据与隐藏真值不包含在代码片段内。'
    elif 14 <= int(number) <= 22:
        specific = '攻击资格使用官方防御；防御资格使用官方攻击并检查正常合法行为误伤率。'
    return ('以下源码节选直接来自当前已发布评测包，并绑定题目版本、完整配置和包摘要。'
            '仅用于说明实际资格基线及调用关系；不是同角色 self-test 参考提交，也不是可直接完整复现的独立程序。'
            '未附带隐藏数据、私有顺序、机密文本、模型权重或凭据；未改变任何评分规则。' + specific)


def build_entry(question, package_root):
    role, _ = identity(question.get('id', ''))
    if question.get('category') != 'adversarial' or question.get('role') != ('attack' if role == 'A' else 'defense'):
        raise ValueError('question role/category binding is invalid')
    if type(question.get('revision')) is not int or question['revision'] < 1 or not isinstance(question.get('evaluationVersion'), str):
        raise ValueError('question version binding is invalid')
    if not PACKAGE_ID.fullmatch(question.get('packageId', '')) or any(not DIGEST.fullmatch(question.get(field, '')) for field in ('definitionDigest', 'packageDigest')):
        raise ValueError('package/definition binding is invalid')
    package_root = Path(package_root)
    package = package_root / question['packageId']
    if package.is_symlink() or package.resolve().parent != package_root.resolve():
        raise ValueError('unsafe package identity')
    metadata = json.loads(confined_file(package, '_metadata.json').read_text(encoding='utf-8-sig'))
    if metadata.get('id') != question['packageId'] or metadata.get('digest') != question['packageDigest'] or metadata.get('valid') is not True:
        raise ValueError('package metadata binding differs from published inventory')
    file_map = metadata.get('files')
    if not isinstance(file_map, dict) or any(not isinstance(value, str) or not DIGEST.fullmatch(value) for value in file_map.values()):
        raise ValueError('package metadata file digests are invalid')
    # EvaluationPackage uses sha256(JSON.stringify(files)), preserving property insertion order.
    encoded_files = json.dumps(file_map, ensure_ascii=False, separators=(',', ':')).encode('utf8')
    if hashlib.sha256(encoded_files).hexdigest() != question['packageDigest']:
        raise ValueError('package metadata digest differs from its file map')
    inventory_files = {row['path']: row['sha256'] for row in question['files']}
    if len(inventory_files) != len(question['files']):
        raise ValueError('duplicate inventory source path')
    source_files, blocks = [], []
    for relative, nodes, label in selection_plan(question['id']):
        if 'dataset' in relative or not relative.endswith('.py'):
            raise ValueError('private asset is not an approved code source')
        expected = inventory_files.get(relative)
        if not isinstance(expected, str) or not DIGEST.fullmatch(expected) or metadata.get('files', {}).get(relative) != expected:
            raise ValueError('source digest is not bound to current package metadata')
        data = confined_file(package, relative).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError('source digest differs from published package')
        excerpt = extract_nodes(data.decode('utf-8-sig'), nodes)
        blocks.append('# ' + label + '\n' + excerpt)
        source_files.append({'path': relative, 'sha256': expected, 'nodes': nodes})
    code = '\n\n'.join(blocks) + '\n'
    if not code.strip() or len(code.encode('utf8')) > MAX_PUBLIC_BYTES:
        raise ValueError('public excerpt size is invalid')
    return {'schemaVersion': 1, 'questionId': question['id'], 'questionVersion': question['revision'],
            'evaluationVersion': question['evaluationVersion'], 'definitionDigest': question['definitionDigest'],
            'packageId': question['packageId'], 'packageDigest': question['packageDigest'], 'sourceFiles': source_files,
            'title': '当前线上资格基线 · 源码节选', 'explanation': explanation(question['id']),
            'code': code, 'codeSha256': hashlib.sha256(code.encode('utf8')).hexdigest(),
            'referenceKind': 'qualification', 'publishedAt': datetime.now(timezone.utc).isoformat()}


def write_catalog(entries, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    targets = [(output / (hashlib.sha256(entry['questionId'].encode('utf8')).hexdigest() + '.json'), entry) for entry in entries]
    if any(path.exists() for path, _ in targets):
        raise FileExistsError('catalog destination already contains a question; use a new review directory')
    for path, entry in targets:
        with path.open('x', encoding='utf8', newline='\n') as stream:
            json.dump(entry, stream, ensure_ascii=False, indent=2)
            stream.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--package-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text(encoding='utf-8-sig'))
    questions = [q for q in inventory['questions'] if q.get('category') == 'adversarial']
    expected = {f'V3-261012-{role}{number:02}' for role in ('A', 'D') for number in NUMBERS}
    if len(questions) != 60 or {q.get('id') for q in questions} != expected:
        raise ValueError('current inventory must include exactly all 60 published adversarial questions')
    entries = [build_entry(question, args.package_root) for question in sorted(questions, key=lambda q: q['id'])]
    write_catalog(entries, args.output)
    print(json.dumps({'questions': len(entries), 'codeBytes': sum(len(entry['code'].encode('utf8')) for entry in entries), 'packagesModified': 0, 'evaluationsRun': 0}))


if __name__ == '__main__':
    main()

"""Rebuild only A03/D03 while preserving every other frozen course byte.

This creates a new, uncalibrated build. It never imports, refreshes calibration,
publishes, changes an existing build, or supplies substitute model measurements.
"""
from __future__ import annotations
import argparse
import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile

import build
import build_classes

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_all import QUESTION_KEYS

IDS = {"V3-261012-A03", "V3-261012-D03"}
SOURCE_IDS = {"A03", "D03"}
ROOT_PACKAGE_KEYS = {"adversarial-A03", "adversarial-D03"}


def snapshot(root):
    root = Path(root)
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
            raise ValueError('Frozen builds cannot contain links or junctions')
        if path.is_file():
            result[path.relative_to(root).as_posix()] = build.sha(path)
    return result


def json_text(path):
    # Preserve CRLF and all whitespace outside the exact records being replaced.
    return Path(path).read_bytes().decode('utf8')


def records(text, key):
    """Return the original byte-equivalent text spans of a root JSON array."""
    decoder = json.JSONDecoder()
    def skip(i):
        while i < len(text) and text[i].isspace():
            i += 1
        return i
    i = skip(0)
    if text[i] != '{':
        raise ValueError('Expected a JSON object')
    i = skip(i + 1)
    while text[i] != '}':
        name, i = decoder.raw_decode(text, i)
        i = skip(i)
        if text[i] != ':':
            raise ValueError('Invalid JSON property')
        i = skip(i + 1)
        if name == key:
            if text[i] != '[':
                raise ValueError('Expected an array: ' + key)
            i = skip(i + 1)
            found = []
            while text[i] != ']':
                start = i
                value, i = decoder.raw_decode(text, i)
                found.append((start, i, value))
                i = skip(i)
                if text[i] == ',':
                    i = skip(i + 1)
                elif text[i] != ']':
                    raise ValueError('Invalid array')
            return found
        _, i = decoder.raw_decode(text, i)
        i = skip(i)
        if text[i] == ',':
            i = skip(i + 1)
    raise ValueError('Missing array: ' + key)


def replace_records(text, key, identity, replacements):
    changes = []
    seen = set()
    newline = '\r\n' if '\r\n' in text else '\n'
    for start, end, row in records(text, key):
        value = row[identity]
        if value in replacements:
            if value in seen:
                raise ValueError('Duplicate record: ' + value)
            seen.add(value)
            indent = text[text.rfind('\n', 0, start) + 1:start]
            if indent.strip():
                indent = '    '
            rendered = json.dumps(replacements[value], ensure_ascii=False, indent=2, allow_nan=False)
            changes.append((start, end, rendered.replace('\n', newline + indent)))
    if seen != set(replacements):
        raise ValueError('Replacement records do not match existing records')
    for start, end, value in reversed(changes):
        text = text[:start] + value + text[end:]
    return text


def append_field(text, key, value):
    if key in json.loads(text):
        raise ValueError('Patch evidence already exists')
    newline = '\r\n' if '\r\n' in text else '\n'
    end = text.rfind('}')
    rendered = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).replace('\n', newline + '  ')
    return text[:end].rstrip() + ',' + newline + '  ' + json.dumps(key) + ': ' + rendered + newline + '}' + text[end + 1:]


def replace_file(path, text):
    # No in-place writes: this also prevents a future copy implementation using
    # hardlinks from changing an older published build through a shared inode.
    path = Path(path)
    temporary = path.with_name(path.name + '.patch-tmp')
    with temporary.open('xb') as stream:
        stream.write(text.encode('utf8'))
    temporary.replace(path)


def affected_file(name):
    return (name in {'manifest.json', 'build-evidence.json', 'adversarial/manifest.json',
                     'adversarial/references/A03.py', 'adversarial/references/D03.py'}
            or any(name.startswith('adversarial/packages/' + key + '/')
                   or name.startswith('adversarial/resources/V3-261012-' + key + '/') for key in SOURCE_IDS))


def root_question(row):
    question = {key: copy.deepcopy(row[key]) for key in QUESTION_KEYS if row.get(key) is not None}
    question['packageKey'] = 'adversarial-' + question['packageKey']
    question['selfTest']['codePath'] = 'adversarial/' + question['selfTest']['codePath']
    question['selfTest']['opponent']['codePath'] = 'adversarial/' + question['selfTest']['opponent']['codePath']
    for resource in question['resources']:
        resource['sourcePath'] = 'adversarial/' + resource['sourcePath']
    evaluation = question['definition']['evaluation']
    evaluation['baselineThreshold'], evaluation['successThreshold'] = 0, 1
    question['deploymentReady'] = False
    question['requiresCalibration'] = True
    return question


def assert_unchanged_records(before, after, key, identity, changed):
    old = {row[identity]: before[start:end] for start, end, row in records(before, key) if row[identity] not in changed}
    new = {row[identity]: after[start:end] for start, end, row in records(after, key) if row[identity] not in changed}
    if old != new:
        raise ValueError('Unrelated JSON records changed: ' + key)
    return len(old)


def patch_build(existing, output, source, bigram, configuration, evidence, relative_judge=False):
    existing, output = Path(existing).resolve(), Path(output).resolve()
    configuration = build_classes.watermark_reference_config(configuration)
    if configuration is None or not isinstance(evidence, dict) or not evidence:
        raise ValueError('An explicit configuration and measured diagnosis evidence object are required')
    if output.exists() or output.is_relative_to(existing) or existing.is_relative_to(output):
        raise ValueError('Output must be a fresh directory outside the existing build')
    original = snapshot(existing)
    root_text = json_text(existing / 'manifest.json')
    group_text = json_text(existing / 'adversarial/manifest.json')
    evidence_text = json_text(existing / 'build-evidence.json')
    root = json.loads(root_text)
    metadata = json.loads(evidence_text)
    if len(root['questions']) != 77 or not IDS <= {q['id'] for q in root['questions']}:
        raise ValueError('Expected the complete frozen 77-question build')
    if root.get('requiresCalibration') is not True or root.get('deploymentReady') is not False:
        raise ValueError('Patch from the original uncalibrated build, never a ready release manifest')
    image = metadata['image']
    old_keys = [(existing / 'adversarial/packages' / key / 'detection-order.key').read_bytes() for key in sorted(SOURCE_IDS)]
    if old_keys[0] != old_keys[1]:
        raise ValueError('Old paired detection ordering keys differ')
    private_order_key = old_keys[0].decode('ascii')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='watermark-patch-', dir=output.parent) as directory:
        staged = Path(directory) / 'adversarial'
        pair = build.build(source, staged, image, bigram, watermark_reference_config=configuration,
                           numbers=['03'], watermark_private_order_key=private_order_key,
                           watermark_relative_judge=relative_judge)
        old_pool = next(pool for pool in json.loads((existing / 'adversarial/api-pools.json').read_text('utf8'))['pools']
                        if pool['poolKey'] == 'V3-261012-API-03')
        new_pool = json.loads((staged / 'api-pools.json').read_text('utf8'))['pools'][0]
        if old_pool != new_pool:
            raise ValueError('The patch must not change the frozen model pool')
        for source_id in sorted(SOURCE_IDS):
            old_package = existing / 'adversarial/packages' / source_id
            new_package = staged / 'packages' / source_id
            for folder in ('public', 'course'):
                if snapshot(old_package / folder) != snapshot(new_package / folder):
                    raise ValueError('Original course source, data and public student helpers must remain byte-identical')
            for name in ('detection-order.key', 'model-parameters.json'):
                if (old_package / name).read_bytes() != (new_package / name).read_bytes():
                    raise ValueError('Frozen model parameters and private sample order cannot change')
        # Deliberately use real copies. In particular old shared inodes cannot be
        # modified when replacing the changed private package or public ZIP.
        shutil.copytree(existing, output, copy_function=shutil.copy2)
        for source_id in sorted(SOURCE_IDS):
            for folder in ('packages', 'resources'):
                name = source_id if folder == 'packages' else 'V3-261012-' + source_id
                destination = output / 'adversarial' / folder / name
                if not destination.resolve().is_relative_to(output) or destination.is_symlink():
                    raise ValueError('Replacement escaped the fresh output')
                shutil.rmtree(destination)
                shutil.copytree(staged / folder / name, destination)
            shutil.copyfile(staged / 'references' / (source_id + '.py'), output / 'adversarial/references' / (source_id + '.py'))
        questions = {row['id']: row for row in pair['questions']}
        packages = {row['key']: row for row in pair['packages']}
        new_group = replace_records(group_text, 'questions', 'id', questions)
        new_group = replace_records(new_group, 'packages', 'key', packages)
        root_packages = {}
        for row in pair['packages']:
            row = copy.deepcopy(row)
            row['key'], row['directory'] = 'adversarial-' + row['key'], 'adversarial/' + row['directory']
            root_packages[row['key']] = row
        new_root = replace_records(root_text, 'questions', 'id', {key: root_question(row) for key, row in questions.items()})
        new_root = replace_records(new_root, 'packages', 'key', root_packages)
        new_evidence = replace_records(evidence_text, 'questions', 'sourceId', {
            row['sourceId']: {key: value for key, value in row.items() if key not in QUESTION_KEYS} for row in pair['questions']})
        patch_evidence = {'kind': 'official-algorithm-parameter-calibration', 'sourceManifestSha256': original['manifest.json'],
                          'questionIds': sorted(IDS), 'referenceAttackConfig': configuration,
                          'previousFailureAndDiagnostics': evidence, 'requiresFreshCalibration': True,
                          'unchangedModelPool': True, 'unchangedPrivateDetectionOrder': True,
                          'previousReferences': {key: original['adversarial/references/' + key + '.py'] for key in sorted(SOURCE_IDS)},
                          'replacementReferences': {key: build.sha(staged / 'references' / (key + '.py')) for key in sorted(SOURCE_IDS)}}
        if relative_judge:
            patch_evidence['kind'] = 'approved-relative-preservation-and-official-parameter-calibration'
            patch_evidence['userDecision'] = '采纳澄清并全量重校准'
            patch_evidence['judgeClarification'] = pair['questions'][0]['judgeClarification']
        new_evidence = append_field(new_evidence, 'watermarkReferencePatch', patch_evidence)
        counts = {
            'rootQuestions': assert_unchanged_records(root_text, new_root, 'questions', 'id', IDS),
            'rootPackages': assert_unchanged_records(root_text, new_root, 'packages', 'key', ROOT_PACKAGE_KEYS),
            'apiQuestions': assert_unchanged_records(group_text, new_group, 'questions', 'id', IDS),
            'apiPackages': assert_unchanged_records(group_text, new_group, 'packages', 'key', SOURCE_IDS),
            'evidenceQuestions': assert_unchanged_records(evidence_text, new_evidence, 'questions', 'sourceId', SOURCE_IDS)}
        for name, text in [('manifest.json', new_root), ('adversarial/manifest.json', new_group), ('build-evidence.json', new_evidence)]:
            json.loads(text)
            replace_file(output / name, text)
        current = snapshot(output)
        if snapshot(existing) != original:
            raise ValueError('Original build bytes changed')
        old_unaffected = {name: value for name, value in original.items() if not affected_file(name)}
        new_unaffected = {name: value for name, value in current.items() if not affected_file(name)}
        if old_unaffected != new_unaffected:
            raise ValueError('Files outside the two permitted courses changed')
        for package in root_packages.values():
            for file in package['files']:
                if current[package['directory'] + '/' + file['path']] != file['sha256']:
                    raise ValueError('Replacement package SHA mismatch')
        for question in map(root_question, questions.values()):
            for code in (question['selfTest'], question['selfTest']['opponent']):
                if current[code['codePath']] != code['codeSha256']:
                    raise ValueError('Replacement official reference SHA mismatch')
            for resource in question['resources']:
                if current[resource['sourcePath']] != resource['sha256']:
                    raise ValueError('Replacement resource SHA mismatch')
        report = {'schemaVersion': 1, 'originalBuildUnchanged': True, 'unchangedFiles': len(old_unaffected),
                  'unchangedRecordCounts': counts, 'changedFiles': sorted(name for name, value in current.items() if original.get(name) != value),
                  'previousManifestSha256': original['manifest.json'], 'replacementManifestSha256': current['manifest.json'],
                  'referenceAttackConfig': configuration, 'relativePreservationClarification': relative_judge, 'requiresFreshCalibration': True,
                  'changedFileDigests': {name: {'previous': original.get(name), 'replacement': value}
                                         for name, value in current.items() if original.get(name) != value}}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--existing', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--bigram', type=Path, required=True)
    parser.add_argument('--watermark-reference-config', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--watermark-relative-judge', action='store_true')
    parser.add_argument('--report', type=Path, required=True, help='External verification report, outside both frozen build directories')
    args = parser.parse_args()
    if any(args.report.resolve().is_relative_to(root.resolve()) for root in (args.existing, args.output)):
        raise ValueError('Report must remain outside frozen builds')
    if args.report.exists():
        raise ValueError('Report must be a fresh file')
    report = patch_build(args.existing, args.output, args.source, args.bigram,
                         json.loads(args.watermark_reference_config.read_text('utf-8-sig')),
                         json.loads(args.evidence.read_text('utf-8-sig')), relative_judge=args.watermark_relative_judge)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open('x', encoding='utf8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
    print(json.dumps({key: value for key, value in report.items() if key != 'changedFileDigests'}, ensure_ascii=False))


if __name__ == '__main__':
    main()

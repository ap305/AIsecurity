"""Prepare an immutable six-course native tool protocol revision.

The default is a read-only plan. Explicit --apply copies the frozen candidate
and changes only six grade entrypoints, adds their trusted helper, and updates
three metadata files. It never calls a model or changes calibration state.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
import stat

from patch_clean_reference import validate_assets
from patch_watermark import (append_field, assert_unchanged_records, json_text,
                             replace_file, replace_records, snapshot)
from native_tool_boundary import POLICY, SUPPORTED_NUMBERS, VERSION, entrypoint_source

SOURCES = {role + number for number in SUPPORTED_NUMBERS for role in ('A', 'D')}
IDS = {'V3-261012-' + key for key in SOURCES}
PACKAGE_KEYS = {'adversarial-' + key for key in SOURCES}
METADATA = {'manifest.json', 'adversarial/manifest.json', 'build-evidence.json'}
PREVIOUS_VERSION = 'v3-261012-api-rpc-http503-retry-v4'
ORIGINAL_ENTRYPOINT = 'import sys\nfrom bot_runtime import main\nmain(sys.argv[1],sys.argv[2])\n'


def digest(body):
    return hashlib.sha256(body).hexdigest()


def unique_rows(rows, field):
    result = {row[field]: row for row in rows}
    if len(result) != len(rows):
        raise ValueError('Duplicate metadata record: ' + field)
    return result


def no_links(path):
    """Check lexical ancestors before resolve, including dangling/reparse links."""
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    # Keep '..' lexical components until every traversed ancestor is checked.
    for part in reversed((candidate, *candidate.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        except NotADirectoryError as exc:
            raise ValueError('Build path has a non-directory ancestor') from exc
        if (stat.S_ISLNK(info.st_mode) or
                getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)):
            raise ValueError('Build and report paths cannot contain links or junctions')
    return candidate


def patch_build(existing, output, diagnostic_evidence, *, apply=False):
    old, out = no_links(existing).resolve(), no_links(output).resolve()
    if out.exists() or out.is_relative_to(old) or old.is_relative_to(out):
        raise ValueError('Output must be fresh and outside the original build')
    if not isinstance(diagnostic_evidence, dict) or not diagnostic_evidence:
        raise ValueError('Explicit diagnostic and offline validation evidence is required')
    # Reject non-JSON/non-finite evidence before copying any files.
    json.dumps(diagnostic_evidence, allow_nan=False)
    original = snapshot(old)
    texts = {name: json_text(old / name) for name in METADATA}
    root = json.loads(texts['manifest.json'])
    group = json.loads(texts['adversarial/manifest.json'])
    evidence = json.loads(texts['build-evidence.json'])
    if len(root['questions']) != 77 or len(root['packages']) != 69:
        raise ValueError('Expected the complete 77-question/69-package candidate')
    if root.get('requiresCalibration') is not True or root.get('deploymentReady') is not False:
        raise ValueError('Only an uncalibrated candidate may be patched')
    if 'nativeToolProtocolBoundaryPatch' in evidence:
        raise ValueError('Native tool protocol revision already applied')
    assets = validate_assets(old, root, original)
    root_q = unique_rows(root['questions'], 'id')
    root_p = unique_rows(root['packages'], 'key')
    group_q = unique_rows(group['questions'], 'id')
    group_p = unique_rows(group['packages'], 'key')
    metadata = unique_rows(evidence['questions'], 'sourceId')
    if (not IDS <= root_q.keys() or not IDS <= group_q.keys() or
            not PACKAGE_KEYS <= root_p.keys() or not SOURCES <= group_p.keys() or
            not SOURCES <= metadata.keys() or len(metadata) != 77):
        raise ValueError('Six-course root/group/evidence scope mismatch')
    questions = {key: copy.deepcopy(root_q[key]) for key in IDS}
    group_questions = {key: copy.deepcopy(group_q[key]) for key in IDS}
    packages = {key: copy.deepcopy(root_p[key]) for key in PACKAGE_KEYS}
    group_packages = {key: copy.deepcopy(group_p[key]) for key in SOURCES}
    changed_metadata = {key: copy.deepcopy(metadata[key]) for key in SOURCES}
    helper = (Path(__file__).parent / 'native_tool_boundary.py').read_bytes()
    helper_text = helper.decode('utf8')
    replacements = {}
    for source in sorted(SOURCES):
        qid, package_key = 'V3-261012-' + source, 'adversarial-' + source
        question, group_question = questions[qid], group_questions[qid]
        for row in (question, group_question):
            if (row['definition']['evaluation']['version'] != PREVIOUS_VERSION or
                    row['definition']['llm'].get('enabled') is not True):
                raise ValueError('Expected the frozen v4 transport version for courses 20/21/22')
        evaluation = question['definition']['evaluation']
        if (question.get('requiresCalibration') is not True or question.get('deploymentReady') is not False or
                evaluation['baselineThreshold'] != 0 or evaluation['successThreshold'] != 1):
            raise ValueError('Expected uncalibrated per-question placeholders')
        if question['packageKey'] != package_key or group_question['packageKey'] != source:
            raise ValueError('Question package binding differs')
        package, group_package = packages[package_key], group_packages[source]
        expected_group = copy.deepcopy(package)
        expected_group['key'] = source
        expected_group['directory'] = 'packages/' + source
        if package['directory'] != 'adversarial/' + expected_group['directory'] or group_package != expected_group:
            raise ValueError('Root/group package records disagree')
        directory = package['directory']
        grade_path, helper_path = directory + '/grade.py', directory + '/native_tool_boundary.py'
        if helper_path in original or any(f['path'] == 'native_tool_boundary.py' for f in package['files']):
            raise ValueError('Trusted helper already exists')
        if json_text(old / grade_path).replace('\r\n', '\n') != ORIGINAL_ENTRYPOINT:
            raise ValueError('Original grade entrypoint differs from the frozen source')
        grade = entrypoint_source(source[1:])
        replacements[grade_path], replacements[helper_path] = grade, helper_text
        for item in (package, group_package):
            indexed = unique_rows(item['files'], 'path')
            if 'grade.py' not in indexed or indexed['grade.py']['sha256'] != original[grade_path]:
                raise ValueError('Original grade hash binding differs')
            indexed['grade.py']['sha256'] = digest(grade.encode('utf8'))
            item['files'].append({'path': 'native_tool_boundary.py', 'sha256': digest(helper)})
            item['files'].sort(key=lambda row: row['path'])
        question['definition']['evaluation']['version'] = VERSION
        group_question['definition']['evaluation']['version'] = VERSION
        group_question['nativeToolProtocolBoundary'] = copy.deepcopy(POLICY)
        changed_metadata[source]['nativeToolProtocolBoundary'] = copy.deepcopy(POLICY)
    new_root = replace_records(texts['manifest.json'], 'questions', 'id', questions)
    new_root = replace_records(new_root, 'packages', 'key', packages)
    new_group = replace_records(texts['adversarial/manifest.json'], 'questions', 'id', group_questions)
    new_group = replace_records(new_group, 'packages', 'key', group_packages)
    new_evidence = replace_records(texts['build-evidence.json'], 'questions', 'sourceId', changed_metadata)
    new_evidence = append_field(new_evidence, 'nativeToolProtocolBoundaryPatch', {
        'kind': POLICY['kind'], 'questionIds': sorted(IDS), 'sourceManifestSha256': original['manifest.json'],
        'evaluationVersion': VERSION, 'helperSha256': digest(helper), 'policy': POLICY,
        'diagnosticAndValidationEvidence': diagnostic_evidence, 'requiresFreshCalibration': True,
        'retainedOtherQuestions': 71, 'retainedOtherPackages': 63,
        'proofPolicy': 'Strict refresh may inherit only the other 71 whole-question contracts. Recalibrate all twelve A20/D20/A21/D21/A22/D22 phases.'})
    retained = {
        'questions': assert_unchanged_records(texts['manifest.json'], new_root, 'questions', 'id', IDS),
        'packages': assert_unchanged_records(texts['manifest.json'], new_root, 'packages', 'key', PACKAGE_KEYS),
        'groupQuestions': assert_unchanged_records(texts['adversarial/manifest.json'], new_group, 'questions', 'id', IDS),
        'groupPackages': assert_unchanged_records(texts['adversarial/manifest.json'], new_group, 'packages', 'key', SOURCES),
        'evidenceQuestions': assert_unchanged_records(texts['build-evidence.json'], new_evidence, 'questions', 'sourceId', SOURCES),
    }
    if retained['questions'] != 71 or retained['packages'] != 63 or retained['evidenceQuestions'] != 71:
        raise ValueError('Unchanged record scope differs')
    replacements.update({'manifest.json': new_root, 'adversarial/manifest.json': new_group, 'build-evidence.json': new_evidence})
    changed = set(replacements)
    report = {
        'schemaVersion': 1, 'applied': apply, 'deploymentReady': False, 'requiresFreshCalibration': True,
        'modelCalls': 0, 'evaluationVersion': VERSION, 'policy': POLICY, 'affectedQuestionIds': sorted(IDS),
        'requiredNewPhasesForChangedQuestions': 12, 'retainedRecords': retained, 'retainedAssets': assets,
        'changedFiles': sorted(changed), 'addedFiles': sorted(changed - original.keys()),
        'previousManifestSha256': original['manifest.json'], 'replacementManifestSha256': digest(new_root.encode('utf8')),
        'changedFileDigests': {name: {'previous': original.get(name), 'replacement': digest(body.encode('utf8'))}
                               for name, body in replacements.items()},
    }
    if not apply:
        return report
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(old, out, copy_function=shutil.copy2)
    for name, body in replacements.items():
        replace_file(out / name, body)
    current = snapshot(out)
    if snapshot(old) != original:
        raise ValueError('Original build changed during patch')
    actual_changed = {name for name in original.keys() | current.keys() if original.get(name) != current.get(name)}
    if actual_changed != changed:
        raise ValueError('Change escaped the six entrypoints/helpers and three metadata files')
    validate_assets(out, json.loads(new_root), current)
    report['originalBuildPreserved'] = True
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--existing', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--diagnostic-evidence', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--apply', action='store_true', help='Create a fresh candidate after explicit release authorization')
    args = parser.parse_args()
    no_links(args.existing)
    no_links(args.output)
    no_links(args.report)
    if args.report.exists() or any(args.report.resolve().is_relative_to(p.resolve()) for p in (args.existing, args.output)):
        raise ValueError('Report must be fresh and outside both builds')
    report = patch_build(args.existing, args.output, json.loads(args.diagnostic_evidence.read_text('utf-8-sig')), apply=args.apply)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open('x', encoding='utf8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
    print(json.dumps({key: value for key, value in report.items() if key != 'changedFileDigests'}))


if __name__ == '__main__':
    main()

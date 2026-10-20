"""Create a fresh API32-only transport revision without changing frozen assets.

All 32 API package digests change and require new measured proofs. The original
build, 45 non-API question records, every public resource, official algorithm,
sample, pool parameter and original scoring gate remain byte-identical.
"""
from __future__ import annotations
import argparse
import copy
import json
from pathlib import Path
import shutil

import build
from bot_runtime import API_EVALUATION_VERSION, GATEWAY_TRANSPORT_POLICY
from patch_watermark import (append_field, assert_unchanged_records, json_text,
                             replace_file, replace_records, snapshot)

SOURCE_IDS = {role + number for number in build.NUMBERS for role in ('A', 'D')}
IDS = {build.PACK_ID + '-' + key for key in SOURCE_IDS}
ROOT_PACKAGE_KEYS = {'adversarial-' + key for key in SOURCE_IDS}


def patch_build(existing, output, diagnostic_evidence):
    existing, output = Path(existing).resolve(), Path(output).resolve()
    if output.exists() or output.is_relative_to(existing) or existing.is_relative_to(output):
        raise ValueError('Output must be a fresh directory outside the existing build')
    if not isinstance(diagnostic_evidence, dict) or not diagnostic_evidence:
        raise ValueError('Explicit diagnostic and local validation evidence is required')
    original = snapshot(existing)
    text = {name: json_text(existing / name) for name in ('manifest.json', 'adversarial/manifest.json', 'build-evidence.json')}
    root, group, evidence = [json.loads(text[name]) for name in text]
    api_questions = {q['id']: q for q in root['questions'] if q['definition']['llm']['enabled']}
    if len(root['questions']) != 77 or set(api_questions) != IDS:
        raise ValueError('Expected all 77 questions with the exact original API32 set')
    if root.get('requiresCalibration') is not True or root.get('deploymentReady') is not False:
        raise ValueError('Use an uncalibrated candidate, never a published manifest')
    if any(q['definition']['evaluation']['version'] == API_EVALUATION_VERSION for q in api_questions.values()):
        raise ValueError('Transport revision already applied')
    group_questions = {q['id']: copy.deepcopy(q) for q in group['questions']}
    group_packages = {p['key']: copy.deepcopy(p) for p in group['packages']}
    root_packages = {p['key']: copy.deepcopy(p) for p in root['packages'] if p['key'] in ROOT_PACKAGE_KEYS}
    if set(group_questions) != IDS or set(group_packages) != SOURCE_IDS or set(root_packages) != ROOT_PACKAGE_KEYS:
        raise ValueError('API group and root manifests disagree')
    runtime_bytes = (Path(__file__).parent / 'bot_runtime.py').read_bytes()
    runtime_sha = build.sha(Path(__file__).parent / 'bot_runtime.py')
    allowed_files = {'manifest.json', 'adversarial/manifest.json', 'build-evidence.json'}
    for key, package in root_packages.items():
        relative = package['directory'] + '/bot_runtime.py'
        if relative != 'adversarial/packages/' + key.removeprefix('adversarial-') + '/bot_runtime.py':
            raise ValueError('Unexpected API package directory')
        entries = [entry for entry in package['files'] if entry['path'] == 'bot_runtime.py']
        if len(entries) != 1 or original.get(relative) != entries[0]['sha256'] or entries[0]['sha256'] == runtime_sha:
            raise ValueError('Existing runtime is missing, changed, or already patched')
        allowed_files.add(relative)
        entries[0]['sha256'] = runtime_sha
        corresponding = group_packages[key.removeprefix('adversarial-')]
        group_entry = [entry for entry in corresponding['files'] if entry['path'] == 'bot_runtime.py']
        if len(group_entry) != 1 or group_entry[0]['sha256'] != original[relative]:
            raise ValueError('Group runtime hash differs')
        group_entry[0]['sha256'] = runtime_sha
    patched_questions = copy.deepcopy(api_questions)
    previous_versions = {}
    for qid, question in patched_questions.items():
        previous_versions[qid] = question['definition']['evaluation']['version']
        question['definition']['evaluation']['version'] = API_EVALUATION_VERSION
        question['requiresCalibration'], question['deploymentReady'] = True, False
        # Existing candidate thresholds are placeholders, not inherited proofs.
        if question['definition']['evaluation']['baselineThreshold'] != 0 or question['definition']['evaluation']['successThreshold'] != 1:
            raise ValueError('Expected uncalibrated threshold placeholders')
        group_questions[qid]['definition']['evaluation']['version'] = API_EVALUATION_VERSION
        group_questions[qid]['gatewayTransportPolicy'] = copy.deepcopy(GATEWAY_TRANSPORT_POLICY)
    evidence_questions = {}
    for row in evidence['questions']:
        if row.get('sourceId') in SOURCE_IDS:
            changed = copy.deepcopy(row)
            changed['gatewayTransportPolicy'] = copy.deepcopy(GATEWAY_TRANSPORT_POLICY)
            evidence_questions[row['sourceId']] = changed
    if set(evidence_questions) != SOURCE_IDS:
        raise ValueError('Evidence is missing an API course')
    new_root = replace_records(text['manifest.json'], 'questions', 'id', patched_questions)
    new_root = replace_records(new_root, 'packages', 'key', root_packages)
    new_group = replace_records(text['adversarial/manifest.json'], 'questions', 'id', group_questions)
    new_group = replace_records(new_group, 'packages', 'key', group_packages)
    new_evidence = replace_records(text['build-evidence.json'], 'questions', 'sourceId', evidence_questions)
    new_evidence = append_field(new_evidence, 'gatewayTransportPatch', {
        'kind': 'trusted-explicit-http503-recovery', 'sourceManifestSha256': original['manifest.json'],
        'questionIds': sorted(IDS), 'evaluationVersion': API_EVALUATION_VERSION,
        'previousEvaluationVersions': previous_versions, 'runtimeSha256': runtime_sha,
        'policy': GATEWAY_TRANSPORT_POLICY, 'requiresFreshCalibration': True,
        'retainedNonApiQuestions': 45, 'diagnosticAndValidationEvidence': diagnostic_evidence,
        'proofPolicy': 'Discard all previous API32 package proofs. Only the unchanged non-API45 may use strict refresh.'})
    counts = {
        'rootQuestions': assert_unchanged_records(text['manifest.json'], new_root, 'questions', 'id', IDS),
        'rootPackages': assert_unchanged_records(text['manifest.json'], new_root, 'packages', 'key', ROOT_PACKAGE_KEYS),
        'evidenceQuestions': assert_unchanged_records(text['build-evidence.json'], new_evidence, 'questions', 'sourceId', SOURCE_IDS)}
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(existing, output, copy_function=shutil.copy2)
    for package in root_packages.values():
        # Atomic replacement, never truncate an inode shared with an old build.
        replace_file(output / package['directory'] / 'bot_runtime.py', runtime_bytes.decode('utf8'))
    for name, replacement in [('manifest.json', new_root), ('adversarial/manifest.json', new_group), ('build-evidence.json', new_evidence)]:
        json.loads(replacement)
        replace_file(output / name, replacement)
    current = snapshot(output)
    if snapshot(existing) != original:
        raise ValueError('Original candidate changed')
    changed_files = {name for name in original.keys() | current.keys() if original.get(name) != current.get(name)}
    if changed_files != allowed_files:
        raise ValueError('Changes differ from the exact 32 runtimes and three metadata files')
    for package in json.loads(new_root)['packages']:
        for entry in package['files']:
            if current.get(package['directory'] + '/' + entry['path']) != entry['sha256']:
                raise ValueError('Final package hash mismatch')
    for question in json.loads(new_root)['questions']:
        for resource in question.get('resources', []):
            if current.get(resource['sourcePath']) != resource['sha256']:
                raise ValueError('Public resource changed or its hash is invalid')
    return {'schemaVersion': 1, 'originalBuildUnchanged': True, 'affectedQuestions': 32,
        'unaffectedQuestions': 45, 'unchangedRecordCounts': counts,
        'unchangedFiles': len(original) - len(changed_files), 'changedFiles': sorted(changed_files),
        'previousManifestSha256': original['manifest.json'], 'replacementManifestSha256': current['manifest.json'],
        'evaluationVersion': API_EVALUATION_VERSION, 'policy': GATEWAY_TRANSPORT_POLICY,
        'requiresFreshApiCalibration': True, 'retainedPublicResources': True,
        'changedFileDigests': {name: {'previous': original[name], 'replacement': current[name]} for name in sorted(changed_files)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--existing', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists() or any(args.report.resolve().is_relative_to(root.resolve()) for root in (args.existing, args.output)):
        raise ValueError('Report must be fresh and outside both candidates')
    report = patch_build(args.existing, args.output, json.loads(args.evidence.read_text('utf-8-sig')))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open('x', encoding='utf8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
    print(json.dumps({key: value for key, value in report.items() if key != 'changedFileDigests'}))


if __name__ == '__main__': main()

"""Prepare an offline A08/D08-only paced, single-attempt transport revision.

Read-only by default. No HTTP, model calls, pool changes, calibration or publication.
The resulting unready candidate requires a fresh 180s server binding and proofs.
"""
from __future__ import annotations
import argparse
import copy
import json
from pathlib import Path
import shutil

from patch_clean_reference import validate_assets
from patch_cumulative_reference import digest, no_links, unique_rows
from patch_watermark import (append_field, assert_unchanged_records, json_text,
                             replace_file, replace_records, snapshot)

SOURCES = {'A08', 'D08'}
IDS = {'V3-261012-' + key for key in SOURCES}
PACKAGE_KEYS = {'adversarial-' + key for key in SOURCES}
VERSION = 'v3-261012-api-rpc-paced08-v12'
PREVIOUS_VERSION = 'v3-261012-api-rpc-http503-retry-v4'
METADATA = {'manifest.json', 'adversarial/manifest.json', 'build-evidence.json'}
POLICY = {
    'kind': 'scoped-paced-single-attempt-gateway', 'serverRequestTimeoutMs': 180000,
    'clientTimeoutSeconds': 210, 'existingRelayTimeoutSeconds': 315,
    'minRequestIntervalSeconds': 35, 'initialCooldownSeconds': 35,
    'maxAttempts': 1, 'retryStatus': None, 'backoffSeconds': [],
    'retryUnknownTransportOutcome': False, 'countEveryPostAttempt': True,
    'modelAndInferenceParametersUnchanged': True, 'evaluationDeadlineUnchanged': True,
    'sourceCodeAndQualityGatesUnchanged': True,
}



def revised_runtime(body):
    trusted = (Path(__file__).parent / 'bot_runtime.py').read_bytes()
    if body.replace(b'\r\n', b'\n') != trusted.replace(b'\r\n', b'\n'):
        raise ValueError('Expected the complete canonical frozen gateway runtime')
    changes = [
        (b'GATEWAY_CLIENT_TIMEOUT_SECONDS = 90', b'GATEWAY_CLIENT_TIMEOUT_SECONDS = 210'),
        (b'GATEWAY_MAX_ATTEMPTS = 3', b'GATEWAY_MAX_ATTEMPTS = 1'),
        (b'GATEWAY_RETRY_DELAYS = (1, 2)', b'GATEWAY_RETRY_DELAYS = ()'),
        (b'"retryStatus": 503', b'"retryStatus": None'),
        (b'"countEveryPostAttempt": True', b'"minRequestIntervalSeconds": 35, "initialCooldownSeconds": 35, "countEveryPostAttempt": True'),
        (b'"v3-261012-api-rpc-http503-retry-v4"', b'"v3-261012-api-rpc-paced08-v12"'),
        (b'"unchangedModelPoolAndEvaluationDeadline": True', b'"unchangedModelPoolAndEvaluationDeadline": False'),
        (b'self.preserve_system = preserve_system',
         b'self.preserve_system = preserve_system\n        self._next_request_at = time.monotonic() + 35'),
        (b'            self.calls += 1',
         b'            delay = max(0, self._next_request_at - time.monotonic())\n'
         b'            if delay:\n                time.sleep(delay)\n'
         b'            self._next_request_at = time.monotonic() + 35\n'
         b'            self.calls += 1'),
    ]
    for old, new in changes:
        if body.count(old) != 1:
            raise ValueError('Frozen runtime deadline or policy marker differs')
        body = body.replace(old, new)
    return body


def patch_build(existing, output, diagnostic_evidence, *, apply=False):
    old, out = no_links(existing).resolve(), no_links(output).resolve()
    if out.exists() or out.is_relative_to(old) or old.is_relative_to(out):
        raise ValueError('Output must be fresh and outside the original build')
    if not isinstance(diagnostic_evidence, dict) or not diagnostic_evidence:
        raise ValueError('Explicit diagnostic and offline validation evidence required')
    json.dumps(diagnostic_evidence, allow_nan=False)
    original = snapshot(old)
    texts = {name: json_text(old / name) for name in METADATA}
    root, group, evidence = [json.loads(texts[name]) for name in
                              ('manifest.json', 'adversarial/manifest.json', 'build-evidence.json')]
    if len(root['questions']) != 77 or len(root['packages']) != 69:
        raise ValueError('Expected the complete 77-question/69-package build')
    if root.get('requiresCalibration') is not True or root.get('deploymentReady') is not False:
        raise ValueError('Only an uncalibrated candidate may be patched')
    if 'gatewayPacing08Patch' in evidence:
        raise ValueError('Deadline revision already applied')
    assets = validate_assets(old, root, original)
    rq, rp = unique_rows(root['questions'], 'id'), unique_rows(root['packages'], 'key')
    gq, gp = unique_rows(group['questions'], 'id'), unique_rows(group['packages'], 'key')
    metadata = unique_rows(evidence['questions'], 'sourceId')
    if not (IDS <= rq.keys() and IDS <= gq.keys() and PACKAGE_KEYS <= rp.keys()
            and SOURCES <= gp.keys() and SOURCES <= metadata.keys() and len(metadata) == 77):
        raise ValueError('Two-course metadata scope mismatch')
    questions = {key: copy.deepcopy(rq[key]) for key in IDS}
    group_questions = {key: copy.deepcopy(gq[key]) for key in IDS}
    packages = {key: copy.deepcopy(rp[key]) for key in PACKAGE_KEYS}
    group_packages = {key: copy.deepcopy(gp[key]) for key in SOURCES}
    changed_metadata = {key: copy.deepcopy(metadata[key]) for key in SOURCES}
    replacements = {}
    for source in sorted(SOURCES):
        qid, package_key = 'V3-261012-' + source, 'adversarial-' + source
        question, group_question = questions[qid], group_questions[qid]
        for row in (question, group_question):
            if (row['definition']['evaluation']['version'] != PREVIOUS_VERSION or
                    row['definition']['llm'].get('enabled') is not True):
                raise ValueError('Expected the frozen v4 model-enabled course08 predecessor')
        ev = question['definition']['evaluation']
        if (question.get('requiresCalibration') is not True or question.get('deploymentReady') is not False
                or ev['baselineThreshold'] != 0 or ev['successThreshold'] != 1):
            raise ValueError('Expected untouched uncalibrated placeholders')
        if question['packageKey'] != package_key or group_question['packageKey'] != source:
            raise ValueError('Question package binding differs')
        package, group_package = packages[package_key], group_packages[source]
        expected_group = copy.deepcopy(package)
        expected_group.update(key=source, directory='packages/' + source)
        if package['directory'] != 'adversarial/packages/' + source or group_package != expected_group:
            raise ValueError('Root/group package records disagree')
        relative = package['directory'] + '/bot_runtime.py'
        body = revised_runtime((old / relative).read_bytes())
        replacements[relative] = body.decode('utf8')
        for item in (package, group_package):
            entries = unique_rows(item['files'], 'path')
            if 'bot_runtime.py' not in entries or entries['bot_runtime.py']['sha256'] != original[relative]:
                raise ValueError('Frozen runtime hash binding differs')
            entries['bot_runtime.py']['sha256'] = digest(body)
        question['definition']['evaluation']['version'] = VERSION
        group_question['definition']['evaluation']['version'] = VERSION
        for row in (group_question, changed_metadata[source]):
            transport = row.get('gatewayTransportPolicy')
            if transport is not None:
                if (not isinstance(transport, dict) or transport.get('clientTimeoutSeconds') != 90
                        or transport.get('maxAttempts') != 3 or transport.get('retryStatus') != 503
                        or transport.get('unchangedModelPoolAndEvaluationDeadline') is not True):
                    raise ValueError('Predecessor gateway transport metadata differs')
                transport['clientTimeoutSeconds'] = 210
                transport['unchangedModelPoolAndEvaluationDeadline'] = False
                transport.update(maxAttempts=1, retryStatus=None, backoffSeconds=[], minRequestIntervalSeconds=35, initialCooldownSeconds=35)
        group_question['gatewayPacingPolicy'] = copy.deepcopy(POLICY)
        changed_metadata[source]['gatewayPacingPolicy'] = copy.deepcopy(POLICY)
    new_root = replace_records(texts['manifest.json'], 'questions', 'id', questions)
    new_root = replace_records(new_root, 'packages', 'key', packages)
    new_group = replace_records(texts['adversarial/manifest.json'], 'questions', 'id', group_questions)
    new_group = replace_records(new_group, 'packages', 'key', group_packages)
    new_evidence = replace_records(texts['build-evidence.json'], 'questions', 'sourceId', changed_metadata)
    new_evidence = append_field(new_evidence, 'gatewayPacing08Patch', {
        'kind': POLICY['kind'], 'questionIds': sorted(IDS), 'sourceManifestSha256': original['manifest.json'],
        'evaluationVersion': VERSION, 'policy': POLICY, 'requiresFreshModelPoolBinding': True,
        'requiredModelPoolParameters': {'requestTimeoutMs': 180000}, 'requiresFreshCalibration': True,
        'diagnosticAndValidationEvidence': diagnostic_evidence,
        'proofPolicy': 'Old A08/D08 configuration proofs are invalid for this candidate. Strict refresh may inherit only the unchanged75 whole-question contracts. Verify a new bounded server binding and all four changed phases.'})
    retained = {
        'questions': assert_unchanged_records(texts['manifest.json'], new_root, 'questions', 'id', IDS),
        'packages': assert_unchanged_records(texts['manifest.json'], new_root, 'packages', 'key', PACKAGE_KEYS),
        'groupQuestions': assert_unchanged_records(texts['adversarial/manifest.json'], new_group, 'questions', 'id', IDS),
        'groupPackages': assert_unchanged_records(texts['adversarial/manifest.json'], new_group, 'packages', 'key', SOURCES),
        'evidenceQuestions': assert_unchanged_records(texts['build-evidence.json'], new_evidence, 'questions', 'sourceId', SOURCES),
    }
    if retained['questions'] != 75 or retained['packages'] != 67 or retained['evidenceQuestions'] != 75:
        raise ValueError('Retained record scope differs')
    replacements.update({'manifest.json': new_root, 'adversarial/manifest.json': new_group,
                         'build-evidence.json': new_evidence})
    # A prior calibrated derivative belongs to the predecessor, never this candidate.
    omitted = ['manifest-calibrated.json'] if 'manifest-calibrated.json' in original else []
    changes = set(replacements) | set(omitted)
    report = {'schemaVersion': 1, 'applied': apply, 'deploymentReady': False, 'modelCalls': 0,
              'requiresFreshCalibration': True, 'requiresFreshModelPoolBinding': True,
              'requiredNewPhasesForChangedQuestions': 4, 'evaluationVersion': VERSION,
              'affectedQuestionIds': sorted(IDS), 'policy': POLICY, 'retainedRecords': retained,
              'retainedAssets': assets, 'changedFiles': sorted(changes), 'notCopiedDerivedArtifacts': omitted,
              'previousManifestSha256': original['manifest.json'],
              'replacementManifestSha256': digest(new_root.encode('utf8')),
              'changedFileDigests': {name: {'previous': original[name], 'replacement': digest(body.encode('utf8'))}
                                     for name, body in replacements.items()}}
    for name in omitted:
        report['changedFileDigests'][name] = {'previous': original[name], 'replacement': None}
    if not apply:
        return report
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(old, out, copy_function=shutil.copy2,
                    ignore=lambda directory, names: omitted if Path(directory) == old else [])
    for name, body in replacements.items():
        replace_file(out / name, body)
    current = snapshot(out)
    if snapshot(old) != original:
        raise ValueError('Original build changed during patch')
    changed = {name for name in original.keys() | current.keys() if original.get(name) != current.get(name)}
    if changed != changes:
        raise ValueError('Changes escaped the two runtimes, three metadata files and obsolete derivative omission')
    validate_assets(out, json.loads(new_root), current)
    report['originalBuildPreserved'] = True
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--existing', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--diagnostic-evidence', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--apply', action='store_true', help='Create only an offline candidate; never deploys or calls models')
    args = parser.parse_args()
    for path in (args.existing, args.output, args.report): no_links(path)
    if args.report.exists() or any(args.report.resolve().is_relative_to(p.resolve()) for p in (args.existing, args.output)):
        raise ValueError('Report must be fresh and outside both builds')
    report = patch_build(args.existing, args.output, json.loads(args.diagnostic_evidence.read_text('utf8')), apply=args.apply)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open('x', encoding='utf8') as stream: json.dump(report, stream, indent=2, allow_nan=False)
    print(json.dumps({key: value for key, value in report.items() if key != 'changedFileDigests'}))


if __name__ == '__main__': main()

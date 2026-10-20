"""Prepare an exact four-file/two-question v5 reference-only delta.

Default operation is read-only. --apply is for a later explicit root decision
after actual diagnostic acceptance. This tool never calls models or APIs.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import shutil
from patch_watermark import append_field, assert_unchanged_records, json_text, replace_file, replace_records, snapshot
from rankshift_reference import POLICY, VERSION, repair_reference

IDS = {'V3-261012-A02', 'V3-261012-D02'}
SOURCES = {'A02', 'D02'}
REF = 'adversarial/references/D02.py'
CHANGED = {'manifest.json', 'adversarial/manifest.json', 'build-evidence.json', REF}


def digest_bytes(body):
    return hashlib.sha256(body).hexdigest()


def validate_assets(root, manifest, hashes):
    counts = {'packageFiles': 0, 'resources': 0, 'referenceBindings': 0}
    for pkg in manifest['packages']:
        for row in pkg['files']:
            if hashes.get(pkg['directory'] + '/' + row['path']) != row['sha256']:
                raise ValueError('Original package file changed')
            counts['packageFiles'] += 1
    for q in manifest['questions']:
        for resource in q['resources']:
            if hashes.get(resource['sourcePath']) != resource['sha256']:
                raise ValueError('Original public resource changed')
            counts['resources'] += 1
        for ref in [q['selfTest'], q['selfTest'].get('opponent')]:
            if ref:
                if hashes.get(ref['codePath']) != ref['codeSha256']:
                    raise ValueError('Original reference binding changed')
                counts['referenceBindings'] += 1
    return counts


def patch_build(existing, output, diagnostic_evidence, *, apply=False):
    old, out = Path(existing).resolve(), Path(output).resolve()
    if out.exists() or out.is_relative_to(old) or old.is_relative_to(out):
        raise ValueError('Output must be fresh and outside the original build')
    if not isinstance(diagnostic_evidence, dict) or not diagnostic_evidence:
        raise ValueError('Explicit diagnostic evidence is required')
    if apply:
        accepted = diagnostic_evidence.get('acceptedDiagnostic', {})
        record = accepted.get('record', {})
        result = record.get('result', {})
        metrics = result.get('metrics', {})
        measured = [metrics.get(k) for k in ('cleanRankShift', 'cleanValidRate', 'qualificationMetric')]
        if (accepted.get('model') not in ('Qwen3-8B', 'Qwen/Qwen3-8B') or
                accepted.get('candidateCodeSha256') != '4d5629d491f225de6cc29ee3349e2e956c64a6446dc96eadde41653081b6f757' or
                record.get('status') != 'completed' or result.get('status') != 'completed' or
                result.get('cleanupStatus') != 'cleaned' or metrics.get('samples') != 20 or
                any(type(v) not in (int, float) or not math.isfinite(v) for v in measured) or
                metrics.get('cleanGatePassed') != 1 or metrics.get('cleanRankShift', 100) > 5 or
                metrics.get('cleanValidRate', 0) < .99 or metrics.get('qualificationMetric', -1) < 0):
            raise ValueError('Applying requires the completed cleaned qualified 8B diagnostic for this exact candidate')
    hashes = snapshot(old)
    texts = {name: json_text(old / name) for name in CHANGED if name != REF}
    root = json.loads(texts['manifest.json'])
    group = json.loads(texts['adversarial/manifest.json'])
    evidence = json.loads(texts['build-evidence.json'])
    if len(root['questions']) != 77 or len(root['packages']) != 69:
        raise ValueError('Expected the complete 77-question/69-package candidate')
    if root.get('requiresCalibration') is not True or root.get('deploymentReady') is not False:
        raise ValueError('Only an uncalibrated candidate may be patched')
    if 'rankShiftReferenceRepairPatch' in evidence:
        raise ValueError('Reference repair already applied')
    counts = validate_assets(old, root, hashes)
    questions = {q['id']: copy.deepcopy(q) for q in root['questions'] if q['id'] in IDS}
    group_questions = {q['id']: copy.deepcopy(q) for q in group['questions'] if q['id'] in IDS}
    metadata = {q['sourceId']: copy.deepcopy(q) for q in evidence['questions'] if q['sourceId'] in SOURCES}
    if set(questions) != IDS or set(group_questions) != IDS or set(metadata) != SOURCES:
        raise ValueError('Question/evidence scope mismatch')
    for q in questions.values():
        evaluation = q['definition']['evaluation']
        if evaluation['version'] != 'v3-261012-api-rpc-http503-retry-v4':
            raise ValueError('Expected the frozen v4 transport candidate')
        if evaluation['baselineThreshold'] != 0 or evaluation['successThreshold'] != 1:
            raise ValueError('Expected uncalibrated threshold placeholders')
    original = json_text(old / REF)
    replacement = repair_reference(original)
    replacement_sha = digest_bytes(replacement.encode('utf8'))
    for collection, path in [(questions, REF), (group_questions, 'references/D02.py')]:
        defense = collection['V3-261012-D02']['selfTest']
        opponent = collection['V3-261012-A02']['selfTest']['opponent']
        for binding in [defense, opponent]:
            if binding['codePath'] != path or binding['codeSha256'] != hashes[REF]:
                raise ValueError('D02/A02 opponent reference is not the same frozen code')
            binding['codeSha256'] = replacement_sha
        for question in collection.values():
            question['definition']['evaluation']['version'] = VERSION
    for key, question in group_questions.items():
        question['officialReferenceRepair'] = copy.deepcopy(POLICY)
    for row in metadata.values():
        row['officialReferenceRepair'] = copy.deepcopy(POLICY)
    revised = {
        'manifest.json': replace_records(texts['manifest.json'], 'questions', 'id', questions),
        'adversarial/manifest.json': replace_records(texts['adversarial/manifest.json'], 'questions', 'id', group_questions),
        'build-evidence.json': replace_records(texts['build-evidence.json'], 'questions', 'sourceId', metadata),
        REF: replacement,
    }
    revised['build-evidence.json'] = append_field(revised['build-evidence.json'], 'rankShiftReferenceRepairPatch', {
        'kind': 'reference-only-empty-injection-passthrough', 'questionIds': sorted(IDS),
        'sourceManifestSha256': hashes['manifest.json'], 'originalReferenceSha256': hashes[REF],
        'replacementReferenceSha256': replacement_sha, 'evaluationVersion': VERSION,
        'policy': POLICY, 'diagnosticEvidence': diagnostic_evidence, 'requiresFreshCalibration': True,
        'retainedPackages': 69, 'retainedOtherQuestions': 75,
        'proofPolicy': 'Strict refresh may inherit only the other 75 whole-question contracts. Recalibrate all four A02/D02 phases.'})
    preserved = {
        'questions': assert_unchanged_records(texts['manifest.json'], revised['manifest.json'], 'questions', 'id', IDS),
        'packages': assert_unchanged_records(texts['manifest.json'], revised['manifest.json'], 'packages', 'key', set()),
        'evidenceQuestions': assert_unchanged_records(texts['build-evidence.json'], revised['build-evidence.json'], 'questions', 'sourceId', SOURCES),
        'groupPackages': assert_unchanged_records(texts['adversarial/manifest.json'], revised['adversarial/manifest.json'], 'packages', 'key', set()),
    }
    if preserved['questions'] != 75 or preserved['packages'] != 69 or preserved['evidenceQuestions'] != 75:
        raise ValueError('Unchanged record scope differs')
    report = {'schemaVersion': 1, 'applied': apply, 'requiresFreshCalibration': True,
        'deploymentReady': False, 'modelCalls': 0, 'changedFiles': sorted(CHANGED),
        'affectedQuestionIds': sorted(IDS), 'requiredNewPhases': 4,
        'retainedRecords': preserved, 'retainedAssets': counts,
        'previousManifestSha256': hashes['manifest.json'],
        'replacementManifestSha256': digest_bytes(revised['manifest.json'].encode('utf8')),
        'changedFileDigests': {name: {'previous': hashes[name], 'replacement': digest_bytes(body.encode('utf8'))} for name, body in revised.items()}}
    if not apply:
        return report
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(old, out, copy_function=shutil.copy2)
    for name, text in revised.items():
        replace_file(out / name, text)
    current = snapshot(out)
    if snapshot(old) != hashes:
        raise ValueError('Original build changed during patch')
    changed = {name for name in hashes.keys() | current.keys() if hashes.get(name) != current.get(name)}
    if changed != CHANGED:
        raise ValueError('Change escaped the four allowed files')
    validate_assets(out, json.loads(revised['manifest.json']), current)
    report['originalBuildPreserved'] = True
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--existing', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--diagnostic-evidence', type=Path, required=True)
    p.add_argument('--report', type=Path, required=True)
    p.add_argument('--apply', action='store_true', help='Only after root explicitly approves the measured diagnostic; acceptedDiagnostic evidence is required')
    a = p.parse_args()
    if a.report.exists() or any(a.report.resolve().is_relative_to(root.resolve())for root in [a.existing,a.output]):
        raise ValueError('Report must be fresh and outside both builds')
    result = patch_build(a.existing,a.output,json.loads(a.diagnostic_evidence.read_text('utf8')),apply=a.apply)
    a.report.parent.mkdir(parents=True,exist_ok=True)
    with a.report.open('x',encoding='utf8')as stream:json.dump(result,stream,indent=2)
    print(json.dumps(result))

"""Create an immutable D02-only restoration candidate; never calls a model."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import shutil

import rankshift_original as author
from patch_clean_reference import validate_assets
from patch_cumulative_reference import digest, no_links, unique_rows
from patch_watermark import (append_field, assert_unchanged_records, json_text,
                             records, replace_file, replace_records, snapshot)

ID = 'V3-261012-D02'
PACKAGE = 'adversarial-D02'
DIRECTORY = 'adversarial/packages/D02'
REFERENCE = 'adversarial/references/D02-original.py'
PREVIOUS_POOL = 'V3-261012-API-02'
PREVIOUS_VERSION = 'v3-261012-response-snapshot4-v11'
METADATA = {'manifest.json', 'adversarial/manifest.json', 'build-evidence.json'}


def append_record(text, key, value):
    entries = records(text, key)
    if not entries:
        raise ValueError('Expected nonempty pool metadata')
    end = entries[-1][1]
    newline = '\r\n' if '\r\n' in text else '\n'
    encoded = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
    return text[:end] + ',' + newline + '    ' + encoded.replace('\n', newline + '    ') + text[end:]


def patch_build(existing, output, *, apply=False):
    old, out = no_links(existing).resolve(), no_links(output).resolve()
    if out.exists() or out.is_relative_to(old) or old.is_relative_to(out):
        raise ValueError('Output must be fresh and outside the original build')
    before = snapshot(old)
    texts = {name: json_text(old / name) for name in METADATA}
    root, group, evidence = (json.loads(texts[name]) for name in
        ('manifest.json', 'adversarial/manifest.json', 'build-evidence.json'))
    if (len(root['questions']) != 77 or len(root['packages']) != 69 or
            root.get('requiresCalibration') is not True or root.get('deploymentReady') is not False):
        raise ValueError('Expected complete uncalibrated 77-question candidate')
    assets = validate_assets(old, root, before)
    q = copy.deepcopy(unique_rows(root['questions'], 'id')[ID])
    gq = copy.deepcopy(unique_rows(group['questions'], 'id')[ID])
    package = copy.deepcopy(unique_rows(root['packages'], 'key')[PACKAGE])
    gp = copy.deepcopy(unique_rows(group['packages'], 'key')['D02'])
    metadata = copy.deepcopy(unique_rows(evidence['questions'], 'sourceId')['D02'])
    normalized = copy.deepcopy(gq['definition'])
    normalized['evaluation'].update(baselineThreshold=0, successThreshold=1)
    if q['definition'] != normalized:
        raise ValueError('Root/group D02 definitions disagree')
    if package['directory'] != DIRECTORY or gp['directory'] != 'packages/D02':
        raise ValueError('D02 package binding differs')
    expected_group = copy.deepcopy(package)
    expected_group.update(key='D02', directory='packages/D02')
    if gp != expected_group:
        raise ValueError('Root/group D02 packages disagree')
    for name, expected in author.ORIGINAL_HASHES.items():
        if before.get(DIRECTORY + '/course/' + name) != expected:
            raise ValueError('Uploaded original D02 source differs: ' + name)
    for split in ('public', 'hidden'):
        lines = (old / DIRECTORY / 'course/data' / (split + '.jsonl')).read_text('utf8').splitlines()
        rows = [json.loads(line) for line in lines if line.strip()]
        if len(rows) != 150 or len({row['sample_id'] for row in rows}) != 150:
            raise ValueError('Expected exactly 150 distinct original samples per split')
    frozen = json.loads((old / DIRECTORY / 'frozen.json').read_bytes())
    if frozen.get('number') != '02' or frozen.get('role') != 'defense' or frozen.get('samples') != 20:
        raise ValueError('Expected frozen predecessor D02 sample contract')
    frozen['samples'] = author.SAMPLES
    environment = json.loads((old / DIRECTORY / 'manifest.json').read_bytes())
    if 'executionProfile' in environment or environment.get('resources', {}).get('timeoutMs') != 3600000:
        raise ValueError('Expected the original one-hour D02 package execution budget')
    environment['executionProfile'] = author.EXECUTION_PROFILE
    environment['resources']['timeoutMs'] = author.TIMEOUT_MS
    reference = author.reference_source((old / DIRECTORY / 'course/defense.py').read_bytes())
    if REFERENCE in before:
        raise ValueError('Original-D02 restoration already exists')
    for row, path in ((q, REFERENCE), (gq, REFERENCE.removeprefix('adversarial/'))):
        ev = row['definition']['evaluation']
        if ev.get('version') != PREVIOUS_VERSION or ev.get('samples') != 20 or row['definition']['llm'].get('enabled') is not True:
            raise ValueError('Expected the audited v11 D02 predecessor')
        if ev.get('sourceDigest') != frozen['sourceDigest'] or ev.get('seed') != frozen['seed']:
            raise ValueError('Frozen predecessor parameters disagree')
        row['definition']['evaluation'] = author.evaluation(ev)
        row['content'] = author.question_content(row['content'])
        row['selfTest'].update(codePath=path, codeSha256=digest(reference.encode('utf8')))
        row.pop('officialReferenceRepair', None)
    if (q.get('requiresCalibration') is not True or q.get('deploymentReady') is not False or
            q['definition']['evaluation']['baselineThreshold'] != 0 or q['definition']['evaluation']['successThreshold'] != 1):
        raise ValueError('Only fresh aggregate calibration placeholders may be patched')
    if gq['definition']['evaluation']['baselineThreshold'] is not None or gq['definition']['evaluation']['successThreshold'] is not None:
        raise ValueError('Group calibration thresholds must be unset')
    for row in (metadata, gq):
        row.pop('officialReferenceRepair', None)
        row.update(poolKey=author.POOL_KEY, effectiveSampleCount=author.SAMPLES, originalEvaluationRestoration=copy.deepcopy(author.POLICY))
        author.restore_metadata(row)
    if metadata.get('responseSnapshotPolicy'):
        metadata['responseSnapshotPolicy']['evaluationVersion'] = author.VERSION
        metadata['responseSnapshotPolicy']['qualityGatesAndScoringFormulaUnchanged'] = True
    frozen_text = json.dumps(frozen, indent=2) + '\n'
    environment_text = json.dumps(environment, ensure_ascii=False, indent=2) + '\n'
    for item in (package, gp):
        indexed = unique_rows(item['files'], 'path')
        for filename, body in (('frozen.json', frozen_text), ('manifest.json', environment_text)):
            if indexed[filename]['sha256'] != before[DIRECTORY + '/' + filename]:
                raise ValueError('D02 package hash differs: ' + filename)
            indexed[filename]['sha256'] = digest(body.encode('utf8'))
    old_pool = unique_rows(evidence['apiPools'], 'poolKey')[PREVIOUS_POOL]
    if author.POOL_KEY in {p['poolKey'] for p in evidence['apiPools']}:
        raise ValueError('Original-D02 pool already exists')
    pool = copy.deepcopy(old_pool)
    pool.update(poolKey=author.POOL_KEY, questionIds=[ID])
    pool['parameters']['maxCalls'] = author.MAX_MODEL_CALLS
    if old_pool['questionIds'] != ['V3-261012-A02', ID]:
        raise ValueError('Expected the audited A02/D02 pool metadata')
    retained_pool = copy.deepcopy(old_pool)
    retained_pool['questionIds'] = ['V3-261012-A02']
    new_root = replace_records(texts['manifest.json'], 'questions', 'id', {ID: q})
    new_root = replace_records(new_root, 'packages', 'key', {PACKAGE: package})
    new_group = replace_records(texts['adversarial/manifest.json'], 'questions', 'id', {ID: gq})
    new_group = replace_records(new_group, 'packages', 'key', {'D02': gp})
    new_evidence = replace_records(texts['build-evidence.json'], 'questions', 'sourceId', {'D02': metadata})
    new_evidence = replace_records(new_evidence, 'apiPools', 'poolKey', {PREVIOUS_POOL: retained_pool})
    new_evidence = append_record(new_evidence, 'apiPools', pool)
    new_evidence = append_field(new_evidence, 'd02OriginalEvaluationRestoration', {
        **author.POLICY, 'evaluationVersion': author.VERSION, 'questionId': ID,
        'sourceManifestSha256': before['manifest.json'], 'requiredNewCalibrationPhases': 2,
        'proofPolicy': 'Only unchanged76 whole-question contracts may inherit proofs; D02 requires fresh cold calibration, warm final self-tests and real isolated student-flow verification.'})
    retained = {
        'questions': assert_unchanged_records(texts['manifest.json'], new_root, 'questions', 'id', {ID}),
        'packages': assert_unchanged_records(texts['manifest.json'], new_root, 'packages', 'key', {PACKAGE}),
        'groupQuestions': assert_unchanged_records(texts['adversarial/manifest.json'], new_group, 'questions', 'id', {ID}),
        'groupPackages': assert_unchanged_records(texts['adversarial/manifest.json'], new_group, 'packages', 'key', {'D02'}),
        'evidenceQuestions': assert_unchanged_records(texts['build-evidence.json'], new_evidence, 'questions', 'sourceId', {'D02'}),
    }
    omitted = {'manifest-calibrated.json'} & before.keys()
    replacements = {'manifest.json': new_root, 'adversarial/manifest.json': new_group,
        'build-evidence.json': new_evidence,
        DIRECTORY + '/frozen.json': frozen_text, DIRECTORY + '/manifest.json': environment_text, REFERENCE: reference}
    report = {'applied': apply, 'modelCalls': 0, 'deploymentReady': False, 'requiresFreshCalibration': True,
        'affectedQuestionIds': [ID], 'evaluationVersion': author.VERSION, 'retainedRecords': retained,
        'retainedAssets': assets, 'changedFiles': sorted(replacements), 'notCopiedDerivedArtifacts': sorted(omitted),
        'previousManifestSha256': before['manifest.json'], 'replacementManifestSha256': digest(new_root.encode('utf8')),
        'maxModelCalls': author.MAX_MODEL_CALLS, 'timeoutMs': author.TIMEOUT_MS,
        'originalReferenceSha256': digest(reference.encode('utf8'))}
    if not apply:
        return report
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(old, out, copy_function=shutil.copy2,
        ignore=lambda directory, names: list(omitted) if Path(directory) == old else [])
    for name, body in replacements.items():
        replace_file(out / name, body)
    after = snapshot(out)
    if snapshot(old) != before:
        raise ValueError('Original build changed during restoration')
    if {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)} != set(replacements) | omitted:
        raise ValueError('Restoration changes escaped the D02-only allowlist')
    validate_assets(out, json.loads(new_root), after)
    report['originalBuildPreserved'] = True
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('existing', 'output', 'report'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    no_links(args.report)
    if args.report.exists() or any(args.report.resolve().is_relative_to(p.resolve()) for p in (args.existing, args.output)):
        raise ValueError('Report must be fresh and outside both builds')
    report = patch_build(args.existing, args.output, apply=args.apply)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open('x', encoding='utf8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
    print(json.dumps(report))


if __name__ == '__main__': main()

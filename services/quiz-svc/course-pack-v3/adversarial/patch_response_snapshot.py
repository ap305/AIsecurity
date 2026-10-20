"""Create an offline four-question response-policy candidate; never calls APIs."""
from __future__ import annotations
import argparse
import copy
import json
from pathlib import Path
import shutil
from patch_clean_reference import validate_assets
from patch_cumulative_reference import digest, no_links, unique_rows
from patch_watermark import append_field, assert_unchanged_records, json_text, replace_file, replace_records, snapshot

SOURCES = {'A02', 'D02', 'A09', 'D09'}
IDS = {'V3-261012-' + source for source in SOURCES}
VERSION = 'v3-261012-response-snapshot4-v11'
POLICY = 'first-valid-response-v1'
METADATA = {'manifest.json', 'adversarial/manifest.json', 'build-evidence.json'}

def patch_build(existing, output, diagnostic_evidence, *, apply=False):
    old, out = no_links(existing).resolve(), no_links(output).resolve()
    if out.exists() or out.is_relative_to(old) or old.is_relative_to(out):
        raise ValueError('Output must be fresh and outside the original build')
    if not isinstance(diagnostic_evidence, dict) or diagnostic_evidence.get('approvedScope') != sorted(IDS):
        raise ValueError('Evidence must bind the exact approved four-question scope')
    json.dumps(diagnostic_evidence, allow_nan=False)
    original = snapshot(old)
    texts = {name: json_text(old / name) for name in METADATA}
    root, group, evidence = (json.loads(texts[name]) for name in ['manifest.json', 'adversarial/manifest.json', 'build-evidence.json'])
    if (len(root['questions']) != 77 or len(root['packages']) != 69 or
            root.get('requiresCalibration') is not True or root.get('deploymentReady') is not False):
        raise ValueError('Expected the complete uncalibrated77 manifest')
    assets = validate_assets(old, root, original)
    rq, gq = unique_rows(root['questions'], 'id'), unique_rows(group['questions'], 'id')
    metadata = unique_rows(evidence['questions'], 'sourceId')
    if not (IDS <= rq.keys() and IDS <= gq.keys() and SOURCES <= metadata.keys() and len(metadata) == 77):
        raise ValueError('Four-question metadata scope differs')
    questions = {key: copy.deepcopy(rq[key]) for key in IDS}
    group_questions = {key: copy.deepcopy(gq[key]) for key in IDS}
    changed_metadata = {key: copy.deepcopy(metadata[key]) for key in SOURCES}
    for source in sorted(SOURCES):
        qid = 'V3-261012-' + source
        # Group manifests intentionally leave thresholds unset; only the
        # aggregate raw manifest carries calibration placeholders 0 and 1.
        normalized_group = copy.deepcopy(gq[qid]['definition'])
        if (normalized_group['evaluation'].get('baselineThreshold') is not None or
                normalized_group['evaluation'].get('successThreshold') is not None):
            raise ValueError('Group thresholds must remain unset before calibration')
        normalized_group['evaluation'].update(baselineThreshold=0, successThreshold=1)
        if rq[qid]['definition'] != normalized_group:
            raise ValueError('Root and group definitions disagree')
        root_ev = questions[qid]['definition']['evaluation']
        if (questions[qid].get('requiresCalibration') is not True or questions[qid].get('deploymentReady') is not False or
                root_ev['baselineThreshold'] != 0 or root_ev['successThreshold'] != 1):
            raise ValueError('Expected aggregate uncalibrated placeholders')
        for row in (questions[qid], group_questions[qid]):
            ev = row['definition']['evaluation']
            if (row['definition']['llm'].get('enabled') is not True or
                    ev.get('version') == VERSION):
                raise ValueError('Expected untouched uncalibrated predecessor definitions')
            params = ev.setdefault('parameters', {})
            if not isinstance(params, dict) or 'responseSnapshotPolicy' in params or 'responseSnapshotScope' in params:
                raise ValueError('Response policy must be new and explicit')
            ev['version'] = VERSION
            params.update(responseSnapshotPolicy=POLICY, responseSnapshotScope=qid)
        changed_metadata[source]['responseSnapshotPolicy'] = {
            'policy': POLICY, 'scope': qid, 'evaluationVersion': VERSION,
            'firstLegalReal8BResponseOnly': True, 'errorsNotStored': True,
            'privateStoreRequired': True, 'qualityGatesAndScoringFormulaUnchanged': True,
        }
    new_root = replace_records(texts['manifest.json'], 'questions', 'id', questions)
    new_group = replace_records(texts['adversarial/manifest.json'], 'questions', 'id', group_questions)
    new_evidence = replace_records(texts['build-evidence.json'], 'questions', 'sourceId', changed_metadata)
    new_evidence = append_field(new_evidence, 'responseSnapshot4Patch', {
        'policy': POLICY, 'questionIds': sorted(IDS), 'evaluationVersion': VERSION,
        'sourceManifestSha256': original['manifest.json'], 'requiresFreshCalibration': True,
        'requiredNewCalibrationPhases': 8, 'requiredNewFinalSelfTestPhases': 8,
        'diagnosticAndValidationEvidence': diagnostic_evidence,
        'proofPolicy': 'Only unchanged73 whole-question contracts may inherit proofs. New four-question domains require cold calibration, warm final self-tests and real student-flow verification.'})
    retained = {
        'questions': assert_unchanged_records(texts['manifest.json'], new_root, 'questions', 'id', IDS),
        'packages': assert_unchanged_records(texts['manifest.json'], new_root, 'packages', 'key', set()),
        'groupQuestions': assert_unchanged_records(texts['adversarial/manifest.json'], new_group, 'questions', 'id', IDS),
        'evidenceQuestions': assert_unchanged_records(texts['build-evidence.json'], new_evidence, 'questions', 'sourceId', SOURCES),
    }
    if retained['questions'] != 73 or retained['packages'] != 69 or retained['evidenceQuestions'] != 73:
        raise ValueError('Retained scope differs')
    replacements = {'manifest.json': new_root, 'adversarial/manifest.json': new_group, 'build-evidence.json': new_evidence}
    omitted = ['manifest-calibrated.json'] if 'manifest-calibrated.json' in original else []
    report = {'applied': apply, 'deploymentReady': False, 'modelCalls': 0,
              'affectedQuestionIds': sorted(IDS), 'evaluationVersion': VERSION,
              'requiredNewCalibrationPhases': 8, 'requiredNewFinalSelfTestPhases': 8,
              'retainedRecords': retained, 'retainedAssets': assets,
              'notCopiedDerivedArtifacts': omitted, 'changedFiles': sorted(METADATA | set(omitted)),
              'previousManifestSha256': original['manifest.json'],
              'replacementManifestSha256': digest(new_root.encode('utf8'))}
    if not apply: return report
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(old, out, copy_function=shutil.copy2,
                    ignore=lambda directory, names: omitted if Path(directory) == old else [])
    for name, text in replacements.items(): replace_file(out / name, text)
    current = snapshot(out)
    if snapshot(old) != original: raise ValueError('Original changed during patch')
    changed = {name for name in original.keys() | current.keys() if original.get(name) != current.get(name)}
    if changed != METADATA | set(omitted): raise ValueError('Changes escaped metadata and obsolete derivative omission')
    validate_assets(out, json.loads(new_root), current)
    report['originalBuildPreserved'] = True
    return report

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['existing', 'output', 'diagnostic-evidence', 'report']: parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    for file in (args.existing, args.output, args.report): no_links(file)
    if args.report.exists() or any(args.report.resolve().is_relative_to(p.resolve()) for p in (args.existing, args.output)):
        raise ValueError('Report must be fresh and outside both builds')
    report = patch_build(args.existing, args.output, json.loads(args.diagnostic_evidence.read_text('utf8')), apply=args.apply)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open('x', encoding='utf8') as stream: json.dump(report, stream, indent=2, allow_nan=False)
    print(json.dumps(report))

if __name__ == '__main__': main()

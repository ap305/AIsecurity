#!/usr/bin/env python
"""Bind successful official-reference self-test measurements to immutable course thresholds.

Input measurements: [{questionId,phase:'baseline'|'opponent',result:{status,metrics},
                     referenceCodeSha256,opponentReferenceCodeSha256?,measuredAt}].
The HTTP orchestrator performs the real isolated evaluations; this tool never runs student code.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path


def calibrate(questions, measurements):
    indexed = {(row['questionId'], row['phase']): row for row in measurements}
    by_scenario_role = {(q['scenarioId'], q['role']): q for q in questions}
    policy, report = {}, []
    for q in questions:
        roles = policy.setdefault(q['scenarioId'], {})
        phases = roles.setdefault(q['role'], {})
        for stage, phase, output_key, mode, fixed_key in (
            ('qualification', 'baseline', 'qualificationMetric', 'baseline', 'baselineThreshold'),
            ('success', 'opponent', 'successMetric', 'opponent', 'successThreshold'),
        ):
            record = indexed.get((q['questionId'], phase))
            if not record or record.get('result', {}).get('status') != 'completed':
                raise ValueError(f'{q["questionId"]}: missing completed {phase} reference run')
            expected = hashlib.sha256(q['solution'].encode()).hexdigest()
            if record.get('referenceCodeSha256') != expected:
                raise ValueError('reference source does not match generated course source')
            if phase == 'opponent':
                other = by_scenario_role[(q['scenarioId'], 'defense' if q['role'] == 'attack' else 'attack')]
                if record.get('opponentReferenceCodeSha256') != hashlib.sha256(other['solution'].encode()).hexdigest():
                    raise ValueError('opponent reference source mismatch')
            value = record['result'].get('metrics', {}).get(output_key)
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f'{q["questionId"]}: invalid {output_key}')
            fixed = q['calibration'][mode] == 'fixed'
            threshold = q['calibration'][fixed_key] if fixed else value
            evidence = {'sourceDigest': q['provenance']['sourceDigest'], 'assets': q['provenance']['assets'],
                        'image': q['provenance']['image'], 'seed': 42, 'measuredAt': record.get('measuredAt'),
                        'referenceCodeSha256': expected, 'phase': phase, 'measuredValue': value,
                        'metrics': record['result']['metrics']}
            phases[stage] = {'metric': q['metrics'][stage], 'threshold': threshold,
                             'source': 'original-v2-explicit-rule' if fixed else 'official-reference-fixed-data',
                             'evidence': evidence}
            report.append({'questionId': q['questionId'], 'phase': phase, 'threshold': threshold,
                           'referenceValue': value, 'referencePasses': value >= threshold,
                           'explicitRuleRetained': fixed})
    return policy, report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--questions', type=Path, required=True)
    parser.add_argument('--measurements', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    policy, report = calibrate(json.loads(args.questions.read_text(encoding='utf8')),
                               json.loads(args.measurements.read_text(encoding='utf8')))
    if args.output.exists():
        raise FileExistsError('select a new policy output path')
    args.output.write_text(json.dumps(policy, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf8')
    args.output.with_suffix('.report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps({'roles': len(policy) * 2, 'referenceFailuresAtExplicitRules': [r for r in report if not r['referencePasses']]}))

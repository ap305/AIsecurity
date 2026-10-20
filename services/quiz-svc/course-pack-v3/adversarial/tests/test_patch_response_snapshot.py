import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_patch_cumulative_reference as fixtures
import patch_response_snapshot as subject

class SnapshotPatchTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CumulativeReferencePatchTests('test_default_plan_is_read_only_and_exact_scope')
        self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.old, self.new = self.fixture.old, self.fixture.new
        self.evidence = {'approvedScope': sorted(subject.IDS), 'kind': 'synthetic offline fixture'}

    def test_plan_does_not_write_or_expand_the_approved_four_question_scope(self):
        before = subject.snapshot(self.old)
        report = subject.patch_build(self.old, self.new, self.evidence)
        self.assertEqual(subject.snapshot(self.old), before); self.assertFalse(self.new.exists())
        self.assertEqual(report['affectedQuestionIds'], sorted(subject.IDS))
        self.assertEqual(report['requiredNewCalibrationPhases'], 8)
        self.assertEqual(report['requiredNewFinalSelfTestPhases'], 8)
        self.assertEqual(report['modelCalls'], 0)

    def test_apply_changes_only_four_definitions_and_three_metadata_files(self):
        before = subject.snapshot(self.old)
        report = subject.patch_build(self.old, self.new, self.evidence, apply=True)
        after = subject.snapshot(self.new)
        self.assertEqual(set(before), set(after))
        self.assertEqual({n for n in before if before[n] != after[n]}, subject.METADATA)
        root = json.loads((self.new / 'manifest.json').read_bytes())
        for old, new in zip(self.fixture.root['questions'], root['questions']):
            expected = copy.deepcopy(old)
            if old['id'] in subject.IDS:
                expected['definition']['evaluation']['version'] = subject.VERSION
                expected['definition']['evaluation'].setdefault('parameters', {}).update(responseSnapshotPolicy=subject.POLICY, responseSnapshotScope=old['id'])
            self.assertEqual(new, expected)
        self.assertEqual(root['packages'], self.fixture.root['packages'])
        self.assertEqual(report['retainedRecords']['questions'], 73)
        self.assertEqual(report['retainedRecords']['packages'], 69)
        self.assertEqual(subject.snapshot(self.old), before)

    def test_already_calibrated_derivative_is_omitted_without_touching_original(self):
        self.fixture.put('manifest-calibrated.json', b'{"deploymentReady":true}')
        before = subject.snapshot(self.old)
        report = subject.patch_build(self.old, self.new, self.evidence, apply=True)
        self.assertFalse((self.new / 'manifest-calibrated.json').exists())
        self.assertEqual(subject.snapshot(self.old), before)
        self.assertEqual(report['notCopiedDerivedArtifacts'], ['manifest-calibrated.json'])

    def test_bad_assets_and_ready_or_repeated_inputs_fail_before_output(self):
        self.fixture.put('shared/reference.py', b'tampered')
        with self.assertRaises(ValueError): subject.patch_build(self.old, self.new, self.evidence, apply=True)
        self.assertFalse(self.new.exists())

    def test_unapproved_scope_evidence_and_nested_output_are_rejected(self):
        for evidence in [{}, {'approvedScope': ['V3-261012-A03']}, {'approvedScope': sorted(subject.IDS), 'x': float('nan')}]:
            with self.assertRaises(ValueError): subject.patch_build(self.old, self.new, evidence)
        with self.assertRaises(ValueError): subject.patch_build(self.old, self.old / 'nested', self.evidence)

    def test_repeated_policy_cannot_be_patched_again(self):
        subject.patch_build(self.old, self.new, self.evidence, apply=True)
        with self.assertRaises(ValueError): subject.patch_build(self.new, self.fixture.base / 'again', self.evidence, apply=True)

if __name__ == '__main__': unittest.main()

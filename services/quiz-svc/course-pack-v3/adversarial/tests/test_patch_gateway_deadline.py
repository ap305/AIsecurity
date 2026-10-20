from __future__ import annotations
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_patch_cumulative_reference as fixtures
import patch_gateway_deadline as subject


class DeadlinePatchTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CumulativeReferencePatchTests('test_default_plan_is_read_only_and_exact_scope')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.old, self.new = self.fixture.old, self.fixture.new
        self.root, self.group = self.fixture.root, self.fixture.group
        runtime = (Path(subject.__file__).parent / 'bot_runtime.py').read_bytes()
        for key in ['A08', 'D08']:
            sha = self.fixture.put('adversarial/packages/' + key + '/bot_runtime.py', runtime)
            for rows, field, value in [(self.root['packages'], 'key', 'adversarial-' + key),
                                        (self.group['packages'], 'key', key)]:
                p = next(p for p in rows if p[field] == value)
                next(f for f in p['files'] if f['path'] == 'bot_runtime.py')['sha256'] = sha
        self.fixture.write_json('manifest.json', self.root)
        self.fixture.write_json('adversarial/manifest.json', self.group)
        self.evidence = {'kind': 'offline synthetic transport fixture, no model calls'}

    def test_default_is_read_only_and_requires_new_binding_and_four_proofs(self):
        before = subject.snapshot(self.old)
        r = subject.patch_build(self.old, self.new, self.evidence)
        self.assertFalse(self.new.exists())
        self.assertEqual(subject.snapshot(self.old), before)
        self.assertFalse(r['applied'])
        self.assertEqual(len(r['changedFiles']), 5)
        self.assertEqual(r['modelCalls'], 0)
        self.assertEqual(r['requiredNewPhasesForChangedQuestions'], 4)
        self.assertTrue(r['requiresFreshModelPoolBinding'])
        self.assertEqual(r['policy']['serverRequestTimeoutMs'], 180000)
        self.assertEqual(r['policy']['clientTimeoutSeconds'], 210)

    def test_apply_retains_other_75_contracts_all_references_resources_and_67_packages(self):
        before = subject.snapshot(self.old)
        r = subject.patch_build(self.old, self.new, self.evidence, apply=True)
        after = subject.snapshot(self.new)
        self.assertEqual(subject.snapshot(self.old), before)
        self.assertEqual({n for n in before if before[n] != after[n]}, set(r['changedFiles']))
        self.assertEqual(set(before), set(after))
        root = json.loads((self.new / 'manifest.json').read_bytes())
        for old, new in zip(self.root['questions'], root['questions']):
            expected = copy.deepcopy(old)
            if old['id'] in subject.IDS:
                expected['definition']['evaluation']['version'] = subject.VERSION
            self.assertEqual(new, expected)
        for name in before:
            if name not in r['changedFiles']:
                self.assertEqual(before[name], after[name])
        self.assertEqual(r['retainedRecords']['questions'], 75)
        self.assertEqual(r['retainedRecords']['packages'], 67)
        self.assertTrue(r['originalBuildPreserved'])

    def test_noncanonical_runtime_is_rejected_before_any_output(self):
        sha = self.fixture.put('adversarial/packages/A08/bot_runtime.py', b'changed runtime')
        for rows, key in [(self.root['packages'], 'adversarial-A08'), (self.group['packages'], 'A08')]:
            package = next(p for p in rows if p['key'] == key)
            next(f for f in package['files'] if f['path'] == 'bot_runtime.py')['sha256'] = sha
        self.fixture.write_json('manifest.json', self.root)
        self.fixture.write_json('adversarial/manifest.json', self.group)
        with self.assertRaisesRegex(ValueError, 'canonical'): subject.patch_build(self.old, self.new, self.evidence, apply=True)
        self.assertFalse(self.new.exists())

    def test_existing_transport_policy_metadata_agrees_with_effective_runtime(self):
        policy = {'clientTimeoutSeconds': 90, 'unchangedModelPoolAndEvaluationDeadline': True,
                  'maxAttempts': 3, 'retryStatus': 503}
        metadata = json.loads((self.old / 'build-evidence.json').read_bytes())
        for source in ['A08', 'D08']:
            next(q for q in self.group['questions'] if q['id'] == 'V3-261012-' + source)['gatewayTransportPolicy'] = copy.deepcopy(policy)
            next(q for q in metadata['questions'] if q['sourceId'] == source)['gatewayTransportPolicy'] = copy.deepcopy(policy)
        self.fixture.write_json('adversarial/manifest.json', self.group)
        self.fixture.write_json('build-evidence.json', metadata)
        subject.patch_build(self.old, self.new, self.evidence, apply=True)
        for file, key in [('adversarial/manifest.json', 'id'), ('build-evidence.json', 'sourceId')]:
            rows = json.loads((self.new / file).read_bytes())['questions']
            for source in ['A08', 'D08']:
                record = next(q for q in rows if q[key] == ('V3-261012-' if key == 'id' else '') + source)
                self.assertEqual(record['gatewayTransportPolicy']['clientTimeoutSeconds'], 210)
                self.assertFalse(record['gatewayTransportPolicy']['unchangedModelPoolAndEvaluationDeadline'])
                self.assertEqual(record['gatewayTransportPolicy']['maxAttempts'], 3)

    def test_root_group_hash_disagreement_is_rejected(self):
        next(p for p in self.group['packages'] if p['key'] == 'D08')['files'][0]['sha256'] = '0' * 64
        self.fixture.write_json('adversarial/manifest.json', self.group)
        with self.assertRaises(ValueError): subject.patch_build(self.old, self.new, self.evidence)
        self.assertFalse(self.new.exists())

    def test_ready_manifest_cannot_be_rewritten(self):
        self.root['deploymentReady'] = True
        self.fixture.write_json('manifest.json', self.root)
        with self.assertRaises(ValueError): subject.patch_build(self.old, self.new, self.evidence, apply=True)
        self.assertFalse(self.new.exists())

    def test_invalid_evidence_and_nested_or_existing_outputs_are_rejected(self):
        for evidence in [{}, {'n': float('nan')}]:
            with self.assertRaises(ValueError): subject.patch_build(self.old, self.new, evidence)
        with self.assertRaises(ValueError): subject.patch_build(self.old, self.old / 'inside', self.evidence)
        with self.assertRaises(ValueError): subject.patch_build(self.old, self.old, self.evidence)

    def test_repeated_patch_is_rejected_without_output(self):
        subject.patch_build(self.old, self.new, self.evidence, apply=True)
        target = self.fixture.base / 'third'
        with self.assertRaises(ValueError): subject.patch_build(self.new, target, self.evidence, apply=True)
        self.assertFalse(target.exists())

    def test_old_ready_derived_manifest_is_not_carried_into_unready_candidate(self):
        self.fixture.put('manifest-calibrated.json', b'{"deploymentReady":true,"oldProofs":true}')
        before = subject.snapshot(self.old)
        report = subject.patch_build(self.old, self.new, self.evidence, apply=True)
        self.assertFalse((self.new / 'manifest-calibrated.json').exists())
        self.assertEqual(subject.snapshot(self.old), before)
        self.assertEqual(report['notCopiedDerivedArtifacts'], ['manifest-calibrated.json'])
        self.assertEqual(len(report['changedFiles']), 6)

    def load_patched_runtime(self):
        subject.patch_build(self.old, self.new, self.evidence, apply=True)
        path = self.new / 'adversarial/packages/D08/bot_runtime.py'
        spec = importlib.util.spec_from_file_location('isolated_deadline_fixture', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_503_retry_keeps_identical_payload_attempt_budget_and_only_changes_wait(self):
        runtime = self.load_patched_runtime()
        calls = []
        def upstream(request, timeout):
            calls.append((request.data, timeout))
            if len(calls) < 3: raise urllib.error.HTTPError(request.full_url, 503, 'fixture', {}, io.BytesIO())
            return io.BytesIO(b'{"choices":[{"message":{"content":"normal loss"}}]}')
        with patch.object(runtime.urllib.request, 'urlopen', side_effect=upstream), patch.object(runtime.time, 'sleep') as sleep:
            gateway = runtime.Gateway({'url': 'http://127.0.0.1:9', 'token': 'fixture'})
            message = gateway.message([{'role': 'user', 'content': 'fixed'}])
            self.assertEqual(message['content'], 'normal loss')
            self.assertEqual(gateway.calls, 3)
        self.assertEqual(len(set(body for body, _ in calls)), 1)
        self.assertEqual([timeout for _, timeout in calls], [210, 210, 210])
        self.assertEqual([c.args for c in sleep.call_args_list], [(1,), (2,)])

    def test_unknown_timeout_does_not_retry_or_cache_failure(self):
        runtime = self.load_patched_runtime()
        gateway = runtime.Gateway({'url': 'http://127.0.0.1:9', 'token': 'fixture'})
        with patch.object(runtime.urllib.request, 'urlopen', side_effect=TimeoutError()) as request:
            with self.assertRaises(runtime.CourseFailure): gateway.message([{'role': 'user', 'content': 'fixed'}])
        self.assertEqual(request.call_count, 1)
        self.assertEqual(gateway.calls, 1)
        self.assertEqual(gateway.cache, {})


if __name__ == '__main__': unittest.main()

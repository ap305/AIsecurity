from __future__ import annotations
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build
import patch_gateway as subject

TEST_ROOT = Path(__file__).resolve().parents[5] / '.test-artifacts'


class GatewayPatchTests(unittest.TestCase):
    def setUp(self):
        TEST_ROOT.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.old, self.new = self.base / 'old', self.base / 'new'
        self.old.mkdir()
        questions, packages, metadata, group_questions, group_packages = [], [], [], [], []
        for source_id in sorted(subject.SOURCE_IDS):
            qid = 'V3-261012-' + source_id
            directory = self.old / 'adversarial/packages' / source_id
            (directory / 'public').mkdir(parents=True)
            (directory / 'bot_runtime.py').write_bytes(b'old trusted runtime\n')
            (directory / 'public/helper.py').write_bytes(b'original public interface\n')
            (directory / 'teacher.bin').write_bytes(b'original samples and weights\x00\x01')
            package = {'key': source_id, 'directory': 'packages/' + source_id,
                'files': [{'path': p.relative_to(directory).as_posix(), 'sha256': build.sha(p)} for p in build.files_under(directory)]}
            group_packages.append(package)
            resource = self.old / 'adversarial/resources' / qid / 'student.zip'
            resource.parent.mkdir(parents=True)
            resource.write_bytes(b'exact immutable public ZIP bytes')
            question = {'id': qid, 'sourceId': source_id, 'definition': {'llm': {'enabled': True},
                'evaluation': {'version': 'before-v4', 'baselineThreshold': 0, 'successThreshold': 1,
                               'samples': 40, 'seed': 42, 'maxModelCalls': 1000}},
                'packageKey': source_id, 'requiresCalibration': True,
                'resources': [{'sourcePath': resource.relative_to(self.old / 'adversarial').as_posix(), 'sha256': build.sha(resource)}]}
            group_questions.append(question)
            root_question = copy.deepcopy(question)
            root_question['packageKey'] = 'adversarial-' + source_id
            root_question['deploymentReady'] = False
            root_question['resources'][0]['sourcePath'] = 'adversarial/' + root_question['resources'][0]['sourcePath']
            questions.append(root_question)
            root_package = copy.deepcopy(package)
            root_package.update(key='adversarial-' + source_id, directory='adversarial/' + package['directory'])
            packages.append(root_package)
            metadata.append({'sourceId': source_id, 'original': {'threshold': .85, 'reference': 'unchanged'}})
        for i in range(45):
            questions.append({'id': 'nonapi-' + str(i), 'definition': {'llm': {'enabled': False}}, 'content': '中文原文 [literal] {x}', 'resources': []})
            metadata.append({'sourceId': 'nonapi-' + str(i), 'original': [i]})
        build.write_json(self.old / 'manifest.json', {'schemaVersion': 1, 'requiresCalibration': True, 'deploymentReady': False,
            'questions': questions, 'packages': packages})
        build.write_json(self.old / 'adversarial/manifest.json', {'questions': group_questions, 'packages': group_packages})
        build.write_json(self.old / 'build-evidence.json', {'questions': metadata, 'apiPools': [{'parameters': {'maxCalls': 1000, 'seed': 42}}]})
        (self.old / 'shared-resource.bin').write_bytes(bytes(range(256)))

    def test_changes_only_32_runtimes_versions_and_evidence_preserves_original(self):
        before = subject.snapshot(self.old)
        report = subject.patch_build(self.old, self.new, {'localHttpTests': 'fixture only'})
        self.assertEqual(subject.snapshot(self.old), before)
        self.assertEqual(report['affectedQuestions'], 32)
        self.assertEqual(report['unchangedRecordCounts']['rootQuestions'], 45)
        self.assertEqual(report['unchangedRecordCounts']['evidenceQuestions'], 45)
        self.assertEqual(len(report['changedFiles']), 35)
        self.assertEqual((self.old / 'shared-resource.bin').read_bytes(), (self.new / 'shared-resource.bin').read_bytes())
        after = json.loads((self.new / 'manifest.json').read_bytes())
        old = json.loads((self.old / 'manifest.json').read_bytes())
        for previous, current in zip(old['questions'], after['questions']):
            if previous['id'] in subject.IDS:
                expected = copy.deepcopy(previous)
                expected['definition']['evaluation']['version'] = subject.API_EVALUATION_VERSION
                self.assertEqual(current, expected)
            else:
                self.assertEqual(current, previous)
        evidence = json.loads((self.new / 'build-evidence.json').read_bytes())
        self.assertTrue(evidence['gatewayTransportPatch']['requiresFreshCalibration'])
        self.assertEqual(evidence['apiPools'], json.loads((self.old / 'build-evidence.json').read_bytes())['apiPools'])

    def test_rejects_reusing_output_or_changing_a_manifest_runtime_hash(self):
        with self.assertRaisesRegex(ValueError, 'fresh directory'):
            subject.patch_build(self.old, self.old, {'fixture': True})
        target = self.old / 'adversarial/packages/A02/bot_runtime.py'
        target.write_bytes(b'tampered old runtime')
        with self.assertRaisesRegex(ValueError, 'Existing runtime'):
            subject.patch_build(self.old, self.new, {'fixture': True})
        self.assertFalse(self.new.exists())

    def test_cannot_repatch_v4_or_patch_a_published_candidate(self):
        path = self.old / 'manifest.json'
        value = json.loads(path.read_bytes())
        value['deploymentReady'] = True
        build.write_json(path, value)
        with self.assertRaisesRegex(ValueError, 'uncalibrated candidate'):
            subject.patch_build(self.old, self.new, {'fixture': True})
        value['deploymentReady'] = False
        value['questions'][0]['definition']['evaluation']['version'] = subject.API_EVALUATION_VERSION
        build.write_json(path, value)
        with self.assertRaisesRegex(ValueError, 'already applied'):
            subject.patch_build(self.old, self.new, {'fixture': True})


if __name__ == '__main__': unittest.main()

from __future__ import annotations
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build
import patch_watermark as subject

CONFIG = {'synonym_ratio': .1, 'swap_ratio': 0., 'delete_ratio': 0., 'seed': 42}
TEST_ROOT = Path(__file__).resolve().parents[5] / '.test-artifacts'
POOL = {'poolKey': 'V3-261012-API-03', 'parameters': {'seed': 42, 'temperature': 0}}


def pair_fixture(output, configured=False):
    output.mkdir(parents=True)
    result = {'schemaVersion': 1, 'packId': 'V3-261012', 'packages': [], 'questions': []}
    refs = {}
    for source_id in ('A03', 'D03'):
        ref = output / 'references' / (source_id + '.py')
        ref.parent.mkdir(exist_ok=True)
        ref.write_text(source_id + (' configured' if configured and source_id == 'A03' else ' original'), encoding='utf8')
        refs[source_id] = {'codePath': ref.relative_to(output).as_posix(), 'codeSha256': build.sha(ref)}
    for source_id in ('A03', 'D03'):
        package = output / 'packages' / source_id
        for folder, name, text in [('course', 'teacher.py', 'original hard gates'), ('public', 'helper.py', 'original student defaults'),
                                   ('', 'detection-order.key', 'a' * 64), ('', 'model-parameters.json', '{}'),
                                   ('', 'class_runtime.py', 'configured runtime' if configured else 'original runtime')]:
            path = package / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf8')
        resource = output / 'resources' / ('V3-261012-' + source_id) / 'student.zip'
        resource.parent.mkdir(parents=True)
        resource.write_bytes(b'public resource new' if configured else b'public resource old')
        evaluation = {'version': 'configured' if configured else 'original', 'baselineThreshold': None, 'successThreshold': None}
        if configured:
            evaluation['referenceAttackConfig'] = CONFIG
        question = {'id': 'V3-261012-' + source_id, 'sourceId': source_id, 'title': source_id, 'category': 'adversarial',
                    'definition': {'evaluation': evaluation}, 'packageKey': source_id,
                    'selfTest': {**refs[source_id], 'opponent': refs['D03' if source_id == 'A03' else 'A03']},
                    'resources': [{'sourcePath': resource.relative_to(output).as_posix(), 'filename': resource.name, 'sha256': build.sha(resource)}]}
        if configured:
            question['officialReferenceConfiguration'] = {'config': CONFIG, 'algorithm': 'LocalEditAttack'}
        result['questions'].append(question)
        result['packages'].append({'key': source_id, 'directory': package.relative_to(output).as_posix(),
                                   'files': [{'path': p.relative_to(package).as_posix(), 'sha256': build.sha(p)} for p in build.files_under(package)]})
    build.write_json(output / 'manifest.json', result)
    build.write_json(output / 'api-pools.json', {'pools': [POOL]})
    return result


class PatchWatermarkTests(unittest.TestCase):
    def setUp(self):
        TEST_ROOT.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.existing = self.root / 'old'
        self.output = self.root / 'new'
        pair = pair_fixture(self.existing / 'adversarial')
        questions = [subject.root_question(q) for q in pair['questions']]
        packages = copy.deepcopy(pair['packages'])
        for package in packages:
            package['key'], package['directory'] = 'adversarial-' + package['key'], 'adversarial/' + package['directory']
        metadata = [{key: value for key, value in q.items() if key not in subject.QUESTION_KEYS} for q in pair['questions']]
        for i in range(75):
            questions.append({'id': 'unchanged-' + str(i), 'content': 'Unicode中文, [literal] {}', 'index': i})
            packages.append({'key': 'unchanged-' + str(i), 'files': [{'path': 'original', 'sha256': str(i)}]})
            metadata.append({'sourceId': 'unchanged-' + str(i), 'data': [i, {'keep': True}]})
        build.write_json(self.existing / 'manifest.json', {'schemaVersion': 1, 'requiresCalibration': True,
                         'deploymentReady': False, 'questions': questions, 'packages': packages})
        build.write_json(self.existing / 'build-evidence.json', {'schemaVersion': 1, 'image': 'image@sha256:fixture', 'questions': metadata, 'apiPools': [POOL]})
        (self.existing / 'unrelated-asset.bin').write_bytes(bytes(range(256)))

    def builder(self, source, output, image, bigram, **kwargs):
        self.assertEqual(kwargs['numbers'], ['03'])
        self.assertEqual(kwargs['watermark_reference_config'], CONFIG)
        self.assertEqual(kwargs['watermark_private_order_key'], 'a' * 64)
        return pair_fixture(output, True)

    def run_patch(self):
        return subject.patch_build(self.existing, self.output, self.root, self.root / 'bigram', CONFIG,
                                   {'originalFailure': {'qualityGatePassed': 0, 'qualificationMetric': -1}})

    def test_new_pair_only_and_original_build_all_bytes_unchanged(self):
        before = subject.snapshot(self.existing)
        with patch.object(build, 'build', side_effect=self.builder):
            report = self.run_patch()
        self.assertEqual(subject.snapshot(self.existing), before)
        self.assertEqual(report['unchangedRecordCounts']['rootQuestions'], 75)
        self.assertEqual(report['unchangedRecordCounts']['rootPackages'], 75)
        self.assertEqual(report['unchangedRecordCounts']['evidenceQuestions'], 75)
        self.assertTrue(all(subject.affected_file(name) for name in report['changedFiles']))
        self.assertEqual((self.existing / 'unrelated-asset.bin').read_bytes(), (self.output / 'unrelated-asset.bin').read_bytes())
        manifest = json.loads((self.output / 'manifest.json').read_text('utf8'))
        a, d = manifest['questions'][:2]
        self.assertEqual(a['selfTest']['codeSha256'], d['selfTest']['opponent']['codeSha256'])
        self.assertFalse(a['deploymentReady'])
        evidence = json.loads((self.output / 'build-evidence.json').read_text('utf8'))
        self.assertEqual(evidence['watermarkReferencePatch']['previousFailureAndDiagnostics']['originalFailure']['qualificationMetric'], -1)

    def test_student_helpers_cannot_change(self):
        def bad_builder(*args, **kwargs):
            result = self.builder(*args, **kwargs)
            (args[1] / 'packages/A03/public/helper.py').write_text('new student defaults', encoding='utf8')
            return result
        with patch.object(build, 'build', side_effect=bad_builder), self.assertRaisesRegex(ValueError, 'public student helpers'):
            self.run_patch()
        self.assertFalse(self.output.exists())

    def test_existing_or_nested_output_is_rejected_before_build(self):
        for destination in (self.existing, self.existing / 'nested'):
            self.output = destination
            with patch.object(build, 'build') as builder, self.assertRaises(ValueError):
                self.run_patch()
            builder.assert_not_called()

    def test_raw_json_replacement_preserves_unrelated_bytes_and_crlf(self):
        text = '{\r\n  "questions": [\r\n    { "id": "keep", "v": [1,  2] },\r\n    {"id":"change","v":0}\r\n  ]\r\n}\r\n'
        result = subject.replace_records(text, 'questions', 'id', {'change': {'id': 'change', 'v': 1}})
        self.assertIn('{ "id": "keep", "v": [1,  2] }', result)
        self.assertEqual(subject.assert_unchanged_records(text, result, 'questions', 'id', {'change'}), 1)
        self.assertTrue(result.endswith('\r\n'))
        self.assertEqual(json.loads(result)['questions'][1]['v'], 1)


if __name__ == '__main__':
    unittest.main()

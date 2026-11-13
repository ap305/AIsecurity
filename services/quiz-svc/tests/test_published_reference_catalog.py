import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'buildPublishedReferenceCatalog.py'
spec = importlib.util.spec_from_file_location('published_catalog', SCRIPT)
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class PublishedReferenceCatalogTests(unittest.TestCase):
    def fixture(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        package_id = '12345678-1234-1234-1234-123456789abc'
        package = root / package_id
        package.mkdir()
        source = '''SECRET_DATASET = "NEVER_PUBLISH_THIS_SECRET"
raise RuntimeError("SOURCE_MUST_NEVER_EXECUTE")
def extraction_run(course, number, worker, guard, models, parameters):
    return {"attackMetric": 0.5}
def evaluate_extraction(course, number, role, phase, student, opponent, parameters, gateway):
    if number == "28" and role == "attack" and phase == "baseline":
        row = extraction_run(course, number, student, None, {}, parameters)
        row["qualificationMetric"] = row["attackMetric"] * 100
        return row
    return protected_branch_not_used_for_a28()
'''
        (package / 'class_runtime.py').write_bytes(source.encode('utf8'))
        sha = hashlib.sha256(source.encode()).hexdigest()
        files = {'class_runtime.py': sha}
        digest = hashlib.sha256(json.dumps(files, separators=(',', ':')).encode()).hexdigest()
        q = {'id': 'V3-261012-A28', 'revision': 3, 'evaluationVersion': 'current-v3', 'category': 'adversarial', 'role': 'attack', 'definitionDigest': 'd' * 64, 'packageId': package_id, 'packageDigest': digest, 'files': [{'path': 'class_runtime.py', 'sha256': sha}]}
        (package / '_metadata.json').write_text(json.dumps({'id': package_id, 'digest': q['packageDigest'], 'valid': True, 'files': files}), encoding='utf8')
        return root, package, q

    def test_a28_extracts_actual_unprotected_baseline_without_private_globals_or_execution(self):
        root, _, q = self.fixture()
        entry = catalog.build_entry(q, root)
        self.assertEqual(entry['referenceKind'], 'qualification')
        self.assertEqual(entry['questionVersion'], 3)
        self.assertEqual(entry['definitionDigest'], 'd' * 64)
        self.assertIn('student, None', entry['code'])
        self.assertNotIn('protected_branch_not_used', entry['code'])
        self.assertNotIn('NEVER_PUBLISH', json.dumps(entry))
        self.assertNotIn('SOURCE_MUST_NEVER_EXECUTE', entry['code'])
        self.assertEqual(entry['codeSha256'], hashlib.sha256(entry['code'].encode('utf8')).hexdigest())
        self.assertEqual(entry['sourceFiles'][0]['path'], 'class_runtime.py')

    def test_changed_package_identity_or_source_digest_is_rejected(self):
        root, package, q = self.fixture()
        changed = dict(q, packageDigest='b' * 64)
        with self.assertRaisesRegex(ValueError, 'package.*binding'):
            catalog.build_entry(changed, root)
        with (package / 'class_runtime.py').open('a', encoding='utf8') as stream:
            stream.write('\n# drift\n')
        with self.assertRaisesRegex(ValueError, 'source.*digest'):
            catalog.build_entry(q, root)

    def test_missing_unprotected_branch_fails_closed(self):
        root, package, q = self.fixture()
        source = 'def extraction_run(*args): return {}\ndef evaluate_extraction(*args): return protected()\n'
        (package / 'class_runtime.py').write_bytes(source.encode('utf8'))
        sha = hashlib.sha256(source.encode()).hexdigest()
        q['files'][0]['sha256'] = sha
        files = {'class_runtime.py': sha}
        q['packageDigest'] = hashlib.sha256(json.dumps(files, separators=(',', ':')).encode()).hexdigest()
        (package / '_metadata.json').write_text(json.dumps({'id': q['packageId'], 'digest': q['packageDigest'], 'valid': True, 'files': files}), encoding='utf8')
        with self.assertRaisesRegex(ValueError, 'A28.*unprotected'):
            catalog.build_entry(q, root)

    def test_package_traversal_and_wrong_role_are_rejected_before_reading(self):
        root, _, q = self.fixture()
        with self.assertRaises(ValueError):
            catalog.build_entry(dict(q, packageId='../private'), root)
        with self.assertRaises(ValueError):
            catalog.build_entry(dict(q, role='defense'), root)

    def test_plan_covers_all_sixty_attack_defense_questions_and_never_selects_dataset_or_weights(self):
        ids = [f'V3-261012-{role}{number:02}' for role in ('A', 'D') for number in range(1, 32) if number != 29]
        self.assertEqual(len(ids), 60)
        for question_id in ids:
            with self.subTest(question=question_id):
                plan = catalog.selection_plan(question_id)
                self.assertTrue(plan)
                self.assertEqual(len(plan), len({path for path, _, _ in plan}))
                for path, nodes, label in plan:
                    self.assertTrue(path.endswith('.py'))
                    self.assertNotIn('dataset', path)
                    self.assertNotIn('weight', path)
                    self.assertTrue(nodes)
                    self.assertTrue(label)
        with self.assertRaises(ValueError):
            catalog.selection_plan('V3-261012-A29')

    def test_write_uses_question_digest_filename_and_refuses_overwrite(self):
        root, _, q = self.fixture()
        entry = catalog.build_entry(q, root)
        output = root / 'output'
        catalog.write_catalog([entry], output)
        target = output / (hashlib.sha256(q['id'].encode()).hexdigest() + '.json')
        self.assertEqual(json.loads(target.read_text(encoding='utf8'))['questionId'], q['id'])
        with self.assertRaises(FileExistsError):
            catalog.write_catalog([entry], output)

    def test_metadata_file_map_tampering_and_invalid_packages_are_rejected(self):
        root, package, q = self.fixture()
        path = package / '_metadata.json'
        metadata = json.loads(path.read_text(encoding='utf8'))
        metadata['files']['unrelated.py'] = 'e' * 64
        path.write_text(json.dumps(metadata), encoding='utf8')
        with self.assertRaisesRegex(ValueError, 'metadata.*digest'):
            catalog.build_entry(q, root)
        del metadata['files']['unrelated.py']
        metadata['valid'] = False
        path.write_text(json.dumps(metadata), encoding='utf8')
        with self.assertRaises(ValueError):
            catalog.build_entry(q, root)


if __name__ == '__main__':
    unittest.main()

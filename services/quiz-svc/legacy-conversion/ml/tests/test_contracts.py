import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'runtime'))
from contracts import check_poison, check_cleaned, MaterialContractError
from build import build, public_dataset
from calibrate import calibrate


class PoisonContracts(unittest.TestCase):
    def setUp(self):
        self.images = np.zeros((100, 1, 28, 28), np.float32)
        self.labels = np.ones(100, np.int64)

    def test_image_changes_count_even_with_unchanged_labels_and_false_report(self):
        images = self.images.copy()
        images[:6, :, 10, 10] = .2
        with self.assertRaises(MaterialContractError):
            check_poison(self.images, self.labels, {'images': images, 'labels': self.labels, 'n_modified': 0})

    def test_equality_at_five_percent_is_allowed_and_array_is_not_mutated(self):
        labels = self.labels.copy()
        labels[:5] = 2
        result = check_poison(self.images, self.labels, {'images': self.images.copy(), 'labels': labels})
        self.assertEqual(result['n_modified'], 5)
        self.assertTrue(np.all(self.labels == 1))

    def test_backdoor_requires_one_contiguous_shared_trigger(self):
        mask = np.zeros((1, 28, 28), np.float32)
        mask[:, 25:27, 25:27] = 1
        pattern = mask.copy()
        images, labels = self.images.copy(), self.labels.copy()
        images[:5] = images[:5] * (1 - mask) + mask * pattern
        labels[:5] = 0
        result = {'images': images, 'labels': labels, 'trigger_mask': mask, 'trigger_pattern': pattern}
        self.assertEqual(check_poison(self.images, self.labels, result, backdoor=True)['n_modified'], 5)
        images[0, 0, 1, 1] = .2
        with self.assertRaises(MaterialContractError):
            check_poison(self.images, self.labels, result, backdoor=True)
        images[0, 0, 1, 1] = 0
        mask[0, 25, 25] = 0
        mask[0, 2, 2] = 1
        with self.assertRaises(MaterialContractError):
            check_poison(self.images, self.labels, result, backdoor=True)

    def test_invalid_pixels_labels_and_unsupported_weights_fail(self):
        for images, labels in [(self.images + 2, self.labels), (self.images, self.labels + 10),
                               (self.images[:10], self.labels), (self.images, self.labels.astype(float))]:
            with self.assertRaises(MaterialContractError):
                check_cleaned({'images': images, 'labels': labels})
        with self.assertRaises(MaterialContractError):
            check_cleaned({'images': self.images, 'labels': self.labels, 'sample_weights': np.ones(100)})


class PackageContracts(unittest.TestCase):
    def test_twelve_records_and_only_explicit_public_files_are_exposed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            questions = build(root / 'no-assets', root / 'output', 'course:test', allow_missing_assets=True)
            self.assertEqual(len(questions), 12)
            self.assertEqual(len({q['questionId'] for q in questions}), 12)
            self.assertFalse(any(q['publishable'] for q in questions))
            for question in questions:
                package = pathlib.Path(question['packageDirectory'])
                manifest = json.loads((package / 'manifest.json').read_text(encoding='utf8'))
                self.assertIn('public/bootstrap.py', manifest['worker']['files'])
                self.assertFalse(any('/data/' in file or 'test.py' in file for file in manifest['worker']['files']))
                for file in package.rglob('*.py'):
                    compile(file.read_text(encoding='utf8'), str(file), 'exec')
                self.assertEqual(question['calibration']['baseline'],
                                 'reference' if question['policy']['qualification']['threshold'] is None else 'fixed')
                if question['scenarioId'] == 'patch_attack':
                    self.assertEqual(question['definition']['evaluation']['version'], 'course-v2-rpc-patch-target-cpu1-blind-v4')
                    self.assertEqual(question['provenance']['detectionProtocol'], 'each-eligible-target-independent-v2')
                    self.assertEqual(question['provenance']['executionProfile']['intraOpThreads'], 1)
                    self.assertIn('public/patch_runtime.py', manifest['worker']['files'])
                    self.assertEqual((package / 'patch_runtime.py').read_bytes(),
                                     (package / 'public' / 'patch_runtime.py').read_bytes())
                    self.assertEqual(question['calibration']['baselineThreshold'], 0)
                else:
                    self.assertEqual(question['definition']['evaluation']['version'],
                                     'course-v2-rpc-v1' if question['scenarioId'].startswith('mnist_')
                                     else 'course-v2-rpc-blinded-v4')
                    self.assertNotIn('public/patch_runtime.py', manifest['worker']['files'])
                if not question['scenarioId'].startswith('mnist_'):
                    self.assertTrue((package / 'evaluation-order.json').is_file())
                    self.assertNotIn('evaluation-order.json', manifest['worker']['files'])
                    self.assertIn('privateOrderSha256', question['provenance'])

    def test_public_patch_api_has_autograd_but_no_hidden_loader(self):
        source = (ROOT / 'sources' / 'patch_attack' / 'dataset.py').read_text(encoding='utf8')
        public = public_dataset(source, 'patch_attack')
        self.assertIn('class TinyDetector', public)
        self.assertIn('def hiding_loss', public)
        self.assertIn('def render_patch_torch', public)
        self.assertNotIn('def generate_benchmark', public)
        self.assertNotIn('def _load_benchmark_from_npz', public)

    def test_calibration_preserves_fixed_threshold_even_if_reference_fails(self):
        import hashlib
        base = {'scenarioId': 'x', 'metrics': {'qualification': 'hard_margin', 'success': 'auc'},
                'provenance': {'sourceDigest': 'fixed-source', 'assets': {}, 'image': 'locked:image'},
                'calibration': {'baseline': 'fixed', 'baselineThreshold': 0, 'opponent': 'reference'}}
        questions = [dict(base, questionId=role, role=role, solution=role) for role in ('attack', 'defense')]
        measurements = []
        for question in questions:
            other = 'defense' if question['role'] == 'attack' else 'attack'
            for phase in ('baseline', 'opponent'):
                measurements.append({'questionId': question['questionId'], 'phase': phase,
                                     'referenceCodeSha256': hashlib.sha256(question['solution'].encode()).hexdigest(),
                                     'opponentReferenceCodeSha256': hashlib.sha256(other.encode()).hexdigest(),
                                     'result': {'status': 'completed', 'metrics': {'qualificationMetric': -.1, 'successMetric': .73}}})
        rules, report = calibrate(questions, measurements)
        self.assertEqual(rules['x']['attack']['qualification']['threshold'], 0)
        self.assertEqual(rules['x']['attack']['success']['threshold'], .73)
        self.assertFalse(report[0]['referencePasses'])
        measurements[0]['referenceCodeSha256'] = 'wrong-reference'
        with self.assertRaises(ValueError):
            calibrate(questions, measurements)


if __name__ == '__main__':
    unittest.main()

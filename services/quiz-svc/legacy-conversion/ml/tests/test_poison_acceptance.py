import importlib.util
from pathlib import Path
import sys
import unittest
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'runtime'))
from contracts import check_poison
spec = importlib.util.spec_from_file_location('poison_acceptance_contract', ROOT / 'acceptance' / 'mnist_poison_attack.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class PoisonAcceptanceContract(unittest.TestCase):
    def setUp(self):
        self.images = np.broadcast_to(np.arange(100, dtype=np.float32)[:, None, None, None] / 100,
                                      (100, 1, 28, 28)).copy()
        self.labels = np.zeros(100, np.int64)
        self.labels[:8] = 5

    def test_joint_changes_use_one_budget_and_only_retained_public_source_images(self):
        before_images, before_labels = self.images.copy(), self.labels.copy()
        result = check_poison(self.images, self.labels, candidate.attack(self.images, self.labels))
        changed = result['labels'] != self.labels
        self.assertEqual(result['n_modified'], 5)
        self.assertTrue(np.all(self.labels[changed] == 5))
        self.assertTrue(np.all(result['labels'][changed] == 8))
        self.assertTrue(np.array_equal(changed, np.any(result['images'] != self.images, axis=(1, 2, 3))))
        donors = {image.tobytes() for image in self.images[(self.labels == 5) & ~changed]}
        self.assertEqual({image.tobytes() for image in result['images'][changed]}, donors)
        np.testing.assert_array_equal(self.images, before_images)
        np.testing.assert_array_equal(self.labels, before_labels)
        repeated = candidate.attack(self.images, self.labels)
        np.testing.assert_array_equal(repeated['images'], result['images'])
        np.testing.assert_array_equal(repeated['labels'], result['labels'])

    def test_zero_budget_and_insufficient_source_class_never_exceed_budget(self):
        zero = candidate.attack(self.images, self.labels, poison_rate=0)
        np.testing.assert_array_equal(zero['images'], self.images)
        np.testing.assert_array_equal(zero['labels'], self.labels)
        self.labels[:] = 0
        self.labels[:2] = 5
        few = check_poison(self.images, self.labels, candidate.attack(self.images, self.labels))
        self.assertEqual(few['n_modified'], 2)
        with self.assertRaises(ValueError):
            candidate.attack(self.images, self.labels, poison_rate=.051)


if __name__ == '__main__':
    unittest.main()

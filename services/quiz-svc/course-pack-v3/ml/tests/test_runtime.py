from __future__ import annotations
import importlib.util
from pathlib import Path
import sys
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('ml_runtime', Path(__file__).resolve().parents[1] / 'runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class ContractTests(unittest.TestCase):
    def test_true_opponent_changes_measured_fidelity_and_claimed_score_is_ignored(self):
        probabilities = np.eye(10)[np.arange(100) % 10] * .9 + .01
        class Victim:
            def predict_proba(self, _images):
                return probabilities
        class Attack:
            def predict(self, _images):
                return probabilities, probabilities.argmax(1)
        class Defense:
            def __init__(self, noisy):
                self.noisy = noisy
            def noise_defend(self, p, y):
                if self.noisy:
                    p = p * .9 + .01
                return {'probabilities': p, 'labels': y, 'score': 1000000}
        images = np.zeros((100, 1, 28, 28), np.float32)
        clean = runtime.evaluate04('attack', Attack(), Defense(False), Victim(), images)
        noisy = runtime.evaluate04('attack', Attack(), Defense(True), Victim(), images)
        self.assertAlmostEqual(clean['successMetric'], 1)
        self.assertLess(noisy['successMetric'], clean['successMetric'])

    def test_hidden_truth_is_not_sent_to_preprocessor(self):
        class Defense:
            def function(self, name, images, labels):
                np.testing.assert_array_equal(labels, np.full(len(images), -1))
                return {'images': images, 'labels': labels}
        image = np.zeros((12, 1, 28, 28), np.float32)
        np.testing.assert_array_equal(runtime.preprocessed(Defense(), image), image)

    def test_probability_contract_rejects_negative_mass_and_fractional_labels(self):
        p = np.ones((2, 10)) / 10
        with self.assertRaises(runtime.ContractError):
            runtime.distribution((p, np.array([0., 0.])), 2)
        p[0, :2] = [-.1, .3]
        with self.assertRaises(runtime.ContractError):
            runtime.distribution((p, p.argmax(1)), 2)

    def test_poison_budget_recomputed_instead_of_trusting_reported_count(self):
        class Attack:
            def function(self, _name, images, labels, **_kwargs):
                return {'images': images, 'labels': 1 - labels, 'n_modified': 0}
        with self.assertRaises(runtime.ContractError):
            runtime.poisoned_dataset(Attack(), '06', {'images': np.zeros((100, 1, 28, 28)), 'labels': np.zeros(100, np.int64)})

    def test_full_evaluation_parameters_and_nested_compatibility(self):
        full = {'version': 'v1', 'successThreshold': .2, 'sourceDigest': 'digest', 'seed': 42}
        self.assertEqual(runtime.frozen_parameters({'parameters': full}), full)
        nested = {'version': 'v1', 'successThreshold': .2, 'parameters': {'sourceDigest': 'digest', 'seed': 42}}
        self.assertEqual(runtime.frozen_parameters({'parameters': nested}), full)

    def test_target_label_is_not_revealed_by_filtered_prediction_batches(self):
        labels = np.asarray([0, 1, 2, 0], dtype=np.int64)
        images = np.zeros((4, 1, 28, 28), np.float32)
        images[:, 0, 0, 0] = np.arange(4) / 10
        calls = []
        class Clean:
            def predict(self, _images): return labels
        class Attack:
            def function(self, _name, train_images, train_labels, **_kwargs):
                mask = np.zeros((1, 28, 28), np.float32); mask[:, 25:27, 25:27] = 1
                return {'images': train_images, 'labels': train_labels, 'trigger_mask': mask, 'trigger_pattern': mask,
                        'target_label': 0, 'poison_indices': np.array([], np.int64), 'n_modified': 0}
            def predict(self, batch):
                calls.append(('attack', len(batch)))
                predicted = np.zeros(len(batch), np.int64) if batch[:, :, 25:27, 25:27].any() else labels
                return np.eye(10)[predicted], predicted
        class Defense:
            def function(self, _name, batch, dummy):
                calls.append(('preprocess', len(batch)))
                np.testing.assert_array_equal(dummy, np.full(4, -1))
                return {'images': batch, 'labels': dummy}
            def predict(self, batch):
                calls.append(('defense', len(batch)))
                predicted = np.asarray([0, 1, 0, 0]) if batch[:, :, 25:27, 25:27].any() else labels
                return np.eye(10)[predicted], predicted
        row = runtime.evaluate07('attack', Attack(), Defense(), Clean(),
              {'images': np.zeros((20, 1, 28, 28), np.float32), 'labels': np.arange(20, dtype=np.int64) % 10},
              {'images': images, 'labels': labels})
        self.assertEqual(row['samples'], 2)
        self.assertEqual(row['successMetric'], .5)
        self.assertEqual(row['unprotectedAttackSuccessRate'], 1)
        self.assertTrue(all(count == 4 for _, count in calls))


if __name__ == '__main__':
    unittest.main()

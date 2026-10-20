"""Legacy watermark formula parity and resistance to branch-count shortcuts."""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


blinded = load_module('legacy_blind_watermark_test_subject', ROOT / 'runtime' / 'blind_watermark.py')
SOURCE = ROOT / 'sources' / 'watermark_image'
original_attack = load_module('legacy_watermark_attack_test_reference', SOURCE / 'attack.py')
original_defense = load_module('legacy_watermark_defense_test_reference', SOURCE / 'defense.py')
original_dataset = load_module('legacy_watermark_dataset_test_reference', SOURCE / 'dataset.py')
with patch.dict(sys.modules, {
    'attack': original_attack, 'defense': original_defense, 'dataset': original_dataset,
}):
    official = load_module('legacy_watermark_test_reference', SOURCE / 'test.py')


def private_order_fixture(ctx, size, purpose):
    """A private deterministic fixture; the shared helper has its own tests."""
    digest = hashlib.sha256(ctx.private_order_seed + purpose.encode('utf8')).digest()
    return np.random.default_rng(int.from_bytes(digest, 'big')).permutation(size)


def auc(labels, scores):
    positives = [score for label, score in zip(labels, scores) if label]
    negatives = [score for label, score in zip(labels, scores) if not label]
    return sum((p > n) + 0.5 * (p == n) for p in positives for n in negatives) / (len(positives) * len(negatives))


class BlindWatermarkTests(unittest.TestCase):
    def setUp(self):
        self.ctx = SimpleNamespace(private_order_seed=bytes.fromhex('11' * 32))
        self.samples = [{'sample_id': str(i), 'image': np.zeros((4, 4, 3), np.uint8)} for i in range(80)]

        def embed_process(value, original, shape, log):
            log.append((1.0, 30.0))
            return True, True, value['image']

        def attack_process(value, ok, original, shape, log):
            if log is not None:
                log.append((1.0, 40.0))
            return True, True, value['image']

        self.legacy = SimpleNamespace(
            _safe=lambda fn, *args: (True, fn(*args)),
            _process_embed=embed_process, _process_attack=attack_process,
            _extract_probability=lambda value: (float(value['probability']), True),
            ssim=lambda *args: 1.0, psnr=lambda *args: 40.0,
            roc_auc=auc, TAU=0.5,
            tpr_fpr=lambda labels, scores, tau: (
                float(np.mean(np.asarray(scores)[np.asarray(labels) == 1] >= tau)),
                float(np.mean(np.asarray(scores)[np.asarray(labels) == 0] >= tau)),
            ),
            mean_quality=lambda rows: {
                'n': len(rows), 'ssim': float(np.mean([x[0] for x in rows])),
                'psnr': float(np.mean([x[1] for x in rows])),
            },
        )

    @staticmethod
    def embed(request):
        image = request['image'].copy()
        image[0, 0, 0] = 1
        return {'image': image}

    def run_pair(self, attack, detect, embed=None, legacy=None, samples=None, attack_name='A'):
        with patch.dict(sys.modules, {'blind_detection': SimpleNamespace(private_order=private_order_fixture)}):
            return blinded.evaluate_pair(
                legacy or self.legacy, self.ctx, attack, embed or self.embed, detect,
                self.samples if samples is None else samples, attack_name, 'D',
            )

    def assert_metrics_equal(self, expected, actual):
        self.assertEqual(set(expected), set(actual))
        for key, value in expected.items():
            if key.startswith('time_'):
                self.assertGreaterEqual(actual[key], 0.0)
            elif isinstance(value, dict):
                self.assert_metrics_equal(value, actual[key])
            elif isinstance(value, float) and np.isnan(value):
                self.assertTrue(np.isnan(actual[key]), key)
            else:
                self.assertEqual(value, actual[key], key)

    def test_stateless_reference_metrics_and_original_request_contract(self):
        observed_attack, observed_detect, sample_ids, events = [], [], [], []

        def embed(request):
            self.assertEqual(set(request), {'sample_id', 'image'})
            events.append('embed')
            return self.embed(request)

        def attack(request):
            observed_attack.append(int(request['image'][0, 0, 0]))
            sample_ids.append(request['sample_id'])
            self.assertEqual(set(request), {'sample_id', 'image'})
            events.append('attack')
            return request

        def detect(request):
            observed_detect.append(int(request['image'][0, 0, 0]))
            self.assertEqual(set(request), {'image'})
            events.append('detect')
            return {'probability': request['image'][0, 0, 0]}

        result = self.run_pair(attack, detect, embed)
        self.assertEqual(result['auc'], 1.0)
        self.assertEqual((result['tpr'], result['fpr']), (1.0, 0.0))
        for key in ('embed_success_rate', 'attack_success_rate', 'detect_success_rate',
                    'embed_valid_rate', 'attack_valid_rate', 'embed_quality_rate', 'attack_quality_rate'):
            self.assertEqual(result[key], 1.0)
        self.assertEqual(result['attack_quality']['n'], len(self.samples))
        self.assertEqual(sorted(sample_ids), sorted([sample['sample_id'] for sample in self.samples] * 2))
        self.assertEqual(events, ['embed'] * 80 + ['attack'] * 160 + ['detect'] * 160)
        self.assertEqual(sorted(observed_attack), [0] * 80 + [1] * 80)
        self.assertNotEqual(observed_attack, [1, 0] * 80)
        self.assertNotEqual(observed_detect, [1, 0] * 80)
        self.assertNotEqual(observed_attack, observed_detect)

    def test_alternating_counter_detector_cannot_recover_branch_labels(self):
        count = 0

        def detect(_request):
            nonlocal count
            count += 1
            return {'probability': float(count % 2)}

        result = self.run_pair(lambda request: request, detect)
        self.assertLess(result['auc'], 0.8)
        self.assertGreater(result['auc'], 0.2)

    def test_alternating_counter_attack_cannot_select_only_positive_branches(self):
        count = 0

        def attack(request):
            nonlocal count
            count += 1
            if count % 2:
                request['image'][0, 0, 0] = 0
            return request

        result = self.run_pair(attack, lambda request: {'probability': request['image'][0, 0, 0]})
        # Fixed positive/negative alternation erases every watermark (AUC=0.5).
        # Private mixing prevents choosing all positive branches by call count.
        self.assertGreater(result['auc'], 0.65)
        self.assertLess(result['auc'], 0.85)

    def test_student_execution_errors_propagate_for_each_stage(self):
        def broken(_request):
            raise RuntimeError('student failed')

        identity = lambda request: request
        detector = lambda _request: {'probability': 0.5}
        for attack, embed, detect in (
            (broken, self.embed, detector), (identity, broken, detector), (identity, self.embed, broken),
        ):
            with self.subTest(stage=(attack is broken, embed is broken, detect is broken)):
                with self.assertRaisesRegex(RuntimeError, 'student failed'):
                    self.run_pair(attack, detect, embed)

    def test_original_identity_and_a0_metrics_are_exactly_preserved(self):
        rng = np.random.default_rng(2718)
        samples = [
            {'sample_id': f'original-{index}', 'image': rng.integers(0, 256, (64, 64, 3), dtype=np.uint8)}
            for index in range(6)
        ]
        for name, attack in (('Id', original_attack.identity_attack), ('A0', original_attack.attack)):
            with self.subTest(attack=name):
                expected = official.evaluate_pair(
                    attack, original_defense.defense, original_defense.detect, samples, name, 'D',
                )
                actual = self.run_pair(
                    attack, original_defense.detect, original_defense.defense,
                    legacy=official, samples=samples, attack_name=name,
                )
                self.assert_metrics_equal(expected, actual)

    def test_original_quality_and_invalid_result_fallbacks_are_preserved(self):
        rng = np.random.default_rng(10)
        samples = [
            {'sample_id': str(index), 'image': rng.integers(0, 256, (16, 16, 3), dtype=np.uint8)}
            for index in range(8)
        ]

        def embed(request):
            index = int(request['sample_id'])
            if index == 0:
                return {}
            if index == 1:
                return {'image': 255 - request['image']}
            if index == 2:
                raise RuntimeError('original embedding fallback')
            return {'image': request['image'].copy()}

        def attack(request):
            index = int(request['sample_id'])
            if index == 3:
                return {'image': np.zeros_like(request['image'])}
            if index == 4:
                return {'image': 255 - request['image']}
            if index == 5:
                raise RuntimeError('original attack fallback')
            return {'image': request['image'].copy()}

        def detect(request):
            value = int(request['image'][0, 0, 0])
            return {'watermark_probability': float('nan') if value % 2 else value / 255}

        expected = official.evaluate_pair(attack, embed, detect, samples, 'A', 'D')
        actual = self.run_pair(attack, detect, embed, legacy=official, samples=samples)
        self.assert_metrics_equal(expected, actual)


if __name__ == '__main__':
    unittest.main()

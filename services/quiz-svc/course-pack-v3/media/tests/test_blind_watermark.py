"""Regression for call-count shortcuts in both watermark branch stages."""
from __future__ import annotations
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'basic'))
from blind_watermark import evaluate_pair


def auc(labels, scores):
    positives = [score for label, score in zip(labels, scores) if label]
    negatives = [score for label, score in zip(labels, scores) if not label]
    return sum((p > n) + .5 * (p == n) for p in positives for n in negatives) / (len(positives) * len(negatives))


class BlindWatermarkTests(unittest.TestCase):
    def setUp(self):
        self.ctx = SimpleNamespace(private_order_seed=bytes.fromhex('11' * 32))
        self.samples = [{'sample_id': str(i), 'image': np.zeros((4, 4, 3), np.uint8)} for i in range(80)]
        def embed_process(value, original, shape, log):
            log.append((1., 30.))
            return True, True, value['image']
        def attack_process(value, ok, original, shape, log):
            if log is not None: log.append((1., 40.))
            return True, True, value['image']
        self.legacy = SimpleNamespace(_safe=lambda fn, *args: (True, fn(*args)), _process_embed=embed_process,
            _process_attack=attack_process, _extract_probability=lambda value: (float(value['probability']), True),
            ssim=lambda *args: 1., psnr=lambda *args: 40., roc_auc=auc, TAU=.5,
            tpr_fpr=lambda labels, scores, tau: (float(np.mean(np.asarray(scores)[np.asarray(labels) == 1] >= tau)),
                float(np.mean(np.asarray(scores)[np.asarray(labels) == 0] >= tau))),
            mean_quality=lambda rows: {'n':len(rows), 'ssim':float(np.mean([x[0] for x in rows])), 'psnr':float(np.mean([x[1] for x in rows]))})
    def embed(self, request):
        image = request['image'].copy()
        image[0, 0, 0] = 1
        return {'image': image}
    def run_pair(self, attack, detect):
        return evaluate_pair(self.legacy, self.ctx, attack, self.embed, detect, self.samples, 'A', 'D')
    def test_stateless_reference_metrics_are_restored_and_branches_are_mixed(self):
        observed_attack, observed_detect = [], []
        def attack(request):
            observed_attack.append(int(request['image'][0, 0, 0]))
            self.assertEqual(set(request), {'sample_id', 'image'})
            return request
        def detect(request):
            observed_detect.append(int(request['image'][0, 0, 0]))
            self.assertEqual(set(request), {'image'})
            return {'probability':request['image'][0, 0, 0]}
        result = self.run_pair(attack, detect)
        self.assertEqual(result['auc'], 1.)
        self.assertEqual((result['tpr'], result['fpr']), (1., 0.))
        for key in ('embed_success_rate', 'attack_success_rate', 'detect_success_rate', 'embed_valid_rate',
                    'attack_valid_rate', 'embed_quality_rate', 'attack_quality_rate'):
            self.assertEqual(result[key], 1.)
        self.assertEqual(result['attack_quality']['n'], len(self.samples))
        self.assertEqual(sorted(observed_attack), [0] * 80 + [1] * 80)
        self.assertNotEqual(observed_attack, [1, 0] * 80)
        self.assertNotEqual(observed_detect, [1, 0] * 80)
        self.assertNotEqual(observed_attack, observed_detect)
    def test_alternating_counter_detector_loses_perfect_auc(self):
        count = 0
        def detect(_request):
            nonlocal count
            count += 1
            return {'probability':float(count % 2)}
        result = self.run_pair(lambda request: request, detect)
        self.assertLess(result['auc'], .8)
    def test_student_failure_is_not_replaced_with_a_score(self):
        def broken(_request): raise RuntimeError('student failed')
        with self.assertRaisesRegex(RuntimeError, 'student failed'):
            self.run_pair(broken, lambda _request: {'probability': .5})


if __name__ == '__main__': unittest.main()

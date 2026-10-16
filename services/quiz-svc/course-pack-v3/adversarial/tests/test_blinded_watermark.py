from __future__ import annotations
import pathlib
import sys
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from class_runtime import blinded_detection


class BlindedWatermarkTests(unittest.TestCase):
    def test_groups_are_mixed_and_original_results_are_restored(self):
        groups = [[('positive', i) for i in range(40)], [('attacked', i) for i in range(40)],
                  [('negative', i) for i in range(80)]]
        observed = []
        def detect(text):
            observed.append(text)
            return {'score': text[1], 'is_watermarked': text[0] != 'negative'}
        result = blinded_detection(detect, groups, '1' * 64)
        self.assertEqual(len(observed), 160)
        self.assertNotEqual(observed, [text for group in groups for text in group])
        self.assertEqual({text[0] for text in observed[:40]}, {'positive', 'attacked', 'negative'})
        for source, restored in zip(groups, result):
            self.assertEqual([item['score'] for item in restored], [item[1] for item in source])

    def test_old_call_count_detector_cannot_recover_positive_labels(self):
        count = 0
        def guessed(_text):
            nonlocal count
            score = float(count < 80)
            count += 1
            return {'score': score, 'is_watermarked': bool(score)}
        positives, _, negatives = blinded_detection(guessed, [list(range(40)), list(range(40)), list(range(80))], '1' * 64)
        auc = sum((p['score'] > n['score']) + .5 * (p['score'] == n['score'])
                  for p in positives for n in negatives) / (40 * 80)
        self.assertLess(auc, .8)


if __name__ == '__main__': unittest.main()

"""Regression: scoring follows each target's own paired intervention, not other targets."""
import ast
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
import numpy as np

from test_runtime import rpc_api, load


def original_metrics():
    # Execute the unchanged numerical functions, without importing Torch in unit tests.
    source = Path(__file__).resolve().parents[1] / 'sources' / 'patch_attack' / 'test.py'
    names = {'iou_xyxy', 'best_match', 'evaluate_targets', 'hide_rate', 'attack_gain',
             'confidence_drop', 'attack_score_base', 'compute_eligible'}
    tree = ast.parse(source.read_text(encoding='utf8'))
    selected = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
    scope = dict(np=np, EPS=1e-8, IOU_THRESH=.5, TARGET_COCO_ID=1)
    exec(compile(selected, str(source), 'exec'), scope)
    return types.SimpleNamespace(**{name: scope[name] for name in names})


class IndependentPatchTargets(unittest.TestCase):
    def setUp(self):
        with patch.dict(sys.modules, platform_student=rpc_api()):
            self.scenarios = load('patch_target_scenarios', 'scenarios.py')
        self.official = original_metrics()
        self.first, self.second = np.zeros((2, 2, 3), np.uint8), np.ones((2, 2, 3), np.uint8)
        self.boxes = [[0, 0, 10, 10], [20, 0, 30, 10], [0, 20, 10, 30]]
        self.samples = [dict(image_id='one', image=self.first, annotations=[{'bbox': b, 'category_id': 1} for b in self.boxes[:2]]),
                        dict(image_id='two', image=self.second, annotations=[{'bbox': self.boxes[2], 'category_id': 1}])]
        self.events = []
        self.pending_params = None

        def predict(image):
            if isinstance(image, tuple):
                kind, original, target = image
                boxes = self.boxes[:2] if original is self.first else self.boxes[2:]
                if kind == 'adv':
                    boxes = [box for box in boxes if box != target]
            else:
                boxes = self.boxes[:2] if image is self.first else self.boxes[2:]
            return [dict(boxes=np.asarray(boxes, dtype=float).reshape(-1, 4),
                         labels=np.ones(len(boxes), dtype=int), scores=np.full(len(boxes), .9))]

        def apply_patch(image, bbox, universal_patch, rng):
            self.assertTrue(image is self.first or image is self.second)
            self.assertIs(universal_patch, self.universal_patch)
            self.assertIsNone(self.pending_params)
            params = {'random': float(rng.random()), 'bbox': bbox}
            self.pending_params = params
            self.events.append(('adv', bbox, params['random']))
            return ('adv', image, bbox), params

        def apply_occlusion(image, bbox, params, rng):
            self.assertIs(params, self.pending_params)
            self.assertIs(params['bbox'], bbox)
            self.pending_params = None
            self.events.append(('occ', bbox, float(rng.random())))
            return ('occ', image, bbox), 'fixed-test-occluder'

        self.detector = types.SimpleNamespace(predict=predict)
        self.dataset = types.SimpleNamespace(apply_patch=apply_patch, apply_occlusion=apply_occlusion)
        self.universal_patch = object()

    def evaluate(self):
        return self.scenarios.patch_detection_metrics(self.official, self.dataset, self.detector,
                                                       self.samples, self.universal_patch)

    def test_all_targets_are_independent_and_untouched_targets_do_not_enter_score(self):
        result = self.evaluate()
        self.assertEqual(result['test_size'], 2)
        self.assertEqual(result['eligible_targets'], 3)
        self.assertEqual(result['evaluation_cases'], 3)
        self.assertEqual(result['hide_rate'], 1)
        self.assertEqual(result['hide_rate_occ'], 0)
        self.assertAlmostEqual(result['attack_gain'], 1 / (1 + 1e-8))
        self.assertEqual(result['attack_qualification_margin'], .5)
        self.assertEqual([event[1] for event in self.events[::2]], self.boxes)
        np.testing.assert_array_equal(self.first, np.zeros_like(self.first))
        np.testing.assert_array_equal(self.second, np.ones_like(self.second))

    def test_original_target_order_and_single_paired_rng_stream_are_reproducible(self):
        first_result = self.evaluate()
        first_events = self.events.copy()
        self.events.clear()
        self.assertEqual(self.evaluate(), first_result)
        self.assertEqual(self.events, first_events)
        self.assertEqual([event[0] for event in first_events], ['adv', 'occ'] * 3)
        self.assertEqual([event[2] for event in first_events], np.random.default_rng(42).random(6).tolist())

    def test_missing_eligible_targets_is_an_evaluator_error(self):
        self.official.compute_eligible = lambda *_: []
        with self.assertRaisesRegex(ValueError, 'no clean-detectable'):
            self.evaluate()


if __name__ == '__main__':
    unittest.main()

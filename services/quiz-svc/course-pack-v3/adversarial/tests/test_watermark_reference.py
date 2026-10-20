from __future__ import annotations
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import build
import build_classes
import class_runtime

CONFIG = {'synonym_ratio': .1, 'swap_ratio': 0., 'delete_ratio': 0., 'seed': 42}
TEST_ROOT = pathlib.Path(__file__).resolve().parents[5] / '.test-artifacts'


class WatermarkReferenceTests(unittest.TestCase):
    def test_explicit_complete_finite_configuration_only(self):
        self.assertIsNone(build_classes.watermark_reference_config(None))
        self.assertEqual(build_classes.watermark_reference_config(CONFIG), CONFIG)
        for value in ({}, {**CONFIG, 'unknown': 1}, {**CONFIG, 'seed': True}, {**CONFIG, 'seed': -1},
                      {**CONFIG, 'seed': 2**32}, {**CONFIG, 'synonym_ratio': float('nan')},
                      {**CONFIG, 'swap_ratio': True}, {**CONFIG, 'delete_ratio': 1.1}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                build_classes.watermark_reference_config(value)

    def test_default_reference_stays_original_and_wrapper_uses_official_algorithm(self):
        TEST_ROOT.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temporary:
            root = pathlib.Path(temporary)
            code = root / 'backend/code'
            code.mkdir(parents=True)
            (code / 'attack.py').write_text('def attack(env, task, config=None):\n    return official(task, config or DEFAULT_ATTACK_CONFIG)\n', encoding='utf8')
            unmodified = build.reference_source(root, '03', 'attack')
            self.assertNotIn('_official_local_edit_attack', unmodified)
            wrapped = build.reference_source(root, '03', 'attack', CONFIG)
            default = {'synonym_ratio': 1., 'swap_ratio': .25, 'delete_ratio': .05, 'seed': 42}
            calls = []
            namespace = {'DEFAULT_ATTACK_CONFIG': default.copy(), 'official': lambda task, cfg: calls.append((task, cfg)) or {'text': 'edited'}}
            exec(wrapped, namespace)
            self.assertEqual(namespace['attack'](None, {'text': 'original'}), {'text': 'edited'})
            self.assertEqual(calls, [({'text': 'original'}, CONFIG)])
            self.assertEqual(namespace['DEFAULT_ATTACK_CONFIG'], default)
            namespace['attack'](None, {}, {'synonym_ratio': 1.})
            self.assertEqual(calls[-1][1], CONFIG)

    def test_defense_baseline_uses_same_config_and_omitted_keeps_author_defaults(self):
        attack = Mock(return_value={'text': 'actual'})
        course = types.SimpleNamespace(reference_attack=attack)
        task = {'watermarked_text': 'original'}
        self.assertEqual(class_runtime.official_watermark_attack(course, task, {'referenceAttackConfig': CONFIG}), {'text': 'actual'})
        self.assertEqual(attack.call_args.kwargs, {'config': CONFIG})
        class_runtime.official_watermark_attack(course, task, {})
        self.assertEqual(attack.call_args.kwargs, {})

    def test_context_cannot_omit_or_change_frozen_reference_configuration(self):
        TEST_ROOT.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temporary:
            root = pathlib.Path(temporary)
            frozen = {'number': '03', 'role': 'attack', 'samples': 40, 'seed': 42, 'budget': 0,
                      'sourceDigest': 'frozen', 'referenceAttackConfig': CONFIG}
            (root / 'frozen.json').write_text(json.dumps(frozen), encoding='utf8')
            for bad in (None, {**CONFIG, 'synonym_ratio': .2}):
                parameters = dict(frozen)
                if bad is None:
                    parameters.pop('referenceAttackConfig')
                else:
                    parameters['referenceAttackConfig'] = bad
                with patch.object(class_runtime, 'load_course') as load_course:
                    with self.assertRaises(class_runtime.CourseFailure):
                        class_runtime.run_context({'role': 'attack', 'phase': 'baseline', 'parameters': parameters}, root)
                    load_course.assert_not_called()


if __name__ == '__main__':
    unittest.main()

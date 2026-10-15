"""Regression tests for migrated result semantics, separate from full-course RPC tests."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import numpy as np

RUNTIME = pathlib.Path(__file__).resolve().parents[1] / 'runtime'
sys.path.insert(0, str(RUNTIME))


def rpc_api():
    module = types.ModuleType('platform_student')
    for name in ('EvaluationInfrastructureError', 'EvaluationTimeoutError', 'StudentExecutionError'):
        setattr(module, name, type(name, (RuntimeError,), {}))
    for name in ('invoke', 'construct', 'call_method'):
        setattr(module, name, lambda *args, **kwargs: None)
    return module


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, RUNTIME / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RuntimeContracts(unittest.TestCase):
    def run_grade(self, parameters, metrics, phase='opponent'):
        api = rpc_api()
        scenario = types.ModuleType('scenarios')
        scenario.evaluate = lambda *_: metrics
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, platform_student=api, scenarios=scenario):
            root = pathlib.Path(directory)
            grade = load('course_grade_case', 'grade.py')
            grade.__file__ = str(root / 'grade.py')
            context = dict(submissionId='student', attemptId='attempt', questionVersion=1,
                           evaluationVersion='v1', phase=phase, role='attack', parameters=parameters,
                           opponent={'submissionId': 'opponent'})
            config = {'scenario': 'fixed', 'roles': {'attack': {
                'qualification': {'metric': 'margin', 'threshold': 0},
                'success': {'metric': 'asr', 'threshold': None}}}}
            (root / 'course.json').write_text(json.dumps(config), encoding='utf8')
            (root / 'context.json').write_text(json.dumps(context), encoding='utf8')
            with patch.object(sys, 'argv', ['grade.py', str(root / 'context.json'), str(root / 'result.json')]):
                grade.main()
            return json.loads((root / 'result.json').read_text(encoding='utf8'))

    def test_frozen_threshold_is_used_and_equality_passes(self):
        result = self.run_grade({'successThreshold': .73}, {'margin': 0, 'asr': .73})
        self.assertEqual(result['status'], 'completed')
        self.assertIs(result['success'], True)

    def test_calibration_keeps_real_metric_and_boolean_transport_contract(self):
        result = self.run_grade({'calibrationMode': True}, {'margin': 0, 'asr': .73})
        self.assertEqual(result['status'], 'completed')
        self.assertIs(result['success'], False)
        self.assertEqual(result['metrics']['successMetric'], .73)

    def test_formal_evaluation_rejects_unfrozen_threshold(self):
        self.assertEqual(self.run_grade({}, {'margin': 0, 'asr': .73})['status'], 'system_error')

    def test_attack_baseline_does_not_require_pair_only_metric(self):
        result = self.run_grade({}, {'margin': 0}, phase='baseline')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['metrics']['qualificationMetric'], 0)
        self.assertNotIn('successMetric', result['metrics'])

    def test_image_cache_object_ids_are_not_deserialized(self):
        access = load('data_access_case', 'data_access.py')
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name, size in [('train', 192), ('test', 96)]:
                np.savez(root / (name + '.npz'), images=np.zeros((size, 2, 2, 3), np.uint8),
                         labels=np.zeros(size, np.int64), sample_ids=np.array(['unused'] * size, dtype=object))
            access.DATA = root
            train, test = access.load_split('deepfake_image')
            self.assertEqual(len(train['images']), 192)
            self.assertEqual(len(test['images']), 96)
            self.assertNotIn('sample_ids', train)

    def test_probability_bad_value_is_student_contract_error(self):
        from contracts import probability, MaterialContractError
        for value in (None, {}, 'not-a-probability', float('nan'), 2):
            with self.assertRaises(MaterialContractError):
                probability(value)

    def test_watermark_invalid_returns_are_unscored_contract_errors(self):
        from contracts import watermark_image_result, watermark_probability_result, MaterialContractError
        image = np.zeros((4, 4, 3), np.uint8)
        for result in (None, {}, {'image': image.astype(float)}, {'image': image[:2]}):
            with self.assertRaises(MaterialContractError):
                watermark_image_result(result, image)
        for result in (None, {}, {'watermark_probability': float('nan')}, {'watermark_probability': 'invalid'}):
            with self.assertRaises(MaterialContractError):
                watermark_probability_result(result)

    def test_watermark_student_execution_error_is_not_converted_to_neutral_score(self):
        api = rpc_api()
        with patch.dict(sys.modules, platform_student=api):
            scenarios = load('watermark_scenario_case', 'scenarios.py')
        official = types.SimpleNamespace()
        def evaluate_pair(attack, embed, detect, samples, *names):
            return official._safe(embed, {'image': np.zeros((4, 4, 3), np.uint8)})
        def fail(*args):
            raise api.StudentExecutionError('student RuntimeError')
        official.evaluate_pair = evaluate_pair
        attack = types.SimpleNamespace(attack=lambda value: value, identity_attack=lambda value: value)
        defense = types.SimpleNamespace(defense=fail, detect=lambda value: {'watermark_probability': .5})
        with patch.object(scenarios, 'load_watermark', return_value=[]):
            with self.assertRaises(api.StudentExecutionError):
                scenarios.watermark({'role': 'attack', 'phase': 'baseline', 'student': None}, official, attack, defense)

    def test_image_quality_failure_retains_metrics_but_malformed_structure_is_unscored(self):
        from contracts import MaterialContractError
        api = rpc_api()
        with patch.dict(sys.modules, platform_student=api):
            scenarios = load('image_scenario_case', 'scenarios.py')
        detector = types.SimpleNamespace(predict=lambda image: .5)
        detector.fit = lambda *args: detector
        defense = types.SimpleNamespace(FIXED_DEFENSE_POOL=[('fixed', {})], build_defense=lambda *args, **kw: detector)
        official = types.SimpleNamespace(check_legality=lambda *args: (False, ['flat image']),
                                         ssim=lambda *args: .94, psnr=lambda *args: 35,
                                         attack_success_rate=lambda *args: 0,
                                         roc_auc=lambda *args: .5)
        split = {'images': np.zeros((2, 4, 4, 3), np.uint8), 'labels': np.array([0, 1])}
        algorithm = types.SimpleNamespace(apply=lambda image: image)
        context = {'role': 'attack', 'phase': 'baseline', 'student': {'url': 'unneeded'}}
        with patch.object(scenarios, 'load_split', return_value=(split, split)), patch.object(scenarios, 'RemoteImageAttack', return_value=algorithm):
            result = scenarios.image(context, official, None, defense)
            self.assertEqual(result['valid_rate'], 0)
            self.assertEqual(result['mean_ssim'], .94)
            self.assertEqual(result['robust_auc'], .5)
            algorithm.apply = lambda image: image[:2]
            with self.assertRaises(MaterialContractError):
                scenarios.image(context, official, None, defense)


if __name__ == '__main__':
    unittest.main()

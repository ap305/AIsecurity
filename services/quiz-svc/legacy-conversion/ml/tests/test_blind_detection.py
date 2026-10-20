"""Original media metrics and grader-private inference scheduling regressions."""
from __future__ import annotations

import ast
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from test_runtime import load, rpc_api
import blind_detection
from contracts import MaterialContractError

ROOT = Path(__file__).resolve().parents[1]


def original_functions(scenario, names, **constants):
    """Use untouched course metric functions without importing training stacks."""
    source = ROOT / 'sources' / scenario / 'test.py'
    tree = ast.parse(source.read_text(encoding='utf8'))
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert len(nodes) == len(names)
    namespace = dict(np=np, **constants)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), namespace)
    return SimpleNamespace(**{name: namespace[name] for name in names})


def audio_metrics():
    return original_functions('deepfake_audio', {
        'compute_det_curve', 'compute_eer', 'auc_from_spoof_prob', 'fpr_fnr_at_threshold',
        'all_detection_metrics', 'attack_success_rate', 'quality_coefficient', 'attack_score',
    }, THRESHOLD=0.5)


def patch_metrics():
    return original_functions('patch_attack', {'tpr_fpr_tnr', 'auroc', 'defense_score', 'evasion_rate'})


class PrivateDetectionTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.seed_path = Path(self.folder.name) / 'evaluation-order.json'
        self.seed_path.write_text(json.dumps({'schemaVersion': 1, 'seed': '3f' * 32}), encoding='utf8')
        change = patch.object(blind_detection, 'ORDER_PATH', self.seed_path)
        change.start()
        self.addCleanup(change.stop)
        with patch.dict(sys.modules, platform_student=rpc_api()):
            self.scenarios = load('private_detection_scenarios', 'scenarios.py')
        self.context = {'role': 'defense', 'phase': 'baseline', 'student': {'url': 'fixture'}}

    def test_private_order_is_frozen_ignores_context_and_separates_purposes(self):
        first = blind_detection.private_order({}, 128, 'test')
        second = blind_detection.private_order({'seed': 'attacker', 'parameters': {'seed': 99}}, 128, 'test')
        np.testing.assert_array_equal(first, second)
        np.testing.assert_array_equal(np.sort(first), np.arange(128))
        self.assertFalse(np.array_equal(first, blind_detection.private_order({}, 128, 'other')))
        self.seed_path.write_text(json.dumps({'schemaVersion': 1, 'seed': '4f' * 32}), encoding='utf8')
        self.assertFalse(np.array_equal(first, blind_detection.private_order({}, 128, 'test')))
        for value in ({}, {'schemaVersion': 1, 'seed': 'a' * 63}, {'schemaVersion': 2, 'seed': 'ab' * 32}):
            self.seed_path.write_text(json.dumps(value), encoding='utf8')
            with self.assertRaises(ValueError):
                blind_detection.private_order({}, 128, 'test')

    def test_private_predictions_restore_order_and_reject_malformed_outputs(self):
        samples = list(np.linspace(0, 1, 90))
        observed = []

        def predict(batch):
            observed.append(batch)
            return batch

        values = blind_detection.mixed_predictions({}, samples, predict, 'test')
        np.testing.assert_array_equal(values, samples)
        self.assertEqual(len(observed), 1)
        self.assertNotEqual(observed[0], samples)
        for invalid in ([0.0] * 89, [float('nan')] * 90, [1.1] * 90, [-0.1] * 90, [[0.5]] * 90):
            with self.subTest(shape=np.shape(invalid)):
                with self.assertRaises(MaterialContractError):
                    blind_detection.mixed_predictions({}, samples, lambda _: invalid, 'test')

    def test_build_reuses_frozen_seeds_and_excludes_them_from_worker_files(self):
        with patch.object(sys, 'path', [str(ROOT), *sys.path]):
            spec = importlib.util.spec_from_file_location('private_detection_builder', ROOT / 'build.py')
            builder = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(builder)
        root = Path(self.folder.name)
        first, second = root / 'first', root / 'second'
        builder.build(root / 'missing-assets', first, 'fixture@sha256:' + 'a' * 64,
                      allow_missing_assets=True)
        seeds_path = first / 'private-order-seeds.json'
        seeds = json.loads(seeds_path.read_text(encoding='utf8'))
        builder.build(root / 'missing-assets', second, 'fixture@sha256:' + 'a' * 64,
                      allow_missing_assets=True, private_order_seeds=seeds_path)
        self.assertEqual(seeds, json.loads((second / 'private-order-seeds.json').read_text(encoding='utf8')))
        self.assertEqual(set(seeds), set(builder.BLINDED_SCENARIOS))
        for scenario in seeds:
            package = first / 'packages' / scenario
            seed_file = package / 'evaluation-order.json'
            self.assertEqual(seed_file.read_bytes(), (second / 'packages' / scenario / 'evaluation-order.json').read_bytes())
            self.assertEqual(json.loads(seed_file.read_text(encoding='utf8'))['seed'], seeds[scenario])
            manifest = json.loads((package / 'manifest.json').read_text(encoding='utf8'))
            self.assertTrue((package / 'blind_detection.py').is_file())
            for name in manifest['worker']['files']:
                self.assertTrue(name.startswith('public/'), name)
                self.assertNotIn('evaluation-order', name)
                self.assertNotIn('blind_detection', name)
                self.assertNotIn('blind_watermark', name)
                self.assertNotIn(seeds[scenario].encode(), (package / name).read_bytes())
            self.assertNotIn(seeds[scenario].encode(), (first / 'questions.json').read_bytes())

    def audio_fixture(self, counter=False):
        official = audio_metrics()
        fidelity = {'SI_SDR': 16.0, 'STOI': 0.9, 'duration_ratio': 1.0,
                    'clipping_ratio_est': 0.01, 'silence_ratio_est': 0.0}
        official.FidelityJudge = lambda: SimpleNamespace(judge=lambda *_: {'valid': True, 'fidelity': fidelity})
        labels = np.r_[np.zeros(32, dtype=int), np.ones(32, dtype=int)]
        audios = np.repeat(np.where(labels == 0, 0.2, 0.8)[:, None], 512, axis=1)
        split = {'audios': audios, 'labels': labels}
        observed = []

        def defend(request):
            self.assertEqual(set(request), {'audio', 'sample_rate'})
            observed.append(float(request['audio'][0]))
            probability = float(len(observed) > 32) if counter else float(request['audio'][0])
            return {'spoof_probability': probability}

        model = SimpleNamespace(train=lambda *_: None, defend=defend)
        algorithms = [SimpleNamespace(attack=lambda request, shift=shift: {
            'audio': request['audio'] - shift, 'sample_rate': 16000,
        }) for shift in (0.6, 0.2)]
        attacks = SimpleNamespace(default_pool=lambda: algorithms)
        with patch.object(self.scenarios, 'load_split', return_value=(split, split)), \
                patch.object(self.scenarios, 'RemoteModel', return_value=model):
            result = self.scenarios.audio(self.context, official, attacks, None)
        return result, official, fidelity, observed

    def test_audio_stateless_metrics_preserve_original_clean_and_all_attack_formulas(self):
        result, official, fidelity, observed = self.audio_fixture()
        bp, sp = np.full(32, 0.2), np.full(32, 0.8)
        attacked = [sp - 0.6, sp - 0.2]
        clean = official.all_detection_metrics(bp, sp)
        robust = official.all_detection_metrics(bp, np.concatenate(attacked))
        quality = official.quality_coefficient(fidelity)
        asrs = [official.attack_success_rate(sp, after, [True] * 32) for after in attacked]
        expected = dict(clean_auc=clean['AUC'], clean_eer=clean['EER'], robust_auc=robust['AUC'],
                        robust_eer=robust['EER'], clean_frr=clean['FRR'], robust_far=robust['FAR'],
                        asr=float(np.mean(asrs)), attack_score=float(np.mean([
                            official.attack_score(asr, quality) for asr in asrs])),
                        quality=quality, valid_rate=1.0, train_size=64, test_size=64)
        self.assertEqual(set(result), set(expected))
        for key in result:
            self.assertAlmostEqual(result[key], expected[key], places=12, msg=key)
        self.assertEqual(len(observed), 128)
        self.assertGreater(len(set(observed[:32])), 1)

    def test_audio_initial_clean_block_counter_no_longer_gives_perfect_detection(self):
        result, *_ = self.audio_fixture(counter=True)
        self.assertLess(result['clean_auc'], 0.8)
        self.assertLess(result['robust_auc'], 0.8)
        self.assertGreater(result['clean_frr'], 0.0)

    def image_fixture(self, counter=False):
        official = original_functions('deepfake_image', {'roc_auc', 'attack_success_rate'}, TAU=0.5)
        official.check_legality = lambda before, after: (int(before[0, 0, 1]) % 3 != 0, [])
        official.ssim = lambda *_: 0.95
        official.psnr = lambda *_: 35.0
        labels = np.r_[np.zeros(32, dtype=int), np.ones(32, dtype=int)]
        images = np.repeat(np.where(labels == 0, 40, 210)[:, None, None, None], 4 * 4 * 3, axis=1)
        images = images.reshape(64, 4, 4, 3).astype(np.uint8)
        images[:, 0, 0, 1] = np.arange(64)
        split = {'images': images, 'labels': labels}
        observed = []

        def predict(image):
            observed.append(int(image[0, 0, 0]))
            return float(len(observed) > 64) if counter else float(image[0, 0, 0] / 255)

        model = SimpleNamespace(predict=predict)
        model.fit = lambda *_: model

        def alter(image, delta):
            image[..., 0] -= delta
            return image

        algorithms = [SimpleNamespace(apply=lambda image, delta=delta: alter(image, delta)) for delta in (50, 150)]
        attacks = SimpleNamespace(build_attack_pool=lambda: list(enumerate(algorithms)))
        with patch.object(self.scenarios, 'load_split', return_value=(split, split)), \
                patch.object(self.scenarios, 'RemoteModel', return_value=model):
            result = self.scenarios.image(self.context, official, attacks, None)
        return result, official, observed

    def test_image_stateless_metrics_preserve_pooling_and_invalid_attack_denominator(self):
        result, official, observed = self.image_fixture()
        valid = np.arange(32, 64) % 3 != 0
        attacked = [np.full(32, 160 / 255), np.full(32, 60 / 255)]
        after = np.concatenate([values[valid] for values in attacked])
        real = np.full(32, 40 / 255)
        robust_auc = official.roc_auc(np.r_[np.ones(len(after)), np.zeros(32)], np.r_[after, real])
        expected = dict(
            mean_asr=float(np.mean([official.attack_success_rate(values, valid) for values in attacked])),
            mean_ssim=0.95, mean_psnr=35.0, valid_rate=float(valid.mean()),
            clean_auc=1.0, robust_auc=robust_auc, defense_score=(1 + robust_auc) / 2,
            attack_qualification_margin=min(float(valid.mean()) - 0.8, 0.95 - 0.92),
            train_size=192, test_size=96,
        )
        self.assertEqual(result, expected)
        self.assertEqual(len(observed), 32 + 64 + 64)
        self.assertGreater(len(set(observed[:32])), 1)

    def test_image_initial_real_and_clean_block_counter_loses_perfect_auc(self):
        result, *_ = self.image_fixture(counter=True)
        self.assertLess(result['clean_auc'], 0.8)
        self.assertLess(result['robust_auc'], 0.8)

    def test_patch_validation_and_pair_share_one_batch_and_keep_original_metrics(self):
        official = patch_metrics()
        groups = [list(np.linspace(0.1, 0.7, 35)), list(np.linspace(0.3, 0.9, 35)),
                  list(np.linspace(0.2, 0.8, 51)), list(np.linspace(0.4, 1.0, 51))]
        batches = []

        def predict_many(batch):
            batches.append(batch)
            return batch

        validation, pair = self.scenarios.patch_classifier_metrics(
            {}, official, SimpleNamespace(predict_many=predict_many), *groups,
        )
        validation_labels = np.r_[np.zeros(35), np.ones(35)]
        validation_scores = np.asarray(groups[0] + groups[1])
        self.assertEqual(validation, official.tpr_fpr_tnr(validation_labels, (validation_scores >= 0.5).astype(int)))
        pair_labels = np.r_[np.zeros(51), np.ones(51)]
        pair_scores = np.asarray(groups[2] + groups[3])
        expected = official.tpr_fpr_tnr(pair_labels, (pair_scores >= 0.5).astype(int))
        expected.update(evasion=official.evasion_rate(expected['tpr']), defense_score=official.defense_score(
            expected['balanced_accuracy'], official.auroc(pair_labels, pair_scores)))
        self.assertEqual(pair, expected)
        self.assertEqual(len(batches), 1)
        self.assertEqual(len(batches[0]), sum(map(len, groups)))

    def test_patch_first_half_clean_per_call_shortcut_loses_perfect_detection(self):
        def predict_many(batch):
            return np.r_[np.zeros(len(batch) // 2), np.ones(len(batch) - len(batch) // 2)]

        validation, pair = self.scenarios.patch_classifier_metrics(
            {}, patch_metrics(), SimpleNamespace(predict_many=predict_many),
            [0.2] * 80, [0.8] * 80, [0.2] * 80, [0.8] * 80,
        )
        self.assertLess(validation['balanced_accuracy'], 0.8)
        self.assertLess(pair['defense_score'], 0.8)
        self.assertGreater(pair['fpr'], 0.0)


if __name__ == '__main__':
    unittest.main()

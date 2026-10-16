"""Trusted original-metric adapter for four real paired media environments."""
from __future__ import annotations

import math
from types import SimpleNamespace
import numpy as np
from basic_adapter import Bridge as BasicBridge, Remote, RemoteModule, InfrastructureFailure
from basic_codec import pack, unpack
from judge_runtime import ConfigurationError, SubmissionError
from blind_detection import private_order, mixed_predictions
from platform_student import invoke, StudentExecutionError, EvaluationInfrastructureError, EvaluationTimeoutError


class Bridge(BasicBridge):
    def call(self, operation, data=None, capability=None):
        try:
            response = invoke(self.worker, 'course_media_call', [operation, pack(data or {}, self.encode_object)])
            return unpack(response, lambda key: Remote(self, key))
        except EvaluationTimeoutError as error:
            raise InfrastructureFailure(timeout=True) from error
        except EvaluationInfrastructureError as error:
            raise InfrastructureFailure() from error
        except (StudentExecutionError, ValueError, TypeError, KeyError):
            raise SubmissionError('媒体提交代码、参数或返回值不符合接口') from None


def make_bridge(worker, role):
    bridge = Bridge(worker)
    bridge.call('initialize', {'role': role})
    return bridge


def patch05(evaluator, ctx, bridge, dataset):
    arr = evaluator._to_numpy(bridge.call('patch'))
    if arr.shape != (3, dataset.PATCH_SIZE, dataset.PATCH_SIZE) or not np.isfinite(arr).all() or arr.min() < -1e-6 or arr.max() > 1 + 1e-6:
        raise SubmissionError('贴片必须为有限的3×32×32、0–1张量')
    return np.clip(arr, 0., 1.)


def independent05(dataset, legacy, detector, bundle, patch, seed):
    """Every eligible target gets its own patch/occlusion and its own denominator."""
    rng = np.random.default_rng(seed)
    eligible = legacy.compute_eligible(detector, bundle['hidden_test'])
    remapped, clean, adv, occ = [], {}, {}, {}
    for index, original in enumerate(eligible):
        target = dict(original, image_id=index)
        remapped.append(target)
        image = original['image']
        adversarial, params = dataset.apply_patch(image, original['bbox'], patch, rng)
        occluded, _ = dataset.apply_occlusion(image, original['bbox'], params, rng)
        clean[index] = detector.predict(image)[0]
        adv[index] = detector.predict(adversarial)[0]
        occ[index] = detector.predict(occluded)[0]
    if not remapped:
        raise ConfigurationError('固定测试集没有合格检测目标')
    return (legacy.evaluate_targets(remapped, clean), legacy.evaluate_targets(remapped, adv),
            legacy.evaluate_targets(remapped, occ), len(remapped))


def defense05(evaluator, ctx, bridge, dataset, legacy, detector, bundle, patch, seed):
    model = bridge.call('restore', {'number': '05'})
    rng = np.random.default_rng(seed + 1)
    hidden = bundle['hidden_test']
    clean = [s['image'].copy() for s in hidden]
    attacked = []
    for sample in hidden:
        if not sample['annotations']:
            raise ConfigurationError('固定贴片测试图缺少目标')
        ann = sample['annotations'][int(rng.integers(len(sample['annotations'])))]
        attacked.append(dataset.apply_patch(sample['image'], ann['bbox'], patch, rng)[0])
    scores = mixed_predictions(ctx, clean + attacked, model.predict_many, '05-baseline')
    labels = np.r_[np.zeros(len(clean)), np.ones(len(attacked))]
    stats = legacy.tpr_fpr_tnr(labels, (scores >= .5).astype(int))
    auc = legacy.auroc(labels, scores)
    value = legacy.defense_score(stats['balanced_accuracy'], auc)
    return {'score': 100 * value, 'metrics': {**stats, 'auroc': auc, 'n_clean': len(clean),
            'n_patched': len(attacked), 'qualified': stats['fpr'] <= .1 and stats['tpr'] >= .7,
            'defense_score': value, 'training_performed': False}}


def paired05(evaluator, ctx, attack, defense):
    evaluator._preflight_data(ctx, '05')
    dataset, legacy = evaluator._code_module('dataset'), evaluator._load_legacy(ctx)
    detector = evaluator._teacher_detector_05(ctx, dataset, 'backend/weights/detector.pt', 'cpu')
    bundle = dataset.load_benchmark(cache_dir=str(ctx.code_dir / 'data'))
    patch = patch05(evaluator, ctx, attack, dataset)
    model = defense.call('restore', {'number': '05'})
    eligible = legacy.compute_eligible(detector, bundle['hidden_test'])
    rng = np.random.default_rng(int(getattr(dataset, 'SEED', 42)))
    attacked, hidden_flags = [], []
    for target in eligible:
        image, _ = dataset.apply_patch(target['image'], target['bbox'], patch, rng)
        evaluation = legacy.evaluate_targets([dict(target, image_id=0)], {0: detector.predict(image)[0]})
        attacked.append(image)
        hidden_flags.append(evaluation['recall'] == 0)
    clean = [sample['image'] for sample in bundle['hidden_test']]
    if not eligible or not clean:
        raise ConfigurationError('贴片测试集缺少目标或干净控制样本')
    scores = mixed_predictions(ctx, clean + attacked, model.predict_many, '05-opponent')
    detected = scores[len(clean):] >= .5
    wins_attack = int(np.sum(np.asarray(hidden_flags) & ~detected))
    wins_defense = int(detected.sum())
    fpr = float(np.mean(scores[:len(clean)] >= .5))
    rate = (wins_attack if ctx.role == 'attack' else wins_defense) / len(eligible)
    if ctx.role == 'defense' and fpr > .1:
        rate = 0.
    return {'score': rate * 100., 'metrics': {'successMetric': rate, 'n_targets': len(eligible),
             'attack_successes': wins_attack, 'defense_successes': wins_defense,
             'clean_fpr': fpr, 'n_clean_controls': len(clean), 'control_threshold': .1,
             'target_protocol': 'independent-target', 'training_performed': False}}


def configure(evaluator, ctx, submission, opponent=None):
    from blind_detection import image_attack11, image_defense11, audio_attack12, audio_defense12
    bridge = make_bridge(submission, ctx.role)
    ctx.student_module = RemoteModule(bridge)
    ctx.weights = None  # all uploaded state is deliberately worker-only
    number = ctx.id[1:]
    evaluator._a05_eligible_and_preds = independent05
    evaluator._student_patch_05 = lambda c, dataset: patch05(evaluator, c, bridge, dataset)
    evaluator._map_d05 = lambda c, dataset, legacy, detector, bundle, patch, seed: defense05(evaluator, c, bridge, dataset, legacy, detector, bundle, patch, seed)
    evaluator._restore_student_defense_11 = lambda c, probe: bridge.call('restore', {'number': '11', 'probe': probe})
    evaluator._restore_student_defense_12 = lambda c: bridge.call('restore', {'number': '12'})
    evaluator._handler_a11 = lambda c, legacy: image_attack11(evaluator,c,legacy,mixed_predictions)
    evaluator._handler_d11 = lambda c, legacy: image_defense11(evaluator,c,legacy,mixed_predictions)
    evaluator._handler_a12 = lambda c, dataset, legacy, train, test, rate, bona, spoof: audio_attack12(
        evaluator,c,dataset,legacy,train,test,rate,bona,spoof,private_order)
    evaluator._handler_d12 = lambda c, legacy, test, rate, bona, spoof: audio_defense12(
        evaluator,c,legacy,test,rate,bona,spoof,private_order)
    # Archive 10 imports symbols into test.py at module load; replacing those
    # references keeps the score bound to the submitted functions.
    legacy = evaluator._load_legacy(ctx)
    if number == '10':
        from blind_watermark import evaluate_pair as blind_pair
        legacy.evaluate_pair = lambda *args: blind_pair(legacy,ctx,*args)
        # Interface failures must remain unscored; the archive's broad _safe
        # would otherwise turn a broken program into a default 0.5 detector.
        legacy._safe = lambda fn, *args: (True, fn(*args))
        old_embed, old_attack, old_probability = legacy._process_embed, legacy._process_attack, legacy._extract_probability
        def process_embed(*args):
            value = old_embed(*args)
            if not value[0]:
                raise SubmissionError('水印嵌入返回图像不符合接口')
            return value
        def process_attack(*args):
            value = old_attack(*args)
            if not value[0]:
                raise SubmissionError('水印攻击返回图像不符合接口')
            return value
        def probability(value):
            answer = old_probability(value)
            if not answer[1]:
                raise SubmissionError('水印检测概率不符合接口')
            return answer
        legacy._process_embed, legacy._process_attack, legacy._extract_probability = process_embed, process_attack, probability
        if ctx.role == 'attack':
            legacy.attack = ctx.student_module.attack
        else:
            legacy.defense, legacy.detect = ctx.student_module.defense, ctx.student_module.detect
    if opponent is None:
        return bridge, None
    opposite_role = 'defense' if ctx.role == 'attack' else 'attack'
    other = make_bridge(opponent, opposite_role)
    attack, defense = (bridge, other) if ctx.role == 'attack' else (other, bridge)
    if number == '05':
        return bridge, lambda: paired05(evaluator, ctx, attack, defense)
    attack_module, defense_module = RemoteModule(attack), RemoteModule(defense)
    if number == '10':
        dataset = evaluator._code_module('dataset')
        def paired10():
            # data_dir is the source API's optional raw-image folder; None
            # selects its fixed NPZ cache under the controlled grader cwd.
            evaluator._preflight_data(ctx, '10')
            samples = dataset.to_samples(dataset.load_benchmark(n=legacy.DEFAULT_N, seed=legacy.DEFAULT_SEED))
            clean = legacy.evaluate_pair(legacy.identity_attack, defense_module.defense, defense_module.detect,
                                         samples, 'Id', 'actual_defense')
            actual = legacy.evaluate_pair(attack_module.attack, defense_module.defense, defense_module.detect,
                                          samples, 'actual_attack', 'actual_defense')
            valid = all(actual[key] >= 1. for key in ('embed_success_rate', 'attack_success_rate', 'detect_success_rate',
                                                      'embed_valid_rate', 'attack_valid_rate'))
            if not valid:
                raise SubmissionError('水印算法接口或输出未通过合法性检查')
            value = 1. - actual['auc'] if ctx.role == 'attack' else (clean['auc'] + actual['auc']) / 2.
            quality = actual['attack_quality_rate'] if ctx.role == 'attack' else actual['embed_quality_rate']
            # Original strict per-sample quality fallback already restores the
            # pre-attack image. Preserve that rule instead of dropping the
            # entire valid submission because one image missed a quality gate.
            return {'score': 100 * value, 'metrics': {'successMetric': value, 'clean_auc': clean['auc'],
                    'actual_opponent_auc': actual['auc'], 'quality_rate': quality, 'training_performed': False}}
        return bridge, paired10
    if number == '11':
        if ctx.role == 'attack':
            evaluator._A11_DETECTOR_ASSETS = (('actual_opponent', 'actual_opponent'),)
            evaluator._a11_detector_from_payload = lambda *args: defense.call('restore', {'number': '11'})
        else:
            legacy.build_attack_pool = lambda: [('actual_opponent', attack_module.JPEGReencodeAttack(quality=85, seed=42))]
    if number == '12':
        original_code_module = evaluator._code_module
        if ctx.role == 'attack':
            evaluator._a12_teacher_defense = lambda *args: defense.call('restore', {'number': '12'})
            evaluator._code_module = lambda name: SimpleNamespace(default_pool=lambda: []) if name == 'attack' else original_code_module(name)
        else:
            evaluator._code_module = lambda name: SimpleNamespace(default_pool=lambda: [attack_module.CodecAttack()]) if name == 'attack' else original_code_module(name)
    return bridge, None


def evaluate(evaluator, ctx, phase, submission, opponent=None):
    bridge, custom = configure(evaluator, ctx, submission, opponent if phase == 'opponent' else None)
    result = custom() if custom else evaluator.evaluate(ctx)
    score = result['score']
    if not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 100:
        raise ConfigurationError('媒体评分超出0–100范围')
    metrics = result['metrics']
    if ctx.id == 'A12':
        own_attack = (metrics.get('per_attack') or [{}])[0]
        metrics['qualified'] = own_attack.get('valid_attack_rate', 0) > 0
    metrics['legalityGate'] = 1 if metrics.get('qualified', True) else 0
    if phase == 'baseline':
        # Negative sentinel cannot pass even a legitimately zero reference
        # threshold. Keep sourceScore and legalityGate separately reviewable.
        metrics['qualificationMetric'] = score if metrics.get('qualified', True) else -1.
        metrics['sourceScore'] = score
    else:
        metrics.setdefault('successMetric', score / 100.)
        if not metrics.get('qualified', True):
            metrics['successMetric'] = 0.
        metrics['actualOpponent'] = True
        metrics['model_sources'] = {'student':'current submission isolated worker', 'opponent':'actual paired submission isolated worker'}
        metrics['note'] = '实际对手来自另一独立worker；不混入官方攻击池或教师检测器冒充对手。'
        policies = {'A11':'single actual detector ASR with original legality and fidelity gate',
                    'D11':'(clean AUC + actual opponent robust AUC)/2',
                    'A12':'student CodecAttack CoreASR times Q against actual defense',
                    'D12':'original EER/AUC/efficiency formula with only actual opponent attack'}
        if ctx.id in policies:
            metrics['score_policy'] = policies[ctx.id]
    return result

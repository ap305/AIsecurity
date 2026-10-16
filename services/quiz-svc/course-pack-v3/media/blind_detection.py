"""Original image/audio metrics with grader-private mixed detection order.

Detection input scheduling never identifies clean, attacked, real or fake
subsets. All inverse indices, labels and timing attribution remain trusted.
"""
from __future__ import annotations
import time
import hashlib
import numpy as np
from judge_runtime import ConfigurationError, SubmissionError


def private_order(ctx, size, purpose):
    """Frozen package-private order; neither the seed nor indices reach workers."""
    seed = getattr(ctx, 'private_order_seed', None)
    if not isinstance(seed, bytes) or len(seed) != 32:
        raise ConfigurationError('缺少私有评测排列种子')
    digest = hashlib.sha256(seed + purpose.encode('utf8')).digest()
    return np.random.default_rng(int.from_bytes(digest, 'big')).permutation(size)


def mixed_predictions(ctx, samples, predict_many, purpose):
    order = private_order(ctx, len(samples), purpose)
    mixed = [samples[int(index)] for index in order]
    predictions = np.asarray(predict_many(mixed), dtype=np.float64)
    if predictions.shape != (len(samples),) or not np.isfinite(predictions).all():
        raise SubmissionError('检测器返回数量或数值无效')
    restored = np.empty(len(samples), dtype=np.float64)
    restored[order] = predictions
    return restored


def image_attack11(evaluator, ctx, legacy, mixed):
    dataset = evaluator._code_module('dataset')
    _, test = dataset.load_benchmark(cache_dir=str(ctx.code_dir / 'data'))
    fake = test['images'][test['labels'] == 1]
    real = test['images'][test['labels'] == 0]
    attack = ctx.student_module.JPEGReencodeAttack(quality=85, seed=42)
    attacked = [np.asarray(attack.apply(image), dtype=np.uint8) for image in fake]
    valid = np.array([bool(legacy.check_legality(image, altered)[0])
                      for image, altered in zip(fake, attacked)], dtype=bool)
    ssims = [legacy.ssim(image, altered) for image, altered in zip(fake, attacked)]
    psnrs = [legacy.psnr(image, altered) for image, altered in zip(fake, attacked)]
    valid_rate = float(np.mean(valid)) if len(fake) else 0.
    mean_ssim = float(np.mean(ssims)) if len(fake) else 0.
    qualified = valid_rate >= legacy.VALID_RATE_MIN and mean_ssim >= legacy.SSIM_MIN
    asrs, aucs = {}, {}
    samples = list(real) + attacked
    labels = np.r_[np.zeros(len(real)), np.ones(len(fake))]
    for path, name in evaluator._A11_DETECTOR_ASSETS:
        detector = evaluator._a11_detector_from_payload(ctx, path, name)
        scores = mixed(ctx, samples, lambda batch: [detector.predict(image) for image in batch], '11-attack')
        asrs[name] = legacy.attack_success_rate(scores[len(real):], valid)
        aucs[name] = legacy.roc_auc(labels, scores)
    value = float(np.mean(list(asrs.values()))) if asrs else 0.
    return {'score': 100 * value, 'metrics': {'n_test_fake':len(fake), 'n_test_real':len(real),
            'asr_per_defense':asrs, 'auc_per_defense_after_attack':aucs, 'mean_asr':value,
            'valid_rate':valid_rate, 'mean_ssim':mean_ssim,
            'mean_psnr':float(np.mean(psnrs)) if psnrs else 0.,
            'qualified':bool(qualified), 'training_performed':False}}


def image_defense11(evaluator, ctx, legacy, mixed):
    dataset = evaluator._code_module('dataset')
    _, test = dataset.load_benchmark(cache_dir=str(ctx.code_dir / 'data'))
    fake_mask, real_mask = test['labels'] == 1, test['labels'] == 0
    fake = test['images'][fake_mask]
    detector = evaluator._restore_student_defense_11(ctx, test['images'][0])
    samples = list(test['images'])
    attacks = []
    for name, attack in legacy.build_attack_pool():
        altered = [np.asarray(attack.apply(image), dtype=np.uint8) for image in fake]
        valid = np.array([bool(legacy.check_legality(image, changed)[0])
                          for image, changed in zip(fake, altered)], dtype=bool)
        start = len(samples)
        samples.extend(altered)
        attacks.append((name, start, valid))
    scores = mixed(ctx, samples, lambda batch: [detector.predict(image) for image in batch], '11-defense')
    clean_scores = scores[:len(test['images'])]
    clean_auc = legacy.roc_auc(test['labels'], clean_scores)
    real_scores = clean_scores[real_mask]
    robust_scores, per_auc, per_asr, legal_counts = [], {}, {}, {}
    for name, start, valid in attacks:
        fake_scores = scores[start:start + len(fake)]
        per_auc[name] = legacy.roc_auc(np.r_[np.ones(len(fake)), np.zeros(len(real_scores))],
                                      np.r_[np.where(valid, fake_scores, 1.), real_scores])
        per_asr[name] = legacy.attack_success_rate(fake_scores, valid)
        legal_counts[name] = int(valid.sum())
        robust_scores.extend(fake_scores[valid].tolist())
    robust_labels = np.r_[np.ones(len(robust_scores)), np.zeros(len(real_scores))]
    robust_scores = np.r_[robust_scores, real_scores]
    robust_auc = legacy.roc_auc(robust_labels, robust_scores)
    value = (clean_auc + robust_auc) / 2.
    return {'score':100 * value, 'metrics':{
        'clean_auc':clean_auc, 'clean_acc':legacy.accuracy(test['labels'],clean_scores),
        'clean_eer':legacy.eer(test['labels'],clean_scores),
        'clean_fpr_at_0.5':float(np.mean(real_scores >= .5)) if len(real_scores) else 0.,
        'robust_auc':robust_auc, 'robust_acc':legacy.accuracy(robust_labels,robust_scores),
        'robust_eer':legacy.eer(robust_labels,robust_scores), 'per_attack_auc':per_auc,
        'per_attack_asr':per_asr, 'n_legal_per_attack':legal_counts,
        'hidden_attack_auc':per_auc.get('composite_hidden'), 'defense_score':value,
        'training_performed':False}}


def audio_predictions(evaluator, ctx, model, samples, rate, order):
    permutation = order(ctx, len(samples), '12-detection')
    scores = np.empty(len(samples), dtype=np.float64)
    durations = np.empty(len(samples), dtype=np.float64)
    for index in permutation:
        start = time.perf_counter()
        scores[index] = evaluator._a12_defend_many(model, [samples[int(index)]], rate)[0]
        durations[index] = time.perf_counter() - start
    return scores, durations


def audio_attack12(evaluator, ctx, dataset, legacy, train, test, rate, bona_label, spoof_label, order):
    model = evaluator._a12_teacher_defense(ctx)
    bona = np.where(test['labels'] == bona_label)[0]
    spoof = np.where(test['labels'] == spoof_label)[0]
    samples = list(test['audios'][bona]) + list(test['audios'][spoof])
    judge = legacy.FidelityJudge()
    pool = [ctx.student_module.CodecAttack()] + [a for a in evaluator._code_module('attack').default_pool()
                                                if a.name != 'A_codec']
    attacks = []
    for attack in pool:
        start = len(samples)
        valid, fidelity = [], []
        for index in spoof:
            result = attack.attack({'sample_id':test['sample_ids'][index], 'audio':test['audios'][index],
                                    'sample_rate':rate})
            if not isinstance(result, dict) or 'audio' not in result:
                raise SubmissionError("CodecAttack.attack 必须返回 {'audio': ndarray}")
            verdict = judge.judge(test['audios'][index], result['audio'], rate)
            samples.append(result['audio'])
            valid.append(bool(verdict['valid']))
            fidelity.append(verdict['fidelity'])
        attacks.append((attack, start, np.asarray(valid,dtype=bool), fidelity))
    scores, _ = audio_predictions(evaluator, ctx, model, samples, rate, order)
    bp, sp = scores[:len(bona)], scores[len(bona):len(bona)+len(spoof)]
    per_attack = []
    for attack, start, valid, fidelity in attacks:
        after = scores[start:start+len(spoof)]
        asr = legacy.attack_success_rate(sp, after, valid, legacy.THRESHOLD)
        fid_agg = {key:float(np.mean([f[key] for f in fidelity if np.isfinite(f[key])]))
                   for key in ('SI_SDR','STOI','duration_ratio','clipping_ratio_est','silence_ratio_est')}
        quality = legacy.quality_coefficient(fid_agg)
        per_attack.append({'attack':getattr(attack,'name',type(attack).__name__), 'ASR':asr,
            'CS':legacy.confidence_suppression(sp,after), 'valid_attack_rate':float(np.mean(valid)) if len(valid) else 0.,
            'mean_p_before':float(np.mean(sp)), 'mean_p_after':float(np.mean(after)), 'Q':quality,
            'CoreASR':asr, 'AttackScore':legacy.attack_score(asr,quality)})
    value = float(np.mean([item['AttackScore'] for item in per_attack])) if per_attack else 0.
    return {'score':value, 'metrics':{'clean':legacy.all_detection_metrics(bp,sp,legacy.THRESHOLD),
            'per_attack':per_attack, 'CoreASR_mean':float(np.mean([item['CoreASR'] for item in per_attack])) if per_attack else 0.,
            'AttackScore_mean':value, 'sample_rate':rate, 'training_performed':False}}


def audio_defense12(evaluator, ctx, legacy, test, rate, bona_label, spoof_label, order):
    model = evaluator._restore_student_defense_12(ctx)
    bona = np.where(test['labels'] == bona_label)[0]
    spoof = np.where(test['labels'] == spoof_label)[0]
    clean_count = len(bona) + len(spoof)
    samples = list(test['audios'][bona]) + list(test['audios'][spoof])
    for attack in evaluator._code_module('attack').default_pool():
        for index in spoof:
            result = attack.attack({'sample_id':test['sample_ids'][index], 'audio':test['audios'][index],
                                    'sample_rate':rate})
            if not isinstance(result, dict) or 'audio' not in result:
                raise SubmissionError("CodecAttack.attack 必须返回 {'audio': ndarray}")
            samples.append(result['audio'])
    scores, durations = audio_predictions(evaluator, ctx, model, samples, rate, order)
    bp, sp = scores[:len(bona)], scores[len(bona):clean_count]
    clean = legacy.all_detection_metrics(bp,sp,legacy.THRESHOLD)
    robust = legacy.all_detection_metrics(bp,scores[clean_count:],legacy.THRESHOLD)
    n_params = sum(int(g.means_.size + g.covariances_.size + g.weights_.size)
                   for g in (model._gmm_bona,model._gmm_spoof))
    size_mb = n_params * 8 / 1e6
    # Original efficiency measures clean inference only. Attribute timings by
    # private inverse indices, not by a distinct clean-only RPC phase.
    avg_ms = float(np.sum(durations[:clean_count])) / max(1,clean_count) * 1000.
    efficiency = legacy.efficiency(size_mb,avg_ms)
    value = legacy.defense_score(robust['EER'],clean['EER'],robust['AUC'],efficiency)
    return {'score':value, 'metrics':{'clean':clean,'robust':robust,
        'defense':{'n_components':(getattr(model,'params',{}) or {}).get('n_components'),
                   'num_ceps':(getattr(model,'params',{}) or {}).get('num_ceps'),
                   'model_size_mb':size_mb,'avg_inference_ms':avg_ms,'Efficiency':efficiency},
        'DefenseScore':value,'training_performed':False}}

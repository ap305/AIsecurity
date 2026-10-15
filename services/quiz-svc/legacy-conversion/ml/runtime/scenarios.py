"""Six course adapters, using the original v2 metrics and fixed model/data settings."""
from __future__ import annotations

import time
import numpy as np
from contracts import (check_poison, check_cleaned, probability, MaterialContractError,
                       watermark_image_result, watermark_probability_result)
from data_access import DATA, load_split, load_patch, load_watermark
from remote import RemoteModel, RemoteAudioAttack, RemoteImageAttack, function
from platform_student import invoke


def participants(context):
    role = context['role']
    if role not in ('attack', 'defense'):
        raise ValueError('missing fixed role')
    other = context.get('opponent') if context['phase'] == 'opponent' else None
    return (context['student'], other) if role == 'attack' else (other, context['student'])


def mnist(context, official, attack, defense, *, backdoor):
    scenario = 'mnist_backdoor' if backdoor else 'mnist_poison'
    train, test = load_split(scenario)
    attacker, defender = participants(context)
    attack_fn = function(attacker, 'attack') if attacker else attack.attack
    defense_fn = function(defender, 'defend') if defender else defense.defend
    kwargs = {'poison_rate': 0.05, 'seed': 42}
    if backdoor:
        kwargs.update(target_label=0, trigger_size=2)
    poisoned = check_poison(train['images'], train['labels'],
                            attack_fn(train['images'].copy(), train['labels'].copy(), **kwargs),
                            backdoor=backdoor)
    clean_model = official.train_model(train['images'], train['labels'], seed=42)
    poison_model = official.train_model(poisoned['images'], poisoned['labels'], seed=42)
    acc_clean = official.accuracy(clean_model, test['images'], test['labels'])
    acc_attack = official.accuracy(poison_model, test['images'], test['labels'])
    # The baseline attack phase tests against the original fixed clean-training classifier.
    # Pairwise attack phases additionally run only the selected student's defense.
    need_defense = context['role'] == 'defense' or context['phase'] == 'opponent'
    if need_defense:
        kw = {} if backdoor else {'seed': 42}
        cleaned = check_cleaned(defense_fn(poisoned['images'].copy(), poisoned['labels'].copy(), **kw))
        model_def = official.train_model(cleaned['images'], cleaned['labels'], seed=42)
        acc_defense = official.accuracy(model_def, test['images'], test['labels'])
    else:
        model_def, acc_defense = poison_model, acc_attack
    result = {'acc_clean': acc_clean, 'acc_attack': acc_attack, 'acc_defense': acc_defense,
              'poison_rate': poisoned['n_modified'] / len(train['labels']),
              'n_modified': poisoned['n_modified'], 'train_size': len(train['labels']), 'test_size': len(test['labels'])}
    if backdoor:
        triggered, _ = official.build_triggered_test(test['images'], test['labels'],
                                                    poisoned['trigger_mask'], poisoned['trigger_pattern'], 0)
        asr_clean = official.asr(clean_model, triggered, 0)
        asr_attack = official.asr(poison_model, triggered, 0)
        asr_defense = official.asr(model_def, triggered, 0)
        gain = official.backdoor_gain(asr_attack, asr_clean)
        removal, skipped = official.backdoor_removal(asr_attack, asr_defense, asr_clean)
        result.update(asr_clean=asr_clean, asr_attack=asr_attack, asr_defense=asr_defense,
                      attack_score=official.attack_score(gain, official.clean_retention(acc_attack, acc_clean)),
                      defense_score=0 if skipped else official.defense_score(removal, official.clean_retention(acc_defense, acc_clean)),
                      defense_score_skipped=int(skipped), backdoor_removal=removal,
                      attack_qualification_margin=min(asr_attack - .60, .03 - (acc_clean - acc_attack)),
                      attack_pair_margin=min(asr_defense - .60, .03 - (acc_clean - acc_defense)),
                      defense_margin=min(.20 - asr_defense, .03 - (acc_clean - acc_defense)))
    else:
        recovery = official.recovery_rate(acc_clean, acc_attack, acc_defense)
        effective = official.effective_asr(acc_clean, acc_defense)
        # Non-damaging normal attacks are not infrastructure errors. Keep a zero diagnostic,
        # and keep this completed matchup in the platform denominator (confirmed D-05).
        recovery_value = 0.0 if recovery is None else recovery
        result.update(untargeted_asr=official.untargeted_asr(acc_clean, acc_attack),
                      accuracy_drop=acc_clean - acc_attack, pair_accuracy_drop=acc_clean - acc_defense,
                      recovery_rate=recovery_value, recovery_defined=int(recovery is not None),
                      effective_asr=effective, defense_score=float(np.clip(recovery_value - effective, 0, 1)))
    return result


def audio(context, official, attack, defense):
    train, test = load_split('deepfake_audio')
    attacker, defender = participants(context)
    model = RemoteModel(defender, 'Defense', seed=42) if defender else defense.LFCCGMMDefense(seed=42)
    model.train(list(train['audios'][train['labels'] == 0]), list(train['audios'][train['labels'] == 1]))
    def predict(audios):
        return np.asarray([probability(model.defend({'audio': audio, 'sample_rate': 16000})['spoof_probability'])
                           for audio in audios])
    bona = test['audios'][test['labels'] == 0]
    spoof = test['audios'][test['labels'] == 1]
    bp, sp = predict(bona), predict(spoof)
    clean = official.all_detection_metrics(bp, sp)
    if attacker:
        attacks = [RemoteAudioAttack(attacker)]
    else:
        attacks = attack.default_pool()
    outcomes, after_all = [], []
    for algorithm in attacks:
        after, valid, fidelities = [], [], []
        for index, sample in enumerate(spoof):
            out = algorithm.attack({'sample_id': f'test-{index}', 'audio': sample.copy(), 'sample_rate': 16000})
            if not isinstance(out, dict) or out.get('sample_rate') != 16000:
                raise MaterialContractError('audio attack must preserve 16kHz sample rate')
            altered = np.asarray(out.get('audio'))
            if altered.dtype.kind not in 'fiu' or altered.ndim != 1 or not altered.size or not np.isfinite(altered).all():
                raise MaterialContractError('audio attack must return finite mono samples')
            # The original spectral and silence metrics require at least one full
            # frame. Such short output already violates the duration contract.
            if len(altered) < 512:
                raise MaterialContractError('audio output is too short for the course metrics')
            verdict = official.FidelityJudge().judge(sample, altered)
            if not all(np.isfinite(value) for value in verdict['fidelity'].values()):
                verdict['valid'] = False
            after.append(probability(model.defend({'audio': altered, 'sample_rate': 16000})['spoof_probability']))
            valid.append(bool(verdict['valid']))
            fidelities.append(verdict['fidelity'])
        after = np.asarray(after)
        after_all.extend(after)
        aggregate = {}
        for key in ('SI_SDR', 'STOI', 'duration_ratio', 'clipping_ratio_est', 'silence_ratio_est'):
            finite = [f[key] for f in fidelities if np.isfinite(f[key])]
            aggregate[key] = float(np.mean(finite)) if finite else 0.0
        q = official.quality_coefficient(aggregate)
        asr = official.attack_success_rate(sp, after, valid)
        outcomes.append({'asr': asr, 'attack_score': official.attack_score(asr, q),
                         'quality': q, 'valid_rate': float(np.mean(valid))})
    robust = official.all_detection_metrics(bp, np.asarray(after_all))
    return dict(clean_auc=clean['AUC'], clean_eer=clean['EER'], robust_auc=robust['AUC'], robust_eer=robust['EER'],
                clean_frr=clean['FRR'], robust_far=robust['FAR'],
                **{key: float(np.mean([r[key] for r in outcomes])) for key in outcomes[0]},
                train_size=64, test_size=64)


def image(context, official, attack, defense):
    train, test = load_split('deepfake_image')
    attacker, defender = participants(context)
    if defender:
        detectors = [RemoteModel(defender, 'Defense', C=1., max_iter=500, seed=42).fit(train['images'], train['labels'])]
    else:
        detectors = [defense.build_defense(name, **params).fit(train['images'], train['labels'])
                     for name, params in defense.FIXED_DEFENSE_POOL]
    attacks = [RemoteImageAttack(attacker)] if attacker else [a for _, a in attack.build_attack_pool()]
    fake = test['images'][test['labels'] == 1]
    real = test['images'][test['labels'] == 0]
    per_attack, pooled = [], [[] for _ in detectors]
    real_scores = [np.asarray([probability(d.predict(im)) for im in real]) for d in detectors]
    clean_scores = [np.asarray([probability(d.predict(im)) for im in test['images']]) for d in detectors]
    for algorithm in attacks:
        altered, valid, ssims, psnrs = [], [], [], []
        for im in fake:
            out = np.asarray(algorithm.apply(im.copy()))
            computable = out.shape == im.shape and out.dtype.kind in 'fiu' and np.isfinite(out).all()
            if computable:
                legal, _ = official.check_legality(im, out)
                # Original v2 reports fidelity independently of its legality flag
                # (e.g. a uniform image can still have a measurable SSIM/PSNR).
                ssims.append(official.ssim(im, out))
                psnrs.append(official.psnr(im, out))
            else:
                raise MaterialContractError('image attack must return a finite RGB array with the original shape')
            altered.append(out)
            valid.append(legal)
        valid = np.asarray(valid, dtype=bool)
        asrs = []
        for index, d in enumerate(detectors):
            scores = np.asarray([probability(d.predict(im)) for im in altered])
            asrs.append(official.attack_success_rate(scores, valid))
            pooled[index].extend(scores[valid])
        per_attack.append({'mean_asr': float(np.mean(asrs)), 'mean_ssim': float(np.mean(ssims)),
                           'mean_psnr': float(np.mean(psnrs)), 'valid_rate': float(valid.mean())})
    aucs, clean_aucs = [], []
    for index in range(len(detectors)):
        clean_aucs.append(official.roc_auc(test['labels'], clean_scores[index]))
        # Original roc_auc returns 0.5 for the single-class case (no legal attacked
        # fakes). Do not invent synthetic probabilities that improve a defense.
        fake_scores = np.asarray(pooled[index])
        labels = np.r_[np.ones(len(fake_scores)), np.zeros(len(real_scores[index]))]
        aucs.append(official.roc_auc(labels, np.r_[fake_scores, real_scores[index]]))
    averages = {k: float(np.mean([r[k] for r in per_attack])) for k in per_attack[0]}
    clean_auc, robust_auc = float(np.mean(clean_aucs)), float(np.mean(aucs))
    return dict(**averages, clean_auc=clean_auc, robust_auc=robust_auc, defense_score=(clean_auc + robust_auc) / 2,
                attack_qualification_margin=min(averages['valid_rate'] - .8, averages['mean_ssim'] - .92),
                train_size=192, test_size=96)


def watermark(context, official, attack, defense):
    # D-05 supersedes the old exception-to-neutral fallback: execution errors are
    # unscored. Original quality-threshold fallback remains in evaluate_pair.
    def safe_student_call(fn, *args):
        return True, fn(*args)
    official._safe = safe_student_call
    attacker, defender = participants(context)
    samples = load_watermark()
    attack_fn = function(attacker, 'attack') if attacker else attack.attack
    embed_fn = function(defender, 'defense') if defender else defense.defense
    detect_fn = function(defender, 'detect') if defender else defense.detect
    def checked_transform(fn):
        def checked(request):
            return watermark_image_result(fn(request), request['image'])
        return checked
    def checked_detector(fn):
        return lambda request: watermark_probability_result(fn(request))
    attack_fn, embed_fn, detect_fn = checked_transform(attack_fn), checked_transform(embed_fn), checked_detector(detect_fn)
    # Explicitly selected pair only. Identity is a control of that same defense,
    # not an additional opponent counted by the platform.
    clean = official.evaluate_pair(attack.identity_attack, embed_fn, detect_fn, samples, 'Id', 'candidate')
    pair = official.evaluate_pair(attack_fn, embed_fn, detect_fn, samples, 'candidate', 'candidate')
    # Retain original matrix diagnostics for baseline calibration: attack strength included
    # the fixed null detector; defense score averaged identity and the selected attack.
    if context['phase'] == 'baseline' and context['role'] == 'attack':
        null = official.evaluate_pair(attack_fn, defense.null_embed, defense.null_detect, samples, 'candidate', 'null')
        mean_attack_auc = (pair['auc'] + null['auc']) / 2
    else:
        mean_attack_auc = pair['auc']
    return dict(clean_auc=clean['auc'], robust_auc=pair['auc'], auc_drop=clean['auc'] - pair['auc'],
                attack_strength=1 - mean_attack_auc, defense_mean_auc=(clean['auc'] + pair['auc']) / 2,
                attack_quality_rate=pair['attack_quality_rate'], embed_quality_rate=clean['embed_quality_rate'],
                attack_valid_rate=pair['attack_valid_rate'], embed_valid_rate=clean['embed_valid_rate'],
                detect_success_rate=pair['detect_success_rate'], tpr=pair['tpr'], fpr=pair['fpr'], test_size=48)


def patch_detection_metrics(official, dataset, detector, samples, patch_image):
    """Each clean-detectable target gets its own independent, paired intervention."""
    eligible = official.compute_eligible(detector, samples)
    if not eligible:
        raise ValueError('fixed detector has no clean-detectable test targets')
    clean, adv, occ, clean_by_image = {}, {}, {}, {}
    cases = []
    rng = np.random.default_rng(42)
    for index, target in enumerate(eligible):
        # Multiple targets can belong to one image. Unique case keys prevent a
        # different, untouched target from entering this intervention's score.
        case_id = f'target-{index}'
        cases.append(dict(target, image_id=case_id))
        image, identifier = target['image'], target['image_id']
        if identifier not in clean_by_image:
            clean_by_image[identifier] = detector.predict(image)[0]
        clean[case_id] = clean_by_image[identifier]
        adv_image, params = dataset.apply_patch(image, target['bbox'], patch_image, rng)
        occ_image, _ = dataset.apply_occlusion(image, target['bbox'], params, rng)
        adv[case_id] = detector.predict(adv_image)[0]
        occ[case_id] = detector.predict(occ_image)[0]
    ec = official.evaluate_targets(cases, clean)
    ea = official.evaluate_targets(cases, adv)
    eo = official.evaluate_targets(cases, occ)
    hide, hide_occ = official.hide_rate(ea['recall']), official.hide_rate(eo['recall'])
    gain = official.attack_gain(hide, hide_occ)
    drop = official.confidence_drop(ec['confs'], ea['confs'])
    return dict(attack_gain=gain, hide_rate=hide, hide_rate_occ=hide_occ, confidence_drop=drop,
                attack_score_base=official.attack_score_base(gain, drop),
                attack_qualification_margin=min(gain - .4, hide - .5),
                eligible_targets=len(eligible), evaluation_cases=len(cases), test_size=len(samples))


def patch(context, official, attack, defense, dataset):
    import torch
    from patch_runtime import configure_patch_runtime
    configure_patch_runtime()
    torch.manual_seed(42)
    np.random.seed(42)
    attacker, defender = participants(context)
    bundle = load_patch(dataset)
    detector = dataset.TinyDetector([dataset.TARGET_COCO_ID], device='cpu', weights_path=str(DATA / 'detector.pt'))
    env = dataset.AttackEnv(detector, device='cpu')
    task = attack.build_task(env, bundle)
    # The worker constructs an independent copy of the public detector. No object crosses RPC.
    if attacker:
        wire_task = {key: value for key, value in task.items() if key != 'detector'}
        result = invoke(attacker, 'course_patch_attack', args=[wire_task], kwargs={'iters': 250, 'seed': 42})
    else:
        result = attack.GradientPatchBaseline(iters=250, seed=42)(env, task)
    ok, patch_image, _ = attack.validate_patch(result)
    if not ok:
        raise MaterialContractError('invalid universal patch')
    result = patch_detection_metrics(official, dataset, detector, bundle['hidden_test'], patch_image)
    base = result['attack_score_base']
    # The attack baseline preserves the original detector-only path. A separate opponent
    # self-test measures the reference matchup metric without changing that baseline.
    if context['role'] == 'attack' and context['phase'] == 'baseline':
        return result
    rng = np.random.default_rng(49)
    tr_clean, tr_patched = official.build_defense_training_data(bundle, rng)
    if defender:
        model = RemoteModel(defender, 'ResNet18Classifier', epochs=8, seed=42).fit(None, tr_clean, tr_patched)
    else:
        model = defense.ResNet18Classifier(epochs=8, seed=42).fit(None, tr_clean, tr_patched)
    patches = official.baseline_patches(rng)
    val_clean = [s['image'].copy() for s in bundle['defense_val']]
    val_patched = []
    for sample in bundle['defense_val']:
        anns = sample['annotations']
        if not anns:
            val_patched.append(sample['image'].copy())
            continue
        ann = anns[int(rng.integers(len(anns)))]
        baseline_patch = patches[int(rng.integers(len(patches)))]
        image, _ = dataset.apply_patch(sample['image'], ann['bbox'], baseline_patch, rng)
        val_patched.append(image)
    values = np.asarray(model.predict_many(val_clean + val_patched))
    values = np.asarray([probability(x) for x in values])
    labels = np.r_[np.zeros(len(val_clean)), np.ones(len(val_patched))]
    validation = official.tpr_fpr_tnr(labels, (values >= .5).astype(int))
    pair = official.evaluate_matchup(patch_image, model, bundle, np.random.default_rng(43))
    result.update(defense_qualification_margin=min(.1 - validation['fpr'], validation['tpr'] - .7),
                  defense_pair_margin=min(.1 - pair['fpr'], pair['tpr'] - .7),
                  validation_fpr=validation['fpr'], validation_tpr=validation['tpr'],
                  defense_score=pair['defense_score'], pair_fpr=pair['fpr'], pair_tpr=pair['tpr'],
                  attack_matchup_score=official.attack_score_matchup(base, pair['evasion']))
    return result


def evaluate(scenario, context):
    # These are trusted package files copied verbatim from the inventoried v2 release.
    # No /materials/code.py or student module is ever imported in this process.
    import original_test as official
    import attack
    import defense
    import dataset
    if scenario == 'mnist_backdoor':
        return mnist(context, official, attack, defense, backdoor=True)
    if scenario == 'mnist_poison':
        return mnist(context, official, attack, defense, backdoor=False)
    if scenario == 'deepfake_audio':
        return audio(context, official, attack, defense)
    if scenario == 'deepfake_image':
        return image(context, official, attack, defense)
    if scenario == 'watermark_image':
        return watermark(context, official, attack, defense)
    if scenario == 'patch_attack':
        return patch(context, official, attack, defense, dataset)
    raise ValueError('unknown course scenario')

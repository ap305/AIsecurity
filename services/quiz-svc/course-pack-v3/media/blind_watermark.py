"""Watermark pair evaluation without disclosing branch labels through call order."""
from __future__ import annotations
import time
import numpy as np


def evaluate_pair(legacy, ctx, attack_fn, embed_fn, detect_fn, samples, attack_name, defense_name):
    from blind_detection import private_order
    count = len(samples)
    embed_success = embed_legal = embed_quality = 0
    embed_log, attack_log, joint_log = [], [], []
    elapsed_embed = elapsed_attack = elapsed_detect = 0.
    originals, branches = [], []
    # Finish embedding before either attack or detection starts. A detector
    # cannot infer a branch from the immediately preceding embed operation.
    for sample in samples:
        original = np.asarray(sample['image'])
        originals.append(original)
        sid = sample.get('sample_id', '')
        started = time.perf_counter()
        ok, value = legacy._safe(embed_fn, {'sample_id': sid, 'image': original.copy()})
        elapsed_embed += time.perf_counter() - started
        embed_success += int(ok)
        embedded = original.copy()
        if ok:
            legal, quality, used = legacy._process_embed(value, original, tuple(original.shape), embed_log)
            embed_legal += int(legal)
            embed_quality += int(quality)
            if used is not None:
                embedded = used
        # The index is grader-only. Student callbacks receive identical fields.
        branches.extend([{'sample_id': sid, 'image': embedded}, {'sample_id': sid, 'image': original.copy()}])
    attacked = [None] * len(branches)
    attack_ok = [False] * len(branches)
    attack_legal = attack_quality = 0
    purpose = str(attack_name) + ':' + str(defense_name)
    for index in private_order(ctx, len(branches), 'watermark10-attack:' + purpose):
        branch = branches[index]
        started = time.perf_counter()
        ok, value = legacy._safe(attack_fn, {'sample_id': branch['sample_id'], 'image': branch['image'].copy()})
        elapsed_attack += time.perf_counter() - started
        attack_ok[index] = ok
        legal, quality, image = legacy._process_attack(value, ok, branch['image'], tuple(branch['image'].shape),
                                                      attack_log if index % 2 == 0 else None)
        attack_legal += int(legal)
        attack_quality += int(quality)
        attacked[index] = image
    detected = [None] * len(branches)
    detect_ok = [False] * len(branches)
    for index in private_order(ctx, len(branches), 'watermark10-detect:' + purpose):
        started = time.perf_counter()
        ok, value = legacy._safe(detect_fn, {'image': attacked[index].copy()})
        elapsed_detect += time.perf_counter() - started
        detected[index], detect_ok[index] = legacy._extract_probability(value if ok else None)
    for index, original in enumerate(originals):
        joint_log.append((legacy.ssim(original, attacked[2 * index]), legacy.psnr(original, attacked[2 * index])))
    labels = [label for _ in samples for label in (1, 0)]
    auc = legacy.roc_auc(labels, detected)
    tpr, fpr = legacy.tpr_fpr(labels, detected, tau=legacy.TAU)
    attack_success = sum(attack_ok[2 * i] and attack_ok[2 * i + 1] for i in range(count))
    detect_success = sum(detect_ok[2 * i] and detect_ok[2 * i + 1] for i in range(count))
    return {'attack_id': attack_name, 'defense_id': defense_name, 'n': count,
        'auc': auc, 'tpr': tpr, 'fpr': fpr,
        'embed_success_rate': embed_success / count if count else 0.,
        'attack_success_rate': attack_success / count if count else 0.,
        'detect_success_rate': detect_success / count if count else 0.,
        'embed_valid_rate': embed_legal / count if count else 0.,
        'attack_valid_rate': attack_legal / (2 * count) if count else 0.,
        'embed_quality_rate': embed_quality / count if count else 0.,
        'attack_quality_rate': attack_quality / (2 * count) if count else 0.,
        'embed_quality': legacy.mean_quality(embed_log), 'attack_quality': legacy.mean_quality(attack_log),
        'joint_quality': legacy.mean_quality(joint_log), 'time_embed': elapsed_embed,
        'time_attack': elapsed_attack, 'time_detect': elapsed_detect}

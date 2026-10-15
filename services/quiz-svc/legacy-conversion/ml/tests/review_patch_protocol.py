"""Reproduce the Patch target-scope review on public train/validation data only.

This analysis does not change the deployed grader or its qualification thresholds.
Run in the fixed course image, with only public.npz and public detector.pt mounted.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys

import numpy as np
import torch


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-data', type=Path, required=True)
    parser.add_argument('--weights', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--course-source', type=Path, default=Path(__file__).resolve().parents[1] / 'sources' / 'patch_attack')
    parser.add_argument('--image-id', required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError('do not overwrite review evidence')
    with np.load(args.public_data, allow_pickle=False) as archive:
        if archive['split_names'].tolist() != ['attack_train', 'attack_val'] or archive['split_sizes'].tolist() != [120, 30]:
            raise ValueError('review accepts only the public 120/30 export, never a full benchmark')
        arrays = {name: archive[name] for name in ('images', 'boxes', 'cids', 'counts')}
        if any(len(value) != 150 for value in arrays.values()):
            raise ValueError('public export must contain exactly 150 records')
        array_proof = {name: dict(dtype=str(value.dtype), shape=list(value.shape),
                                 sha256=hashlib.sha256(value.tobytes(order='C')).hexdigest())
                       for name, value in arrays.items()}
    sys.path.insert(0, str(args.course_source.resolve()))
    import attack
    import dataset
    import test as metrics
    torch.manual_seed(42)
    torch.set_num_threads(2)
    np.random.seed(42)
    bundle = dataset._load_benchmark_from_npz(str(args.public_data), {'attack_train': 120, 'attack_val': 30})
    detector = dataset.TinyDetector([1], device='cpu', weights_path=str(args.weights))
    env = dataset.AttackEnv(detector, device='cpu')
    patch = attack.GradientPatchAttack(iters=250, seed=42)(env, attack.build_task(env, bundle))['patch']
    valid, patch, _ = attack.validate_patch({'patch': patch})
    if not valid:
        raise RuntimeError('official reference returned an invalid patch')
    eligible = metrics.compute_eligible(detector, bundle['attack_val'])

    def summarize(count, adv_hits, occ_hits):
        hide, hide_occ = 1 - adv_hits / count, 1 - occ_hits / count
        gain = metrics.attack_gain(hide, hide_occ)
        return dict(targets=count, adv_hits=adv_hits, occlusion_hits=occ_hits,
                    hide_rate=hide, hide_rate_occ=hide_occ, attack_gain=gain,
                    qualification_margin=min(gain - .4, hide - .5),
                    qualified=gain >= .4 and hide >= .5)

    rng = np.random.default_rng(42)
    adv_predictions, occ_predictions = {}, {}
    first_count = first_adv_hits = first_occ_hits = 0
    for target in eligible:
        identifier = target['image_id']
        if identifier in adv_predictions:
            continue
        adv, params = dataset.apply_patch(target['image'], target['bbox'], patch, rng)
        occ, _ = dataset.apply_occlusion(target['image'], target['bbox'], params, rng)
        pa, po = detector.predict(adv)[0], detector.predict(occ)[0]
        adv_predictions[identifier], occ_predictions[identifier] = pa, po
        first_count += 1
        first_adv_hits += metrics.best_match(target['bbox'], target['cid'], pa)[0]
        first_occ_hits += metrics.best_match(target['bbox'], target['cid'], po)[0]
    original = summarize(len(eligible), metrics.evaluate_targets(eligible, adv_predictions)['n_correct'],
                         metrics.evaluate_targets(eligible, occ_predictions)['n_correct'])
    actual_targets = summarize(first_count, first_adv_hits, first_occ_hits)
    rng = np.random.default_rng(42)
    independent_adv_hits = independent_occ_hits = 0
    for target in eligible:
        adv, params = dataset.apply_patch(target['image'], target['bbox'], patch, rng)
        occ, _ = dataset.apply_occlusion(target['image'], target['bbox'], params, rng)
        independent_adv_hits += metrics.best_match(target['bbox'], target['cid'], detector.predict(adv)[0])[0]
        independent_occ_hits += metrics.best_match(target['bbox'], target['cid'], detector.predict(occ)[0])[0]
    report = dict(
        status='public_analysis_not_a_publication_self_test', questionId='PATCH-AD',
        purpose='Public-only target-scope comparison; no production grading change',
        seed=42, trainingSamples=120, validationImages=30, eligibleTargets=len(eligible),
        thresholds=dict(attack_gain=.4, hide_rate=.5, comparison='greater_than_or_equal'),
        sourceFiles={name: sha256(args.course_source / name) for name in ('attack.py', 'dataset.py', 'test.py')},
        publicData=dict(sha256=sha256(args.public_data), arrays=array_proof),
        publicWeightsSha256=sha256(args.weights),
        trainedPatchFloat32BytesSha256=hashlib.sha256(patch.astype(np.float32).tobytes(order='C')).hexdigest(),
        runtime=dict(imageId=args.image_id, torch=torch.__version__, numpy=np.__version__,
                     torchvision=importlib.metadata.version('torchvision'), torchThreads=2),
        scopes=dict(unchanged_original=original, only_actually_patched_targets=actual_targets,
                    each_eligible_independent=summarize(len(eligible), independent_adv_hits, independent_occ_hits)),
        interpretation='The official patch hides every actually patched validation target. Untouched targets remain in the original denominator. This does not prove the original threshold mathematically impossible.',
    )
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps(report['scopes'], ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()

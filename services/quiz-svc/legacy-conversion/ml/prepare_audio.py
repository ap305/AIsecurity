#!/usr/bin/env python
"""Replace the broken old audio cache with deterministic disjoint splits from its original generator."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import numpy as np


def create_audio_asset(destination):
    source = Path(__file__).resolve().parent / 'sources' / 'deepfake_audio' / 'dataset.py'
    spec = importlib.util.spec_from_file_location('original_audio_dataset', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    samples = module.generate_dataset(n_bonafide=64, n_spoof=64, seed=42)
    rng = np.random.default_rng(42)
    train, test = [], []
    for label in (0, 1):
        pool = [sample for sample in samples if sample['label'] == label]
        indices = rng.permutation(len(pool))
        train.extend(pool[int(index)] for index in indices[:32])
        test.extend(pool[int(index)] for index in indices[32:64])
    train, test = module._stack(train), module._stack(test)
    if set(train['sample_ids']) & set(test['sample_ids']):
        raise ValueError('original generator produced duplicate sample identities')
    arrays = {}
    for split, data in (('train', train), ('test', test)):
        for key in ('audios', 'labels', 'sample_ids'):
            arrays[split + '_' + key] = np.asarray(data[key])
    destination = Path(destination)
    if destination.exists():
        raise FileExistsError('refusing to overwrite audio data; select a new staging path')
    destination.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(destination, **arrays)
    report = {'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'seed': 42,
              'train': 64, 'test': 64, 'trainClassCounts': [32, 32], 'testClassCounts': [32, 32],
              'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'disjoint': True}
    destination.with_suffix('.provenance.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(create_audio_asset(args.output)))

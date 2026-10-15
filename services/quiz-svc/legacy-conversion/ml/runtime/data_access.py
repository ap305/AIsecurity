"""Read fixed, verified grader-only assets. Missing data never falls back to another benchmark."""
from __future__ import annotations

from pathlib import Path
import numpy as np

DATA = Path(__file__).resolve().parent / 'data'


def load_split(kind):
    if kind == 'deepfake_audio':
        with np.load(DATA / 'audio_splits.npz', allow_pickle=False) as bundle:
            train = {key: bundle['train_' + key] for key in ('audios', 'labels', 'sample_ids')}
            test = {key: bundle['test_' + key] for key in ('audios', 'labels', 'sample_ids')}
        if len(train['labels']) != 64 or len(test['labels']) != 64:
            raise ValueError('audio course requires 64 training and 64 test samples')
        if set(train['sample_ids']) & set(test['sample_ids']):
            raise ValueError('training/test sample overlap')
        return train, test
    expected = (8000, 2000) if kind.startswith('mnist_') else (192, 96)
    splits = []
    for name, size in zip(('train', 'test'), expected):
        with np.load(DATA / (name + '.npz'), allow_pickle=False) as bundle:
            split = {key: bundle[key] for key in ('images', 'labels')}
            # The original image cache has object-typed IDs. Scoring needs only
            # numeric images/labels, so never enable pickle just to read unused IDs.
        if len(split['labels']) != size or len(split['images']) != size:
            raise ValueError('course dataset size differs from the fixed v2 benchmark')
        splits.append(split)
    return tuple(splits)


def load_patch(dataset):
    # The public worker receives only detector.pt, never this benchmark archive.
    return dataset._load_benchmark_from_npz(str(DATA / 'benchmark.npz'), dataset.SPLIT_SIZES)


def load_watermark():
    with np.load(DATA / 'synth_images.npz', allow_pickle=False) as bundle:
        images, ids = bundle['images'], bundle['sample_ids']
    if images.shape != (48, 512, 512, 3) or images.dtype != np.uint8:
        raise ValueError('watermark course requires 48 RGB 512px images')
    return [{'image': image, 'sample_id': str(identifier)} for image, identifier in zip(images, ids)]

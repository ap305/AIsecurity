"""Trusted validation for the v2 course; never deserialize a student's Python objects."""
from __future__ import annotations

import numpy as np


class MaterialContractError(ValueError):
    pass


def probability(value):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise MaterialContractError('probability must be a numeric scalar') from error
    if not np.isfinite(number) or not 0 <= number <= 1:
        raise MaterialContractError('probability must be finite and within [0,1]')
    return number


def watermark_image_result(result, reference):
    if not isinstance(result, dict) or 'image' not in result:
        raise MaterialContractError('watermark transform must return an image dictionary')
    output = np.asarray(result['image'])
    if output.shape != np.asarray(reference).shape or output.dtype != np.uint8:
        raise MaterialContractError('watermark transform must preserve RGB shape and uint8 dtype')
    return result


def watermark_probability_result(result):
    if not isinstance(result, dict) or 'watermark_probability' not in result:
        raise MaterialContractError('watermark detector must return watermark_probability')
    return dict(result, watermark_probability=probability(result['watermark_probability']))


def mnist_arrays(result, *, max_samples=32000):
    if not isinstance(result, dict) or 'images' not in result or 'labels' not in result:
        raise MaterialContractError('expected images and labels')
    images, labels = np.asarray(result['images']), np.asarray(result['labels'])
    if images.ndim != 4 or images.shape[1:] != (1, 28, 28) or not 1 <= len(images) <= max_samples:
        raise MaterialContractError('invalid MNIST image dimensions')
    if labels.shape != (len(images),) or labels.dtype.kind not in 'iu':
        raise MaterialContractError('invalid MNIST labels')
    if images.dtype.kind not in 'fiu' or not np.isfinite(images).all() or images.min() < 0 or images.max() > 1:
        raise MaterialContractError('invalid MNIST pixel values')
    if labels.min() < 0 or labels.max() > 9:
        raise MaterialContractError('MNIST label outside 0..9')
    return images.astype(np.float32), labels.astype(np.int64)


def check_poison(original_images, original_labels, result, rate=0.05, *, backdoor=False, target=0):
    images, labels = mnist_arrays(result, max_samples=len(original_images))
    if images.shape != original_images.shape:
        raise MaterialContractError('poisoning may not add or delete training samples')
    image_changed = np.any(images != original_images, axis=(1, 2, 3))
    changed = image_changed | (labels != original_labels)
    n_modified = int(changed.sum())
    if n_modified > int(len(images) * rate):
        raise MaterialContractError('poisoning exceeds the five-percent sample budget')
    checked = dict(result, images=images, labels=labels, n_modified=n_modified)
    if backdoor:
        mask = np.asarray(result.get('trigger_mask'))
        pattern = np.asarray(result.get('trigger_pattern'))
        if mask.shape != (1, 28, 28) or pattern.shape != mask.shape:
            raise MaterialContractError('trigger must be [1,28,28]')
        if not np.isfinite(mask).all() or not np.isfinite(pattern).all():
            raise MaterialContractError('trigger must be finite')
        if not np.all((mask == 0) | (mask == 1)) or int(mask.sum()) != 4:
            raise MaterialContractError('trigger mask must contain exactly four binary pixels')
        ys, xs = np.where(mask[0] == 1)
        if ys.max() - ys.min() != 1 or xs.max() - xs.min() != 1:
            raise MaterialContractError('trigger mask must be a contiguous two-by-two square')
        if pattern.min() < 0 or pattern.max() > 1:
            raise MaterialContractError('trigger values must be within [0,1]')
        expected = original_images * (1 - mask) + pattern * mask
        if np.any(labels[changed] != target) or not np.allclose(images[changed], expected[changed], rtol=0, atol=1e-7):
            raise MaterialContractError('all poisoned samples must use the same trigger and target label')
        checked.update(trigger_mask=mask.astype(np.float32), trigger_pattern=pattern.astype(np.float32))
    return checked


def check_cleaned(result):
    images, labels = mnist_arrays(result)
    # Original v2's fixed sklearn MLP does not consume sample_weights. Do not silently pretend it does.
    if result.get('sample_weights') is not None:
        raise MaterialContractError('this course MLP accepts cleaned/augmented samples, not sample_weights')
    return dict(result, images=images, labels=labels)


def finite_metrics(values):
    return {str(key): float(value) for key, value in values.items()
            if isinstance(value, (int, float, np.integer, np.floating, bool)) and np.isfinite(value)}

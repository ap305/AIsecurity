"""Grader-private inference schedules; labels and inverse indices never enter RPC."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import numpy as np
from contracts import MaterialContractError

ORDER_PATH = Path(__file__).resolve().parent / 'evaluation-order.json'


def private_order(context, size, purpose):
    # The context can contain student-visible frozen parameters. Never accept a
    # seed from it: the only source is this immutable, grader-only package file.
    value = json.loads(ORDER_PATH.read_text(encoding='utf8'))
    raw = value.get('seed')
    if (value.get('schemaVersion') != 1 or not isinstance(raw, str) or len(raw) != 64
            or any(ch not in '0123456789abcdef' for ch in raw)):
        raise ValueError('invalid private evaluation order')
    seed = bytes.fromhex(raw)
    digest = hashlib.sha256(seed + purpose.encode('utf8')).digest()
    return np.random.default_rng(int.from_bytes(digest, 'big')).permutation(size)


def mixed_predictions(context, samples, predict_many, purpose):
    order = private_order(context, len(samples), purpose)
    values = np.asarray(predict_many([samples[int(index)] for index in order]), dtype=np.float64)
    if values.shape != (len(samples),) or not np.isfinite(values).all():
        raise MaterialContractError('detector returned invalid prediction count or values')
    if np.any(values < 0) or np.any(values > 1):
        raise MaterialContractError('detector probabilities must be in [0,1]')
    restored = np.empty(len(samples), dtype=np.float64)
    restored[order] = values
    return restored

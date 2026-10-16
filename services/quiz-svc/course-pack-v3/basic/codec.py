"""Course-local tensor codec layered on the platform's bounded, data-only RPC.

No pickle, dynamic type lookup, executable source, or teacher-side object
construction is accepted from student responses. Dictionary keys are data.
"""
from __future__ import annotations

import math


def pack(value, object_encoder=None, depth=0):
    import numpy as np
    import torch
    if depth > 40:
        raise ValueError('course value nesting limit')
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('non-finite course number')
        return value
    if torch.is_tensor(value):
        if value.layout != torch.strided:
            value = value.to_dense()
        return {'kind': 'tensor', 'value': value.detach().cpu().contiguous().numpy()}
    if isinstance(value, np.ndarray):
        return {'kind': 'array', 'value': value}
    if isinstance(value, np.generic):
        return pack(value.item(), object_encoder, depth + 1)
    if isinstance(value, torch.device):
        if value.type != 'cpu':
            raise ValueError('course inference only supports CPU')
        return {'kind': 'device', 'value': 'cpu'}
    if isinstance(value, (list, tuple)):
        return {'kind': 'tuple' if isinstance(value, tuple) else 'list',
                'value': [pack(v, object_encoder, depth + 1) for v in value]}
    if isinstance(value, dict):
        if any(type(k) not in (str, int) for k in value):
            raise ValueError('course dictionary keys must be strings or integers')
        return {'kind': 'dict', 'value': [[k, pack(v, object_encoder, depth + 1)] for k, v in value.items()]}
    if object_encoder:
        return object_encoder(value)
    raise ValueError('unsupported course value')


def unpack(value, object_decoder=None, depth=0):
    import numpy as np
    import torch
    if depth > 40:
        raise ValueError('course value nesting limit')
    if value is None or type(value) in (str, bool, int):
        return value
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError('non-finite course number')
        return value
    if not isinstance(value, dict) or set(value) != {'kind', 'value'}:
        raise ValueError('invalid course value')
    kind, raw = value['kind'], value['value']
    if kind in ('tensor', 'array'):
        if not isinstance(raw, np.ndarray) or raw.dtype.kind not in 'biuf' or raw.ndim > 8:
            raise ValueError('invalid numerical array')
        if raw.dtype.kind == 'f' and not np.isfinite(raw).all():
            raise ValueError('non-finite numerical array')
        return torch.from_numpy(raw) if kind == 'tensor' else raw
    if kind == 'device' and raw == 'cpu':
        return torch.device('cpu')
    if kind in ('list', 'tuple') and isinstance(raw, list):
        result = [unpack(v, object_decoder, depth + 1) for v in raw]
        return tuple(result) if kind == 'tuple' else result
    if kind == 'dict' and isinstance(raw, list):
        result = {}
        for pair in raw:
            if not isinstance(pair, list) or len(pair) != 2 or type(pair[0]) not in (str, int) or pair[0] in result:
                raise ValueError('invalid course dictionary')
            result[pair[0]] = unpack(pair[1], object_decoder, depth + 1)
        return result
    if kind == 'object' and object_decoder and isinstance(raw, str):
        return object_decoder(raw)
    raise ValueError('unsupported course response type')

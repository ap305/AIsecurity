"""Data-only RPC encoding for numeric privacy data and published tabular cells.

NaN represents missing ratings. Infinity, pickle and dynamic type construction
are forbidden. DataFrame/Series carry only bounded cells, labels and indexes.
"""
from __future__ import annotations

import math


def pack(value, depth=0):
    import numpy as np
    import pandas as pd
    import torch
    if depth > 40:
        raise ValueError('tabular nesting limit')
    if value is None or type(value) in (str, bool, int):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return {'kind': 'missing', 'value': None}
        if not math.isfinite(value):
            raise ValueError('infinite tabular value')
        return value
    if isinstance(value, np.generic):
        return pack(value.item(), depth + 1)
    if torch.is_tensor(value):
        return {'kind': 'tensor', 'value': value.detach().cpu().contiguous().numpy()}
    if isinstance(value, np.ndarray):
        if value.ndim > 8 or value.nbytes > 67108864:
            raise ValueError('tabular array limit')
        if value.dtype.kind in 'biuf':
            if value.dtype.kind == 'f' and np.isinf(value).any():
                raise ValueError('infinite tabular array')
            if value.dtype.kind == 'f' and np.isnan(value).any():
                # Production RPC permits finite numeric arrays only. Missing
                # ratings cross as an explicit boolean mask, never JSON NaN.
                return {'kind': 'masked_array', 'value': [np.nan_to_num(value, nan=0), np.isnan(value)]}
            return {'kind': 'array', 'value': value}
        if value.dtype.kind in 'OUS':
            return {'kind': 'cells', 'value': [list(value.shape), [pack(v, depth + 1) for v in value.reshape(-1).tolist()]]}
        raise ValueError('unsupported array dtype')
    if isinstance(value, pd.DataFrame):
        return {'kind': 'frame', 'value': pack([value.columns.tolist(), value.index.tolist(), value.to_numpy(dtype=object)], depth + 1)}
    if isinstance(value, pd.Series):
        return {'kind': 'series', 'value': pack([value.index.tolist(), value.tolist(), value.name], depth + 1)}
    if isinstance(value, (tuple, list, set, frozenset)):
        kind = 'tuple' if isinstance(value, tuple) else 'set' if isinstance(value, (set, frozenset)) else 'list'
        return {'kind': kind, 'value': [pack(v, depth + 1) for v in value]}
    if isinstance(value, dict):
        if any(type(k) not in (str, int) for k in value):
            raise ValueError('invalid tabular dictionary key')
        return {'kind': 'dict', 'value': [[k, pack(v, depth + 1)] for k, v in value.items()]}
    raise ValueError('unsupported tabular value')


def unpack(value, depth=0):
    import numpy as np
    import pandas as pd
    import torch
    if depth > 40:
        raise ValueError('tabular nesting limit')
    if value is None or type(value) in (str, bool, int):
        return value
    if type(value) is float and math.isfinite(value):
        return value
    if not isinstance(value, dict) or set(value) != {'kind', 'value'}:
        raise ValueError('invalid tabular envelope')
    kind, raw = value['kind'], value['value']
    if kind == 'missing' and raw is None:
        return float('nan')
    if kind == 'masked_array':
        if not isinstance(raw, list) or len(raw) != 2:
            raise ValueError('invalid missing-value mask')
        data, mask = raw
        if not isinstance(data, np.ndarray) or not isinstance(mask, np.ndarray) or data.dtype.kind != 'f' or mask.dtype.kind != 'b' or data.shape != mask.shape or data.nbytes > 67108864 or data.ndim > 8 or not np.isfinite(data).all():
            raise ValueError('invalid missing-value arrays')
        return np.where(mask, np.nan, data)
    if kind in ('tensor', 'array'):
        if not isinstance(raw, np.ndarray) or raw.dtype.kind not in 'biuf' or raw.ndim > 8 or raw.nbytes > 67108864:
            raise ValueError('invalid tabular array')
        if raw.dtype.kind == 'f' and (np.isinf(raw).any() or (kind == 'tensor' and np.isnan(raw).any())):
            raise ValueError('invalid numerical value')
        return torch.from_numpy(raw) if kind == 'tensor' else raw
    if kind == 'cells' and isinstance(raw, list) and len(raw) == 2:
        shape, cells = raw
        if not isinstance(shape, list) or len(shape) > 8 or any(type(n) is not int or n < 0 for n in shape):
            raise ValueError('invalid cell shape')
        if not isinstance(cells, list) or math.prod(shape) != len(cells) or len(cells) > 1000000:
            raise ValueError('cell count limit')
        result = np.empty(len(cells), dtype=object)
        for i, cell in enumerate(cells):
            result[i] = unpack(cell, depth + 1)
        return result.reshape(shape)
    if kind in ('list', 'tuple', 'set') and isinstance(raw, list):
        result = [unpack(v, depth + 1) for v in raw]
        return tuple(result) if kind == 'tuple' else set(result) if kind == 'set' else result
    if kind == 'dict' and isinstance(raw, list):
        result = {}
        for item in raw:
            if not isinstance(item, list) or len(item) != 2 or type(item[0]) not in (str, int) or item[0] in result:
                raise ValueError('invalid tabular dictionary')
            result[item[0]] = unpack(item[1], depth + 1)
        return result
    if kind in ('frame', 'series'):
        cells = unpack(raw, depth + 1)
        if not isinstance(cells, list) or len(cells) != 3:
            raise ValueError('invalid tabular table')
        if kind == 'frame':
            columns, index, data = cells
            if not isinstance(data, np.ndarray) or data.ndim != 2 or data.shape != (len(index), len(columns)):
                raise ValueError('invalid tabular frame dimensions')
            return pd.DataFrame(data, columns=columns, index=index)
        index, data, name = cells
        if not isinstance(data, list) or len(index) != len(data):
            raise ValueError('invalid tabular series dimensions')
        return pd.Series(data, index=index, name=name)
    raise ValueError('unsupported tabular type')

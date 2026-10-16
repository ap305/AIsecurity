"""Project result protocol: bounded finite numerical metrics, exact bindings."""
from __future__ import annotations
import hashlib
import math
import re


def numeric_metrics(source):
    output = {}
    priority = ('qualificationMetric', 'successMetric', 'legalityGate', 'sourceScore')
    def add(key, value):
        if len(output) >= 100:
            return
        if isinstance(value, (bool, int, float)) and math.isfinite(float(value)):
            name = re.sub('[^A-Za-z0-9_.-]', '_', key)
            if not name or not name[0].isalpha() or not name[0].isascii():
                name = 'm_' + name
            if len(name) > 80:
                name = name[:71] + '_' + hashlib.sha256(name.encode()).hexdigest()[:8]
            if name in output:
                raise ValueError('numerical metric key collision')
            output[name] = int(value) if isinstance(value, bool) else value
        elif isinstance(value, dict):
            for child, item in value.items():
                add(key + '.' + str(child), item)
        elif isinstance(value, (list, tuple)):
            for index, item in enumerate(value):
                add(key + '.' + str(index), item)
    for name in priority:
        if name in source:
            add(name, source[name])
    for name, value in source.items():
        if name not in priority:
            add(str(name), value)
    return output


def completed(context, evaluated):
    result = {'status':'completed', 'metrics':numeric_metrics(evaluated.get('metrics', {}))}
    if context['phase'] == 'basic':
        result.update(score=evaluated['score'], maxScore=100)
    elif context['phase'] == 'opponent':
        parameters = context.get('parameters', {})
        if parameters.get('calibrationMode') is True:
            result['success'] = False
        else:
            threshold = parameters.get('successThreshold')
            if type(threshold) not in (int, float) or not math.isfinite(threshold) or not 0 < threshold <= 1:
                raise ValueError('opponent success threshold must be calibrated and positive')
            result['success'] = bool(result['metrics']['successMetric'] >= threshold and
                                     result['metrics'].get('legalityGate', 1) >= 1)
    return result

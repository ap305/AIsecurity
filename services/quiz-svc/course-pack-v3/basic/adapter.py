"""Trusted adapter for the archived B01..B17 scoring functions.

Only numerical outputs cross from the worker. Private labels, aggregation,
teacher reference execution and final result writing remain in this process.
"""
from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path
from types import SimpleNamespace

from basic_codec import pack, unpack
from judge_runtime import ConfigurationError, SubmissionError
from platform_student import invoke, expose, StudentExecutionError, EvaluationInfrastructureError, EvaluationTimeoutError


class InfrastructureFailure(BaseException):
    """Bypass upstream broad student-error catches without losing provenance."""
    def __init__(self, timeout=False):
        self.timeout = timeout


class Remote:
    def __init__(self, bridge, identifier, symbol=None):
        if not isinstance(identifier, str) or not re.fullmatch('[a-f0-9]{32}', identifier):
            raise SubmissionError('学生返回非法对象标识')
        object.__setattr__(self, '_bridge', bridge)
        object.__setattr__(self, '_identifier', identifier)
        object.__setattr__(self, '_symbol', symbol)

    def __call__(self, *args, **kwargs):
        if self._symbol:
            return self._bridge.call('function', {'name': self._symbol, 'args': args, 'kwargs': kwargs})
        return self._bridge.call('call', {'object': self, 'args': args, 'kwargs': kwargs})

    def __getattr__(self, name):
        return self._bridge.call('member', {'object': self, 'name': name})

    def __setattr__(self, name, value):
        self._bridge.call('set', {'object': self, 'name': name, 'value': value})


class RemoteModule:
    def __init__(self, bridge):
        self.bridge = bridge
    def __getattr__(self, name):
        result = self.bridge.call('symbol', {'name': name})
        if isinstance(result, Remote):
            object.__setattr__(result, '_symbol', name)
        return result


class RemoteWeights:
    def __init__(self, bridge):
        self.bridge = bridge
        self._info = None
    def info(self):
        if self._info is None:
            info = self.bridge.call('weight_info')
            if not isinstance(info, dict) or not isinstance(info.get('shapes'), dict):
                raise SubmissionError('参数结构描述无效')
            self._info = info
        return self._info
    @property
    def metadata(self):
        return self.info().get('metadata', {})
    @property
    def raw(self):
        return self.info().get('raw', {})
    def as_state_dict(self, model=None):
        # Upstream only reads embedding rows for B06/B12. Never transfer or
        # deserialize a student's full checkpoint into the trusted grader.
        shapes = self.info()['shapes']
        result = {}
        for key, shape in shapes.items():
            if not isinstance(key, str) or not isinstance(shape, list) or any(type(n) is not int or n < 0 for n in shape):
                raise SubmissionError('参数维度无效')
            result[key] = SimpleNamespace(shape=tuple(shape))
        return result
    def tensor(self, name):
        return self.bridge.call('tensor', {'name': name})


class Bridge:
    def __init__(self, worker):
        self.worker = worker
    def encode_object(self, value):
        if not isinstance(value, Remote) or value._bridge is not self:
            raise ValueError('only this student worker can own a remote object')
        return {'kind': 'object', 'value': value._identifier}
    def call(self, operation, data=None, capability=None):
        try:
            args = [operation, pack(data or {}, self.encode_object)]
            if capability is not None:
                args.append(capability)
            response = invoke(self.worker, 'course_basic_call', args)
            return unpack(response, lambda key: Remote(self, key))
        except EvaluationTimeoutError as error:
            raise InfrastructureFailure(timeout=True) from error
        except EvaluationInfrastructureError as error:
            raise InfrastructureFailure() from error
        except StudentExecutionError:
            raise SubmissionError('学生代码或参数接口运行失败') from None
        except (ValueError, TypeError, KeyError):
            raise SubmissionError('学生返回了不符合接口的结果') from None


def configure(evaluator, context, worker):
    bridge = Bridge(worker)
    context.student_module = RemoteModule(bridge)
    context.weights = RemoteWeights(bridge) if context.problem['weights']['required'] else None

    def load_model(ctx, cls_name, state_model=None, what=None, *args, **kwargs):
        return bridge.call('load_model', {'name': cls_name, 'state_model': state_model, 'args': args, 'kwargs': kwargs})
    evaluator._load_model = load_model

    original_student_attr = evaluator._student_attr
    def student_attr(ctx, name):
        if ctx.id == 'B04' and name == 'run_inference':
            def detection(model, tensor, device):
                def predict(encoded):
                    import torch
                    tensors = unpack(encoded)
                    if not isinstance(tensors, list) or not 1 <= len(tensors) <= 4:
                        raise SubmissionError('检测模型请求批量无效')
                    for value in tensors:
                        if not torch.is_tensor(value) or value.ndim != 3 or value.shape[0] != 3 or value.numel() > 12000000:
                            raise SubmissionError('检测模型请求图像无效')
                    with torch.inference_mode():
                        return pack(model(tensors))
                return bridge.call('detection', {'tensor': tensor}, expose(methods={'predict': predict}))
            return detection
        return original_student_attr(ctx, name)
    evaluator._student_attr = student_attr
    evaluator._patch_fasterrcnn_factory = lambda ctx, model: None

    def check_gp(ctx, teacher, real):
        try:
            value = bridge.call('gradient_penalty', {'state': teacher.state_dict(), 'real': real[:64], 'fake': real[:64].clone()})
            value = float(value.item())
            return math.isfinite(value) and value >= 0, value
        except Exception:
            return False, float('nan')
    evaluator._b08_check_gp = check_gp

    def augment_contract(ctx, images):
        import numpy as np
        image = (np.clip(images[0][0], 0, 1) * 255).astype('uint8')
        return bridge.call('augment_contract', {'image': image})
    evaluator._b15_augment_contract = augment_contract

    def bert(ctx):
        import numpy as np
        import torch
        import dataset
        evaluator._require_data(ctx, 'data/AGNews/train.csv', 'data/AGNews/test.csv')
        evaluator._b17_config_dir(ctx)
        model = load_model(ctx, 'BertClassifier')
        _, test = dataset.load_benchmark(0, dataset.DEFAULT_TEST_SIZE, dataset.DEFAULT_SEED)
        texts = list(test['texts'])
        labels = np.asarray(test['labels'], dtype=np.int64)
        count = len(texts)
        options = ctx.problem.get('inference') or {}
        maximum = options.get('max_samples', evaluator.B17_DEFAULT_MAX_SAMPLES)
        seed = int(options.get('seed', evaluator.B17_DEFAULT_SEED))
        if maximum is None or int(maximum) <= 0 or int(maximum) >= count:
            selection = np.arange(count, dtype=np.int64)
        else:
            selection = np.sort(np.random.default_rng(seed).choice(count, size=int(maximum), replace=False))
        correct = total = 0
        for start in range(0, len(selection), 32):
            indices = selection[start:start + 32]
            batch = bridge.call('bert_batch', {'texts': [texts[int(index)] for index in indices]})
            output = model(batch['input_ids'], batch['attention_mask'])
            evaluator._check_logits(output, 'BertClassifier', classes=4)
            if output.shape[0] != len(indices):
                raise SubmissionError('BERT输出批量与输入不一致')
            expected = torch.from_numpy(labels[indices])
            correct += int((output.argmax(1) == expected).sum().item())
            total += len(indices)
        return evaluator._result(100 * correct / total if total else 0, {
            'test_accuracy': evaluator._round(100 * correct / total if total else 0),
            'evaluated_samples': len(selection), 'full_test_samples': count,
            'sampling_seed': seed, 'subset_hash': hashlib.sha256(np.asarray(selection, dtype=np.int64).tobytes()).hexdigest()[:16],
            'n_test': total, 'score_policy': ctx.problem['score_policy'],
            'note': '本地真实BERT结构严格加载学生参数；标签留在可信评分器；固定随机子集纯推理',
        })
    evaluator.HANDLERS['B17'] = bert
    return context

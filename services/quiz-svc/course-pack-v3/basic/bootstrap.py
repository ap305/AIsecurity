"""Untrusted worker adapter. Only this process imports student code/weights."""
from __future__ import annotations

import importlib.util
import json
import pathlib
import re
import secrets
import sys
import types


def load_student(code_path, work_dir):
    public = pathlib.Path(__file__).resolve().parent
    sys.path.insert(0, str(public))
    from basic_codec import pack, unpack
    import numpy as np
    import torch
    import checkpoints

    torch.set_num_threads(1)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    torch.manual_seed(42)
    np.random.seed(42)
    config = json.loads((public / 'course.json').read_text(encoding='utf8'))
    student = types.ModuleType('student_submission')
    student.__file__ = str(code_path)
    sys.modules[student.__name__] = student
    exec(compile(pathlib.Path(code_path).read_text(encoding='utf8'), str(code_path), 'exec'), student.__dict__)

    objects = {}
    checkpoint = None

    def weights():
        nonlocal checkpoint
        if checkpoint is None:
            checkpoint = checkpoints.load('/materials/weights.bin', required=True)
            if checkpoint.is_joblib:
                raise ValueError('basic courses do not accept executable joblib checkpoints')
        return checkpoint

    def encode_object(obj):
        for key, previous in objects.items():
            if previous is obj:
                return {'kind': 'object', 'value': key}
        if len(objects) >= 128:
            raise ValueError('course object limit')
        key = secrets.token_hex(16)
        objects[key] = obj
        return {'kind': 'object', 'value': key}

    def decode_object(key):
        if not re.fullmatch('[a-f0-9]{32}', key) or key not in objects:
            raise ValueError('invalid course object')
        return objects[key]

    def member(obj, name):
        if not isinstance(name, str) or not re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,79}', name):
            raise ValueError('invalid public member')
        return getattr(obj, name, None)

    def configure_bert():
        from transformers import BertConfig, BertModel
        cfg = BertConfig.from_json_file(str(public / 'bert' / 'config.json'))

        class LocalBert:
            @staticmethod
            def from_pretrained(*args, **kwargs):
                return BertModel(cfg)
        student.BertModel = LocalBert

    def dispatch(operation, data=None, capability=None):
        torch.set_num_threads(1)
        data = unpack(data, decode_object) if data is not None else {}
        if operation == 'symbol':
            result = member(student, data['name'])
        elif operation == 'member':
            result = member(data['object'], data['name'])
        elif operation == 'set':
            if data['name'] != 'q_table':
                raise ValueError('only the declared Q-table can be assigned')
            setattr(data['object'], data['name'], data['value'])
            result = None
        elif operation == 'call':
            with torch.no_grad():
                result = data['object'](*data.get('args', []), **data.get('kwargs', {}))
        elif operation == 'function':
            # B02 compute_gradient and B08 gradient_penalty need input autograd.
            result = member(student, data['name'])(*data.get('args', []), **data.get('kwargs', {}))
        elif operation == 'load_model':
            if config['id'] == 'B17':
                configure_bert()
            model = member(student, data['name'])(*data.get('args', []), **data.get('kwargs', {}))
            model.load_state_dict(weights().as_state_dict(data.get('state_model')), strict=True)
            model.to('cpu').eval()
            if config['id'] == 'B17' and not any(k.startswith('bert.') for k in model.state_dict()):
                raise ValueError('BERT checkpoint must include the real bert.* architecture')
            result = model
        elif operation == 'weight_info':
            ckpt = weights()
            raw = ckpt.raw if isinstance(ckpt.raw, dict) else {}
            allowed = ('char_to_idx', 'idx_to_char', 'vocab')
            result = {'metadata': {k: ckpt.metadata[k] for k in allowed if k in ckpt.metadata},
                      'raw': {k: raw[k] for k in allowed if k in raw},
                      'shapes': {k: list(v.shape) for k, v in ckpt.as_state_dict(data.get('state_model')).items()
                                 if torch.is_tensor(v)}}
        elif operation == 'tensor':
            result = weights().tensor(data['name'])
        elif operation == 'detection':
            class TeacherDetector:
                def __call__(self, tensors):
                    return unpack(capability.predict(pack(tensors)))
                def eval(self):
                    return self
                def to(self, *args, **kwargs):
                    return self
            result = member(student, 'run_inference')(TeacherDetector(), data['tensor'], torch.device('cpu'))
        elif operation == 'gradient_penalty':
            from gan_teacher import Discriminator
            model = Discriminator()
            model.load_state_dict(data['state'], strict=True)
            model.eval()
            torch.manual_seed(1)
            result = member(student, 'gradient_penalty')(model, data['real'], data['fake'])
        elif operation == 'augment_contract':
            from PIL import Image
            fn = member(student, 'make_augment_transform')
            if fn is None:
                result = {'present': False}
            else:
                try:
                    tfm = fn()
                    output = tfm(Image.fromarray(data['image'], mode='L'))
                    shape = list(output.shape)
                    result = {'present': True, 'callable': True, 'output_shape': shape, 'ok': shape == [1, 28, 28]}
                except Exception:
                    result = {'present': True, 'callable': False}
        elif operation == 'bert_batch':
            from transformers import BertTokenizer
            tokenizer = BertTokenizer.from_pretrained(str(public / 'bert'), local_files_only=True)
            # Actual scoring labels never cross this process boundary.
            ds = member(student, 'AGNewsDataset')(data['texts'], [0] * len(data['texts']), tokenizer)
            rows = [ds[index] for index in range(len(data['texts']))]
            result = {key: torch.stack([row[key] for row in rows]) for key in ('input_ids', 'attention_mask')}
            for tensor in result.values():
                if tensor.dtype != torch.int64 or tensor.ndim != 2 or tensor.shape != (len(rows), 128):
                    raise ValueError('AGNewsDataset must return int64 [128] ids/mask')
        else:
            raise ValueError('unsupported course operation')
        return pack(result, encode_object)

    wrapper = types.ModuleType('course_basic_worker')
    wrapper.course_basic_call = dispatch
    return wrapper

"""Worker-only media execution. Role is supplied by the trusted grader lazily.

Student state_dict and joblib payloads never enter the grader process. The
public helper source contains structure and inference utilities, no test data.
"""
from __future__ import annotations

import pathlib
import json
import re
import secrets
import sys
import types


def load_student(code_path, work_dir):
    public = pathlib.Path(__file__).resolve().parent
    sys.path.insert(0, str(public))
    from basic_codec import pack, unpack
    import checkpoints
    import numpy as np
    import torch
    torch.set_num_threads(1)
    torch.manual_seed(42)
    np.random.seed(42)
    course = json.loads((public / 'course.json').read_text(encoding='utf8'))
    student = None
    role = None
    checkpoint = None
    objects = {}
    models = {}
    members = {}

    def weights():
        nonlocal checkpoint
        if checkpoint is None:
            checkpoint = checkpoints.load('/materials/weights.bin', required=True)
        return checkpoint

    def encode_object(value):
        for key, previous in objects.items():
            if value is previous:
                return {'kind': 'object', 'value': key}
        if len(objects) >= 256:
            raise ValueError('media object budget exceeded')
        key = secrets.token_hex(16)
        objects[key] = value
        return {'kind': 'object', 'value': key}

    def decode_object(key):
        if not re.fullmatch('[a-f0-9]{32}', key) or key not in objects:
            raise ValueError('invalid media object')
        return objects[key]

    def member(value, name):
        if not isinstance(name, str) or not re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,79}', name) or name.startswith('__'):
            raise ValueError('invalid media member')
        key = (id(value), name)
        if key not in members:
            members[key] = getattr(value, name, None)
        return members[key]

    def initialize(value):
        nonlocal student, role
        if value not in ('attack', 'defense') or (role and role != value):
            raise ValueError('worker role cannot change')
        if student is None:
            role = value
            student = types.ModuleType(role)
            student.__file__ = str(code_path)
            sys.modules[role] = student
            helper = public / (role + '_helper.py')
            exec(compile(helper.read_text(encoding='utf8'), str(helper), 'exec'), student.__dict__)
            # Submission definitions override the public scaffold in its own
            # namespace, exactly as the archive's synthesis contract specifies.
            exec(compile(pathlib.Path(code_path).read_text(encoding='utf8'), str(code_path), 'exec'), student.__dict__)
            for name in course['symbols'][role]:
                if not callable(getattr(student, name, None)):
                    raise ValueError('submission is missing a declared callable entry')
        return True

    def restore(number):
        if number in models:
            return models[number]
        ckpt = weights()
        if number == '05':
            net = student._build_resnet18(pretrained=False)
            net.load_state_dict(ckpt.as_state_dict(), strict=True)
            net.to('cpu').eval()
            model = student.DefenseModel(device='cpu')
            model.net, model.input_size = net, 224
        elif number == '11':
            if not ckpt.is_joblib:
                raise ValueError('fitted classifier requires joblib-v1')
            obj = ckpt.load_joblib()
            model = student.Defense()
            if isinstance(obj, dict):
                model._clf, model._scaler = obj['clf'], obj['scaler']
            else:
                model._clf, model._scaler = obj._clf, obj._scaler
            model._fitted = True
        elif number == '12':
            if not ckpt.is_joblib:
                raise ValueError('fitted GMM requires joblib-v1')
            obj = ckpt.load_joblib()
            if not isinstance(obj, dict) or not {'gmm_bona', 'gmm_spoof'} <= set(obj):
                raise ValueError('missing fitted GMM pair')
            try:
                model = student.Defense(**(obj.get('params') or {}))
            except TypeError:
                model = student.Defense()
            model._gmm_bona, model._gmm_spoof = obj['gmm_bona'], obj['gmm_spoof']
            model._calib = obj.get('calib', {'mean': 0., 'scale': 1.})
            if hasattr(model, 'params'):
                model.params = {**model.params, **(obj.get('params') or {})}
            model.is_trained = True
            model.train_seconds = float((ckpt.metadata or {}).get('train_seconds', 0.) or 0.)
            for gmm in (model._gmm_bona, model._gmm_spoof):
                if not callable(getattr(gmm, 'score', None)):
                    raise ValueError('not a fitted GMM')
        else:
            raise ValueError('unknown media model')
        models[number] = model
        return model

    def dispatch(operation, encoded=None):
        data = unpack(encoded, decode_object) if encoded is not None else {}
        if operation == 'initialize':
            result = initialize(data['role'])
        elif student is None:
            raise ValueError('media worker must be initialized by grader')
        elif operation == 'symbol':
            result = member(student, data['name'])
        elif operation == 'member':
            result = member(data['object'], data['name'])
        elif operation == 'function':
            result = member(student, data['name'])(*data.get('args', []), **data.get('kwargs', {}))
        elif operation == 'call':
            with torch.no_grad():
                result = data['object'](*data.get('args', []), **data.get('kwargs', {}))
        elif operation == 'restore':
            result = restore(data['number'])
            if data.get('probe') is not None:
                feat = np.asarray(result._extract(data['probe'])).reshape(1, -1)
                result._scaler.transform(feat)
                result.predict(data['probe'])
        elif operation == 'patch':
            ckpt = weights()
            result = ckpt.tensor('patch') if 'patch' in (ckpt.tensors or {}) else ckpt.tensor()
        elif operation == 'audio_stats':
            model = restore('12')
            result = {'n_params': sum(int(g.means_.size + g.covariances_.size + g.weights_.size)
                                      for g in (model._gmm_bona, model._gmm_spoof)),
                      'params': model.params}
        else:
            raise ValueError('unknown media operation')
        return pack(result, encode_object)

    module = types.ModuleType('media_worker')
    module.course_media_call = dispatch
    return module

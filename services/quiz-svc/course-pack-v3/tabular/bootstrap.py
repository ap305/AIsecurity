"""Student-only worker: role is bound by the grader on first RPC, including opponents."""
from __future__ import annotations

import ast
import copy
import importlib.util
import json
import pathlib
import sys
import types


def load_student(code_path, _work_dir):
    public = pathlib.Path(__file__).resolve().parent
    sys.path.insert(0, str(public))
    from tabular_codec import pack, unpack
    import numpy as np
    import torch
    import checkpoints
    torch.set_num_threads(1)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    config = json.loads((public / 'course.json').read_text(encoding='utf8'))
    source = pathlib.Path(code_path).read_text(encoding='utf-8-sig')
    student_tree = ast.parse(source)
    for node in ast.walk(student_tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            imports = [n.name for n in node.names] if isinstance(node, ast.Import) else [node.module or '']
            if any(name.split('.')[0] in ('attack', 'defense', 'test', 'assemble') for name in imports):
                raise ValueError('reference module imports are not a submission interface')
    bound_role, module, frozen_model, detector = None, None, None, None
    qi_context = None

    def initialize(role):
        nonlocal bound_role, module
        if bound_role:
            if bound_role != role:
                raise ValueError('worker role cannot change')
            return
        if role not in ('attack', 'defense'):
            raise ValueError('invalid fixed role')
        tree = ast.parse((public / (role + '_backend.py')).read_text(encoding='utf8'))
        indices = [i for i, node in enumerate(tree.body) if isinstance(node, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == '__COURSE_SLOT__' for t in node.targets)]
        if len(indices) != 1:
            raise ValueError('invalid course slot')
        submitted = ast.parse(source).body
        tree.body[indices[0]:indices[0] + 1] = [n for n in submitted if not (isinstance(n, ast.ImportFrom) and n.module == '__future__')]
        module = types.ModuleType('tabular_student_' + role)
        module.__file__ = str(code_path)
        sys.modules[module.__name__] = module
        exec(compile(ast.fix_missing_locations(tree), str(code_path), 'exec'), module.__dict__)
        for name in config['entries'][role]:
            if not callable(getattr(module, name, None)):
                raise ValueError('required entry missing')
        for name in ('train_model', '_train_shadow', 'train_shadow', 'federated_train', 'retrain_gold'):
            if hasattr(module, name):
                setattr(module, name, forbidden_training)
        bound_role = role

    def forbidden_training(*args, **kwargs):
        raise ValueError('model training is offline only')

    def architecture():
        spec = importlib.util.spec_from_file_location('tabular_architecture', public / 'architecture.py')
        model_module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = model_module
        spec.loader.exec_module(model_module)
        return model_module

    def construct(state):
        arch = architecture()
        model = arch.model_from_state_dict(state)
        model.load_state_dict(state, strict=True)
        return model.cpu().eval()

    def model():
        nonlocal frozen_model
        if frozen_model is None:
            ckpt = checkpoints.load('/materials/weights.bin', required=True)
            if ckpt.is_joblib:
                raise ValueError('privacy models require a numerical state_dict')
            frozen_model = construct(ckpt.as_state_dict())
        return frozen_model

    def load_detector():
        nonlocal detector
        if detector is not None:
            return detector
        ckpt = checkpoints.load('/materials/weights.bin', required=True)
        if not ckpt.is_joblib:
            raise ValueError('D30 requires an offline fitted detector')
        payload = ckpt.load_joblib()  # Executable deserialization is confined to this untrusted worker.
        if not isinstance(payload, dict) or 'clf' not in payload or payload.get('model', 'rf') not in ('rf', 'logreg'):
            raise ValueError('invalid detector checkpoint')
        detector = module.FeatureBasedProfileDetector(model=payload.get('model', 'rf'), n_fill=int(payload.get('n_fill', 50)), seed=int(payload.get('seed', 42)))
        clf = payload['clf']
        if payload.get('model') == 'logreg':
            from sklearn.pipeline import Pipeline
            clf = Pipeline([('scaler', payload['scaler']), ('clf', clf)])
        if not callable(getattr(clf, 'predict_proba', None)) or 1 not in set(np.asarray(clf.classes_).tolist()):
            raise ValueError('detector must be fitted for class one')
        detector.clf = clf
        detector.feature_names = list(payload.get('feature_names') or detector.feature_names)
        if payload.get('importances') is not None:
            detector.importances = np.asarray(payload['importances'], dtype=np.float64)
        detector._fitted = True
        return detector

    def dispatch(role, operation, encoded, capability=None):
        nonlocal qi_context
        initialize(role)
        data = unpack(encoded)
        if operation == 'call':
            if data['name'] not in config['entries'][role]:
                raise ValueError('function is outside declared interface')
            try:
                result = getattr(module, data['name'])(*data.get('args', []), **data.get('kwargs', {}))
            except ValueError:
                # Budget/unknown-mode probes require the declared ValueError,
                # without sending exception text or remote exception objects.
                result = {'__course_exception__': 'ValueError'}
        elif operation == 'predict' and role == 'defense' and config['number'] in ('23', '24', '25'):
            with torch.inference_mode():
                result = model()(data['images'])
        elif operation == 'mia' and role == 'attack' and config['number'] == '23':
            result = module.attack(lambda images: unpack(capability.query(pack(images))), data['images'], data['labels'], **data['kwargs'])
        elif operation == 'forget' and role == 'attack' and config['number'] == '25':
            class QueryModel(torch.nn.Module):
                def forward(self, images):
                    return unpack(capability.query(pack(images)))
            result = module.attack(QueryModel(), *data['args'], **data['kwargs'])
        elif operation == 'dlg' and role == 'attack' and config['number'] == '24':
            target = construct(data['state'])
            before = {key: value.clone() for key, value in target.state_dict().items()}
            kwargs = data['kwargs']
            if 'reference_images' in kwargs or 'reference_labels' in kwargs:
                raise ValueError('hidden reconstruction labels may not enter a worker')
            result = module.dlg_attack(target, data['gradients'], **kwargs)
            if any(not torch.equal(value, target.state_dict()[key]) for key, value in before.items()):
                raise ValueError('frozen victim parameters changed')
        elif operation == 'protect' and role == 'defense' and config['number'] == '24':
            result = module._protect_core(data['gradients'], data['clip_norm'], data['noise'], data['topk'], torch.Generator().manual_seed(data['seed']))
        elif operation == 'detector' and role == 'defense' and config['number'] == '30':
            if data['method'] not in ('score', 'defend'):
                raise ValueError('detector training is forbidden')
            result = getattr(load_detector(), data['method'])(*data['args'])
        elif operation == 'mf_parameters' and config['number'] == '31':
            ckpt = checkpoints.load('/materials/weights.bin', required=True)
            state = ckpt.tensors or ckpt.state_dict
            if not isinstance(state, dict) or not {'mu', 'bu', 'bi', 'P', 'Q'}.issubset(state):
                raise ValueError('invalid offline MF checkpoint')
            result = {key: state[key] for key in ('mu', 'bu', 'bi', 'P', 'Q')}
        elif operation == 'rating_push' and role == 'attack' and config['number'] == '31':
            # Planning keeps the published frozen proxy. The trusted grader,
            # not this worker, trains/evaluates the validated resulting matrix.
            module.fit_mf = lambda *_args, **_kwargs: data['model']
            result = module.rating_push_attack(data['train'], target_item=data['target'], budget=data['budget'],
                                               n_rounds=3, seed=42, verbose=False)
        elif operation == 'qi_context' and role == 'attack' and config['number'] == '26':
            qi_context = data
            result = True
        elif operation == 'qi_distance' and role == 'attack' and config['number'] == '26':
            if qi_context is None:
                raise ValueError('published table is unavailable')
            table, columns, context, weights = copy.deepcopy(qi_context)
            result = module.qi_distance(data['row'], table, columns, context, weights)
        elif operation == 'qi_batch' and role == 'attack' and config['number'] == '26':
            if qi_context is None or not 1 <= len(data['rows']) <= 100:
                raise ValueError('invalid public target batch')
            result = []
            for _, row in data['rows'].iterrows():
                table, columns, context, weights = copy.deepcopy(qi_context)
                result.append(module.qi_distance(row, table, columns, context, weights))
        else:
            raise ValueError('unsupported tabular operation')
        return pack(result)

    wrapper = types.ModuleType('tabular_worker')
    wrapper.course_tabular_call = dispatch
    return wrapper

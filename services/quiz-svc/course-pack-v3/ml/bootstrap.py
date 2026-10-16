"""Course 01/04/06/07 student adapter; only the isolated worker runs this file."""
from __future__ import annotations

import ast
import importlib.util
import json
import pathlib
import sys
import types


def load_student(code_path, work_dir):
    public = pathlib.Path(__file__).resolve().parent
    sys.path.insert(0, str(public))
    import numpy as np
    import torch
    import checkpoints
    from course_codec import pack, unpack
    torch.set_num_threads(1)
    config = json.loads((public / 'course.json').read_text(encoding='utf-8'))
    source = pathlib.Path(code_path).read_text(encoding='utf-8-sig')
    cache, models = {}, {}
    checkpoint = None

    def weights():
        nonlocal checkpoint
        if checkpoint is None:
            checkpoint = checkpoints.load('/materials/weights.bin', required=True)
        return checkpoint

    def student(role):
        if role in cache:
            return cache[role]
        if role not in ('attack', 'defense'):
            raise ValueError('Invalid role')
        spec = importlib.util.spec_from_file_location('dataset', public / 'dataset.py')
        dataset = importlib.util.module_from_spec(spec)
        sys.modules['dataset'] = dataset
        spec.loader.exec_module(dataset)
        tree = ast.parse(source)
        required = config['symbols'][role]
        for name in required:
            node = next((n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name == name), None)
            if node is None or any(isinstance(n, ast.Raise) and n.exc is not None and
                  'NotImplementedError' in ast.unparse(n.exc) and 'TODO' in ast.unparse(n.exc) for n in ast.walk(node)):
                raise ValueError('Complete the published entry before submitting')
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or '']
                if any(name.split('.')[0] in ('attack', 'defense', 'test', 'assemble') for name in names):
                    raise ValueError('Reference modules are not student imports')
        backend = ast.parse((public / (role + '_backend.py')).read_text(encoding='utf-8'))
        slots = [i for i, node in enumerate(backend.body) if isinstance(node, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == '__COURSE_SLOT__' for t in node.targets)]
        if len(slots) != 1:
            raise ValueError('Invalid public role framework')
        futures = [n for n in tree.body if isinstance(n, ast.ImportFrom) and n.module == '__future__']
        backend.body[slots[0]:slots[0] + 1] = [n for n in tree.body if n not in futures]
        prior = [n for n in backend.body if isinstance(n, ast.ImportFrom) and n.module == '__future__']
        backend.body = futures + prior + [n for n in backend.body if n not in prior]
        result = types.ModuleType('student_' + role)
        result.__file__ = str(code_path)
        sys.modules[result.__name__] = result
        exec(compile(ast.fix_missing_locations(backend), str(code_path), 'exec'), result.__dict__)
        if config['number'] == '01' and role == 'defense':
            result._V3_WARMUP_STATE = weights().as_state_dict('warmup')
        cache[role] = result
        return result

    def uploaded(role):
        if role in models:
            return models[role]
        mod = student(role)
        number = config['number']
        if number == '01':
            import architecture
            value = architecture.build_model()
            state = weights().as_state_dict('defended' if role == 'defense' else None)
            value.load_state_dict(state, strict=True)
            value.eval()
        elif number == '04' and role == 'attack':
            value = mod.StudentCNN()
            value.load_state_dict(weights().as_state_dict(), strict=True)
            value.eval()
            if sum(p.numel() for p in value.parameters()) > 1_000_000:
                raise ValueError('StudentCNN exceeds the one-million parameter budget')
        elif number in ('06', '07'):
            value = weights().load_joblib()
            if not callable(getattr(value, 'predict', None)) or not callable(getattr(value, 'predict_proba', None)):
                raise ValueError('Upload must contain the trained course estimator')
        elif number == '04' and role == 'defense':
            value = mod.NoiseDefense()
        else:
            raise ValueError('Unsupported model course')
        models[role] = value
        return value

    def call(role, operation, payload):
        data = unpack(payload)
        mod = student(role)
        if operation == 'function':
            name = data['name']
            if name not in config['symbols'][role]:
                raise ValueError('Unknown published student function')
            result = getattr(mod, name)(*data.get('args', []), **data.get('kwargs', {}))
        elif operation == 'predict':
            value = uploaded(role)
            images = data['images']
            if config['number'] == '01':
                import architecture
                result = architecture.predict(value, images, device=torch.device('cpu'))
            elif config['number'] == '04':
                with torch.no_grad():
                    result = mod.student_predict(value, images)
            else:
                flat = np.asarray(images, dtype=np.float32).reshape(len(images), -1)
                result = (value.predict_proba(flat), value.predict(flat))
        elif operation == 'noise_defend' and config['number'] == '04' and role == 'defense':
            result = uploaded(role).defend(data['probabilities'], data['labels'])
        else:
            raise ValueError('Unknown course operation')
        return pack(result)

    result = types.ModuleType('course_entry')
    result.course_ml_call = call
    return result

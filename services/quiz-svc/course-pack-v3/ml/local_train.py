"""Student-side practice/training/export. No formal hidden test assets required."""
from __future__ import annotations
import argparse
import ast
import io
import json
from pathlib import Path
import sys
import types
import numpy as np
import torch

ROOT = Path(__file__).resolve().parent


def synthesize(role, path):
    framework = (ROOT / (role + '-backend.py')).read_text(encoding='utf8')
    marker = '# [IMPORTANT] Replace this line with real attack/defense code.'
    tree = ast.parse(path.read_text(encoding='utf-8-sig'))
    text = ast.unparse(ast.Module(body=[n for n in tree.body if not
                       (isinstance(n, ast.ImportFrom) and n.module == '__future__')], type_ignores=[]))
    module = types.ModuleType('practice_' + role)
    module.__file__ = str(path)
    exec(compile(framework.replace(marker, text), str(path), 'exec'), module.__dict__)
    return module


def mlp(images, labels):
    from sklearn.neural_network import MLPClassifier
    model = MLPClassifier(hidden_layer_sizes=(256, 128), activation='relu', solver='adam', alpha=1e-4,
              batch_size=128, learning_rate_init=.001, max_iter=40, early_stopping=True,
              validation_fraction=.1, n_iter_no_change=5, random_state=42)
    model.fit(images.reshape(len(images), -1), labels)
    return model


def demo_poison(number, images, labels):
    """Documented fixed local practice attack, never formal hidden data."""
    images, labels = images.copy(), labels.copy()
    rng = np.random.default_rng(42)
    candidates = np.flatnonzero(labels != 0) if number == '07' else np.arange(len(labels))
    indices = rng.choice(candidates, size=min(len(candidates), int(len(labels) * (.2 if number == '01' else .05))), replace=False)
    if number == '07':
        images[indices, :, 25:27, 25:27] = 1
        labels[indices] = 0
    else:
        labels[indices] = (labels[indices] + rng.integers(1, 10, len(indices))) % 10
    return images, labels


def train(code_path, target):
    import dataset
    config = json.loads((ROOT / 'course.json').read_text(encoding='utf8'))
    number, role = config['number'], config['role']
    student = synthesize(role, code_path)
    torch.set_num_threads(4)
    torch.manual_seed(42)
    if number == '04':
        if role == 'defense':
            print('D04 submits only the completed NoiseDefense code; no model upload is required.')
            return
        bench = dataset.load_benchmark()
        teacher = dataset.train_victim_model(**bench['victim_train'], seed=42)
        api = student.VictimAPI(teacher, budget=500, defense=None)
        result = student.attack(api, {'query_images': bench['query_pool']['images'], 'query_budget': 500,
                       'num_classes': 10, 'image_shape': (1, 28, 28)}, seed=42)
        payload = {'format': 'state-dict-v1', 'state_dict': result['student'].cpu().state_dict()}
    else:
        data, _ = dataset.load_benchmark()
        images, labels = data['images'], data['labels']
        if role == 'attack':
            kwargs = {'poison_rate': .2 if number == '01' else .05, 'seed': 42}
            if number == '07':
                kwargs['target_label'] = 0
            result = student.attack(images, labels, **kwargs)
            images, labels = result['images'], result['labels']
        else:
            images, labels = demo_poison(number, images, labels)
        if number == '01':
            import architecture
            if role == 'defense':
                warmup = architecture.train_model(architecture.build_model(), images, labels,
                           epochs=2, batch_size=128, lr=.001, seed=42, device=torch.device('cpu'))
                student._V3_WARMUP_STATE = warmup.cpu().state_dict()
                result = student.defend(images, labels, device=torch.device('cpu'))
                images, labels = result['images'], result['labels']
            torch.manual_seed(42)
            model = architecture.train_model(architecture.build_model(), images, labels,
                        epochs=2, batch_size=128, lr=.001, seed=42, device=torch.device('cpu'))
            payload = ({'format': 'models-v1', 'models': {'warmup': warmup.cpu().state_dict(), 'defended': model.cpu().state_dict()}}
                       if role == 'defense' else {'format': 'state-dict-v1', 'state_dict': model.cpu().state_dict()})
        else:
            if role == 'defense':
                result = student.defend(images, labels)
                images, labels = result['images'], result['labels']
            import joblib
            stream = io.BytesIO()
            joblib.dump(mlp(images, labels), stream)
            payload = {'format': 'joblib-v1', 'payload': torch.from_numpy(np.frombuffer(stream.getvalue(), dtype=np.uint8).copy())}
    target.parent.mkdir(parents=True, exist_ok=True)
    torch.save(payload, target)
    print(json.dumps({'exported': str(target), 'formalScore': False, 'data': 'public training data only'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--code', type=Path, default=ROOT / 'blank.py')
    parser.add_argument('--out', type=Path, default=ROOT / 'model.pt')
    args = parser.parse_args()
    import os
    os.chdir(ROOT)
    train(args.code.resolve(), args.out.resolve())

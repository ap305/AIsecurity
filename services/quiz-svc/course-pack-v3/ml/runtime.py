"""Trusted ML pair scoring. Only numerical values cross student RPC boundaries."""
from __future__ import annotations

import importlib.util
import json
import math
import pathlib
import sys
import numpy as np


class ContractError(ValueError):
    pass


def distribution(output, count):
    if isinstance(output, dict):
        probabilities, labels = output.get('probabilities'), output.get('labels')
    elif isinstance(output, (tuple, list)) and len(output) == 2:
        probabilities, labels = output
    else:
        raise ContractError('Expected probabilities and labels')
    probabilities, labels = np.asarray(probabilities), np.asarray(labels)
    if (probabilities.shape != (count, 10) or labels.shape != (count,) or
            probabilities.dtype.kind not in 'fiu' or labels.dtype.kind not in 'iu' or
            not np.isfinite(probabilities).all() or np.any(probabilities < 0) or
            not np.allclose(probabilities.sum(1), 1, atol=1e-5) or
            not np.array_equal(probabilities.argmax(1), labels)):
        raise ContractError('Invalid class distribution')
    return probabilities.astype(np.float64), labels.astype(np.int64)


def agreement(left, right):
    mid = (left + right) / 2
    divergence = sum(np.sum(np.where(p > 0, p * np.log(np.maximum(p, 1e-15) /
                       np.maximum(mid, 1e-15)), 0), axis=1) for p in (left, right)) / 2
    return float(np.clip(1 - np.mean(divergence) / math.log(2), 0, 1))


def evaluate04(role, attack, defense, victim, images):
    raw = np.asarray(victim.predict_proba(images.reshape(len(images), -1)), dtype=np.float64)
    raw /= raw.sum(1, keepdims=True)
    raw_labels = raw.argmax(1)
    protected, protected_labels = distribution(defense.noise_defend(raw.copy(), raw_labels.copy()), len(images))
    student, student_labels = distribution(attack.predict(images), len(images))
    ler = float(np.mean(protected_labels != raw_labels))
    la0, lad = float(np.mean(student_labels == raw_labels)), float(np.mean(student_labels == protected_labels))
    pa0, pad = agreement(raw, student), agreement(protected, student)
    attack_metric = float(0.8 * lad + 0.2 * pad)
    # Compare this exact uploaded attacker against the exact supplied defense.
    # It is inference response fidelity, not a claim that distillation was rerun.
    suppression = 0.8 * max(0., (la0 - lad) / (la0 - .1)) if la0 > .1 else 0.
    suppression += .2 * max(0., (pa0 - pad) / pa0) if pa0 > 0 else 0.
    quality = .7 * (1 - ler) + .3 * (1 - float(np.mean(np.abs(raw - protected).sum(1) / 2)))
    defense_metric = float(np.clip(.75 * suppression + .25 * quality, 0, 1))
    valid = ler <= .10
    own = attack_metric if role == 'attack' else defense_metric
    return {'qualificationMetric': 100 * own if valid else -1., 'successMetric': own if valid else -1.,
            'legalBehaviorPassed': valid, 'labelErrorRate': ler, 'attackFidelity': attack_metric,
            'defenseSuppression': suppression, 'serviceQuality': quality, 'samples': len(images),
            'trainingPerformed': False, 'pairPolicy': 'uploaded-attacker-versus-protected-response'}


def trigger(images, mask, pattern):
    return images * (1 - mask[None]) + pattern[None] * mask[None]


def validate_trigger(output, images, labels):
    if not isinstance(output, dict):
        raise ContractError('Attack must return a dictionary')
    mask, pattern = np.asarray(output.get('trigger_mask')), np.asarray(output.get('trigger_pattern'))
    if (mask.shape != (1, 28, 28) or pattern.shape != mask.shape or
            not np.isfinite(mask).all() or not np.isfinite(pattern).all() or
            not np.isin(mask, [0, 1]).all() or not 0 < np.count_nonzero(mask) <= 25 or
            np.any(pattern < 0) or np.any(pattern > 1) or output.get('target_label') != 0):
        raise ContractError('Invalid local trigger')
    indices = np.asarray(output.get('poison_indices'))
    if (indices.ndim != 1 or indices.dtype.kind not in 'iu' or len(indices) > int(.05 * len(images)) or
            len(np.unique(indices)) != len(indices) or np.any(indices < 0) or np.any(indices >= len(images)) or
            type(output.get('n_modified')) is not int or output['n_modified'] != len(indices)):
        raise ContractError('Invalid poison budget or indices')
    expected_images, expected_labels = images.copy(), labels.copy()
    expected_images[indices], expected_labels[indices] = trigger(images[indices], mask, pattern), 0
    if (not np.array_equal(output.get('labels'), expected_labels) or
            not np.allclose(output.get('images'), expected_images, atol=1e-7, rtol=0)):
        raise ContractError('Attack changed samples outside its declared trigger budget')
    return mask.astype(np.float32), pattern.astype(np.float32)


def preprocessed(defense, images):
    # The student's preprocessing receives dummy labels, never hidden test truth.
    dummy = np.full(len(images), -1, dtype=np.int64)
    output = defense.function('defend', images, dummy)
    if not isinstance(output, dict):
        raise ContractError('Defense must return a dictionary')
    result = np.asarray(output.get('images'))
    if (result.shape != images.shape or not np.isfinite(result).all() or np.any(result < 0) or
            np.any(result > 1) or not np.array_equal(output.get('labels'), dummy)):
        raise ContractError('Defense must preserve hidden sample order/count and dummy labels')
    return result.astype(np.float32)


def evaluate07(role, attack, defense, clean, train, hidden):
    mask, pattern = validate_trigger(attack.function('attack', train['images'], train['labels'],
                                   target_label=0, poison_rate=.05, seed=42), train['images'], train['labels'])
    images, labels = hidden['images'], hidden['labels']
    target_mask = labels != 0
    if not target_mask.any():
        raise RuntimeError('No eligible hidden samples')
    # Never reveal which hidden images have the target label by sending a
    # filtered subset to student code. Filter only the returned predictions.
    trigger_images = trigger(images, mask, pattern)
    clean_labels = clean.predict(images.reshape(len(images), -1))
    base_accuracy = float(np.mean(clean_labels == labels))
    _, raw_attacker = distribution(attack.predict(images), len(images))
    attacker_accuracy = float(np.mean(raw_attacker == labels))
    _, attacker_trigger = distribution(attack.predict(trigger_images), len(trigger_images))
    raw_asr = float(np.mean(attacker_trigger[target_mask] == 0))
    defended_clean = preprocessed(defense, images)
    defended_trigger = preprocessed(defense, trigger_images)
    _, defense_labels = distribution(defense.predict(defended_clean), len(images))
    _, defense_trigger = distribution(defense.predict(defended_trigger), len(trigger_images))
    accuracy = float(np.mean(defense_labels == labels))
    asr = float(np.mean(defense_trigger[target_mask] == 0))
    retention = min(1., accuracy / max(base_accuracy, 1e-12))
    own = asr if role == 'attack' else (1 - asr) * retention
    # Both sides must preserve ordinary task behavior; suppression alone is not sufficient.
    legal = base_accuracy - attacker_accuracy <= .03 if role == 'attack' else True
    return {'qualificationMetric': 100 * own if legal else -1., 'successMetric': own if legal else -1.,
            'legalBehaviorPassed': legal, 'attackSuccessRate': asr, 'unprotectedAttackSuccessRate': raw_asr,
            'cleanAccuracy': base_accuracy, 'attackCleanAccuracy': attacker_accuracy,
            'defenseCleanAccuracy': accuracy, 'cleanRetention': retention, 'samples': int(target_mask.sum()),
            'trainingPerformed': False}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class Reference:
    """Reviewed teacher reference only; no student source or checkpoint is loaded here."""
    def __init__(self, root, number, role):
        import checkpoints
        import torch
        self.number, self.role = number, role
        self.module = load_module('trusted_' + role, root / 'teacher' / (role + '.py'))
        if number in ('01', '06'):
            self.model = None
            if number == '01' and role == 'defense':
                weights = checkpoints.load(str(root / 'fixtures' / 'defense.pt'), required=True)
                self.module._V3_WARMUP_STATE = weights.as_state_dict('warmup')
        elif number == '04' and role == 'defense':
            self.model = self.module.NoiseDefense()
        else:
            weights = checkpoints.load(str(root / 'fixtures' / (role + '.pt')), required=True)
            if number == '04':
                self.model = self.module.StudentCNN()
                self.model.load_state_dict(weights.as_state_dict(), strict=True)
                self.model.eval()
            else:
                self.model = weights.load_joblib()

    def function(self, name, *args, **kwargs):
        return getattr(self.module, name)(*args, **kwargs)

    def predict(self, images):
        import torch
        if self.number == '04':
            with torch.no_grad():
                return self.module.student_predict(self.model, images)
        flat = images.reshape(len(images), -1)
        return self.model.predict_proba(flat), self.model.predict(flat)

    def noise_defend(self, probabilities, labels):
        return self.model.defend(probabilities, labels)


def poisoned_dataset(attack, number, train):
    images, labels = train['images'], train['labels']
    rate = .2 if number == '01' else .05
    output = attack.function('attack', images, labels, poison_rate=rate, seed=42)
    if not isinstance(output, dict):
        raise ContractError('Attack must return images and labels')
    altered = np.asarray(output.get('labels'))
    if (altered.shape != labels.shape or altered.dtype.kind not in 'iu' or np.any(altered < 0) or
            np.any(altered > 9) or not np.array_equal(output.get('images'), images) or
            int(np.count_nonzero(altered != labels)) > int(rate * len(labels))):
        raise ContractError('Label-only poison exceeds its fixed budget')
    return {'images': images.copy(), 'labels': altered.copy()}


def cleaned_dataset(defense, number, poisoned):
    images, labels = poisoned['images'], poisoned['labels']
    kwargs = ({'seed': 42, 'warmup_epochs': 2, 'filter_ratio': .12, 'batch_size': 128, 'lr': .001}
              if number == '01' else {'seed': 42, 'max_shift': 2, 'copies': 1})
    output = defense.function('defend', images, labels, **kwargs)
    if not isinstance(output, dict):
        raise ContractError('Defense must return images and labels')
    result, ys = np.asarray(output.get('images')), np.asarray(output.get('labels'))
    if (result.ndim != images.ndim or result.shape[1:] != images.shape[1:] or ys.shape != (len(result),) or
            ys.dtype.kind not in 'iu' or np.any(ys < 0) or np.any(ys > 9) or
            not np.isfinite(result).all() or np.any(result < 0) or np.any(result > 1)):
        raise ContractError('Invalid sanitized training data')
    if number == '01':
        kept = np.asarray(output.get('kept_indices'))
        if (kept.shape != (len(result),) or kept.dtype.kind not in 'iu' or
                not len(images) - int(.12 * len(images)) <= len(kept) <= len(images) or
                len(np.unique(kept)) != len(kept) or np.any(kept < 0) or np.any(kept >= len(images)) or
                not np.array_equal(result, images[kept]) or not np.array_equal(ys, labels[kept])):
            raise ContractError('Label-flip defense may remove at most the frozen 12% filter budget')
    elif len(result) != 2 * len(images) or not np.array_equal(ys, np.tile(labels, 2)):
        raise ContractError('Augmentation defense must return exactly two copies preserving labels')
    return {'images': result.astype(np.float32), 'labels': ys.astype(np.int64)}


def evaluate_poison(number, role, attack, defense, train, hidden, architecture):
    """Fixed, trusted training only; no remote model executable is deserialized."""
    import torch
    from sklearn.neural_network import MLPClassifier
    poisoned = poisoned_dataset(attack, number, train)
    cleaned = cleaned_dataset(defense, number, poisoned)
    def accuracy(data):
        torch.manual_seed(42)
        np.random.seed(42)
        if number == '01':
            model = architecture.train_model(architecture.build_model(), data['images'], data['labels'],
                        epochs=2, batch_size=128, lr=.001, seed=42, device=torch.device('cpu'), verbose=False)
            predicted = architecture.predict(model, hidden['images'], device=torch.device('cpu'))
        else:
            model = MLPClassifier(hidden_layer_sizes=(256, 128), activation='relu', solver='adam', alpha=1e-4,
                      batch_size=128, learning_rate_init=.001, max_iter=40, early_stopping=True,
                      validation_fraction=.1, n_iter_no_change=5, random_state=42)
            model.fit(data['images'].reshape(len(data['images']), -1), data['labels'])
            predicted = model.predict(hidden['images'].reshape(len(hidden['images']), -1))
        return float(np.mean(predicted == hidden['labels']))
    clean_acc, attack_acc, defense_acc = [accuracy(data) for data in (train, poisoned, cleaned)]
    retention = min(1., defense_acc / max(clean_acc, 1e-12))
    recovery = float(np.clip((defense_acc - attack_acc) / (clean_acc - attack_acc), 0, 1)) if clean_acc > attack_acc else 0.
    own = max(0., (clean_acc - defense_acc) / max(clean_acc, 1e-12)) if role == 'attack' else recovery * retention
    return {'qualificationMetric': own * 100, 'successMetric': own, 'legalBehaviorPassed': True,
            'cleanAccuracy': clean_acc, 'poisonAccuracy': attack_acc, 'defenseAccuracy': defense_acc,
            'recoveryRate': recovery, 'cleanRetention': retention, 'samples': len(hidden['labels']),
            'trainingPerformed': True, 'trainingSeed': 42, 'trainingRuns': 3,
            'trainingEpochBudget': 2 if number == '01' else 40}


def frozen_parameters(context):
    evaluation = context.get('parameters', {})
    if not isinstance(evaluation, dict):
        raise RuntimeError('Evaluation parameters must be an object')
    nested = evaluation.get('parameters', {})
    if not isinstance(nested, dict):
        raise RuntimeError('Nested frozen parameters must be an object')
    return {**nested, **{key: value for key, value in evaluation.items() if key != 'parameters'}}


def run(context, root):
    root = pathlib.Path(root)
    sys.path.insert(0, str(root / 'teacher'))
    import checkpoints
    from ml_bridge import Bridge
    config = json.loads((root / 'frozen.json').read_text(encoding='utf8'))
    number, role, phase = config['number'], context['role'], context['phase']
    if number not in ('01', '04', '06', '07') or role not in ('attack', 'defense') or phase not in ('baseline', 'opponent'):
        raise RuntimeError('Unsupported frozen course or phase')
    parameters = frozen_parameters(context)
    if parameters.get('sourceDigest') != config['sourceDigest']:
        raise RuntimeError('Frozen course digest does not match')
    student = Bridge(context['student'], role)
    other_role = 'defense' if role == 'attack' else 'attack'
    other = Bridge(context['opponent'], other_role) if phase == 'opponent' else Reference(root, number, other_role)
    attack, defense = (student, other) if role == 'attack' else (other, student)
    if number == '04':
        with np.load(root / 'data' / 'hidden.npz', allow_pickle=False) as data:
            images = data['images']
        victim = checkpoints.load(str(root / 'teacher' / 'victim.pt'), required=True).load_joblib()
        return evaluate04(role, attack, defense, victim, images)
    datasets = []
    for name in ('train', 'test'):
        with np.load(root / 'data' / (name + '.npz'), allow_pickle=False) as data:
            datasets.append({key: data[key] for key in ('images', 'labels')})
    if number == '01':
        for data in datasets:
            if data['images'].dtype != np.uint8:
                raise RuntimeError('Frozen CIFAR cache must contain uint8 images')
            data['images'] = data['images'].astype(np.float32) / 255.
    if number in ('01', '06'):
        architecture = load_module('trusted_architecture', root / 'teacher' / 'architecture.py') if number == '01' else None
        return evaluate_poison(number, role, attack, defense, *datasets, architecture)
    clean = checkpoints.load(str(root / 'teacher' / 'clean.pt'), required=True).load_joblib()
    return evaluate07(role, attack, defense, clean, *datasets)

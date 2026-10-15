"""Validate the frozen poisoning submission using only the original public train file."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_TRAIN_SHA256 = '52f58266c4ba1098e8a4ae564af2e21e1b3595dc3c701d2252123b1529e97ab9'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-train', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, default=ROOT / 'acceptance' / 'mnist_poison_attack.py')
    parser.add_argument('--seeds', type=int, nargs='*', default=[])
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError('do not overwrite public acceptance evidence')
    if hashlib.sha256(args.public_train.read_bytes()).hexdigest() != PUBLIC_TRAIN_SHA256:
        raise ValueError('only the original public train.npz is accepted')
    with np.load(args.public_train, allow_pickle=False) as data:
        images, labels = data['images'], data['labels']
    original_images, original_labels = images.copy(), labels.copy()
    spec = importlib.util.spec_from_file_location('frozen_poison_acceptance', args.candidate)
    candidate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(candidate)
    sys.path.insert(0, str(ROOT / 'runtime'))
    from contracts import check_poison
    result = check_poison(images, labels, candidate.attack(images, labels), backdoor=False)
    repeated = candidate.attack(images, labels)
    assert np.array_equal(images, original_images) and np.array_equal(labels, original_labels)
    assert np.array_equal(result['images'], repeated['images']) and np.array_equal(result['labels'], repeated['labels'])
    image_changed = np.any(result['images'] != images, axis=(1, 2, 3))
    label_changed = result['labels'] != labels
    changed = image_changed | label_changed
    assert int(changed.sum()) == 400 and np.array_equal(image_changed, label_changed)
    assert np.all(labels[changed] == 5) and np.all(result['labels'][changed] == 8)
    retained = np.flatnonzero((labels == 5) & ~changed)
    donor_images = {images[i].tobytes() for i in retained}
    copied_images = {image.tobytes() for image in result['images'][changed]}
    assert copied_images == donor_images
    report = dict(publicTrainSha256=PUBLIC_TRAIN_SHA256,
                  candidateCodeSha256=hashlib.sha256(args.candidate.read_bytes()).hexdigest(),
                  samples=len(images), shape=list(result['images'].shape), imageDtype=str(result['images'].dtype),
                  labelDtype=str(result['labels'].dtype), changedImages=int(image_changed.sum()),
                  changedLabels=int(label_changed.sum()), changedSamples=int(changed.sum()),
                  retainedSourceImages=len(retained), donorCoverageComplete=True,
                  pixelMin=float(result['images'].min()), pixelMax=float(result['images'].max()),
                  inputUnchanged=True, repeatDeterministic=True, runtimeContractPassed=True,
                  changedIndicesSha256=hashlib.sha256(np.flatnonzero(changed).astype('<i8').tobytes()).hexdigest(),
                  validation=[])
    if args.seeds:
        from sklearn.model_selection import train_test_split
        source = ROOT / 'sources' / 'mnist_poison'
        sys.path.insert(0, str(source))
        spec = importlib.util.spec_from_file_location('original_mnist_metrics', source / 'test.py')
        official = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(official)
        for seed in args.seeds:
            train, validation = train_test_split(np.arange(len(labels)), test_size=.2, stratify=labels, random_state=seed)
            clean = official.train_model(images[train], labels[train], seed=42)
            altered = check_poison(images[train], labels[train], candidate.attack(images[train], labels[train]))
            poisoned = official.train_model(altered['images'], altered['labels'], seed=42)
            clean_acc = official.accuracy(clean, images[validation], labels[validation])
            poison_acc = official.accuracy(poisoned, images[validation], labels[validation])
            report['validation'].append(dict(splitSeed=seed, cleanAccuracy=clean_acc, poisonAccuracy=poison_acc,
                                             accuracyDrop=clean_acc-poison_acc, changedSamples=altered['n_modified']))
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()

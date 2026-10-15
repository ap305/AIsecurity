"""Audit original Patch defense on a public-only 160 train + 60 validation NPZ.

Run twice in fresh fixed-image processes. The input must contain exactly the
original benchmark rows 150:370, with images/boxes/cids/counts arrays. No hidden
rows are accepted. This diagnostic does not replace the platform's RPC self-test.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import threading
import types

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from build import enforce_pretrained
from runtime.patch_runtime import configure_patch_runtime


def digest(values):
    result = hashlib.sha256()
    for value in values:
        if isinstance(value, torch.Tensor):
            value = value.detach().cpu().contiguous().numpy()
        result.update(np.ascontiguousarray(value).tobytes())
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-npz', type=Path, required=True)
    parser.add_argument('--sources', type=Path, default=ROOT / 'sources' / 'patch_attack')
    parser.add_argument('--profile', choices=['original', 'flags', 'single'], default='single')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('refuse to overwrite evidence')
    if args.profile == 'single':
        configure_patch_runtime()
    elif args.profile == 'flags':
        torch.use_deterministic_algorithms(True)
        torch.backends.mkldnn.deterministic = True
    sys.path.insert(0, str(args.sources.resolve()))
    import dataset
    # Use the original reference, with the same strict pretrained requirement
    # as the production builder; no random-weight fallback in this audit.
    defense = types.ModuleType('defense')
    defense.__file__ = str(args.sources / 'defense.py')
    sys.modules['defense'] = defense
    exec(compile(enforce_pretrained(Path(defense.__file__).read_text(encoding='utf8')),
                 defense.__file__, 'exec'), defense.__dict__)
    import test as official
    with np.load(args.public_npz, allow_pickle=False) as archive:
        if set(archive.files) != {'images', 'boxes', 'cids', 'counts'}:
            raise ValueError('expected the public-only four-array defense slice')
        images, boxes, cids, counts = (archive[key] for key in ['images', 'boxes', 'cids', 'counts'])
    if images.shape != (220, 128, 128, 3) or images.dtype != np.uint8 or any(len(x) != 220 for x in [boxes, cids, counts]):
        raise ValueError('only the original 160 + 60 public defense samples are accepted')
    samples = []
    for i in range(220):
        anns = [{'bbox': boxes[i, k].tolist(), 'category_id': int(cids[i, k])}
                for k in range(int(counts[i]))]
        samples.append({'image_id': 150 + i, 'image': images[i], 'annotations': anns})
    bundle = {'defense_train': samples[:160], 'defense_val': samples[160:]}
    rng = np.random.default_rng(49)
    clean, patched = official.build_defense_training_data(bundle, rng)
    patches = official.baseline_patches(rng)
    val_clean, val_patched = [s['image'].copy() for s in samples[160:]], []
    for sample in samples[160:]:
        ann = sample['annotations'][int(rng.integers(len(sample['annotations'])))]
        patch = patches[int(rng.integers(len(patches)))]
        image, _ = dataset.apply_patch(sample['image'], ann['bbox'], patch, rng)
        val_patched.append(image)
    report = dict(profile=args.profile, torch=torch.__version__, numpy=np.__version__,
                  threads=torch.get_num_threads(), interop=torch.get_num_interop_threads(),
                  sourceHashes={name: hashlib.sha256((args.sources / name).read_bytes()).hexdigest()
                                for name in ['attack.py', 'defense.py', 'dataset.py', 'test.py']},
                  publicNpzSha256=hashlib.sha256(args.public_npz.read_bytes()).hexdigest(),
                  trainHash=digest(clean + patched), validationHash=digest(val_clean + val_patched),
                  samplerHashes=[], steps=[])
    original_build = defense._build_resnet18
    def build(*a, **kw):
        net = original_build(*a, **kw)
        report['initialFcHash'] = digest([net.fc.weight, net.fc.bias])
        report['postBuildRngHash'] = digest([torch.get_rng_state()])
        return net
    defense._build_resnet18 = build
    original_iter = torch.utils.data.RandomSampler.__iter__
    def sampler(self):
        indices = []
        for value in original_iter(self):
            indices.append(value)
            yield value
        report['samplerHashes'].append(hashlib.sha256(json.dumps(indices).encode()).hexdigest())
    torch.utils.data.RandomSampler.__iter__ = sampler
    original_loss = torch.nn.BCEWithLogitsLoss.forward
    def loss(self, inputs, targets):
        value = original_loss(self, inputs, targets)
        report['steps'].append(dict(loss=float(value.detach()), logitsHash=digest([inputs])))
        return value
    torch.nn.BCEWithLogitsLoss.forward = loss
    state = {}
    def construct(): state['classifier'] = defense.ResNet18Classifier(epochs=8, seed=42)
    def fit(): state['model'] = state['classifier'].fit(None, clean, patched)
    def predict(): state['scores'] = state['model'].predict_many(val_clean + val_patched)
    # Match the RPC construct/fit/predict calls' separate, serialized thread lifecycle.
    for operation in [construct, fit, predict]:
        def guarded():
            try: operation()
            except BaseException as error: state['error'] = error
        thread = threading.Thread(target=guarded)
        thread.start()
        thread.join()
        if 'error' in state: raise state['error']
    scores = state['scores']
    report.update(modelHash=digest(state['model'].net.state_dict().values()),
                  scoresHash=digest([scores]), validationFpr=float(np.mean(scores[:60] >= .5)),
                  validationTpr=float(np.mean(scores[60:] >= .5)))
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print(json.dumps({key: report[key] for key in ['profile', 'modelHash', 'scoresHash', 'validationFpr', 'validationTpr']}))


if __name__ == '__main__':
    main()

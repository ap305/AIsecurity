"""Explicitly prepare independent local-practice assets from reviewed generators.

The immutable package builder only copies these assets; no generator is shipped
to workers or students. Formal images/audio and reference weights stay unchanged.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import numpy as np


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def write_npz(path, arrays):
    if any(np.asarray(value).dtype.kind == 'O' for value in arrays.values()):
        raise ValueError('Public arrays must not require executable pickle')
    buffer = io.BytesIO()
    np.savez_compressed(buffer, **arrays)
    data = buffer.getvalue()
    if path.exists() and path.read_bytes() != data:
        raise ValueError('An existing prepared asset is immutable: ' + path.name)
    if not path.exists(): path.write_bytes(data)
    return {'filename':path.name, 'sha256':sha(data), 'bytes':len(data)}


def prepare(source_root, prepared_root):
    courses = source_root / '题目' / '对抗'
    output = prepared_root / 'public-assets'
    output.mkdir(parents=True, exist_ok=True)
    evidence = {'schemaVersion':1, 'seed':1042, 'assets':[], 'formalAssetsModified':False}
    image_course = next(courses.glob('A10-*'))
    image_source = image_course / 'backend' / 'code' / 'dataset.py'
    image_module = load(image_source, 'reviewed_public_image_generator')
    images = image_module.synthesize(n=48, size=512, seed=1042)
    with np.load(image_course / 'backend/code/data/synth_images.npz', allow_pickle=False) as data:
        hidden = {sha(np.asarray(image).tobytes()) for image in data['images']}
    generated = {sha(image.tobytes()) for image in images['images']}
    if hidden & generated: raise ValueError('Local practice images overlap the formal images')
    record = write_npz(output / 'media10-training.npz', images)
    record.update(sourceSha256=sha(image_source.read_bytes()), samples=48, formalSampleOverlap=0)
    evidence['assets'].append(record)
    audio_course = next(courses.glob('A12-*'))
    audio_source = audio_course / 'backend' / 'code' / 'dataset.py'
    audio_module = load(audio_source, 'reviewed_public_audio_generator')
    samples = audio_module.generate_dataset(n_bonafide=64, n_spoof=64, seed=1042)
    rng = np.random.default_rng(1042)
    training, validation = [], []
    for label in (audio_module.LABEL_BONAFIDE, audio_module.LABEL_SPOOF):
        selected = [sample for sample in samples if sample['label'] == label]
        order = rng.permutation(len(selected))
        training.extend(selected[index] for index in order[:32])
        validation.extend(selected[index] for index in order[32:64])
    with np.load(audio_course / 'backend/code/data/synth_cache.npz', allow_pickle=False) as data:
        hidden_audio = {sha(audio.astype(np.float32).tobytes()) for audio in data['audios']}
    training_audio = {sha(np.asarray(sample['audio'],dtype=np.float32).tobytes()) for sample in training}
    validation_audio = {sha(np.asarray(sample['audio'],dtype=np.float32).tobytes()) for sample in validation}
    if training_audio & validation_audio or hidden_audio & (training_audio | validation_audio):
        raise ValueError('Local practice audio overlaps another split or the formal audio')
    for name, split in [('training',training), ('validation',validation)]:
        record = write_npz(output / ('media12-' + name + '.npz'), audio_module._stack(split))
        record.update(sourceSha256=sha(audio_source.read_bytes()), samples=len(split), samplesPerClass=32,
                      formalSampleOverlap=0, practiceSplitOverlap=0)
        evidence['assets'].append(record)
    provenance = output / 'media-public-training-provenance.json'
    encoded = (json.dumps(evidence, ensure_ascii=False, indent=2) + '\n').encode('utf8')
    if provenance.exists() and provenance.read_bytes() != encoded:
        raise ValueError('An existing preparation provenance is immutable')
    if not provenance.exists(): provenance.write_bytes(encoded)
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--prepared', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source.resolve(), args.prepared.resolve()), ensure_ascii=False))

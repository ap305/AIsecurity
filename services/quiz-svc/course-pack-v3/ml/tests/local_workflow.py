"""Run the downloadable training/export flow on a small public-training subset."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile
import numpy as np


def balanced(labels, limit=256):
    each = max(1, limit // len(np.unique(labels)))
    return np.concatenate([np.flatnonzero(labels == label)[:each] for label in np.unique(labels)])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ids', default='D01,A04,A07,D07,D04')
    args = parser.parse_args()
    args.build, args.output = args.build.resolve(), args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((args.build / 'manifest.json').read_text(encoding='utf8'))
    reports = []
    for source_id in args.ids.split(','):
        question = next(q for q in manifest['questions'] if q['sourceId'] == source_id)
        resource = next(r for r in question['resources'] if r['filename'].endswith('.zip'))
        work = args.output / source_id
        work.mkdir()
        with zipfile.ZipFile(args.build / resource['sourcePath']) as archive:
            for name in archive.namelist():
                target = (work / name).resolve()
                if not target.is_relative_to(work) or name.startswith(('/', '\\')):
                    raise ValueError('Invalid local resource path')
            archive.extractall(work)
        (work / 'filled.py').write_text((args.build / question['selfTest']['codePath']).read_text(encoding='utf8'), encoding='utf8')
        dataset = work / 'data' / ('practice.npz' if source_id.endswith('04') else 'train.npz')
        with np.load(dataset, allow_pickle=False) as original:
            values = {key: original[key] for key in original.files}
        if source_id.endswith('04'):
            select = balanced(values['train_labels'])
            values['train_images'], values['train_labels'] = values['train_images'][select], values['train_labels'][select]
            values['query_images'] = values['query_images'][:256]
        else:
            select = balanced(values['labels'])
            values['images'], values['labels'] = values['images'][select], values['labels'][select]
        np.savez_compressed(dataset, **values)
        env = dict(os.environ, PYTHONUTF8='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1')
        with (work / 'training.log').open('w', encoding='utf8') as log:
            subprocess.run([sys.executable, '-B', 'local_train.py', '--code', 'filled.py', '--out', 'model.pt'], cwd=work,
                           env=env, stdout=log, stderr=subprocess.STDOUT, timeout=900, check=True)
        if question['definition']['weights']['required']:
            import torch
            payload = torch.load(work / 'model.pt', map_location='cpu', weights_only=True)
            expected = 'models-v1' if source_id == 'D01' else 'state-dict-v1' if source_id == 'A04' else 'joblib-v1'
            assert payload['format'] == expected
        reports.append({'id': source_id, 'downloadedWorkflow': True, 'publicTrainingSubset': len(select),
                        'uploadRequired': question['definition']['weights']['required'], 'formalScore': False})
        print(json.dumps(reports[-1]), flush=True)
    (args.output / 'result.json').write_text(json.dumps(reports, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()

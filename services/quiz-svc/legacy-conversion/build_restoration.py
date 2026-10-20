#!/usr/bin/env python3
"""Build the original twenty questions and a SHA-deduplicated private transport archive."""
from __future__ import annotations
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf8')


def verify_assets(previous):
    rows = json.loads((previous / 'questions.json').read_text(encoding='utf8'))
    expected = {'deepfake_audio': {'audio_splits.npz'}, 'deepfake_image': {'train.npz', 'test.npz'},
                'mnist_backdoor': {'train.npz', 'test.npz'}, 'mnist_poison': {'train.npz', 'test.npz'},
                'patch_attack': {'benchmark.npz', 'detector.pt'}, 'watermark_image': {'synth_images.npz'}}
    evidence = []
    for scenario, names in expected.items():
        matches = [row for row in rows if row['scenarioId'] == scenario]
        if len(matches) != 2 or matches[0]['provenance']['assets'] != matches[1]['provenance']['assets']:
            raise ValueError('missing or inconsistent fixed asset provenance: ' + scenario)
        recorded = matches[0]['provenance']['assets']
        if set(recorded) != names:
            raise ValueError('unexpected asset list: ' + scenario)
        for name in sorted(names):
            path = previous / 'packages' / scenario / 'data' / name
            if not path.is_file() or path.is_symlink():
                raise ValueError('missing regular fixed asset: ' + str(path))
            digest = sha(path)
            if digest != recorded[name]['sha256'] or path.stat().st_size != recorded[name]['bytes']:
                raise ValueError('fixed asset differs from previous provenance: ' + str(path))
            evidence.append({'scenario': scenario, 'file': name, 'bytes': path.stat().st_size, 'sha256': digest})
    return evidence


def rewrite_paths(path, output, runtime_root):
    rows = json.loads(path.read_text(encoding='utf8'))
    for row in rows:
        for key in ('packageDirectory', 'referenceCodePath'):
            if key in row:
                relative = Path(row[key]).resolve().relative_to(output.resolve()).as_posix()
                row[key] = str(PurePosixPath(runtime_root) / relative)
    save(path, rows)
    return rows


def archive_bundle(output, archive_path, image, runtime_root):
    if archive_path.exists():
        raise FileExistsError('transport archive already exists')
    files, blobs = [], {}
    for path in sorted(output.rglob('*')):
        if path.is_symlink():
            raise ValueError('symlinks are forbidden in the private restoration bundle')
        if not path.is_file():
            continue
        digest = sha(path)
        files.append({'path': path.relative_to(output).as_posix(), 'sha256': digest, 'bytes': path.stat().st_size})
        blobs.setdefault(digest, path)
    index = {'schemaVersion': 1, 'packId': 'legacy20-restoration', 'runtimeRoot': runtime_root,
             'image': image, 'questions': 20, 'packages': 10, 'files': files}
    with tarfile.open(archive_path, 'w:gz', compresslevel=6) as archive:
        data = (json.dumps(index, ensure_ascii=False, indent=2) + '\n').encode('utf8')
        item = tarfile.TarInfo('index.json')
        item.size, item.mode, item.mtime = len(data), 0o600, 0
        archive.addfile(item, io.BytesIO(data))
        for digest, path in sorted(blobs.items()):
            item = tarfile.TarInfo('blobs/' + digest)
            item.size, item.mode, item.mtime = path.stat().st_size, 0o600, 0
            with path.open('rb') as content:
                archive.addfile(item, content)
    archive_path.chmod(0o600)
    return {'archive': str(archive_path.resolve()), 'sha256': sha(archive_path),
            'archiveBytes': archive_path.stat().st_size, 'files': len(files), 'uniqueBlobs': len(blobs),
            'materializedBytes': sum(item['bytes'] for item in files),
            'uniqueBytes': sum(path.stat().st_size for path in blobs.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--asset-build-root', type=Path, required=True,
                        help='previous verified ML build containing questions.json and packages/*/data')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--runtime-root', default='/courses/legacy20')
    parser.add_argument('--private-order-seeds', type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9.:_/-]+@sha256:[0-9a-f]{64}', args.image):
        raise ValueError('a verified immutable registry image digest is required')
    runtime_root = PurePosixPath(args.runtime_root)
    if not runtime_root.is_absolute() or '..' in runtime_root.parts or str(runtime_root) != args.runtime_root:
        raise ValueError('runtime root must be a normalized absolute Linux path')
    if args.output.exists() and any(args.output.iterdir()):
        raise FileExistsError('select a new empty restoration directory')
    if args.archive.exists() or args.archive.resolve().is_relative_to(args.output.resolve()):
        raise ValueError('archive must be new and outside the materialized bundle')
    assets = verify_assets(args.asset_build_root)
    args.output.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, '-B', str(ROOT / 'bots/build.py'), '--source', str(ROOT / 'bots/sources'),
                    '--questions', str(ROOT / 'bots/sources/questions.json'), '--output', str(args.output / 'bots'),
                    '--image', args.image], check=True, stdout=subprocess.DEVNULL)
    command = [sys.executable, '-B', str(ROOT / 'ml/build.py'), '--asset-root', str(args.asset_build_root / 'packages'),
               '--output', str(args.output / 'ml'), '--image', args.image]
    if args.private_order_seeds:
        command.extend(['--private-order-seeds', str(args.private_order_seeds)])
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    bots = rewrite_paths(args.output / 'bots/metadata.json', args.output, args.runtime_root)
    ml = rewrite_paths(args.output / 'ml/questions.json', args.output, args.runtime_root)
    rewrite_paths(args.output / 'ml/packages.json', args.output, args.runtime_root)
    if len(bots) != 8 or len(ml) != 12 or len({row['questionId'] for row in bots + ml}) != 20:
        raise ValueError('restoration must contain all original twenty unique questions')
    target = args.output / 'acceptance'
    target.mkdir()
    mapping = json.loads((ROOT / 'ml/acceptance/manifest.json').read_text(encoding='utf8'))
    for name in ['manifest.json', *mapping.values()]:
        source = ROOT / 'ml/acceptance' / name
        if source.is_symlink() or not source.is_file() or source.parent != ROOT / 'ml/acceptance':
            raise ValueError('invalid acceptance material')
        shutil.copyfile(source, target / name)
    save(args.output / 'assets-provenance.json', {'files': assets, 'totalBytes': sum(a['bytes'] for a in assets),
                                               'thresholds': 'not calibrated; new-server proofs required'})
    shutil.copyfile(ROOT / 'RESTORATION.md', args.output / 'RESTORATION.md')
    args.archive.parent.mkdir(parents=True, exist_ok=True)
    report = archive_bundle(args.output, args.archive, args.image, args.runtime_root)
    save(args.archive.with_suffix('.report.json'), report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

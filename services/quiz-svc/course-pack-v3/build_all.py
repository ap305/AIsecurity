"""Build and freeze all 77 questions, without changing the site or database.

The initial manifest is explicitly uncalibrated and cannot be published by the
HTTP importer. Real reference evaluation in the final Docker image must precede
the separately frozen release manifest.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
EXPECTED_SHA = '9aae9548bb93992b766b01c2bfed53b90b8cf469dd68a669008b38154721d778'
QUESTION_KEYS = ('id', 'title', 'moduleCode', 'number', 'difficulty', 'category', 'scenarioId', 'role',
                 'content', 'answerTemplate', 'definition', 'packageKey', 'selfTest', 'resources',
                 'requiresCalibration', 'deploymentReady')


def relative_file(group, root, value):
    path = Path(value)
    if not path.is_absolute():
        path = group / path
    path = path.resolve()
    if not path.is_relative_to(group.resolve()) or not path.exists() or path.is_symlink():
        raise ValueError('Build references escaped their own group or are missing')
    return path.relative_to(root).as_posix()


def aggregate(output, image, archive_sha):
    manifest = {'schemaVersion': 1, 'packId': 'V3-261012', 'sourceArchiveSha256': archive_sha,
                'requiresCalibration': True, 'deploymentReady': False, 'packages': [], 'questions': []}
    metadata = {'schemaVersion': 1, 'image': image, 'questions': [], 'apiPools': []}
    for name in ('basic', 'adversarial', 'media', 'ml', 'tabular'):
        group = output / name
        raw = json.loads((group / 'manifest.json').read_text(encoding='utf8'))
        missing = {row['id']: row['missingAssets'] for row in raw['questions'] if row.get('missingAssets')}
        if missing:
            raise ValueError('Required author assets are missing: ' + json.dumps(missing, ensure_ascii=False))
        for package in raw['packages']:
            package['key'] = name + '-' + package['key']
            package['directory'] = relative_file(group, output, package['directory'])
            manifest['packages'].append(package)
        for row in raw['questions']:
            metadata['questions'].append({key: value for key, value in row.items() if key not in QUESTION_KEYS})
            question = {key: row[key] for key in QUESTION_KEYS if row.get(key) is not None}
            question['packageKey'] = name + '-' + question['packageKey']
            material = question['selfTest']
            material['codePath'] = relative_file(group, output, material['codePath'])
            if 'opponent' in material:
                material['opponent']['codePath'] = relative_file(group, output, material['opponent']['codePath'])
            for resource in question['resources']:
                resource['sourcePath'] = relative_file(group, output, resource['sourcePath'])
            evaluation = question['definition']['evaluation']
            for key, placeholder in [('baselineThreshold', 0), ('successThreshold', 1)]:
                if evaluation.get(key) is None:
                    evaluation[key] = placeholder
            question['deploymentReady'] = False
            question['requiresCalibration'] = question['category'] == 'adversarial'
            manifest['questions'].append(question)
        if (group / 'api-pools.json').exists():
            metadata['apiPools'].extend(json.loads((group / 'api-pools.json').read_text(encoding='utf8'))['pools'])
    expected = {f'V3-261012-B{n:02}' for n in range(1, 18)} | {
                  f'V3-261012-{role}{n:02}' for role in 'AD' for n in range(1, 32) if n != 29}
    ids = [q['id'] for q in manifest['questions']]
    if len(ids) != 77 or set(ids) != expected:
        raise ValueError('Must build exactly the 77 requested questions')
    keys = [p['key'] for p in manifest['packages']]
    if len(set(keys)) != len(keys):
        raise ValueError('Duplicate package keys')
    for name, data in [('manifest.json', manifest), ('build-evidence.json', metadata)]:
        (output / name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf8')
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--media-private-order-seeds', type=Path)
    parser.add_argument('--allow-development-image', action='store_true')
    args = parser.parse_args()
    args.output, args.prepared = args.output.resolve(), args.prepared.resolve()
    if args.output.exists():
        raise ValueError('Build output must not already exist')
    if not args.allow_development_image and not re.fullmatch(r'.+@sha256:[a-f0-9]{64}', args.image):
        raise ValueError('Production build requires an immutable approved image digest')
    with args.archive.open('rb') as file:
        archive_sha = hashlib.file_digest(file, 'sha256').hexdigest()
    if archive_sha != EXPECTED_SHA:
        raise ValueError('Source archive does not match the inspected user attachment')
    args.output.mkdir(parents=True)
    for name in ('basic', 'adversarial', 'media', 'ml', 'tabular'):
        command = [sys.executable, '-B', '-X', 'utf8', str(ROOT / name / 'build.py'),
                   '--source', str(args.source.resolve()), '--output', str(args.output / name), '--image', args.image]
        if name == 'basic':
            command += ['--reference-weights', str(args.prepared)]
        if name == 'adversarial':
            command += ['--bigram', str(args.prepared / 'watermark' / 'backend' / 'weights' / 'bigram.pt')]
        if name == 'media':
            command += ['--practice-cache-root', str(args.prepared / 'public-assets')]
            if args.media_private_order_seeds:
                command += ['--private-order-seeds', str(args.media_private_order_seeds.resolve())]
        subprocess.run(command, check=True)
    result = aggregate(args.output, args.image, archive_sha)
    print(json.dumps({'questions': len(result['questions']), 'packages': len(result['packages']),
                      'requiresCalibration': True, 'deploymentReady': False}))


if __name__ == '__main__':
    main()

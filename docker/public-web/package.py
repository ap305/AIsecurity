#!/usr/bin/env python3
"""Package apps/web/dist after a clean, tagged frontend build; contains no secrets."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'v[0-9]{8}-[0-9]{2}-[a-z0-9-]+', args.release):
        raise ValueError('Invalid release name')
    if git('status', '--porcelain'):
        raise ValueError('Commit changes before packaging')
    commit = git('rev-parse', 'HEAD')
    if git('cat-file', '-t', args.release) != 'tag' or git('rev-list', '-n', '1', args.release) != commit:
        raise ValueError('Release must be an annotated tag at HEAD')
    dist = ROOT / 'apps' / 'web' / 'dist'
    files = {}
    for path in sorted(dist.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlinks are not accepted in builds')
        if path.is_file():
            files[path.relative_to(dist).as_posix()] = path.read_bytes()
    if 'index.html' not in files or 'release.json' in files:
        raise ValueError('Missing build or reserved manifest filename')
    manifest = {'release': args.release, 'sourceCommit': commit,
                'files': {p: hashlib.sha256(b).hexdigest() for p, b in files.items()}}
    files['release.json'] = json.dumps(manifest, indent=2).encode()
    output = Path(args.output)
    with output.open('xb') as destination:
        with tarfile.open(fileobj=destination, mode='w:gz') as tar:
            for name, content in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                entry.mode = 0o644
                tar.addfile(entry, io.BytesIO(content))
    print(json.dumps({'archive': str(output), 'release': args.release,
                      'commit': commit, 'files': len(files) - 1,
                      'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}, indent=2))


if __name__ == '__main__':
    main()

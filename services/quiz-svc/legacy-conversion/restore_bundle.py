#!/usr/bin/env python3
"""Materialize a private restoration archive without archive extraction or links."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile


def restore(archive_path, output):
    output = Path(output)
    if output.is_symlink() or output.exists() and any(output.iterdir()):
        raise FileExistsError('destination must be new or empty, never an existing release')
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        if len({member.name for member in members}) != len(members):
            raise ValueError('duplicate archive entries')
        if any(not member.isfile() or not (member.name == 'index.json' or
               re.fullmatch(r'blobs/[0-9a-f]{64}', member.name)) for member in members):
            raise ValueError('archive contains a link or an unexpected path')
        index = json.load(archive.extractfile('index.json'))
        if index.get('schemaVersion') != 1 or index.get('packId') != 'legacy20-restoration':
            raise ValueError('unknown bundle format')
        expected, paths, blobs = set(), set(), {}
        for item in index['files']:
            relative = PurePosixPath(item['path'])
            if (relative.is_absolute() or relative == PurePosixPath('.') or '..' in relative.parts or str(relative) != item['path']
                    or '\\' in item['path'] or ':' in item['path'] or item['path'] in paths
                    or not re.fullmatch(r'[0-9a-f]{64}', item['sha256'])
                    or not isinstance(item['bytes'], int) or item['bytes'] < 0):
                raise ValueError('invalid materialization path or digest')
            paths.add(item['path'])
            name = 'blobs/' + item['sha256']
            expected.add(name)
            if name not in blobs:
                body = archive.extractfile(name).read()
                if hashlib.sha256(body).hexdigest() != item['sha256']:
                    raise ValueError('transport blob checksum mismatch')
                blobs[name] = body
            if len(blobs[name]) != item['bytes']:
                raise ValueError('transport blob size mismatch')
        if {member.name for member in members} != expected | {'index.json'}:
            raise ValueError('unreferenced or missing transport blobs')
        if any(str(parent) in paths for name in paths for parent in PurePosixPath(name).parents
               if parent != PurePosixPath('.')):
            raise ValueError('a file cannot also be a parent directory')
        # All archive input is verified before creating the destination.
        output.mkdir(parents=True, exist_ok=True)
        resolved = output.resolve()
        for item in index['files']:
            destination = output / item['path']
            if not destination.resolve().is_relative_to(resolved):
                raise ValueError('materialization escaped destination')
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as handle:
                handle.write(blobs['blobs/' + item['sha256']])
            destination.chmod(0o600)
    return {'questions': index['questions'], 'packages': index['packages'], 'files': len(paths),
            'image': index['image'], 'runtimeRoot': index['runtimeRoot'], 'output': str(output.resolve())}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(restore(args.archive, args.output), ensure_ascii=False, indent=2))

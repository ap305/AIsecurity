"""Verify a local versioned resource backup without executing project code."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backup-dir", required=True, type=Path)
    parser.add_argument("--expected-manifest-sha256", required=True)
    args = parser.parse_args()

    root = args.backup_dir.resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit("Backup manifest is missing")
    if sha256(manifest_path) != args.expected_manifest_sha256.lower():
        raise SystemExit("Backup manifest hash differs")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    verified_bytes = 0
    for record in manifest["files"]:
        path = (root / record["backupRelativePath"]).resolve()
        if not path.is_relative_to(root) or not path.is_file() or path.is_symlink():
            raise SystemExit("Backup path is missing, symlinked, or outside backup root")
        if path.stat().st_size != record["bytes"] or sha256(path) != record["sha256"]:
            raise SystemExit("Backup file size or SHA-256 differs: " + record["backupRelativePath"])
        verified_bytes += record["bytes"]
    if len(manifest["files"]) != manifest["fileCount"] or verified_bytes != manifest["totalBytes"]:
        raise SystemExit("Backup manifest totals differ")
    print(json.dumps({
        "resourceVersion": manifest["resourceVersion"],
        "verifiedFiles": len(manifest["files"]),
        "verifiedBytes": verified_bytes,
        "status": "ok",
    }))


if __name__ == "__main__":
    main()

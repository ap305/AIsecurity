# Resource version for the course v3 source snapshot

This code snapshot includes the 77-question adapter from source commit `35f932f66553734af7d3a3c69bc33489c39fda7f`. Its matching local resource version is `course-v3-261012-source-35f932f`. The machine-readable identifier and hashes are in [resource-version.json](resource-version.json). The sanitized Git commit is recorded separately in the local backup after it exists; it is not embedded in its own commit.

## Local backup and verification

On the source Windows computer, the sibling directory `AIsecurity-resource-backups/course-v3-261012-source-35f932f` contains `manifest.json` and 2,039 verified files (4,683,187,317 bytes). Its manifest SHA-256 is `51e52ce7f16b6d16ff8daf961defbb85db21305617ce64e365e8f3d39130a4c5`. Run from the code checkout:

```sh
python tools/verify_resource_backup.py --backup-dir <path-to-course-v3-261012-source-35f932f> --expected-manifest-sha256 51e52ce7f16b6d16ff8daf961defbb85db21305617ce64e365e8f3d39130a4c5
```

The backup has five groups: the original 1.95 GB course archive; 68 legacy PDF, ZIP, model and dataset files excluded from Git; prepared weights, pretrained inputs and the full local course build; local build and release records; and the local calibration and verification records. Every manifest entry records its workspace-relative source path, backup-relative path, byte size and SHA-256. The course archive hash matches the value pinned in `course-pack-v3/build_all.py`.

This is a **same-volume local copy**, not offsite disaster recovery. Do not remove the original files. A separate storage location is needed to protect against loss of the E: volume.

## What the code checkout can do

The checkout has the latest adapter source and ordinary project tests/build, but does not include the private course archive, reference weights, generated question packages, old PDF/ZIP/model assets, or local calibration output. Full question-bank building or operation requires restoring and reviewing those resources separately. Do not upload the local backup to GitHub or a cloud environment without reviewing its data rights and sensitive content.

The original archive and legacy input bytes are needed for an exact rebuild and cannot be assumed to be downloadable again. Generated question packages can be rebuilt from the pinned archive, prepared assets and approved image. The B17 reference weight can be retrained, but an identical output is not guaranteed, so its existing bytes and hash are preserved. The recorded local manifest has `deploymentReady=false`; it must not be treated as a published question bank or a completed calibration.

To restore locally, verify the backup first, then copy the needed files from their `backupRelativePath` to the matching `sourceRelativePath` in the local manifest. Keep secrets and production deployment configuration outside this source checkout. For the course v3 builder, use the verified raw archive and prepared assets as explicit inputs; run calibration and publication only in an approved environment.

# Sanitized source snapshot

This copy now includes the application, evaluation adapters and tests from local commit `84bfede533fc57b667f195ae78538359235e00ac` on `feat/course-pack-20261016`, continuing the existing sanitized history at `d372302`. The original local directory and its Git history remain untouched. This copy retains only sanitized export commits; the original branches, tags, and full history are not included. See [SOURCE_REFRESH_20261020.md](SOURCE_REFRESH_20261020.md) for scope and validation.

## Excluded from this snapshot

- Local environment files, authentication keys, user uploads, dependencies, build output, and test artifacts were never copied.
- Deployment credentials, host-specific configuration, deployment runbooks, and recorded server validation output were excluded.
- 45 PDF attachments, 9 dataset ZIP archives, 2 model files, and 10 small external dataset or generated metadata files were excluded pending personal-data and redistribution review.
- The new course-pack server verification record and `media/calibration.local.json` were excluded as environment-specific output.

The matching resource version, local backup verification, and restore limits are documented in [RESOURCE_RESTORE.md](RESOURCE_RESTORE.md). The large resources remain local and are not part of this Git snapshot.

Infrastructure addresses in retained source and documentation were replaced with local or example addresses. Non-example email addresses in scenario and test material were consistently replaced with reserved `example.com` addresses.

## Runtime limits

The web app's question attachment downloads and parts of the evaluation system require the excluded assets. Review and sanitize those assets before restoring them. The latest course-pack source is included, but its environment-specific verification and calibration output is not. The resource backup below remains the earlier immutable resource snapshot; updating source code does not change its manifest or claim new assets were backed up. Validation of this source refresh is recorded separately; full operation from this asset-free checkout and the Codex cloud environment remain unverified. A release still requires verification in the target environment.

For Codex cloud code tasks, use Node.js 20+ and pnpm 9+, install from the repository root with `pnpm install --frozen-lockfile`, then run `pnpm test` and `pnpm build`. Running the backend as a service separately requires PostgreSQL and a development-only `DATABASE_URL`; full evaluation also requires Docker Engine, Compose v2, Python 3, and approved images. Do not use production credentials in the cloud code environment.

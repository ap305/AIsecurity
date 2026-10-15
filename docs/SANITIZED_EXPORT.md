# Sanitized source snapshot

This repository is a new source snapshot of local commit `81d3e38` on `fix/teaching-interaction`. The original local directory and its Git history remain untouched. This repository intentionally starts with a new root commit; the original branches and tags are not included.

## Excluded from this snapshot

- Local environment files, authentication keys, user uploads, dependencies, build output, and test artifacts were never copied.
- Deployment credentials, host-specific configuration, deployment runbooks, and recorded server validation output were excluded.
- 45 PDF attachments, 9 dataset ZIP archives, 2 model files, and 10 small external dataset or generated metadata files were excluded pending personal-data and redistribution review.

Infrastructure addresses in retained source and documentation were replaced with local or example addresses. Non-example email addresses in scenario and test material were consistently replaced with reserved `example.com` addresses.

## Runtime limits

The web app's question attachment downloads and parts of the evaluation system require the excluded assets. Review and sanitize those assets before restoring them. This snapshot has not been run or tested after export.

For Codex cloud code tasks, use Node.js 20+ and pnpm 9+, install from the repository root with `pnpm install --frozen-lockfile`, then run `pnpm test` and `pnpm build`. Running the backend as a service separately requires PostgreSQL and a development-only `DATABASE_URL`; full evaluation also requires Docker Engine, Compose v2, Python 3, and approved images. Do not use production credentials in the cloud code environment.

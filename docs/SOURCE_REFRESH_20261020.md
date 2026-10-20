# Latest source refresh — 2026-10-20

Source: `84bfede533fc57b667f195ae78538359235e00ac`. This commit continues the private repository's existing sanitized history, without importing the original local history or rewriting the remote branch.

Updated code includes:

- Question-bank categories and student/teacher hall navigation, question resource handling, and clearer submission diagnostics.
- Reviewed Python worker bootstrap compatibility for legal future imports in both ML and API/class-role packages. Transformations apply only to the exact reviewed bootstrap digests, inside isolated worker copies.
- Safe error classification, finite retries, and preservation of existing effective scores after invalid student submissions.
- Per-question teacher scores and regression coverage of score, version and access-isolation rules.
- The 77-question course adapters, measured calibration and independent proof tooling, bounded 8B request timeouts/pacing, and guarded paired A08/D08 finalization.
- Response snapshots restricted to the approved A02/D02 and A09/D09 scopes; A08/D08 do not use response snapshots.

Only source, tests and the sanitized helper required by CLI tests are updated. Production deployment scripts/configuration, session credentials, student submissions/weights, database backups, raw calibration records and environment-specific acceptance reports remain outside this repository. Existing reviewed source assets and resource-restore documentation are retained.

Validation on the refreshed checkout passed: backend **274 passed, 0 failed, 2 skipped**; frontend **41 passed, 0 failed**; Python API/ML bootstrap regressions **3 passed**. Prisma client generation, backend TypeScript compilation and frontend TypeScript/Vite production build all succeeded. The two skips are the optional real Docker integration and the POSIX filesystem-permissions case on Windows; neither is claimed as exercised here.

The dependency wrapper initially attempted an unnecessary store update, so the installed Node/tsx/TypeScript/Vite entrypoints were run directly. Local HTTP/database fixtures needed loopback access outside the restricted process sandbox. An initial export-only failure caught an overbroad replacement of reserved `example.test` addresses; those synthetic domains are now preserved, and the final full backend suite passed. Production code and production records were not changed by this export correction. No external model service or production database was used for source tests.

The earlier resource backup is still independently identified by `resource-version.json`; this source refresh does not claim it contains the newer generated runtime packages or new calibration records. Restore and verify approved assets before attempting a complete question-bank rebuild or deployment.

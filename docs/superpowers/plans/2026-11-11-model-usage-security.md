# Model usage security implementation plan

> For agentic workers: use subagent-driven development for independent components, followed by integration review.

**Goal:** close the observed model gateway exposure and give administrators reliable model usage and abnormal-spend visibility without blocking submissions or altering existing grades.

**Architecture:** add an append-only model request ledger and administrator-only policy/alert data. Instrument actual upstream requests centrally; cache hits are recorded separately and never counted as fresh upstream usage. Daily and cumulative thresholds are warning-only, per the user's explicit choice on 2026-11-11. Alert delivery is in the existing administrator interface; no unrequested email/SMS/webhook.

**Stack:** existing Express/TypeScript, Prisma/PostgreSQL, React; no new production dependencies.

## Binding decisions and alternatives

- User chose statistics and alerts, with hard limits disabled. No admission rejection, worker pause, changed retry/scoring logic, key replacement, model switch or true paid calibration is included.
- Compared blocking each individual gateway call (can interrupt an evaluation) and reserving full task budgets (larger scoring-queue integration): both deferred. This release uses thresholds only; clearly label this in the UI, not as a spending guarantee.
- Initial editable warning thresholds: platform daily 10,000 and cumulative 100,000 upstream attempts; account daily 4,000 and cumulative 20,000; warning at 80%, exceeded at 100%. They exceed the observed recent production day peaks and allow visibility into larger calibration runs; they do not affect admission.
- Count known upstream attempts, successful responses, failed/unknown outcomes, cache hits, and reported input/output/total tokens. Missing usage is unknown, never zero-cost; do not invent historical tokens or currency amounts. Counters begin at deployment and old audit data is not backfilled as billing data.
- Statistics are per account, question, model and day; test accounts remain identifiable and included in cost visibility, while score/leaderboard exclusion stays unchanged.
- All alert messages are fixed/allowlisted; no raw upstream errors, body, authorization, credentials or prompts enter the ledger, logs or admin output. Config must reject credential-shaped parameters server-side.
- Existing policy editing requires admin auth and optimistic revision checks. Only acknowledge alerts; retain event history.

## Component contracts

Backend service `services/quiz-svc/src/services/modelUsage.ts` owns new Prisma models/migration, statistics/policy/alerts helpers. Route `routes/modelUsage.ts` owns GET `/admin/model-usage?days=7`, PUT `/admin/model-usage/policy`, POST `/admin/model-usage/alerts/:id/ack` (requireAdminMw and no-store). Implementer will publish precise TypeScript exports and response DTO before frontend integration.

Root owns instrumentation `services/apiPool.ts`, `routes/apiPool.ts`, `routes/evaluationPackages.ts`, `routes/teacherLeases.ts`, `routes/llm.ts`, `app.ts`. Low-level tracking has start/finish methods; metadata is server-derived. Tracking failures must not replace successful evaluation responses; emit fixed sanitized monitoring-failure logs. New requests in production must all have metadata; tests without a configured tracking context can continue to use callPool directly without DB.

Frontend owns new `pages/admin/ModelUsage.tsx`, a dedicated API/types module and tests. Root wires route/navigation. The view exposes observe-only state, today/range/all-time totals, per-day/model/question/account tables, data coverage, policy and alerts. Loading/error/retry/save/ack states must release buttons reliably.

## Tasks and verification

- [ ] Backend ledger, policy, aggregation and alerts with failing-first integration tests: concurrent finishes idempotent; token schema; incomplete calls; 80/100% deduplication; acknowledged recurrence; admin isolation; no private payloads; BJT boundary; no legacy-score mutations.
- [ ] Instrument all production model entry points, including self-tests and administrator legacy/connection test; test success, timeout, HTTP 401/402/429, invalid JSON, snapshot reuse and tracking failure. Health requires valid login, cached checks, bounded sanitized response; no live upstream calls in tests.
- [ ] Admin page tests and build: correct unknown usage, no currency claims, observe-only editable thresholds, bounded filters and error recovery.
- [ ] Run full backend/frontend regression, type checks and production build; independent review of privacy, accounting and noninterference.
- [ ] Backup and restore-test production DB, use additive migrations only, stage isolated cloned environment, use synthetic local provider there for end-to-end request/statistics/alert checks. Do not clone provider secrets into new external destinations.
- [ ] Deploy through existing guarded API bridge/drain mechanism; allow existing workers to finish; preserve public domain routing and old assets. Verify old grade/submission/question rows via readonly snapshots, public API permissions, queue health and warning-only policy; verify no paid model calls were made by acceptance tests.
- [ ] Commit verified source in release worktree; synchronize only cleaned source/tests/docs to sanitized GitHub repo. Keep deployment secrets and evidence private.

## Review focus

1. Old pending requests, DB tracking failures and pending UI operations must not cause scoring or submission regressions.
2. Cached responses contain original usage: never count their token fields again as billed upstream work.
3. Repeated finish/alert generation under concurrency must not inflate usage or spam identical alerts.
4. Service restart, midnight and stale policy revision must retain counters and visible uncertainty.
5. Health/admin error bodies and arbitrary configuration strings must not leak keys or become stored prompts.

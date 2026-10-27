# D02 Original Evaluation Restoration Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the isolated source fix and independent rollout review. Execute the authorized deployment without an extra approval gate.

**Goal:** Restore uploaded D02 evaluation semantics and public150/hidden150 sample scope, calibrate and test an immutable new package, then safely publish it.

**Architecture:** Reuse the existing trusted evaluator, isolated student RPC, response snapshots and measured self-test pipeline. Change D02 alone and bind fresh proofs to its new package and frozen configuration. Preserve prior submissions and scores; do not bulk re-evaluate students.

**Tech Stack:** Python course package builder/runtime, TypeScript quiz-svc, PostgreSQL, Docker Compose.

**Spec:** User instruction of 2026-10-27 and docs/validation/2026-10-27-d02-original-evaluation-audit.md.

## Global Constraints

- D02 uses all 150 public and 150 hidden records and original Top-K, clean gates, attack anchors and original DataIsolationDefense reference.
- Keep the confirmed PRD student-opponent win-rate scoring and approved exact-request real8B response snapshots.
- Use the existing Qwen3-8B service only; never weaken original clean gates to force a pass.
- Other questions, student submissions and existing scores remain unchanged.
- No restart or evaluation interruption on the active production API; calibration must be resource-bounded and isolated where necessary.
- Publication requires genuine calibration, final frozen-configuration tests, backup, concurrency preconditions and verified score preservation.

## Review Focus

- Shared A02/D02 evaluator: ensure A02 and all other question outputs remain unchanged.
- Top-K: verify N150/K15 and nonzero reverse-order distance with original pure functions.
- Original reference clean gate: retain actual failure evidence; do not silently repair or lower thresholds.
- Version switch: old pending/running tasks must remain valid and existing best scores must not be cleared.
- Model/resource budget: isolate calibration from the live worker and avoid unbounded retries or duplicate work.

### Task 1: Source restoration and regression checks

- [ ] Write failing builder/runtime tests for D02 full sample scope and original reference source.
- [ ] Apply the smallest D02-specific builder/config change, preserving original course files and other questions.
- [ ] Correct the misleading scoring direction and disclose full samples/reference in D02 presentation.
- [ ] Run focused regression tests and independent diff review; record immutable package/source hashes.

### Task 2: Independent calibration and acceptance

- [ ] Inspect live containers, queues and existing clone tooling read-only; select an isolated worker/DB and valid normal admin session.
- [ ] Build D02-only candidate without altering production bindings.
- [ ] Run original reference baseline/opponent calibration using existing 8B pool; keep all gates and failure evidence.
- [ ] Freeze measured thresholds, then run new genuine final self-tests and student-path acceptance for the frozen candidate.

### Task 3: Safe production publication

- [ ] Verify current publication/update semantics, preserving existing scores and avoiding invalidation of active tasks.
- [ ] Back up relevant state and snapshot other question definitions plus formal score fingerprints.
- [ ] Publish only after acceptance passes, with compare-and-swap and an explicit preservation check.
- [ ] Verify public question/API, existing results, queues and health; retain old package for historical evaluation.
- [ ] Commit only reviewed source/tests/documentation and synchronize the sanitized GitHub checkout without private history or data.

If an original reference cannot pass original gates, do not publish a failing package. Report the measured blocker and retain the current production version.

# Classes, solutions and email verification implementation plan

> For agentic workers: use subagent-driven development for independent components; root integrates shared schema, routing, builds and release verification. Steps use checkbox tracking.

**Goal:** deliver classroom membership/export, opt-in public solutions, and compatible email verification/recovery without altering existing scores or submission rules.

**Architecture:** additive independent tables and feature routes; shared existing auth and score helpers; feature pages use existing React/API components. SMTP stays disabled until configured and verified.

**Tech Stack:** Express/TypeScript, Prisma/PostgreSQL, React/Vite, existing adm-zip; Nodemailer for SMTP.

**Spec:** ../specs/2026-11-13-classes-solutions-email-design.md

## Global constraints

- Existing release worktree, new feature branch; never publish the main checkout's unpublished D02 code.
- Root owns schema/migration, app route registration, App/Sidebar, package dependency/lockfile and final integration. Agents own non-overlapping feature files.
- TeacherGrant is an additional privilege, not User.role mutation. Query privilege from current database state for writes.
- No changes to question definition, revision, score ledger, rankings, inference budgets or model credentials.
- User explicitly chose shared-only highest solutions and development/mock verification for email with no mail provider configured.
- Only new feature tables are added; no automatic data backfill or user migration.

## Review focus

1. Stale auth, revoked teacher grant and guessed class IDs must not expose another class's student data.
2. Opt-in revoked, obsolete revision, inactive arena slot, null score, zero score and ties must select only the intended public solution.
3. Registration/verification/recovery replay and concurrent transactions must create/change at most one account without sending twice.
4. Mail delivery failure or disabled SMTP must leave existing login and submissions usable and never report a successful delivery.
5. CSV formulas, code/Markdown content and private submission paths must not become executable content or leak into responses.

## Shared schema contract (root)

TeacherGrant(userId PK, grantedBy, createdAt).
Classroom(id UUID, name, description, ownerId, inviteCode UNIQUE, archivedAt nullable, createdAt, updatedAt).
ClassMembership(id UUID, classroomId, userId, joinedAt; UNIQUE(classroomId,userId)).
ClassJoinThrottle(userId PK, attempts, windowStartedAt).
QuestionSolution(id UUID, questionId, questionVersion, authorId, kind standard/user, title, explanation, code, sourceSubmissionId nullable, referenceKind nullable, published Boolean, createdAt, updatedAt).
UserEmail(userId PK, email UNIQUE, verifiedAt).
EmailChallenge(id UUID, purpose, email, userId nullable, tokenHash UNIQUE, sessionVersion nullable, expiresAt, consumedAt nullable, createdAt).
EmailSendThrottle(key PK, count, windowStartedAt, lastSentAt).
All references scalar, indexed; deletion/status/version checked in feature queries. No old table mutation.

### Task 1: shared migration and contracts (root)
- [x] Add migration 20261113000000_classes_solutions_email and schema models above; regenerate Prisma locally with cached engines.
- [x] Verify fresh disposable DB accepts migration and old business models still query unchanged.
- [x] Add route registrations after feature implementations, add /classes and /question/:id/solutions and email routes; preserve current guards.

### Task 2: classroom backend and frontend (class implementer)
**Files:** src/services/classrooms.ts, src/routes/classrooms.ts, tests/classrooms.integration.test.ts; export reusable questionScoresForStudents from services/adminStudentScores.ts; apps/web/src/lib/classrooms.ts, pages/Classes.tsx and tests; admin/UserManager.tsx teaching grant controls.
**Interfaces:** GET /api/classrooms returns {canTeach,owned,joined}; POST /classrooms {name,description}; POST /classrooms/join {inviteCode}; GET /classrooms/:id; POST /:id/invite; PUT /:id {name,description,archived}; DELETE /:id/membership; DELETE /:id/members/:userId; POST /classrooms/export {classroomIds} returns CSV/ZIP; GET/PUT /admin/users/:id/teaching {enabled}. Export `canTeach(userId:string, db=prisma):Promise<boolean>` for solutions.
- [x] Tests first: multi-membership/idempotent join, owner/admin boundaries, current-session checks, invite rotation/archive, revoke grant, no source code in rosters.
- [x] Implement with transaction authorization checks; no old score writes.
- [x] CSV/ZIP tests: mixed basic/arena current scores, no-score vs zero, leading-zero ID, injection, excluded test accounts, denied mixed-owner export.
- [x] UI create/join/manage/export and teacher grant controls; bounded loading, clear errors, disabled only during its operation, allow retry.
- [x] Run feature tests and report changed files; root commits after integration.

### Task 3: solutions backend and frontend (solution implementer)
**Files:** services/questionSolutions.ts, routes/questionSolutions.ts, tests/questionSolutions.integration.test.ts; apps/web/src/lib/questionSolutions.ts, pages/QuestionSolutions.tsx and tests; SolveQuestion.tsx top action.
**Interfaces:** GET /api/questions/:id/solutions {canPublishStandard,standard,user,top}; POST /questions/:id/solutions {kind,title,explanation,code,sourceSubmissionId?,referenceKind?}; PUT /solutions/:id {title,explanation,code,published}; DELETE /solutions/:id withdraws; GET /questions/:id/solution-candidates lists own eligible submissions only. Each item code/author display/source/score/time whitelist, no private fields. Top maximum 2 exact highest, latest source submit first, deduplicated by source submission (the same author may have two distinct tied submissions).
- [x] Write tests demonstrating no code appears before opt-in, ownership checks and withdrawn hiding.
- [x] Add version-bound standalone publishing, plain text upload read locally <=256 KiB, Markdown rendering using existing component without raw HTML.
- [x] Implement distinct basic/arena ranking selection with tie tests, test-account exclusion, dynamic scores and prior versions. Reuse current scoring rules; no ledger updates.
- [x] UI three tabs and current-source notices; do not claim manually uploaded standard equals current actual opponent. Missing reliable standard is explicit.
- [x] Validate same-role/opponent/qualification distinctions and report reference import feasibility; no private package reads without allowed current source manifest.
- [x] Run tests; root commits after integration.

### Task 4: email backend and frontend (email implementer)
**Files:** services/authEmail.ts, services/emailSender.ts, routes/authEmail.ts, tests/authEmail.integration.test.ts; lib/auth.ts and routes/auth.ts for transactional verified registration and config only; frontend Register/Login/AccountSecurity, new EmailVerification/PasswordRecovery pages and lib/authEmail.ts. Root wires App and config deps.
**Interfaces:** GET /auth/config adds emailEnabled; POST /auth/email/request {purpose:registration|bind|reset,email,currentPassword?}; POST /auth/register accepts emailToken alongside existing fields when enabled; POST /auth/email/bind {token,currentPassword}; POST /auth/password-recovery {token,newPassword}; GET /auth/email returns own bound email and feature state. Request success generic {accepted:true}; no token returned outside injectable local test sender. Verification links /email-verification#token=...&purpose=...; anonymous frontend requests must omit Bearer.
- [x] Tests first with local capturing sender: enabled registration, bind, reset, replay/races, wrong purpose, expiry, session version change, disabled/deleted/admin restrictions, sending errors/throttle.
- [x] Use new email tables and existing password/security transaction helpers; sender outside retried transaction. Enforce SMTP TLS and timeout, safe recipient/sender, fixed URL, no raw errors or tokens logged.
- [x] EMAIL OFF preserves old registration/login; EMAIL ON rejects missing verification without creating user; old accounts stay usable.
- [x] UI registration verification, self binding and recovery; refresh/return flows do not persist passwords or tokens in localStorage or send them to unrelated endpoints.
- [x] Environment-only config example with placeholders and SMTP enablement checklist; run mock integration tests, no real messages.

### Task 5: integration, independent review and release (root)
- [x] Cross-feature auth/router/UI integration and independent privacy/permission review.
- [x] Backend full regression, frontend tests/typecheck/build; meaningful skipped test limits documented.
- [x] Commit exact candidate, tag and stage isolated clone; backup and compare existing rows, roles, scores, active queues. No production mail or model generation.
- [x] Publish classroom/opt-in-solution functionality only after acceptance; email disabled without SMTP. Preserve current sessions, old assets and score definitions.
- [x] Record actual verification and external mail activation prerequisites; prepare only sanitized source/tests/docs for synchronization to the existing GitHub repository. Verify the remote branch after pushing; no private history or runtime data is included.

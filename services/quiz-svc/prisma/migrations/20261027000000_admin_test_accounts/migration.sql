-- Additive defaults retain every existing account and its current session.
-- No submission, score, arena pool, or other historical table is modified.
BEGIN;
SET LOCAL lock_timeout = '1000ms';
SET LOCAL statement_timeout = '5000ms';
ALTER TABLE "User"
ADD COLUMN "isTestAccount" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "accountStatus" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
COMMIT;

-- Fields previously deployed with schema push are made reproducible for clean installs.
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "autoBranch" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "branchPrefix" TEXT;
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "uploadMinScoreAttack" INTEGER;
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "uploadMinScoreDefense" INTEGER;
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "judgeMode" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "judgeVersion" TEXT;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "definition" TEXT NOT NULL DEFAULT '{}',
ADD COLUMN     "evaluationVersion" TEXT NOT NULL DEFAULT 'v1',
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "role" TEXT,
ADD COLUMN     "scenarioId" TEXT;

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'basic',
ADD COLUMN     "configSnapshot" TEXT NOT NULL DEFAULT '{}',
ADD COLUMN     "evaluationVersion" TEXT NOT NULL DEFAULT 'v1',
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "materialHash" TEXT,
ADD COLUMN     "questionVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "role" TEXT,
ADD COLUMN     "scenarioId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "studentId" TEXT;

-- CreateTable
CREATE TABLE "QuestionRevision" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BasicScore" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "questionVersion" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "submissionId" TEXT NOT NULL,
    "scoreReachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BasicScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BasicTotal" (
    "userId" TEXT NOT NULL,
    "totalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tasksCompleted" INTEGER NOT NULL DEFAULT 0,
    "scoreReachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BasicTotal_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "EvaluationTask" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "cleanupStatus" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiPool" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "credentialEnv" TEXT,
    "parameters" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiPoolRevision" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiPoolRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherLease" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "questionVersion" INTEGER NOT NULL,
    "poolSnapshot" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'creating',
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "nonce" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "maxCalls" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArenaPool" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "evaluationVersion" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArenaPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArenaAlgorithm" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "evaluationVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "baselineResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArenaAlgorithm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArenaSlot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "evaluationVersion" TEXT NOT NULL,
    "algorithmId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArenaSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArenaEvaluation" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "algorithmId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "evaluationVersion" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "snapshotRevision" INTEGER,
    "opponentsSnapshot" TEXT,
    "result" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArenaEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArenaScore" (
    "id" TEXT NOT NULL,
    "algorithmId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "evaluationVersion" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "successCount" INTEGER NOT NULL,
    "opponentCount" INTEGER NOT NULL,
    "snapshotRevision" INTEGER NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "achievedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArenaScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuestionRevision_questionId_revision_key" ON "QuestionRevision"("questionId", "revision");

-- CreateIndex
CREATE INDEX "BasicScore_questionId_idx" ON "BasicScore"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "BasicScore_userId_questionId_key" ON "BasicScore"("userId", "questionId");

-- CreateIndex
CREATE INDEX "BasicTotal_totalScore_scoreReachedAt_idx" ON "BasicTotal"("totalScore", "scoreReachedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationTask_submissionId_key" ON "EvaluationTask"("submissionId");

-- CreateIndex
CREATE INDEX "EvaluationTask_state_createdAt_idx" ON "EvaluationTask"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiPoolRevision_poolId_revision_key" ON "ApiPoolRevision"("poolId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherLease_userId_questionId_key" ON "TeacherLease"("userId", "questionId");

-- CreateIndex
CREATE INDEX "AuditEvent_targetId_createdAt_idx" ON "AuditEvent"("targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ArenaPool_scenarioId_evaluationVersion_key" ON "ArenaPool"("scenarioId", "evaluationVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ArenaAlgorithm_submissionId_key" ON "ArenaAlgorithm"("submissionId");

-- CreateIndex
CREATE INDEX "ArenaAlgorithm_scenarioId_evaluationVersion_role_status_idx" ON "ArenaAlgorithm"("scenarioId", "evaluationVersion", "role", "status");

-- CreateIndex
CREATE INDEX "ArenaSlot_scenarioId_evaluationVersion_role_idx" ON "ArenaSlot"("scenarioId", "evaluationVersion", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ArenaSlot_userId_scenarioId_role_evaluationVersion_key" ON "ArenaSlot"("userId", "scenarioId", "role", "evaluationVersion");

-- CreateIndex
CREATE INDEX "ArenaEvaluation_status_createdAt_idx" ON "ArenaEvaluation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ArenaEvaluation_algorithmId_kind_status_idx" ON "ArenaEvaluation"("algorithmId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ArenaScore_algorithmId_key" ON "ArenaScore"("algorithmId");

-- CreateIndex
CREATE INDEX "ArenaScore_questionId_score_achievedAt_idx" ON "ArenaScore"("questionId", "score", "achievedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_userId_idempotencyKey_key" ON "Submission"("userId", "idempotencyKey");

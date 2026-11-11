BEGIN;
SET LOCAL lock_timeout = '1500ms';
SET LOCAL statement_timeout = '20s';

CREATE TABLE "ModelUsageRecord" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "questionId" TEXT,
    "submissionId" TEXT,
    "poolId" TEXT,
    "model" TEXT,
    "source" TEXT NOT NULL CHECK ("source" IN ('evaluation', 'selftest', 'teacher', 'admin_test', 'legacy', 'health')),
    "kind" TEXT NOT NULL CHECK ("kind" IN ('llm', 'teacher', 'health')),
    "outcome" TEXT NOT NULL DEFAULT 'pending' CHECK ("outcome" IN ('pending', 'success', 'http_error', 'timeout', 'transport', 'invalid_json', 'snapshot')),
    "isSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER CHECK ("inputTokens" >= 0),
    "outputTokens" INTEGER CHECK ("outputTokens" >= 0),
    "totalTokens" INTEGER CHECK ("totalTokens" >= 0),
    "elapsedMs" INTEGER CHECK ("elapsedMs" >= 0),
    "httpStatus" INTEGER CHECK ("httpStatus" BETWEEN 100 AND 599),
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "ModelUsageRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelUsagePolicy" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "mode" TEXT NOT NULL DEFAULT 'observe' CHECK ("mode" = 'observe'),
    "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
    "globalDaily" INTEGER NOT NULL DEFAULT 10000 CHECK ("globalDaily" BETWEEN 1 AND 1000000000),
    "userDaily" INTEGER NOT NULL DEFAULT 4000 CHECK ("userDaily" BETWEEN 1 AND 1000000000),
    "globalTotal" INTEGER NOT NULL DEFAULT 100000 CHECK ("globalTotal" BETWEEN 1 AND 1000000000),
    "userTotal" INTEGER NOT NULL DEFAULT 20000 CHECK ("userTotal" BETWEEN 1 AND 1000000000),
    "warnPercent" INTEGER NOT NULL DEFAULT 80 CHECK ("warnPercent" BETWEEN 1 AND 99),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ModelUsagePolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelUsageAlert" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "type" TEXT NOT NULL CHECK ("type" IN ('threshold', 'upstream')),
    "severity" TEXT NOT NULL CHECK ("severity" IN ('warning', 'critical')),
    "code" TEXT NOT NULL,
    "scope" TEXT NOT NULL CHECK ("scope" IN ('global', 'user', 'pool', 'source')),
    "scopeId" TEXT,
    "period" TEXT NOT NULL CHECK ("period" IN ('daily', 'total', 'rolling')),
    "value" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "acknowledgementHistory" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "ModelUsageAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModelUsageRecord_createdAt_idx" ON "ModelUsageRecord"("createdAt");
CREATE INDEX "ModelUsageRecord_kind_isSnapshot_createdAt_idx" ON "ModelUsageRecord"("kind", "isSnapshot", "createdAt");
CREATE INDEX "ModelUsageRecord_actorId_kind_isSnapshot_createdAt_idx" ON "ModelUsageRecord"("actorId", "kind", "isSnapshot", "createdAt");
CREATE INDEX "ModelUsageRecord_poolId_finishedAt_idx" ON "ModelUsageRecord"("poolId", "finishedAt");
CREATE INDEX "ModelUsageRecord_source_finishedAt_idx" ON "ModelUsageRecord"("source", "finishedAt");
CREATE UNIQUE INDEX "ModelUsageAlert_dedupeKey_key" ON "ModelUsageAlert"("dedupeKey");
CREATE INDEX "ModelUsageAlert_acknowledgedAt_lastSeenAt_idx" ON "ModelUsageAlert"("acknowledgedAt", "lastSeenAt");
COMMIT;

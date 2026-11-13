BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "TeacherGrant" (
    "userId" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeacherGrant_pkey" PRIMARY KEY ("userId")
);
CREATE TABLE "Classroom" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "ownerId" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Classroom_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Classroom_inviteCode_key" ON "Classroom"("inviteCode");
CREATE INDEX "Classroom_ownerId_idx" ON "Classroom"("ownerId");
CREATE TABLE "ClassMembership" (
    "id" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClassMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClassMembership_classroomId_userId_key" ON "ClassMembership"("classroomId", "userId");
CREATE INDEX "ClassMembership_userId_idx" ON "ClassMembership"("userId");
CREATE TABLE "ClassJoinThrottle" (
    "userId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClassJoinThrottle_pkey" PRIMARY KEY ("userId")
);
CREATE TABLE "QuestionSolution" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "questionVersion" INTEGER NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL DEFAULT '',
    "code" TEXT NOT NULL DEFAULT '',
    "sourceSubmissionId" TEXT,
    "referenceKind" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "QuestionSolution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuestionSolution_kind_check" CHECK ("kind" IN ('standard','user'))
);
CREATE INDEX "QuestionSolution_questionId_questionVersion_published_idx" ON "QuestionSolution"("questionId", "questionVersion", "published");
CREATE INDEX "QuestionSolution_sourceSubmissionId_idx" ON "QuestionSolution"("sourceSubmissionId");
CREATE INDEX "QuestionSolution_authorId_idx" ON "QuestionSolution"("authorId");
CREATE TABLE "UserEmail" (
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserEmail_pkey" PRIMARY KEY ("userId")
);
CREATE UNIQUE INDEX "UserEmail_email_key" ON "UserEmail"("email");
CREATE TABLE "EmailChallenge" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "sessionVersion" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailChallenge_purpose_check" CHECK ("purpose" IN ('registration','bind','reset'))
);
CREATE UNIQUE INDEX "EmailChallenge_tokenHash_key" ON "EmailChallenge"("tokenHash");
CREATE INDEX "EmailChallenge_email_purpose_idx" ON "EmailChallenge"("email", "purpose");
CREATE INDEX "EmailChallenge_expiresAt_idx" ON "EmailChallenge"("expiresAt");
CREATE INDEX "EmailChallenge_userId_idx" ON "EmailChallenge"("userId");
CREATE TABLE "EmailSendThrottle" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailSendThrottle_pkey" PRIMARY KEY ("key")
);
COMMIT;

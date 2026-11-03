SET lock_timeout = '1500ms';
SET statement_timeout = '20s';

CREATE TABLE "UserSecurity" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "lastLoginAt" TIMESTAMP(3),
  "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  "temporaryPasswordExpiresAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "AuthRevocation" (
  "tokenHash" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AuthRevocation_expiresAt_idx" ON "AuthRevocation"("expiresAt");
CREATE INDEX "AuthRevocation_userId_idx" ON "AuthRevocation"("userId");
CREATE TABLE "AuthLoginThrottle" (
  "accountKey" TEXT NOT NULL PRIMARY KEY,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "blockedUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "AuthLoginThrottle_updatedAt_idx" ON "AuthLoginThrottle"("updatedAt");

RESET lock_timeout;
RESET statement_timeout;

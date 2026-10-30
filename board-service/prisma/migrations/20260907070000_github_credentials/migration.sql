CREATE TABLE "GithubCredential" (
  "ownerEmail" TEXT PRIMARY KEY,
  "boardSub" TEXT NOT NULL,
  "githubUserId" TEXT NOT NULL UNIQUE,
  "githubLogin" TEXT NOT NULL,
  "accessCipher" TEXT NOT NULL,
  "refreshCipher" TEXT NOT NULL,
  "accessExpiresAt" TIMESTAMP(3) NOT NULL,
  "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
  "scopes" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "refreshLeaseUntil" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

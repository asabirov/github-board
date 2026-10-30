-- CreateTable
CREATE TABLE "McpGrant" (
    "id" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scopes" TEXT[],
    "currentRefreshHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAccessToken" (
    "jti" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpAccessToken_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "McpRefreshToken" (
    "tokenHash" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "replacedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpRefreshToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE INDEX "McpGrant_sub_idx" ON "McpGrant"("sub");

-- CreateIndex
CREATE INDEX "McpAccessToken_grantId_idx" ON "McpAccessToken"("grantId");

-- CreateIndex
CREATE INDEX "McpAccessToken_expiresAt_idx" ON "McpAccessToken"("expiresAt");

-- CreateIndex
CREATE INDEX "McpRefreshToken_grantId_idx" ON "McpRefreshToken"("grantId");

-- CreateIndex
CREATE INDEX "McpRefreshToken_expiresAt_idx" ON "McpRefreshToken"("expiresAt");

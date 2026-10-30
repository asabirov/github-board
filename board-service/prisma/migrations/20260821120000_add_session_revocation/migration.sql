-- CreateTable
CREATE TABLE "RevokedSession" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevokedSession_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "SessionEpoch" (
    "sub" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionEpoch_pkey" PRIMARY KEY ("sub")
);

-- CreateIndex
CREATE INDEX "RevokedSession_expiresAt_idx" ON "RevokedSession"("expiresAt");

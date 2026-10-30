-- CreateTable
CREATE TABLE "PersonalToken" (
    "id" TEXT NOT NULL,
    "ownerEmail" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" TEXT[],
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PersonalToken_tokenHash_key" ON "PersonalToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PersonalToken_ownerEmail_idx" ON "PersonalToken"("ownerEmail");

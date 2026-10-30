-- The Github webhook store (#1007, V5). Applied to both databases, like every
-- migration here, and written only in the one GITHUB_STORE_DATABASE_URL names:
-- the entrypoint runs `migrate deploy` against that URL as well when it is set.
-- Each table is described on its model in schema.prisma.

-- CreateTable
CREATE TABLE "GithubWebhookDelivery" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "installationId" BIGINT,
    "repositoryId" BIGINT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubStoredIssue" (
    "repositoryId" BIGINT NOT NULL,
    "number" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "issue" JSONB,
    "writtenAt" TIMESTAMP(3) NOT NULL,
    "missedAt" TIMESTAMP(3),

    CONSTRAINT "GithubStoredIssue_pkey" PRIMARY KEY ("repositoryId","number")
);

-- CreateTable
CREATE TABLE "GithubStoredRepo" (
    "repositoryId" BIGINT NOT NULL,
    "fullName" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "baselineStartedAt" TIMESTAMP(3) NOT NULL,
    "dirtyAt" TIMESTAMP(3),
    "forgottenAt" TIMESTAMP(3),

    CONSTRAINT "GithubStoredRepo_pkey" PRIMARY KEY ("repositoryId")
);

-- CreateTable
CREATE TABLE "GithubWebhookOwner" (
    "owner" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "issuesLiveSince" TIMESTAMP(3) NOT NULL,
    "lastDeliveryAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubWebhookOwner_pkey" PRIMARY KEY ("owner")
);

-- CreateIndex
CREATE INDEX "GithubWebhookDelivery_receivedAt_idx" ON "GithubWebhookDelivery"("receivedAt");

-- CreateIndex
CREATE INDEX "GithubStoredIssue_owner_idx" ON "GithubStoredIssue"("owner");

-- CreateIndex
-- An uninstall deletes a whole owner's rows from both tables. This is the twin
-- of the index above, and it was missing (#1070, S7).
CREATE INDEX "GithubStoredRepo_owner_idx" ON "GithubStoredRepo"("owner");

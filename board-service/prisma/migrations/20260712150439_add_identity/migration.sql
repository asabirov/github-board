-- CreateTable
CREATE TABLE "Identity" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "emails" TEXT[],
    "githubLogin" TEXT,
    "clickupUserId" TEXT,
    "clickupNames" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateEnum
CREATE TYPE "KrState" AS ENUM ('candidate', 'proposed', 'active', 'delivered', 'retired');

-- CreateEnum
CREATE TYPE "HypothesisResult" AS ENUM ('ready_discovery', 'cycle_attached', 'confirmed', 'refuted', 'inconclusive');

-- CreateEnum
CREATE TYPE "CycleStatus" AS ENUM ('upcoming', 'active', 'buffer', 'cooldown', 'closed');

-- CreateEnum
CREATE TYPE "Track" AS ENUM ('business', 'platform');

-- CreateEnum
CREATE TYPE "ObjectiveScope" AS ENUM ('year', 'cycle');

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "githubLogin" TEXT,
    "clickupUserId" TEXT,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Year" (
    "id" TEXT NOT NULL,
    "objective" TEXT NOT NULL,

    CONSTRAINT "Year_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cycle" (
    "id" TEXT NOT NULL,
    "yearId" TEXT NOT NULL,
    "goalSentence" TEXT NOT NULL,
    "narrative" TEXT NOT NULL DEFAULT '',
    "status" "CycleStatus" NOT NULL DEFAULT 'upcoming',
    "workStart" TIMESTAMP(3) NOT NULL,
    "workEnd" TIMESTAMP(3) NOT NULL,
    "bufferEnd" TIMESTAMP(3),
    "cooldownEnd" TIMESTAMP(3),
    "showcaseDate" TIMESTAMP(3),

    CONSTRAINT "Cycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Objective" (
    "id" TEXT NOT NULL,
    "scope" "ObjectiveScope" NOT NULL,
    "title" TEXT NOT NULL,
    "yearId" TEXT,
    "cycleId" TEXT,

    CONSTRAINT "Objective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyResult" (
    "id" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "cycleId" TEXT,
    "driId" TEXT,
    "measure" TEXT NOT NULL DEFAULT '',
    "dataSource" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL DEFAULT '',
    "baseline" DOUBLE PRECISION,
    "current" DOUBLE PRECISION,
    "target" DOUBLE PRECISION,
    "direction" TEXT NOT NULL DEFAULT 'up',
    "qualitative" TEXT,
    "state" "KrState" NOT NULL DEFAULT 'candidate',
    "track" "Track",
    "mapsToAnnualKrId" TEXT,
    "clickupTaskId" TEXT,
    "githubIssueUrl" TEXT,

    CONSTRAINT "KeyResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hypothesis" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT,
    "belief" TEXT NOT NULL DEFAULT '',
    "signalMetric" TEXT,
    "signalThreshold" TEXT,
    "counterMetric" TEXT,
    "decisionDeadline" TIMESTAMP(3),
    "minimalTest" TEXT,
    "result" "HypothesisResult" NOT NULL DEFAULT 'ready_discovery',
    "driId" TEXT,
    "drivesKrId" TEXT,

    CONSTRAINT "Hypothesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deliverable" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "driId" TEXT,
    "weekIndex" INTEGER,
    "track" "Track",
    "state" "KrState" NOT NULL DEFAULT 'candidate',
    "servesHypothesisId" TEXT,
    "servesKrId" TEXT,
    "completionIssueUrl" TEXT,

    CONSTRAINT "Deliverable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Week" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'work',
    "expectations" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "Week_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Showcase" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "sections" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "Showcase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Week_cycleId_index_key" ON "Week"("cycleId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "Showcase_cycleId_key" ON "Showcase"("cycleId");

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_yearId_fkey" FOREIGN KEY ("yearId") REFERENCES "Year"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Objective" ADD CONSTRAINT "Objective_yearId_fkey" FOREIGN KEY ("yearId") REFERENCES "Year"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Objective" ADD CONSTRAINT "Objective_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyResult" ADD CONSTRAINT "KeyResult_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "Objective"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyResult" ADD CONSTRAINT "KeyResult_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hypothesis" ADD CONSTRAINT "Hypothesis_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hypothesis" ADD CONSTRAINT "Hypothesis_drivesKrId_fkey" FOREIGN KEY ("drivesKrId") REFERENCES "KeyResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_servesHypothesisId_fkey" FOREIGN KEY ("servesHypothesisId") REFERENCES "Hypothesis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Week" ADD CONSTRAINT "Week_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Showcase" ADD CONSTRAINT "Showcase_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

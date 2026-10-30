-- A historical name alone cannot establish which repository held these bytes.
-- Preserve every row and its original name for a reviewed identity backfill.
ALTER TABLE "FeedbackImage" ADD COLUMN "repositoryId" BIGINT;
ALTER TABLE "FeedbackImage" ADD CONSTRAINT "FeedbackImage_repositoryId_positive"
  CHECK ("repositoryId" IS NULL OR "repositoryId" > 0);

BEGIN;

-- Preserve level 1 and leave room for both 100-point increments.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PersonalGoal" WHERE "dailyGoal" > 2147483647 - 200)
    OR EXISTS (SELECT 1 FROM "OrganisationGoal" WHERE "dailyGoal" > 2147483647 - 200) THEN
    RAISE EXCEPTION 'Flame levels migration exceeds the integer maximum when adding higher thresholds. No goals were changed.';
  END IF;
END $$;

ALTER TABLE "PersonalGoal"
  ADD COLUMN "level2Goal" INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN "level3Goal" INTEGER NOT NULL DEFAULT 300;

ALTER TABLE "OrganisationGoal"
  ADD COLUMN "level2Goal" INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN "level3Goal" INTEGER NOT NULL DEFAULT 300;

UPDATE "PersonalGoal"
SET "level2Goal" = GREATEST(200, "dailyGoal" + 100),
    "level3Goal" = GREATEST(300, GREATEST(200, "dailyGoal" + 100) + 100);

UPDATE "OrganisationGoal"
SET "level2Goal" = GREATEST(200, "dailyGoal" + 100),
    "level3Goal" = GREATEST(300, GREATEST(200, "dailyGoal" + 100) + 100);

ALTER TABLE "PersonalGoal"
  ADD CONSTRAINT "PersonalGoal_levels_increasing" CHECK ("dailyGoal" > 0 AND "dailyGoal" < "level2Goal" AND "level2Goal" < "level3Goal");

ALTER TABLE "OrganisationGoal"
  ADD CONSTRAINT "OrganisationGoal_levels_increasing" CHECK ("dailyGoal" > 0 AND "dailyGoal" < "level2Goal" AND "level2Goal" < "level3Goal");

COMMIT;

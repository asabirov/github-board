CREATE TABLE "PersonalGoal" (
    "sub" TEXT NOT NULL PRIMARY KEY,
    "dailyGoal" INTEGER NOT NULL DEFAULT 100 CHECK ("dailyGoal" > 0)
);

CREATE TABLE "OrganisationGoal" (
    "orgId" BIGINT NOT NULL PRIMARY KEY,
    "dailyGoal" INTEGER NOT NULL DEFAULT 100 CHECK ("dailyGoal" > 0)
);

-- Drop the fixture-backed roadmap shadow world. Atlas now holds no relational
-- state: the OKR tree comes from ClickUp, hypotheses from GitHub, readings from
-- PostHog. Tables are dropped CASCADE (removes their FKs/indexes), then the
-- enums. IF EXISTS keeps this idempotent and safe to run against a fresh DB.

-- Tables (CASCADE also removes foreign keys, unique indexes, sequences).
DROP TABLE IF EXISTS "Showcase" CASCADE;
DROP TABLE IF EXISTS "Week" CASCADE;
DROP TABLE IF EXISTS "Deliverable" CASCADE;
DROP TABLE IF EXISTS "Hypothesis" CASCADE;
DROP TABLE IF EXISTS "KeyResult" CASCADE;
DROP TABLE IF EXISTS "Objective" CASCADE;
DROP TABLE IF EXISTS "Cycle" CASCADE;
DROP TABLE IF EXISTS "Year" CASCADE;
DROP TABLE IF EXISTS "Person" CASCADE;

-- Enums.
DROP TYPE IF EXISTS "ObjectiveScope";
DROP TYPE IF EXISTS "Track";
DROP TYPE IF EXISTS "CycleStatus";
DROP TYPE IF EXISTS "HypothesisResult";
DROP TYPE IF EXISTS "KrState";

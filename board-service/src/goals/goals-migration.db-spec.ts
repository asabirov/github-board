import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createPrismaClient } from '../prisma';

const legacy = readFileSync('prisma/migrations/20260924095000_daily_goals/migration.sql', 'utf8');
const migration = readFileSync('prisma/migrations/20260927130000_flame_levels/migration.sql', 'utf8');
const tables = ['PersonalGoal', 'OrganisationGoal'] as const;

async function withLegacyGoals(goals: [number, number], check: (db: ReturnType<typeof createPrismaClient>, migrate: () => void) => Promise<void>) {
  const schema = `goal_migration_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = createPrismaClient();
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  const db = createPrismaClient(url.toString());
  const execute = (sql: string) => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'execute', '--stdin'], {
      input: sql, env: { ...process.env, DATABASE_URL: url.toString() }, stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    execute(legacy);
    await db.$executeRawUnsafe('INSERT INTO "PersonalGoal" (sub, "dailyGoal") VALUES ($1, $2)', 'person', goals[0]);
    await db.$executeRawUnsafe('INSERT INTO "OrganisationGoal" ("orgId", "dailyGoal") VALUES (1, $1)', goals[1]);
    await check(db, () => execute(migration));
  } finally {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  }
}

it.each([
  [100, 200, 300],
  [150, 250, 350],
  [250, 350, 450],
  [2147483447, 2147483547, 2147483647],
])('migrates goal %i with higher thresholds %i and %i in both tables', async (dailyGoal, level2Goal, level3Goal) => {
  await withLegacyGoals([dailyGoal, dailyGoal], async (db, migrate) => {
    migrate();
    for (const table of tables) {
      expect(await db.$queryRawUnsafe(`SELECT "dailyGoal", "level2Goal", "level3Goal" FROM "${table}"`))
        .toEqual([{ dailyGoal, level2Goal, level3Goal }]);
    }
  });
});

it.each([
  [2147483448, 100],
  [100, 2147483448],
  [2147483647, 100],
  [100, 2147483647],
])('rejects overflowing personal/team goals %i/%i without changing either table', async (personal, team) => {
  await withLegacyGoals([personal, team], async (db, migrate) => {
    expect(migrate).toThrow(/Flame levels migration.*integer maximum/);
    for (const [index, table] of tables.entries()) {
      expect(await db.$queryRawUnsafe(`SELECT "dailyGoal" FROM "${table}"`))
        .toEqual([{ dailyGoal: [personal, team][index] }]);
      expect(await db.$queryRawUnsafe(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position', table,
      )).toEqual([{ column_name: index === 0 ? 'sub' : 'orgId' }, { column_name: 'dailyGoal' }]);
    }
  });
});

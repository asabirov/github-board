import { createPrismaClient } from './src/prisma';
import { execFileSync } from 'node:child_process';

/**
 * Brings the database up to the current schema before the db-specs run (#456),
 * inside the private schema `vitest.db.config.ts` minted for this run (#789).
 *
 * This is `prisma migrate deploy` rather than a step in the `test:db` script so
 * that the DATABASE_URL guard in `vitest.db.config.ts` is what a developer
 * without a database hears — a Prisma connection error two layers down says the
 * same thing far less usefully.
 *
 * It also means the lane proves the migration applies cleanly, every run, and
 * since #789 that is a real claim rather than a courtesy: the schema is empty
 * when this starts, so every migration is applied from nothing here instead of
 * answering "No pending migrations to apply" on a laptop that migrated once in
 * July.
 */

/**
 * The shape `vitest.db.config.ts` mints, matched whole. The teardown below
 * interpolates the name into DDL, and a schema this run did not create is one it
 * must never drop — `public`, above all, which on a developer's machine is their
 * own database.
 */
const RUN_SCHEMA = /^dbspec_\d+_[0-9a-f]{8}$/;

function runSchema(): string {
  const schema = process.env.BOARD_DB_TEST_SCHEMA ?? '';
  if (!RUN_SCHEMA.test(schema)) {
    // Reachable only if the per-run schema is removed from the config, or stops
    // reaching this process. Refusing here is the point: without it the lane
    // silently falls back to whatever schema DATABASE_URL names — `public` — and
    // two concurrent runs delete each other's rows again, with nothing to see.
    throw new Error(
      `test:db must run in its own schema, and BOARD_DB_TEST_SCHEMA is ${schema ? `"${schema}"` : 'unset'}. ` +
        'vitest.db.config.ts mints it; if that is gone, concurrent runs corrupt each other (#789).',
    );
  }
  return schema;
}

export default function setup(): () => Promise<void> {
  const schema = runSchema();
  const storeSchema = `${schema}_store`;
  console.log(`test:db is using schemas "${schema}" and "${storeSchema}" (BOARD_DB_KEEP_SCHEMA=1 to keep them)`);
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
  // The webhook store's own schema, migrated the same way and from the same
  // migrations, which is what `docker-entrypoint.sh` does with the two URLs in
  // production (#1007, V5). The boot refuses a store that points where
  // DATABASE_URL points, so the lane has to run the real shape to run at all.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.BOARD_DB_TEST_STORE_URL },
  });

  return async () => {
    // Kept on request, so a red run can be opened and read. Otherwise every run
    // would leave a schema behind and a laptop would collect one per lane per
    // day — the tidy-up is the other half of being allowed to make one.
    if (process.env.BOARD_DB_KEEP_SCHEMA === '1') return;
    const prisma = createPrismaClient();
    try {
      for (const name of [schema, storeSchema]) {
        await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      }
    } finally {
      await prisma.$disconnect();
    }
  };
}

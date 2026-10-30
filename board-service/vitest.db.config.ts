import { randomBytes } from 'node:crypto';
import { defineConfig } from 'vitest/config';

/**
 * The real-Postgres lane (#456). `pnpm test` runs `src/**\/*.spec.ts` against no
 * database at all and cannot tell whether Prisma's SQL is right, whether a
 * migration applies, or whether a compare-and-swap really picks one winner — the
 * in-memory seam answers that last one correctly only because JavaScript is
 * single-threaded. This config runs `src/**\/*.db-spec.ts`, which the default
 * include pattern deliberately does not match, so a developer with no database
 * sees exactly today's green.
 *
 * It THROWS on a missing DATABASE_URL rather than skipping. A lane that excuses
 * itself reports zero tests and reads green while testing nothing, which is how
 * this repository has shipped a vacuous guard before.
 */
if (!process.env.DATABASE_URL) {
  throw new Error('test:db needs DATABASE_URL — run: docker compose up -d postgres');
}

/**
 * Every run gets its own Postgres schema, and this is where the name is minted
 * (#789).
 *
 * The lane's specs write rows tagged with their own pid, and until this landed
 * that was assumed to be enough to keep two runs apart. It is not, because two
 * of the things under test delete BY PREDICATE across the whole table rather
 * than by tag: `revoke()` prunes every row past its expiry, and `bumpEpoch()`
 * every epoch older than a session lifetime. So a second run's `revoke` deletes
 * the deliberately expired row `session-revocation.db-spec.ts` writes to prove
 * the read compares expiry itself, and that run goes red on a bug it does not
 * have. Measured on this laptop, six concurrent runs at a time: 3 of 30 runs
 * failed that way. That is not a rare shape — one checkout per lane and one
 * local Postgres between them is the ordinary way this repository is worked, and
 * a red run nobody caused is how a lane learns to distrust the lane.
 *
 * `fileParallelism: false` below is the same problem one level in, between files
 * of ONE run, and it stays: a per-run schema is shared by every file inside that
 * run, so it does nothing about the two files' rows meeting.
 *
 * The name is minted here rather than in `vitest.db.setup.ts` because both the
 * main process and the workers need it: `prisma migrate deploy` runs in the
 * setup, and the specs connect from workers. Both get it through `process.env`,
 * which this file mutates before vitest starts either — measured, by deleting
 * the `test.env` copy that was here first and watching the workers still land in
 * the private schema. That inheritance is vitest's to change, so it is checked
 * from the worker side rather than assumed:
 * `src/auth/session-revocation.isolation.db-spec.ts` asks Postgres, from where
 * the specs connect, which schema it is in.
 *
 * The `??` makes a second evaluation of this file reuse the first name instead
 * of stranding the migration in a schema nothing reads.
 * `BOARD_DB_TEST_SCHEMA` names it for the teardown, which refuses to drop
 * anything that is not one of ours.
 */
const schema =
  process.env.BOARD_DB_TEST_SCHEMA ?? `dbspec_${process.pid}_${randomBytes(4).toString('hex')}`;
const isolatedUrl = (() => {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
})();

/**
 * A second schema of its own for the Github webhook store (#1007, V5; #1070,
 * S4). The boot refuses a store URL that points where DATABASE_URL points, so
 * `webhook.integration.db-spec.ts` cannot share one — and should not: production
 * runs two databases, each carrying the whole schema and writing only its own
 * tables, and until this the lane exercised that shape nowhere. Both schemas are
 * migrated in the setup and dropped in the teardown.
 */
const storeSchema = `${schema}_store`;
const storeUrl = (() => {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', storeSchema);
  return url.toString();
})();

process.env.BOARD_DB_TEST_SCHEMA = schema;
process.env.BOARD_DB_TEST_STORE_SCHEMA = storeSchema;
process.env.BOARD_DB_TEST_STORE_URL = storeUrl;
process.env.DATABASE_URL = isolatedUrl;

export default defineConfig({
  test: {
    globals: true,
    clearMocks: true,
    environment: 'node',
    include: ['src/**/*.db-spec.ts'],
    testTimeout: 30000,
    // Applies the migrations before anything runs, so the guard above is the
    // first thing a developer without a database hears from.
    globalSetup: ['./vitest.db.setup.ts'],
    // Two files of ONE run share that run's schema, and `pruneExpired` deletes by
    // expiry across the whole table rather than by a per-file prefix — so two
    // files in parallel would still delete each other's rows mid-test. The
    // per-run schema above separates runs; this separates files.
    fileParallelism: false,
  },
});

import { createPrismaClient } from '../prisma';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The lane runs in a schema of its own, asked from inside a worker (#789).
 *
 * It lives beside `session-revocation.db-spec.ts` because that file is the one
 * this broke. Its rows are the ones another run's `revoke()` deleted: the prune
 * is `deleteMany({ where: { expiresAt: { lte: now } } })`, which is table-wide
 * and cannot see a tag, so the deliberately expired row written to prove that
 * `isRevoked` compares expiry itself was swept by a second run and that run went
 * red on a bug it did not have. Six concurrent runs at a time on this laptop,
 * five rounds: 3 of 30 failed exactly there.
 *
 * `vitest.db.setup.ts` refuses to run the lane at all when the schema is missing
 * or is not one of ours, which covers the main process. It cannot cover THIS
 * side. The workers are a separate process and get the isolated DATABASE_URL
 * through `test.env`, so a vitest that stopped honouring that option, or a
 * config that set only `process.env`, would leave the setup happy, the migration
 * landing in the private schema, and every spec in this lane quietly reading
 * `public` again. Only a query issued from where the specs connect can tell.
 */
describe('the db lane owns its schema (#789)', () => {
  const prisma = createPrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('connects the specs to this run private schema, not to public', async () => {
    const [{ schema }] =
      await prisma.$queryRaw<{ schema: string }[]>`SELECT current_schema() AS "schema"`;
    expect(schema).not.toBe('public');
    expect(schema).toMatch(/^dbspec_\d+_[0-9a-f]{8}$/);
    expect(schema).toBe(process.env.BOARD_DB_TEST_SCHEMA);
  });

  it('finds the migrated tables in that schema, so nothing is reaching past it', async () => {
    // `current_schema()` alone would still be satisfied by a search_path whose
    // next entry is `public` and whose tables all live there. `to_regclass`
    // resolves the name the way the specs' own writes resolve it, so this asks
    // Postgres where the table a spec is about to write actually is.
    const [{ schema }] = await prisma.$queryRaw<{ schema: string }[]>`
      SELECT "n"."nspname" AS "schema"
      FROM "pg_class" "c"
      JOIN "pg_namespace" "n" ON "n"."oid" = "c"."relnamespace"
      WHERE "c"."oid" = to_regclass('"RevokedSession"')
    `;
    expect(schema).toBe(process.env.BOARD_DB_TEST_SCHEMA);
  });
});

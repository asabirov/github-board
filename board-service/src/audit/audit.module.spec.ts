import { describe, expect, it, afterAll } from 'vitest';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuditModule } from './audit.module';
import { AUDIT_REPOSITORY, DisabledAuditRepository, PrismaAuditRepository } from './audit.types';

/**
 * The key the #774 coupling is pinned to (#212, #456, #774).
 *
 * `config.schema.ts` refuses to boot `GITHUB_WRITE_ENABLED=true` on anything but
 * `IDENTITY_SOURCE=db`, and the whole reason is one ternary in
 * `audit.module.ts`: on `db` the trail is `PrismaAuditRepository`, on anything
 * else it is `DisabledAuditRepository`, whose `record` is a `logger.debug` that
 * drops `targetType`, `targetId` and `summary`. Rename that key, or change what
 * it is compared against, and every schema test still passes while the guarantee
 * they enforce is gone — so the pairing is asserted here, through the container,
 * against the concrete classes.
 *
 * The config is a stub in a @Global module rather than `ConfigModule.forRoot`:
 * the factory resolves `ConfigService` from AuditModule's own injector, and this
 * is the one shape that reaches it without depending on how @nestjs/config
 * orders `process.env` against a `load()` factory.
 */
function moduleWith(identitySource: string) {
  @Global()
  @Module({
    providers: [{ provide: ConfigService, useValue: { get: (key: string) => (key === 'IDENTITY_SOURCE' ? identitySource : undefined) } }],
    exports: [ConfigService],
  })
  class StubConfigModule {}

  return Test.createTestingModule({ imports: [StubConfigModule, AuditModule] }).compile();
}

// PrismaClient reads DATABASE_URL at CONSTRUCTION and throws without one — the
// same fact `config.schema.ts` makes the key required under `db`. Nothing here
// connects; the client is built and dropped.
const DATABASE_URL_BEFORE = process.env.DATABASE_URL;
process.env.DATABASE_URL = 'postgresql://board:board@localhost:5432/board';

describe('AuditModule wires the trail off IDENTITY_SOURCE (#774)', () => {
  afterAll(() => {
    if (DATABASE_URL_BEFORE === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = DATABASE_URL_BEFORE;
  });

  it("records into Postgres on 'db' — the value GITHUB_WRITE_ENABLED=true forces", async () => {
    const moduleRef = await moduleWith('db');
    expect(moduleRef.get(AUDIT_REPOSITORY)).toBeInstanceOf(PrismaAuditRepository);
    await moduleRef.close();
  });

  // Every value #774 refuses a writes-on board on, including the default nobody
  // sets. Each one records nothing, which is why the schema refuses the pair.
  for (const source of ['fixture', undefined, 'DB', 'postgres']) {
    it(`records nothing on ${JSON.stringify(source)}`, async () => {
      const moduleRef = await moduleWith(source as string);
      expect(moduleRef.get(AUDIT_REPOSITORY)).toBeInstanceOf(DisabledAuditRepository);
      await moduleRef.close();
    });
  }
});

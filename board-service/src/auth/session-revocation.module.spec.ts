import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SessionRevocationModule } from './session-revocation.module';
import { SessionRevocationService } from './session-revocation.service';
import {
  MemorySessionRevocationStore,
  PrismaSessionRevocationStore,
  SESSION_REVOCATION_STORE,
} from './session-revocation.repository';

/**
 * The factory the whole feature rests on, asserted through Nest rather than by
 * reading it (#679).
 *
 * Every other spec for this area hands the service a store it built by hand, so
 * all of them would stay green against a module that bound the wrong one — and
 * the difference between the two bindings is whether sign-out survives a deploy.
 * What is tested here is the real graph: the real `ConfigService`, the real
 * `useFactory`, the instance the service actually receives.
 */

// The `db` branch constructs a PrismaClient, which reads its datasource URL at
// construction. No connection is opened until a query is issued, so a syntactically
// valid URL is enough and this file talks to no database. `test:db` is where SQL
// is exercised.
process.env.DATABASE_URL ??= 'postgresql://board:board@127.0.0.1:5432/board';

async function graphFor(identitySource: string | undefined) {
  const mod = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => (identitySource === undefined ? {} : { IDENTITY_SOURCE: identitySource })],
      }),
      SessionRevocationModule,
    ],
  }).compile();
  await mod.init();
  return {
    store: mod.get(SESSION_REVOCATION_STORE),
    service: mod.get(SessionRevocationService),
    close: () => mod.close(),
  };
}

describe('SessionRevocationModule — which store it binds (#679)', () => {
  it('binds Postgres at IDENTITY_SOURCE=db, and the service reports itself durable', async () => {
    const { store, service, close } = await graphFor('db');
    try {
      expect(store).toBeInstanceOf(PrismaSessionRevocationStore);
      // Read off the service, not the store: `durable` is what the logout handler
      // branches on, and it reaches it through this instance.
      expect(service.durable).toBe(true);
    } finally {
      await close();
    }
  });

  it('binds the memory store for every other value, and the service says so', async () => {
    // Both arms, because one alone cannot tell a working branch from a constant.
    for (const source of ['github', undefined]) {
      const { store, service, close } = await graphFor(source);
      try {
        expect(store).toBeInstanceOf(MemorySessionRevocationStore);
        expect(service.durable).toBe(false);
      } finally {
        await close();
      }
    }
  });

  /**
   * The alarm fires because Nest built the store, not because a test called a
   * hook. It used to live in `onModuleInit`, which reaches only instances Nest is
   * wiring — so the same class reached silently through
   * `SessionRevocationService`'s default argument, and a store that was not there
   * read as a store that was.
   */
  it('announces IN-MEMORY ONLY while Nest brings the module up', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    try {
      const { close } = await graphFor('github');
      await close();
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((m) => m.includes('IN-MEMORY ONLY'))).toHaveLength(1);
  });

  it('says nothing at error level when the durable store is the one bound', async () => {
    // The other side of the pair: without it the assertion above passes against a
    // store that shouts on every boot, durable or not.
    const errors: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    try {
      const { close } = await graphFor('db');
      await close();
    } finally {
      spy.mockRestore();
    }
    expect(errors).toEqual([]);
  });
});

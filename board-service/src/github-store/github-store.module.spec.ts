import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  GithubStoreModule,
  describeDatabase,
  issueStoreFrom,
  STORE_CONNECTIONS,
  STORE_QUERY_TIMEOUT_S,
  storeConnectionUrl,
  type DatabaseIdentity,
} from './github-store.module';
import { ISSUE_STORE, IssueStoreSignal, PrismaIssueStore } from './issue-store';

/**
 * Which store the boot builds (#1007, V5), and what it says about where it is.
 * No database is reached: a Prisma client connects on first use, and nothing
 * here uses it.
 */

const cfg = (vars: Record<string, unknown>): ConfigService =>
  ({ get: (k: string) => vars[k] }) as unknown as ConfigService;
const spyLogger = () => {
  const log = vi.fn();
  const warn = vi.fn();
  return { logger: { log, warn } as unknown as Logger, log, warn };
};

const SECRET = 'a-webhook-secret-twenty-plus';
const STORE = 'postgresql://board:hunter2-password@board-store-pg:5432/board_store';

/** What two connections say about themselves. The real one asks Postgres, and
 *  `store-database-identity.db-spec.ts` drives that against a real one; here
 *  the answers are given, so the arithmetic above them can be settled without a
 *  database. */
const says = (answers: Record<string, DatabaseIdentity>) => async (url: string) => {
  const answer = answers[url];
  if (!answer) throw new Error(`nothing is listening for ${url}`);
  return answer;
};
const ELSEWHERE: DatabaseIdentity = { cluster: '111', database: 'board_store', schema: 'public' };
const IDENTITY_DB: DatabaseIdentity = { cluster: '222', database: 'board', schema: 'public' };

describe('the store the boot builds (#1007, V5)', () => {
  it.each([STORE, undefined])('builds none while the secret is unset (URL=%s), and says so', async (url) => {
    const { logger, log } = spyLogger();
    expect(await issueStoreFrom(cfg({ GITHUB_STORE_DATABASE_URL: url }), logger)).toBeNull();
    expect(String(log.mock.calls[0][0])).toMatch(/is off/);
  });

  it.each(['1', String(STORE_CONNECTIONS - 1)])('refuses store connection_limit=%s at construction', async (limit) => {
    await expect(issueStoreFrom(cfg({
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_STORE_DATABASE_URL: `${STORE}?connection_limit=${limit}`,
    }), spyLogger().logger)).rejects.toThrow(
      `GITHUB_STORE_DATABASE_URL connection_limit=${limit} must be an integer at least ${STORE_CONNECTIONS}.`,
    );
  });

  it('refuses the secret without a store URL', async () => {
    await expect(issueStoreFrom(cfg({ GITHUB_WEBHOOK_SECRET: SECRET }), spyLogger().logger)).rejects.toThrow(
      /GITHUB_STORE_DATABASE_URL/,
    );
  });

  it('builds the Postgres store and names where it is, never with the password', async () => {
    const { logger, log, warn } = spyLogger();
    const store = await issueStoreFrom(cfg({ GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_STORE_DATABASE_URL: STORE, ISSUES_STORE_MAX_AGE_MS: 3_600_000 }), logger);
    expect(store).toBeInstanceOf(PrismaIssueStore);
    const said = log.mock.calls.flat().join(' ');
    expect(said).toContain('board-store-pg:5432/board_store');
    expect(said).not.toContain('hunter2');
    expect(warn).not.toHaveBeenCalled();
    await (store as PrismaIssueStore).onModuleDestroy();
  });

  // A warning here used to let the boot through, and what it let through was
  // Github issue titles written into the database that holds the encrypted
  // Github credentials (#1070, S4).
  it.each([SECRET, undefined])('refuses to boot when the store URL is the identity database (secret=%s)', async (secret) => {
    const { logger, log } = spyLogger();
    await expect(
      issueStoreFrom(cfg({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_STORE_DATABASE_URL: STORE, DATABASE_URL: STORE, ISSUES_STORE_MAX_AGE_MS: 3_600_000 }), logger),
    ).rejects.toThrow(
      'GITHUB_STORE_DATABASE_URL points at board-store-pg:5432/board_store, which is where DATABASE_URL points ' +
      '(the same host, port, database and schema): the GitHub store would write data beside the identity and credential tables. ' +
      'Set GITHUB_STORE_DATABASE_URL to a separate database.',
    );
    // And it never claims the store is on before refusing.
    expect(log.mock.calls.flat().join(' ')).not.toContain('is on');
  });

  it.each([SECRET, undefined])('refuses the same place spelled the same way, before anything is connected (secret=%s)', async (secret) => {
    const sameDb = 'postgresql://other:other@board-store-pg:5432/board_store?connection_limit=2';
    const never = async (): Promise<DatabaseIdentity> => {
      throw new Error('nothing should have been connected');
    };
    await expect(
      issueStoreFrom(cfg({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_STORE_DATABASE_URL: sameDb, DATABASE_URL: STORE, ISSUES_STORE_MAX_AGE_MS: 3_600_000 }), spyLogger().logger, never),
    ).rejects.toThrow(/the same host, port, database and schema/);
  });

  // The half a spelling cannot defeat (#1070, S4): a store whose URL names
  // another host, port or password, and whose connection lands in the identity
  // database all the same.
  it.each([SECRET, undefined])('refuses a store URL that names somewhere else and reaches the identity database (secret=%s)', async (secret) => {
    const alias = 'postgresql://board:board@127.0.0.1:6543/board';
    const identityUrl = 'postgresql://board:board@localhost:5432/board';
    const { logger, log } = spyLogger();
    await expect(
      issueStoreFrom(
        cfg({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_STORE_DATABASE_URL: alias, DATABASE_URL: identityUrl, ISSUES_STORE_MAX_AGE_MS: 3_600_000 }),
        logger,
        says({ [storeConnectionUrl(alias)]: IDENTITY_DB, [identityUrl]: IDENTITY_DB }),
      ),
    ).rejects.toThrow(/database board of cluster 222, schema public/);
    expect(log.mock.calls.flat().join(' ')).not.toContain('is on');
  });

  it.each([SECRET, undefined])('builds the store when the two connections land in different databases (secret=%s)', async (secret) => {
    const identityUrl = 'postgresql://board:board@localhost:5432/board';
    const { logger, warn } = spyLogger();
    const store = await issueStoreFrom(
      cfg({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_STORE_DATABASE_URL: STORE, DATABASE_URL: identityUrl, ISSUES_STORE_MAX_AGE_MS: 3_600_000 }),
      logger,
      says({ [storeConnectionUrl(STORE)]: ELSEWHERE, [identityUrl]: IDENTITY_DB }),
    );
    if (secret) expect(store).toBeInstanceOf(PrismaIssueStore);
    else expect(store).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    await (store as PrismaIssueStore)?.onModuleDestroy();
  });

  it.each([SECRET, undefined])('allows a schema of its own in the identity database, and says that is what it is (secret=%s)', async (secret) => {
    const ownSchema = 'postgresql://board:board@localhost:5432/board?schema=github_store';
    const identityUrl = 'postgresql://board:board@localhost:5432/board';
    const { logger, log } = spyLogger();
    const store = await issueStoreFrom(
      cfg({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_STORE_DATABASE_URL: ownSchema, DATABASE_URL: identityUrl, ISSUES_STORE_MAX_AGE_MS: 3_600_000 }),
      logger,
      says({ [storeConnectionUrl(ownSchema)]: { ...IDENTITY_DB, schema: 'github_store' }, [identityUrl]: IDENTITY_DB }),
    );
    if (secret) expect(store).toBeInstanceOf(PrismaIssueStore);
    else expect(store).toBeNull();
    expect(log.mock.calls.flat().join(' ')).toContain('in schema github_store of its own');
    await (store as PrismaIssueStore)?.onModuleDestroy();
  });

  it.each([SECRET, undefined])('boots and says which comparison it made when a database cannot be asked (secret=%s)', async (secret) => {
    const identityUrl = 'postgresql://board:board@localhost:5432/board';
    const { logger, warn } = spyLogger();
    const store = await issueStoreFrom(
      cfg({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_STORE_DATABASE_URL: STORE, DATABASE_URL: identityUrl, ISSUES_STORE_MAX_AGE_MS: 3_600_000 }),
      logger,
      says({ [identityUrl]: IDENTITY_DB }),
    );
    if (secret) expect(store).toBeInstanceOf(PrismaIssueStore);
    else expect(store).toBeNull();
    expect(String(warn.mock.calls[0][0])).toMatch(/could not be compared .*only their URLs were/);
    await (store as PrismaIssueStore)?.onModuleDestroy();
  });
});

describe('the store URL (#1007, V5)', () => {
  it('is described by host, port, database and schema only', () => {
    expect(describeDatabase('postgresql://u:hunter2@h:6543/db?schema=s1')).toBe('h:6543/db (schema s1)');
    expect(describeDatabase('not a url')).toBe('a URL that does not parse');
  });

  it('gets the store pool size unless it names one', () => {
    expect(new URL(storeConnectionUrl(STORE)).searchParams.get('connection_limit')).toBe(String(STORE_CONNECTIONS));
    expect(new URL(storeConnectionUrl(`${STORE}?connection_limit=2`)).searchParams.get('connection_limit')).toBe('2');
  });

  // The bound that ends a query on a server that took it and stopped answering,
  // which Prisma's transaction timeout does not (#1070, B1).
  it('gets a socket timeout unless it names one', () => {
    expect(new URL(storeConnectionUrl(STORE)).searchParams.get('socket_timeout')).toBe(String(STORE_QUERY_TIMEOUT_S));
    expect(new URL(storeConnectionUrl(`${STORE}?socket_timeout=30`)).searchParams.get('socket_timeout')).toBe('30');
  });

  it('keeps its credentials, database and schema as they were', () => {
    const parsed = new URL(storeConnectionUrl('postgresql://board:p%40ss@board-store-pg:5432/board_store?schema=s'));
    expect([parsed.username, parsed.password, parsed.host, parsed.pathname, parsed.searchParams.get('schema')])
      .toEqual(['board', 'p%40ss', 'board-store-pg:5432', '/board_store', 's']);
  });
});

it('exposes no cache signal when the store provider is unavailable', async () => {
  const module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), GithubStoreModule],
    providers: [ConfigService],
  }).overrideProvider(ISSUE_STORE).useValue(null)
    .overrideProvider(ConfigService).useValue(cfg({ GITHUB_WEBHOOK_SECRET: SECRET }))
    .compile();
  expect(module.get(IssueStoreSignal)).toBeNull();
  await module.close();
});

it('exposes the same signal that committed store deliveries update', async () => {
  const store = new PrismaIssueStore({ $disconnect: vi.fn() } as unknown as PrismaClient, 3_600_000);
  const module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), GithubStoreModule],
  }).overrideProvider(ISSUE_STORE).useValue(store)
    .overrideProvider(ConfigService).useValue(cfg({ GITHUB_WEBHOOK_SECRET: SECRET }))
    .compile();
  const signal = module.get(IssueStoreSignal);
  store.signal!.bump([101]);
  expect(signal.generationFor({ id: 101, full: 'org/repo' })).toBe(1);
  await module.close();
});

import { createConnection, createServer, type AddressInfo, type Server } from 'node:net';
import { lookup } from 'node:dns/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { askDatabase, issueStoreFrom } from './github-store.module';
import { PrismaIssueStore } from './issue-store';

/**
 * The boot's refusal to put the webhook store in the identity database, against
 * a real Postgres (#1070, S4).
 *
 * The refusal used to compare the two URLs' text, and a verifier defeated it by
 * typing one host two ways: a store at `127.0.0.1` against a DATABASE_URL of
 * `localhost` booted, and a Github issue title landed in the database that holds
 * the encrypted Github credentials. Nothing without a database can catch that.
 * Every shape below is the SAME database reached down a route spelled
 * differently, and only the database itself can say so.
 *
 * The lane hands this file two schemas in one database, which is also the one
 * shape that has to go on booting: a schema somebody chose on purpose.
 */

const SECRET = 'a-webhook-secret-twenty-plus';
const IDENTITY = process.env.DATABASE_URL as string;
const OWN_SCHEMA = process.env.BOARD_DB_TEST_STORE_URL as string;
const REFUSED = /which is where DATABASE_URL points/;

const cfg = (store: string, secret: string | undefined): ConfigService =>
  ({
    get: (k: string) =>
      ({
        GITHUB_WEBHOOK_SECRET: secret,
        GITHUB_STORE_DATABASE_URL: store,
        DATABASE_URL: IDENTITY,
        ISSUES_STORE_MAX_AGE_MS: 3_600_000,
      })[k],
  }) as unknown as ConfigService;

const spyLogger = () => {
  const log = vi.fn();
  const warn = vi.fn();
  return { logger: { log, warn } as unknown as Logger, log, warn };
};

/** Boots the store and gives back the connection it opened, so a lane that
 *  runs every file in one process does not accumulate pools. */
async function boot(store: string, logger: Logger, secret: string | undefined): Promise<void> {
  const built = await issueStoreFrom(cfg(store, secret), logger);
  if (secret) expect(built).toBeInstanceOf(PrismaIssueStore);
  else expect(built).toBeNull();
  await (built as PrismaIssueStore)?.onModuleDestroy();
}

/** The error a boot refused with. Fails the test if it booted instead. */
async function refusal(store: string, secret: string | undefined): Promise<string> {
  try {
    const built = await issueStoreFrom(cfg(store, secret), spyLogger().logger);
    await (built as PrismaIssueStore)?.onModuleDestroy();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`${store} booted, and it points where DATABASE_URL points`);
}

/** The host's address if it was named, its name if it was an address. IPv4,
 *  because `localhost` against `127.0.0.1` is the pair the verifier booted
 *  through, and because a URL will not take a bare `::1` as a hostname. */
async function addressOf(host: string): Promise<string> {
  const { address } = await lookup(host, { family: 4 });
  if (address !== host) return address;
  if (address === '127.0.0.1') return 'localhost';
  throw new Error(`no second spelling of ${host} to test with`);
}

/** The same host with letters in it, so a case can be changed at all. */
async function namedHost(host: string): Promise<string> {
  return /[a-z]/i.test(host) ? host : addressOf(host);
}

/** A pooler, in the one respect that matters here: another host and port in
 *  front of the same database, which no comparison of URLs can see through. */
function pooler(host: string, port: number): Promise<Server> {
  const server = createServer((client) => {
    const upstream = createConnection({ host, port });
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const servers: Server[] = [];

/** The identity URL as it would be typed on the other side of a pooler. */
async function throughAPooler(): Promise<string> {
  const identity = new URL(IDENTITY);
  const server = await pooler(identity.hostname, Number(identity.port || 5432));
  servers.push(server);
  const through = new URL(IDENTITY);
  through.hostname = '127.0.0.1';
  through.port = String((server.address() as AddressInfo).port);
  expect(through.host).not.toBe(identity.host);
  return through.toString();
}

afterAll(async () => {
  for (const server of servers) await new Promise((done) => server.close(done));
});

describe.each([SECRET, undefined])('the boot refuses a store in the identity database (secret=%s)', (secret) => {
  it('refuses the host spelled as its address — the alias that defeated the URL comparison', async () => {
    const alias = new URL(IDENTITY);
    alias.hostname = await addressOf(alias.hostname);
    expect(alias.toString()).not.toBe(IDENTITY);
    expect(await refusal(alias.toString(), secret)).toMatch(REFUSED);
  });

  it('refuses the host spelled in another case, which a URL keeps as it was typed', async () => {
    const other = new URL(IDENTITY);
    other.hostname = (await namedHost(other.hostname)).toUpperCase();
    expect(other.hostname).not.toBe(new URL(IDENTITY).hostname);
    expect(await refusal(other.toString(), secret)).toMatch(REFUSED);
  });

  it('refuses the same database behind a pooler on another host and port', async () => {
    expect(await refusal(await throughAPooler(), secret)).toMatch(REFUSED);
  });

  it('refuses the same database under a different password', async () => {
    const other = new URL(IDENTITY);
    other.password = 'a-different-password';
    expect(await refusal(other.toString(), secret)).toMatch(REFUSED);
  });

  it('refuses the same database spelled with a trailing slash', async () => {
    const other = new URL(IDENTITY);
    other.pathname = `${other.pathname}/`;
    expect(await refusal(other.toString(), secret)).toMatch(REFUSED);
  });

  it('names the database and cluster it refused, and never the credentials', async () => {
    const identity = new URL(IDENTITY);
    const alias = new URL(IDENTITY);
    alias.hostname = await addressOf(alias.hostname);
    const there = await askDatabase(IDENTITY);
    const said = await refusal(alias.toString(), secret);
    expect(said).toContain(`database ${there.database} of cluster ${there.cluster}, schema ${there.schema}`);
    // The pair, not the password alone: a password that is also a word in the
    // database's name would make that assertion pass on a message that leaked it.
    expect(said).not.toContain(`${identity.username}:${identity.password}`);
  });

  it('says the same thing down every route, which is why the spellings are caught', async () => {
    expect(await askDatabase(await throughAPooler())).toEqual(await askDatabase(IDENTITY));
  });
});

describe.each([SECRET, undefined])('what the boot still allows (secret=%s)', (secret) => {
  it('boots into a schema of its own in that same database, and says which', async () => {
    const { logger, log, warn } = spyLogger();
    await boot(OWN_SCHEMA, logger, secret);
    const said = log.mock.calls.flat().join(' ');
    expect(said).toContain(`in schema ${process.env.BOARD_DB_TEST_STORE_SCHEMA} of its own`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('boots and says so when a database cannot be asked, rather than implying it was', async () => {
    const unreachable = new URL(IDENTITY);
    unreachable.hostname = '127.0.0.1';
    unreachable.port = '1';
    unreachable.pathname = '/board_store_elsewhere';
    const { logger, warn } = spyLogger();
    await boot(unreachable.toString(), logger, secret);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not be compared/);
  });
});

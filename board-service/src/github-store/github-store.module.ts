import { IssueStoreHealth } from './issue-store-health';
import { createPrismaClient } from '../prisma';
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISSUE_STORE, IssueStoreSignal, PrismaIssueStore, type IssueStore } from './issue-store';
import { GithubWebhookController } from './webhook.controller';

import { STORE_CONNECTIONS } from './concurrency';
export { STORE_CONNECTIONS } from './concurrency';

/**
 * How long one query on the store's connection may run before the driver gives
 * up on it, in seconds (#1007, V5). Prisma's transaction `timeout` is checked
 * between statements, so a server that takes a query and then stops answering
 * is not bounded by it at all — a frozen store held one delivery 45 seconds in
 * isolation and 300 in the running service. This is the client-side bound that
 * ends such a query and gives the connection back, well above the slowest
 * legitimate one: the biggest measured read, 197,000 rows, took 3.8 seconds.
 *
 * The answer to Github is bounded separately and lower, in `webhook-deadline.ts`,
 * because a stalled connection is the store's problem and a held socket is
 * Github's.
 */
export const STORE_QUERY_TIMEOUT_S = 10;

/**
 * The store is chosen here and nowhere else (#1007, V5): off unless
 * GITHUB_WEBHOOK_SECRET is set, and then always on GITHUB_STORE_DATABASE_URL,
 * which the config schema requires alongside the secret. It is never defaulted
 * to DATABASE_URL, because a store that silently shared the identity database
 * would put Github data beside the encrypted credentials without anybody having
 * decided it. The boot line names which database it is on, never with the
 * password. The database checks also run with only the URL set, because the
 * destination bootstrap uses it without the webhook receiver (#1172).
 */
export async function issueStoreFrom(
  config: ConfigService,
  logger = new Logger('GithubStore'),
  // Injected so the unit specs can settle the URL arithmetic without a
  // Postgres. The database specs beside them drive the real one.
  ask: DatabaseProbe = askDatabase,
  signal?: IssueStoreSignal | null,
): Promise<IssueStore | null> {
  const url = config.get<string>('GITHUB_STORE_DATABASE_URL');
  const webhook = config.get<string>('GITHUB_WEBHOOK_SECRET');
  if (webhook && !url) throw new Error('GITHUB_STORE_DATABASE_URL must be set when GITHUB_WEBHOOK_SECRET is set');
  if (url) {
    // Refused rather than warned about (#1070, S4): a warning in a boot log is not
    // a decision anybody made, and what it let through was Github issue titles
    // written into the very database that holds the encrypted Github credentials.
    // Production gives the store its own container, board-store-pg.
    const here = describeDatabase(url);
    const identity = config.get<string>('DATABASE_URL') ?? '';
    // The cheap half, and the only half that runs before anything is connected:
    // the two URLs naming one place in the same words. It catches a copy of the
    // same URL under a different password or with an extra parameter, and it is
    // what is left when the databases cannot be asked.
    if (identity !== '' && parses(url) && parses(identity) && here === describeDatabase(identity)) {
      throw sharedDatabase(here, 'the same host, port, database and schema');
    }
    // The half that a spelling cannot defeat: ask each connection which database
    // it is attached to. See `DatabaseIdentity`.
    const shared = identity === '' ? null : await sharesIdentityDatabase(here, storeConnectionUrl(url), identity, ask, logger);
    if (shared) logger.log(shared);
  }
  if (!webhook || !url) {
    logger.log('Github webhook store is off (GITHUB_WEBHOOK_SECRET is unset): every issue list is read from Github');
    return null;
  }
  logger.log(`Github webhook store is on ${describeDatabase(url)}`);
  const client = createPrismaClient(storeConnectionUrl(url), {
    minimumConnections: STORE_CONNECTIONS, urlName: 'GITHUB_STORE_DATABASE_URL',
  });
  return new PrismaIssueStore(client, config.get<number>('ISSUES_STORE_MAX_AGE_MS') as number, signal);
}

/**
 * What a connection is attached to, whatever its URL spells (#1070, S4).
 *
 * Comparing the two URLs is not enough, and a verifier proved it: a store at
 * `127.0.0.1` against a DATABASE_URL of `localhost` booted, and a Github issue
 * title landed in the identity database beside the encrypted credentials. A
 * host alias, a spelling, a different port forwarded to one place and any
 * pooler in front of either defeat a comparison of text.
 *
 * So each side is asked instead. `system_identifier` is written into the
 * cluster once, at initdb, and every route to that cluster answers the same
 * one; `current_database()` and the search_path schema name the rest. A pooler
 * answers for the database it fronts, which is the database the writes would
 * land in — exactly the question being asked.
 */
export interface DatabaseIdentity {
  /** The cluster's own id, the same down every route that reaches it. */
  cluster: string;
  database: string;
  schema: string;
}

export type DatabaseProbe = (url: string) => Promise<DatabaseIdentity>;

/** Opens one connection, asks it where it is, and gives it back. */
export async function askDatabase(url: string): Promise<DatabaseIdentity> {
  const client = createPrismaClient(url);
  try {
    const rows = await client.$queryRaw<{ cluster: string; database: string; schema: string | null }[]>`
      SELECT (SELECT system_identifier::text FROM pg_control_system()) AS cluster,
             current_database()::text AS database,
             current_schema()::text AS schema`;
    const row = rows[0];
    if (!row) throw new Error('the database answered no row');
    // `current_schema()` is null while the schema named on the URL does not
    // exist yet, which is every boot before its first migration.
    return { cluster: row.cluster, database: row.database, schema: row.schema ?? schemaOf(url) };
  } finally {
    await client.$disconnect();
  }
}

/** The schema a URL names, or the one Postgres would pick without it. */
function schemaOf(url: string): string {
  try {
    return new URL(url).searchParams.get('schema') ?? 'public';
  } catch {
    return 'public';
  }
}

/**
 * Throws when the store would write into the identity database itself, and
 * returns a line for the boot log when it would write into a schema of its own
 * there — which is a thing somebody typed on purpose, so it boots and says so.
 * Returns null when the two are different databases.
 */
async function sharesIdentityDatabase(
  here: string,
  storeUrl: string,
  identityUrl: string,
  ask: DatabaseProbe,
  logger: Logger,
): Promise<string | null> {
  let store: DatabaseIdentity;
  let identity: DatabaseIdentity;
  try {
    store = await ask(storeUrl);
    identity = await ask(identityUrl);
  } catch (err) {
    // A database that cannot be asked is one the comparison was not made
    // against, and the boot says which comparison it fell back to rather than
    // leaving the stronger one implied. Not fatal: a store that is down is
    // already a documented state, and board answers every delivery 503.
    logger.warn(
      `the webhook store and the identity database could not be compared (${(err as Error).message}): ` +
        'only their URLs were, which a host alias or a pooler in front of either can defeat',
    );
    return null;
  }
  if (store.cluster !== identity.cluster || store.database !== identity.database) return null;
  const where = `database ${store.database} of cluster ${store.cluster}`;
  if (store.schema !== identity.schema) {
    return `the webhook store is in ${where}, which DATABASE_URL also names, in schema ${store.schema} of its own`;
  }
  throw sharedDatabase(here, `${where}, schema ${store.schema}`);
}

/** The one refusal, whichever half of the comparison caught it. */
function sharedDatabase(here: string, why: string): Error {
  return new Error(
    `GITHUB_STORE_DATABASE_URL points at ${here}, which is where DATABASE_URL points (${why}): the GitHub ` +
      'store would write data beside the identity and credential tables. Set GITHUB_STORE_DATABASE_URL to a separate database.',
  );
}

/** Whether a URL is one at all. Two URLs that do not parse both describe as
 *  "a URL that does not parse", which is not the two of them naming one place. */
function parses(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Host, port, database and schema of a Postgres URL, and nothing else. */
export function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    const schema = parsed.searchParams.get('schema');
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}${schema ? ` (schema ${schema})` : ''}`;
  } catch {
    return 'a URL that does not parse';
  }
}

/** The URL with `connection_limit` and `socket_timeout` set to the store's own
 *  values, unless it already names them. */
export function storeConnectionUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connection_limit')) parsed.searchParams.set('connection_limit', String(STORE_CONNECTIONS));
    if (!parsed.searchParams.has('socket_timeout')) parsed.searchParams.set('socket_timeout', String(STORE_QUERY_TIMEOUT_S));
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The webhook receiver and the store behind it. @Global so the issues cache
 * module, a leaf, can take the store and its signal without importing this
 * module; both are optional there, so a spec that builds that module alone sees
 * no store and reads Github exactly as before. The signal is null while the
 * store is off, and the cache then behaves exactly as it did before V5.
 */
@Global()
@Module({
  controllers: [GithubWebhookController],
  providers: [
    IssueStoreHealth,
    { provide: ISSUE_STORE, inject: [ConfigService], useFactory: (config: ConfigService) => issueStoreFrom(config) },
    {
      provide: IssueStoreSignal,
      inject: [ISSUE_STORE],
      useFactory: (store: IssueStore | null) => store?.signal ?? null,
    },
  ],
  exports: [ISSUE_STORE, IssueStoreSignal, IssueStoreHealth],
})
export class GithubStoreModule {}

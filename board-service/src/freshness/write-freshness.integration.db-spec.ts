import { createPrismaClient } from '../prisma';
import { GithubUserService } from '../auth/github-user.service';
import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { request as httpRequest } from 'http';
import { SignJWT } from 'jose';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IssueBucketsService } from '../issue-buckets/issue-buckets.service';
import { ISSUE_BUCKETS_SOURCE, IssueBucketCounts } from '../issue-buckets/issue-buckets.types';
import { IssueDetailService } from '../issue-detail/issue-detail.service';
import { ISSUE_DETAIL_SOURCE } from '../issue-detail/issue-detail.types';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import { ISSUES_SOURCE } from '../issues-metrics/issues-metrics.types';
import { PROJECTS_SOURCE } from '../projects/project.types';
import { ProjectsService } from '../projects/projects.service';

/** Every source the four caches read Github through, labelled for the log. */
const SOURCE_TOKENS: [string, symbol | string][] = [
  ['projects', PROJECTS_SOURCE],
  ['issues', ISSUES_SOURCE],
  ['buckets', ISSUE_BUCKETS_SOURCE],
  ['issue-detail', ISSUE_DETAIL_SOURCE],
];

/** A signed-in teammate, as the services take one. */
const HUMAN = { agent: false, email: 'octocat@example.com' };

/** Record every method call made on a source, in order. Own and inherited
 *  methods both, because a fixture source declares its methods on the prototype
 *  and a stub declares them on the instance. Accessors are skipped: reading one
 *  to see whether it is a function would run it. */
function record(source: object, label: string, into: string[]): void {
  const target = source as Record<string, unknown>;
  const seen = new Set<string>();
  for (let o: object | null = source; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const name of Object.getOwnPropertyNames(o)) {
      if (name === 'constructor' || seen.has(name)) continue;
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(o, name);
      if (!descriptor || typeof descriptor.value !== 'function') continue;
      const fn = descriptor.value as (...args: unknown[]) => unknown;
      target[name] = (...args: unknown[]) => {
        into.push(`${label}.${name}`);
        return fn.apply(source, args);
      };
    }
  }
}

const TEAM_MEMBER = 'octocat@example.com';
const SESSION_SECRET = 'integration-secret-0123456789-write-freshness-692';

// Fixture-only config, set BEFORE AppModule is imported — its
// ConfigModule.forRoot() reads process.env at import time.
//
// Since #743 this block and that import sit at MODULE scope, not in `beforeAll`.
// The ordering survives: static imports are hoisted above both, exactly as they
// were hoisted above the hook body. What changes is who pays for loading
// AppModule — vitest caps hooks but not module load, and in the hook that load
// blew the 30s budget three times for three. docs/traps.md has the numbers and
// the two prices the move buys.
process.env.AUTH_DISABLED = 'false';
process.env.BOARD_SESSION_SECRET = SESSION_SECRET;
process.env.BOARD_MCP_ENABLED = 'false';
process.env.BOARD_ALLOWED_GITHUB = '';
process.env.BOARD_FIXTURE_ADMINS = '';
process.env.BOARD_ADMIN_EMAILS = '';
process.env.BOARD_ADMIN_EMAILS = '';
process.env.BOARD_AGENT_TOKENS = '';
process.env.ISSUES_SOURCE = 'fixture';
process.env.PROJECTS_SOURCE = 'fixture';
// No defaults since #1175, and this file boots a writes-on board, which owes
// BOOT_ALERT_REPO as well: a board that can write names where a bad boot
// reports.
process.env.GITHUB_ORGS = 'acme';
process.env.FEEDBACK_REPO = 'acme/board';
process.env.BOOT_ALERT_REPO = 'acme/board';
process.env.BOOT_ALERT_ASSIGNEE = 'on-call';
// `db`, and this file is a `.db-spec.ts`, because of #774: GITHUB_WRITE_ENABLED
// now REQUIRES IDENTITY_SOURCE=db, so a spec that boots a writes-on board is a
// spec that boots a database-backed board. It used to say `fixture` here, which
// is the pairing #774 was filed about — a board performing audited writes into
// an audit log that records nothing.
//
// Overriding the Prisma seams instead, and staying in the fixture lane, was
// tried and dropped: with a `db` config and no reachable Postgres this file
// answers 503 to every request, from SessionRevocationService failing closed on
// an unreadable store — so the overrides would have to cover the revocation
// store, the admin roster cache and the identity repository before a single
// assertion ran. Each one is a piece of "the real module graph" this file exists
// to boot, and the docblock below says why that matters. Real Postgres costs
// less than three stubs.
process.env.IDENTITY_SOURCE = 'db';
// The close route is gated on it, and a 503 would prove nothing about caches.
process.env.GITHUB_WRITE_ENABLED = 'true';
process.env.GITHUB_TOKEN = '';
// And the write credential, which this file has more reason to blank than any
// other: it sets GITHUB_WRITE_ENABLED=true above, and #756's boot hook asks
// Github `GET /user` under GITHUB_WRITE_TOKEN whenever one is set. See the
// same line in `auth/required-scopes.integration.spec.ts`.
process.env.GITHUB_WRITE_TOKEN = '';
process.env.GITHUB_APP_ID = '';
process.env.GITHUB_PRIVATE_KEY = '';
process.env.GITHUB_INSTALLATION_ID = '';
process.env.GITHUB_USER_APP_CLIENT_ID = '';
process.env.GITHUB_USER_APP_CLIENT_SECRET = '';
process.env.BOARD_CREDENTIAL_KEY = '';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '';
process.env.GOOGLE_DWD_SUBJECT = '';
// NOT cleared: `vitest.db.config.ts` refuses to start without it and its
// globalSetup has already applied the migrations against it. Blanking it here
// would fail boot validation, DATABASE_URL being required under `db`.

// Top-level await: vitest loads this file through vite-node's ESM pipeline, but
// `pnpm exec tsc -p tsconfig.json --noEmit` reads this package as
// CommonJS and rejects it with TS1309. The import is a statement of its OWN so
// the directive covers the await and nothing else — written as one line it
// swallows TS2307 too, and a typo'd specifier compiles clean against `any`
// (measured both ways in this file, 2026-08-30). Do not collapse it;
// required-scopes.integration.spec.ts says what else depends on the split.
const appModulePromise = import('../app.module.js');
// @ts-expect-error TS1309 — top-level await in a CommonJS module
const appModule = await appModulePromise;
const { AppModule } = appModule;

/**
 * The close route, end to end: a write done on the board drops the cached reads
 * it invalidated (#692).
 *
 * `freshness.spec.ts` beside this drives each cache and the interceptor
 * directly. This one boots the REAL AppModule — the whole guard chain, the real
 * `POST /api/issues/:owner/:repo/:number/close`, the real module graph — and
 * asks the question the issue was filed about: after a close, does a surface
 * that was warm before it still serve the number from before?
 *
 * It is the half neither a service test nor a synthetic controller can answer,
 * because what it tests is the WIRING: an interceptor that is not registered, or
 * a registry that cannot reach a cache from the container, passes every test in
 * the file next door.
 */
describe('a close drops what it invalidated (#692) — the real route, the real module graph', () => {
  /** Whatever port the kernel hands this run. It used to be 3692, and a second
   *  agent on this machine holding that port failed the lane in `beforeAll` with
   *  EADDRINUSE — a red run nobody caused, which is the same reason the lane
   *  mints a schema of its own (#1070). */
  let port = 0;
  /** A fixture issue the close route can really close (fixture-issue-detail.source.ts). */
  const ISSUE = 'acme/acme/218';

  /** How many times the dashboard's counts have been fetched, and what they say.
   *  The second fetch answers one fewer open issue — the close that just
   *  happened. A board still serving the first answer is the bug (#692). */
  let bucketReads = 0;
  const bucketSource = {
    counts: async (): Promise<IssueBucketCounts> => {
      bucketReads += 1;
      return { open: bucketReads === 1 ? 5 : 4, bugs: 0, feedback: 0, unassigned: 0 };
    },
  };

  let app: INestApplication | undefined;

  /** This file's rows, and only this file's (#774 review).
   *
   * Every other file in the db lane owns its rows by a prefix it writes into
   * them. This one cannot: it boots the real AppModule, so the rows are the
   * roster PrismaIdentityRepository seeds from PEOPLE_ALIASES (fixed ids from
   * source), the `identity.seed` events IdentitySeedAudit files against them,
   * and the `issue.close` event the write below records — none of them naming
   * anything this file chose. So the namespace is time rather than text: what
   * exists BEFORE `app.init()` is somebody else's, what appears after is ours.
   *
   * It matters locally, not in CI. CI's database is ephemeral; the `board-pg`
   * compose volume is not, and `fileParallelism: false` says the lane shares one
   * database — so without this, each local run left a real audit row and a
   * seeded roster behind for the next reader of the Admin log to find. */
  const prisma = createPrismaClient();
  let auditBefore = new Set<string>();
  let identitiesBefore = new Set<string>();
  /** Everything the service warned about while it was coming up. The registry
   *  resolves its holders at `onApplicationBootstrap`, so a cache it cannot
   *  reach says so HERE — before any request — and this is the only place a
   *  test can hear it. */
  const bootWarnings: string[] = [];

  beforeAll(async () => {
    // Taken BEFORE the module graph is built: the roster seed and its audit
    // events both run at `onApplicationBootstrap`, inside `app.init()` below.
    auditBefore = new Set((await prisma.auditEvent.findMany({ select: { id: true } })).map((r) => r.id));
    identitiesBefore = new Set((await prisma.identity.findMany({ select: { id: true } })).map((r) => r.id));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The one source that has to CHANGE its answer, so "did the cache go" is
      // observable at the surface rather than inferred from a call count.
      .overrideProvider(ISSUE_BUCKETS_SOURCE)
      .useValue(bucketSource)
      .compile();
    app = moduleRef.createNestApplication();
    // This suite isolates scopes/freshness; assume a synthetic Github connection.
    vi.spyOn(app.get(GithubUserService), 'principal').mockImplementation(async (email: string) => ({
      key: email, email, login: null, token: 'synthetic-connected', owners: [{ login: 'acme', type: 'Organization' }], repositories: [], cache: new WeakMap(),
    }));
    // Mirrors main.ts closely enough to matter: the global prefix is what makes
    // the paths below match at all.
    app.setGlobalPrefix('api', { exclude: ['mcp'] });
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((line: unknown) => void bootWarnings.push(String(line)));
    await app.init();
    warn.mockRestore();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo | string | null;
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
    port = address.port;
  });

  afterAll(async () => {
    // Guarded because a hook that failed at or before `createNestApplication()`
    // leaves `app` unassigned, and an unguarded close then reports a second
    // failure over the real one (#743). The `| undefined` above is what makes
    // tsc require this rather than leaving it to a comment.
    await app?.close();

    // Deletes by id, never by a predicate: a `where` on time or on actor would
    // also take a row written by a local board running against the same
    // database. Audit first, identities second — the seed events point at the
    // identities, so the other order leaves events naming rows that are gone.
    // Wrapped, because a teardown that throws reports over whatever failed
    // first, and an uncleaned row is a smaller harm than a hidden failure.
    try {
      const audit = await prisma.auditEvent.findMany({ select: { id: true } });
      const mine = audit.filter((r) => !auditBefore.has(r.id)).map((r) => r.id);
      if (mine.length) await prisma.auditEvent.deleteMany({ where: { id: { in: mine } } });

      const identities = await prisma.identity.findMany({ select: { id: true } });
      const seeded = identities.filter((r) => !identitiesBefore.has(r.id)).map((r) => r.id);
      if (seeded.length) await prisma.identity.deleteMany({ where: { id: { in: seeded } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  /** Minimal HTTP client. The repo has supertest as an untyped bare dep, so its
   *  integration specs use Node's own `http` — required-scopes.integration.spec.ts
   *  says why. `agent: false` because the global agent pools sockets, and a
   *  pooled one outlives the server that answered on it. */
  function call(
    method: string,
    path: string,
    opts: { token?: string } = {},
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          agent: false,
          headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let json: unknown = undefined;
            try {
              json = data ? JSON.parse(data) : undefined;
            } catch {
              json = data;
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  /** A plain human UI session — the HS256 shape google-auth mints after login. */
  const session = (email: string): Promise<string> =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('atlas')
      .setSubject(`sub-${email}`)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(SESSION_SECRET));

  it('every cache the registry names was reachable when the service came up', () => {
    // A cache the container cannot hand over goes on serving what a write
    // invalidated, and nothing about a request afterwards looks wrong. Resolved
    // at bootstrap since the review, so the verdict is in the deploy log rather
    // than in one warning at whenever somebody first writes.
    expect(bootWarnings.filter((l) => l.includes('not reachable'))).toEqual([]);
  });

  it('serves the post-close counts on the next read, not the ones cached before the write', async () => {
    const token = await session(TEAM_MEMBER);

    const before = await call('GET', '/api/issues/buckets', { token });
    expect(before.status).toBe(200);
    expect((before.json as IssueBucketCounts).open).toBe(5);

    const wrote = await call('POST', `/api/issues/${ISSUE}/close`, { token });
    expect(wrote.status).toBe(201);
    // The issue was open and the request named no reason, so the fixture keeps
    // Github's default (#1006).
    expect(wrote.json).toEqual({ state: 'closed', stateReason: 'completed' });

    // ONE, and it is the read this test made before the write. These counts are
    // four Github SEARCH queries, so this cache is one of the three that a write
    // drops and does NOT refill (#692): search allows thirty requests a minute
    // against core REST's five thousand an hour, and it is eventually consistent
    // — a refill this close to the write would usually re-cache the count from
    // before it and hold that for a full TTL. This line is what fails if a
    // refill is ever put on this cache's write path.
    expect(bucketReads).toBe(1);

    // NOTHING has expired — the counts' TTL is 60 s and this test takes
    // milliseconds. Only the write happened, so a cache still answering `5` is
    // serving a number the close made wrong.
    const after = await call('GET', '/api/issues/buckets', { token });
    expect(after.status).toBe(200);
    expect((after.json as IssueBucketCounts).open).toBe(4);
    expect(bucketReads).toBe(2);
  });

  it('refills the two caches that can take it, and never spends a Github SEARCH', async () => {
    // The decision of the second review round, measured at the entry point
    // rather than argued about (#692): a close refills the ingest and the
    // Projects rollup — core REST and GraphQL, on budgets that can carry it —
    // and leaves the Search-backed cache dropped for the next reader.
    // Every source in the graph is wrapped and every method call recorded, AFTER
    // the four caches have been warmed, so a refill has something to refill and a
    // cold cache cannot make this pass for the wrong reason.
    const token = await session(TEAM_MEMBER);
    const calls: string[] = [];

    await Promise.all([
      // `app!`, not `app?.`: a `beforeAll` that throws leaves every `it` in the
      // file unrun, so inside a test the hook has necessarily assigned it. Only
      // the teardown runs either way, which is why that one carries a real guard.
      app!.get(ProjectsService).listProjects(undefined),
      app!.get(IssuesCacheService).getIssues(),
      app!.get(IssueBucketsService).getBuckets(),
      app!.get(IssueDetailService).getIssue('acme', 'acme', 218, HUMAN),
    ]);

    for (const [label, token_] of SOURCE_TOKENS) record(app!.get(token_), label, calls);

    const wrote = await call('POST', `/api/issues/${ISSUE}/close`, { token });
    expect(wrote.status).toBe(201);

    // The write itself, then the two refills it started and did not wait for.
    const touched = () => [...new Set(calls.map((c) => c.split('.')[0]))].sort();
    await vi.waitFor(() => expect(touched()).toEqual(['issue-detail', 'issues', 'projects']));

    // And said the other way round, because this is the half that costs money:
    // the Search-backed source was not asked anything. A
    // `warmAfterWrite` added to it puts four searches on every
    // write — nine issue-detail routes declare a capability, so ticking a
    // checkbox in an issue body would spend them too.
    expect(calls.filter((c) => ['buckets'].includes(c.split('.')[0]))).toEqual([]);
    // The issue the write just wrote is not re-read either: that cache is
    // dropped and refilled by whoever opens the page.
    expect(calls.filter((c) => c.endsWith('.fetch'))).toEqual([]);
  });
});

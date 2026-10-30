import 'reflect-metadata';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import type { GithubCredential } from '../generated/prisma/client';
import { GithubUserService } from './github-user.service';

/**
 * What one cold first load of My work costs a person, for a narrow Github grant
 * and a broad one (#1209 part 5, measurement 2).
 *
 * Part 4 retired the per-surface owner pins, so what a person reads is now their
 * own App grants and nothing can narrow it. This measures the two ends of that:
 * an account granted one small organization, and an account granted the two
 * organizations of the synthetic shape every count in
 * `docs/ops/github-request-budget.md` was taken against.
 *
 * It is the REAL AppModule over the REAL guard chain, with `ISSUES_SOURCE=github`
 * and the part 1 harness's synthetic Github (`scripts/github-call-count/fake-github.mjs`)
 * in `fetch`'s place, so no real Github is called. Only `credential` is stubbed:
 * discovery, pagination, the ETag store and the request observer all run, as
 * they do in `github-scope-baseline.spec.ts`. It is in the real-Postgres lane
 * because the Github App's own settings require `IDENTITY_SOURCE=db`, and
 * `credential` is stubbed because a stored credential needs the App's client
 * secret and the cipher key, neither of which changes a count.
 *
 * "First load" is the two reads the browser starts together when My work opens,
 * which `board-frontend/src/opening-mine.spec.ts` locks: `/api/auth/me` and
 * `/api/issues/mine`. The queue is released only once `/me` has verified the
 * identity, so the paint waits on both. The time below is the server's: from
 * issuing the pair to both having answered, over a loopback socket. A browser's
 * own paint work is not in it, and neither is a real network.
 *
 * Each person is their own cold start. `PrincipalState` gives every person their
 * own cache state, so person 2's load is as cold as person 1's, and that is what
 * lets one boot hold the whole sample.
 */

const SESSION_SECRET = 'first-load-measurement-session-secret-1209';
/** A narrow grant is one small organization. A broad one is the 96 + 29
 *  repositories of the synthetic shape the budget doc's counts were taken in. */
const NARROW = 'narrow-org';
const BROAD = 'acme,globex';
const SHAPES = {
  // `from` is where this shape's people start and `hour` is the one person the
  // person-hour uses. A principal is cached for a minute, so each shape gets a
  // block of its own: a person who loaded under the narrow grant would answer
  // from that cache under the broad one.
  narrow: { grants: NARROW, owners: 1, repositories: 5, from: 0, hour: 40 },
  broad: { grants: BROAD, owners: 2, repositories: 125, from: 20, hour: 41 },
};
/** The sample the measurement run takes. The default lane takes the smallest
 *  one that still proves the shape of the answer, to stay inside the suite's
 *  budget; `BOARD_MEASURE_GITHUB=1` takes enough for a p95. */
const PEOPLE = process.env.BOARD_MEASURE_GITHUB === '1' ? 20 : 2;

const logDir = mkdtempSync(join(tmpdir(), 'board-first-load-'));
process.env.FAKE_GH_LOG = join(logDir, 'gh-calls.jsonl');
process.env.FAKE_ORGS = `${NARROW}:5:2,acme:96:8,globex:29:4`;
process.env.FAKE_GRANTS = '';

// Every Github credential the boot path can spend is blanked first, so nothing
// a developer's local `.env` holds can reach this file (#756, and
// `src/sources/spec-boot-credentials.spec.ts` holds it). The synthetic ones
// below are set after it, and only the synthetic Github answers them.
process.env.GITHUB_TOKEN = '';
process.env.GITHUB_WRITE_TOKEN = '';
process.env.GITHUB_APP_ID = '';
process.env.GITHUB_PRIVATE_KEY = '';
process.env.GITHUB_INSTALLATION_ID = '';
process.env.GITHUB_USER_APP_CLIENT_ID = '';
process.env.GITHUB_USER_APP_CLIENT_SECRET = '';
process.env.BOARD_CREDENTIAL_KEY = '';

Object.assign(process.env, {
  AUTH_DISABLED: 'false', IDENTITY_SOURCE: 'db', BOARD_MCP_ENABLED: 'false',
  BOARD_ADMIN_EMAILS: '', BOARD_FIXTURE_ADMINS: '', BOARD_AGENT_TOKENS: '',
  BOARD_ALLOWED_GITHUB: '',
  BOARD_SESSION_SECRET: SESSION_SECRET,
  GITHUB_WRITE_ENABLED: 'false', GITHUB_ORGS: 'acme,globex',
  // The App's three settings are peers, and `configured` needs them. The
  // secret and the key are never used: `credential` is stubbed, so nothing
  // exchanges a code or decrypts a stored token.
  GITHUB_USER_APP_CLIENT_ID: 'first-load-measurement',
  GITHUB_USER_APP_CLIENT_SECRET: 'first-load-measurement-secret',
  BOARD_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
  GITHUB_TOKEN: 'ghp_fake000000000000000000000000000000',
  // No default since #1175, and it names a repository the synthetic Github serves.
  FEEDBACK_REPO: 'acme/repo-0',
  ISSUES_SOURCE: 'github', PROJECTS_SOURCE: 'fixture', REPOS_SOURCE: 'fixture', DELIVERY_SOURCE: 'fixture',
  ISSUE_BUCKETS_SOURCE: 'fixture', ISSUE_DETAIL_SOURCE: 'fixture',
  GITHUB_LOGIN_DERIVATION_RPM: '60000',
});

// The synthetic Github replaces `fetch` for api.github.com and github.com only,
// so the loopback calls below reach the app. Imported after the env above,
// because it reads FAKE_ORGS once.
const fakeGithubPromise = import('../../scripts/github-call-count/fake-github.mjs');
const appModulePromise = import('../app.module.js');
// @ts-expect-error TS1309 — top-level await in a CommonJS module
await fakeGithubPromise;
// @ts-expect-error TS1309 — top-level await in a CommonJS module
const { AppModule } = await appModulePromise;

let app: INestApplication;
let origin: string;
const events: { identity: string; actor: string; source: string; resource: string; status: number }[] = [];
const requests = channel('board.github.request');
const collect = (value: unknown) => events.push(value as typeof events[number]);

beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('api');
  // Everything else about the person is real. The githubUserId differs per
  // person, so each one is their own identity to the ETag store, the request
  // observer and the caches.
  vi.spyOn(app.get(GithubUserService), 'credential').mockImplementation(async (boardSub?: string) => ({
    row: { version: 'v1', githubUserId: `9${/\d+/.exec(boardSub ?? '')?.[0] ?? '0'}`, githubLogin: (boardSub ?? '').split('@')[0] } as GithubCredential,
    token: (boardSub ?? '').replace(/^synthetic-/, ''),
  }));
  requests.subscribe(collect);
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});

afterAll(async () => {
  requests.unsubscribe(collect);
  if (app) await app.close();
  rmSync(logDir, { recursive: true, force: true });
});

async function session(email: string): Promise<string> {
  return new SignJWT({ email }).setProtectedHeader({ alg: 'HS256' }).setSubject(`synthetic-${email}`)
    .setIssuer('atlas').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(SESSION_SECRET));
}

/** The pair My work opens with, started together as the browser starts them. */
async function firstLoad(email: string, owner: string): Promise<{ ms: number; requests: number }> {
  const headers = { Authorization: `Bearer ${await session(email)}` };
  const before = events.length;
  const started = performance.now();
  const [me, mine] = await Promise.all([
    fetch(`${origin}/api/auth/me`, { headers }),
    fetch(`${origin}/api/issues/mine?org=${owner}&timeZone=UTC`, { headers }),
  ]);
  const ms = performance.now() - started;
  // The bodies are read before the assertion, so a refused load says why
  // rather than printing two status codes.
  const bodies = await Promise.all([me.text(), mine.text()]);
  expect([me.status, mine.status], bodies.join(' | ')).toEqual([200, 200]);
  // This person's own requests. The machine's are on the same channel and have
  // nothing to do with a person's first load: at this point they are the
  // derived-login searches the boot started, on the deployment token.
  return { ms, requests: events.slice(before).filter((event) => event.actor === 'person').length };
}

/** Nearest-rank quantile: the smallest sample at or above that share of them. */
function quantile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * share) - 1))];
}

it.each(Object.entries(SHAPES))('measures a cold first load for a %s grant', async (name, shape) => {
  process.env.FAKE_GRANTS = shape.grants;
  const owner = shape.grants.split(',')[0];
  const loads: { ms: number; requests: number }[] = [];
  for (let person = 0; person < PEOPLE; person++) {
    // A person of their own each time, so every load is a cold one.
    loads.push(await firstLoad(`person${shape.from + person}@example.test`, owner));
  }
  // Discovery is one installation listing plus one repository page per
  // installation, and the two reads of the pair share the one discovery. The
  // ingest then reads every repository the person's grants cover, once.
  const discovery = 1 + shape.owners;
  expect(loads.map((load) => load.requests)).toEqual(loads.map(() => discovery + shape.repositories));
  const times = loads.map((load) => load.ms);
  if (process.env.BOARD_MEASURE_GITHUB === '1') {
    console.log(JSON.stringify({
      shape: name, grantedOwners: shape.owners, repositories: shape.repositories, coldLoads: PEOPLE,
      requestsPerFirstLoad: discovery + shape.repositories, discovery, issueLists: shape.repositories,
      medianMs: Math.round(quantile(times, 0.5)), p95Ms: Math.round(quantile(times, 0.95)),
      slowestMs: Math.round(Math.max(...times)),
    }));
  }
});

/**
 * One active person-hour, measurement 3. The part 1 baseline in
 * `docs/ops/github-request-budget.md` counted discovery alone, by calling
 * `principal()` directly. This counts what the same hour costs through the
 * routes, so the issue ingest's refills are in it as well as the access
 * re-checks: the surfaces part 4 widened are what the comparison is about.
 *
 * The workload is My work left open: `/api/auth/me` and `/api/issues/mine`
 * every 20 seconds, which is the renewal cadence
 * `board-frontend/src/App.tsx` sets, for the half-open hour `[0, 3600)`.
 * Only Date is virtual, as in `github-scope-baseline.spec.ts`; the requests,
 * the caches and their TTLs all run normally.
 */
it.each(Object.entries(SHAPES))('measures one active person-hour for a %s grant', async (name, shape) => {
  process.env.FAKE_GRANTS = shape.grants;
  const owner = shape.grants.split(',')[0];
  // Nobody who has loaded already: their access pass would still be inside its
  // TTL, and this hour would measure a cache rather than an hour.
  const email = `person${shape.hour}@example.test`;
  const headers = { Authorization: `Bearer ${await session(email)}` };
  // A whole hour under BOARD_MEASURE_GITHUB=1, and eleven checks otherwise:
  // enough to hold the re-check cadence, and well inside the lane's budget. No
  // refill happens in 220 s, because the ingest's TTL is ten minutes, so only
  // the measurement run reports a refill.
  const seconds = process.env.BOARD_MEASURE_GITHUB === '1' ? 3600 : 220;
  // The hour starts now and only moves forward. A virtual clock set behind the
  // real one makes every cache this process already holds look fresh, which is
  // how an earlier draft of this measured an hour of nothing.
  const start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  const before = events.length;
  let checks = 0;
  try {
    for (let second = 0; second < seconds; second += 20) {
      vi.setSystemTime(start + second * 1000);
      checks++;
      const [me, mine] = await Promise.all([
        fetch(`${origin}/api/auth/me`, { headers }),
        fetch(`${origin}/api/issues/mine?org=${owner}&timeZone=UTC`, { headers }),
      ]);
      const bodies = await Promise.all([me.text(), mine.text()]);
      expect([me.status, mine.status], bodies.join(' | ')).toEqual([200, 200]);
    }
  } finally {
    vi.useRealTimers();
  }
  const own = events.slice(before).filter((event) => event.actor === 'person');
  const discovery = own.filter((event) => event.source === 'discovery');
  const measurement = {
    shape: name, grantedOwners: shape.owners, repositories: shape.repositories,
    checks, seconds, requests: own.length, discovery: discovery.length, surface: own.length - discovery.length,
    notModified: own.filter((event) => event.status === 304).length,
    // Github counts every answer except a 304 to a conditional request, so this
    // is the part of the hour that reaches the person's budget.
    billed: own.filter((event) => event.status !== 304).length,
    perActivePersonHour: Math.round((own.length * 3600) / seconds),
  };
  if (process.env.BOARD_MEASURE_GITHUB === '1') console.log(JSON.stringify(measurement));
  // Every check needs a fresh access pass, because the one before it has less
  // than MIN_READ_HEADROOM_MS left, so discovery scales with the checks and not
  // with the surfaces read.
  expect(measurement.discovery).toBe(checks * (1 + shape.owners));
  expect(measurement.surface).toBeGreaterThan(0);
});

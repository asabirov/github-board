import { createPrismaClient } from '../prisma';
import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SignJWT } from 'jose';
import { PrismaClient } from '../generated/prisma/client';
import { GithubUserService, GITHUB_DB } from '../auth/github-user.service';
import type { GithubPrincipal, GithubRepository } from '../auth/github-principal';
import { applyBodyParsers } from '../config/body-limits';
import { storedIssueOf } from '../issues-metrics/stored-issue';
import { PrismaIssueStore } from './issue-store';
import { WEBHOOK_PATH } from './webhook-body';

/**
 * The webhook store through the real AppModule and every guard (#1007, V5).
 *
 * Two claims, and the second is the one that matters. A delivery Github signed
 * gets through a guard chain built for people with no session at all, and one
 * that is not signed does not. And a signed-in person is answered from the
 * store for their own repository and never for another's, even though the
 * store holds both and the owner is live: the store sits behind the principal
 * guard and the person's repository list, not beside them.
 *
 * Github is a spy on `fetch` that answers every request with nothing and
 * records it, so the test can say which issue lists were read from Github:
 * none, while the store could answer.
 */

const SECRET = 'integration-webhook-secret-0123456789';
const ALPHA = 2_000_001;
const BETA = 2_000_002;
const GAMMA = 2_000_003;

// Clear inherited credentials, one line each so `spec-boot-credentials.spec.ts`
// can read them (#756).
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
  BOARD_ALLOWED_GITHUB: '',
  BOARD_ADMIN_EMAILS: '', BOARD_FIXTURE_ADMINS: '', BOARD_AGENT_TOKENS: '',
  BOARD_SESSION_SECRET: 'synthetic-board-session-secret-for-1007',
  GITHUB_WRITE_ENABLED: 'false', GITHUB_ORGS: 'acme',
  // No default since #1175.
  FEEDBACK_REPO: 'acme/board',
  ISSUES_SOURCE: 'github', PROJECTS_SOURCE: 'fixture', REPOS_SOURCE: 'fixture', DELIVERY_SOURCE: 'fixture',
  ISSUE_BUCKETS_SOURCE: 'fixture', ISSUE_DETAIL_SOURCE: 'fixture',
  GOOGLE_SERVICE_ACCOUNT_JSON: '', GOOGLE_DWD_SUBJECT: '',
  // The store's own schema, minted and migrated beside the identity one by
  // `vitest.db.config.ts`. The boot refuses a store pointing where DATABASE_URL
  // points (#1070, S4), and production's two databases are this shape.
  GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_STORE_DATABASE_URL: process.env.BOARD_DB_TEST_STORE_URL,
});

const githubPaths: string[] = [];
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== 'api.github.com') return realFetch(input, init);
  githubPaths.push(url.pathname);
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
});

const appModulePromise = import('../app.module.js');
// @ts-expect-error TS1309 — top-level await in a CommonJS module
const appModule = await appModulePromise;
const { AppModule } = appModule;

const repo = (id: number, name: string): GithubRepository => ({
  id, name, full_name: `acme/${name}`, owner: { login: 'acme' }, archived: false, fork: false, has_issues: true,
});
const REPOSITORIES: Record<string, GithubRepository[]> = {
  'a@example.test': [repo(ALPHA, 'alpha')],
  'b@example.test': [repo(BETA, 'beta')],
  // A repository the store holds nothing for, read from Github.
  'c@example.test': [repo(GAMMA, 'gamma')],
};

// On the store's own schema, the one the AppModule's store was pointed at
// above, so what this seeds is what the app reads (#1070, S4).
const prisma = createPrismaClient(process.env.BOARD_DB_TEST_STORE_URL);
const store = new PrismaIssueStore(prisma, 3_600_000);
let app: NestExpressApplication;
let origin: string;

function ghIssue(number: number, title: string) {
  return {
    number, title, html_url: `https://github.com/acme/x/issues/${number}`, state: 'open',
    created_at: '2026-09-01T00:00:00Z', updated_at: new Date().toISOString(), closed_at: null,
    user: { login: 'someone' }, assignees: [], labels: [], milestone: null, body: '',
  };
}

let deliveries = 0;
async function deliver(event: string, payload: unknown, sign = true): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', sign ? SECRET : 'not-the-secret-at-all-000').update(body).digest('hex')}`;
  return fetch(origin + WEBHOOK_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': `integration-${process.pid}-${++deliveries}`,
      'x-hub-signature-256': signature,
    },
    body,
  });
}

const issuesDelivery = (id: number, name: string, action: string, issue: ReturnType<typeof ghIssue>) => ({
  action,
  installation: { id: 7 },
  repository: { id, full_name: `acme/${name}`, owner: { login: 'acme' } },
  issue,
});

async function queueAs(email: string): Promise<string> {
  const token = await new SignJWT({ email }).setProtectedHeader({ alg: 'HS256' }).setSubject(`synthetic-${email}`)
    .setIssuer('atlas').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.BOARD_SESSION_SECRET));
  const response = await fetch(`${origin}/api/issues/all`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return response.text();
}

beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication<NestExpressApplication>({ rawBody: true });
  // The two lines of `main.ts` this depends on, in its order.
  app.setGlobalPrefix('api');
  applyBodyParsers(app, { webhook: true });
  vi.spyOn(app.get(GithubUserService), 'principal').mockImplementation(async (email: string): Promise<GithubPrincipal> => ({
    key: email, githubUserId: email, email, login: email[0], token: `synthetic-${email}`,
    owners: [{ login: 'acme', type: 'Organization' }], repositories: REPOSITORIES[email] ?? [],
    cache: new WeakMap(), permissionCache: new WeakMap(),
  }));
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});

afterAll(async () => {
  if (app) {
    await app.get<PrismaClient>(GITHUB_DB).$disconnect();
    await app.close();
  }
  await prisma.$disconnect();
});

describe('the webhook through the real guard chain (#1007, V5)', () => {
  it('takes a signed delivery with no session, and refuses one signed with anything else', async () => {
    const refused = await deliver('issues', issuesDelivery(ALPHA, 'alpha', 'labeled', ghIssue(1, 'Alpha plan')), false);
    expect(refused.status).toBe(401);
    const taken = await deliver('issues', issuesDelivery(ALPHA, 'alpha', 'labeled', ghIssue(1, 'Alpha plan')));
    expect(taken.status).toBe(200);
    expect(await taken.json()).toEqual({ status: 'applied' });
    expect(await prisma.githubWebhookOwner.findUnique({ where: { owner: 'acme' } })).not.toBeNull();
  });
});

describe('a person is answered from the store for their own repositories only (#1007, V5)', () => {
  beforeAll(async () => {
    // Two baselines begun after the owner went live, as two earlier Github
    // reads by two people would have left them.
    const began = Date.now();
    await store.baseline({ id: ALPHA, full: 'acme/alpha' }, [storedIssueOf(ghIssue(1, 'Alpha plan'))], began);
    await store.baseline({ id: BETA, full: 'acme/beta' }, [storedIssueOf(ghIssue(1, 'Beta private roadmap'))], began);
  });

  it('reads from Github a repository the store holds nothing for, which shows the spy sees Github', async () => {
    const before = githubPaths.length;
    await queueAs('c@example.test');
    expect(githubPaths.slice(before)).toContain('/repos/acme/gamma/issues');
  });

  it('serves each person their own repository from the store and never the other, reading no issue list from Github', async () => {
    const before = githubPaths.length;
    const a = await queueAs('a@example.test');
    const b = await queueAs('b@example.test');
    expect(a).toContain('Alpha plan');
    expect(a).not.toContain('Beta private roadmap');
    expect(b).toContain('Beta private roadmap');
    expect(b).not.toContain('Alpha plan');
    expect(githubPaths.slice(before).filter((p) => p.endsWith('/issues'))).toEqual([]);
  });

  it('shows a change Github delivered on the next read, still with no issue list read from Github', async () => {
    const before = githubPaths.length;
    const opened = await deliver('issues', issuesDelivery(ALPHA, 'alpha', 'opened', ghIssue(2, 'Arrived by webhook')));
    expect(opened.status).toBe(200);
    expect(await queueAs('a@example.test')).toContain('Arrived by webhook');
    expect(await queueAs('b@example.test')).not.toContain('Arrived by webhook');
    expect(githubPaths.slice(before).filter((p) => p.endsWith('/issues'))).toEqual([]);
  });
});

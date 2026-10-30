import 'reflect-metadata';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import { GithubUserService } from './github-user.service';
import { GITHUB_DB } from './github-user.service';
import type { PrismaClient } from '../generated/prisma/client';

// Clear inherited credentials before enabling only synthetic user OAuth.
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
  BOARD_SESSION_SECRET: 'synthetic-board-session-secret-for-892',
  // The settings #1175 took the defaults off, so a board that needs one and
  // names none is refused at boot.
  GITHUB_WRITE_ENABLED: 'false',
  GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board',
  ISSUES_SOURCE: 'fixture', PROJECTS_SOURCE: 'fixture', REPOS_SOURCE: 'fixture', DELIVERY_SOURCE: 'fixture',
  ISSUE_BUCKETS_SOURCE: 'fixture', ISSUE_DETAIL_SOURCE: 'fixture',
  GOOGLE_SERVICE_ACCOUNT_JSON: '', GOOGLE_DWD_SUBJECT: '',
});
const appModulePromise = import('../app.module.js');
// @ts-expect-error TS1309 — top-level await in a CommonJS module
const { AppModule } = await appModulePromise;
let app: INestApplication;
let origin: string;
beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication(); app.setGlobalPrefix('api');
  vi.spyOn(app.get(GithubUserService), 'principal').mockImplementation(async (email: string) => {
    await new Promise((resolve) => setTimeout(resolve, email.startsWith('a') ? 10 : 1));
    return { key: email, email, login: email[0], token: `synthetic-${email}`, owners: [{ login: email[0], type: 'User' }], repositories: [], cache: new WeakMap(), permissionCache: new WeakMap() };
  });
  await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
});
afterAll(async () => { if (app) { await app.get<PrismaClient>(GITHUB_DB).$disconnect(); await app.close(); } });
it('keeps simultaneous admitted HTTP requests in their own Github principal through the real guard chain', async () => {
  const replies = await Promise.all(['a','b'].map(async (name) => {
    const token = await new SignJWT({ email: `${name}@example.test` }).setProtectedHeader({ alg: 'HS256' }).setSubject(`synthetic-${name}`).setIssuer('atlas').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.BOARD_SESSION_SECRET));
    const response = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ githubLogin: string; github: { owners: { login: string }[]; visibilityKey: string } }>;
  }));
  expect(replies.map((r) => r.githubLogin)).toEqual(['a','b']);
  expect(replies.map((r) => r.github.owners[0].login)).toEqual(['a','b']);
  expect(replies[0].github.visibilityKey).not.toBe(replies[1].github.visibilityKey);
});

it('missing App configuration leaves an admitted person unconnected and sends no shared Github reads', async () => {
  vi.restoreAllMocks();
  const realFetch = globalThis.fetch;
  let remoteCalls = 0;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (!String(input).startsWith(origin)) { remoteCalls++; throw new Error('Unexpected external call'); }
    return realFetch(input, init);
  });
  try {
    const token = await new SignJWT({ email: 'a@example.test' }).setProtectedHeader({ alg: 'HS256' }).setSubject('synthetic-a').setIssuer('atlas').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.BOARD_SESSION_SECRET));
    const headers = { Authorization: `Bearer ${token}` };
    const meResponse = await fetch(`${origin}/api/auth/me`, { headers });
    expect(meResponse.status).toBe(200);
    expect(meResponse.headers.get('cache-control')).toContain('no-store');
    const me = await meResponse.json() as { github: { configured: boolean; connected: boolean; owners: unknown[] }; writesEnabled: boolean };
    expect(me.github).toMatchObject({ configured: false, connected: false, owners: [] });
    expect(me.writesEnabled).toBe(false);
    // `/api/sync/sources` is on this list because `sync` is a whole segment of
    // GITHUB_SURFACE (#1169 review, B1): the freshness read skips
    // `operationOwner()`, and that is not the same as being reachable with no
    // connection. The route's docblock says so; this is what holds it.
    for (const path of ['/api/repos','/api/issues/all','/api/projects','/api/sync/sources']) {
      const response = await fetch(origin + path, { headers });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ message: 'Sign in with GitHub to use this surface' });
    }
    expect(remoteCalls).toBe(0);
  } finally { spy.mockRestore(); }
});

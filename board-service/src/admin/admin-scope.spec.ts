import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { request as httpRequest } from 'http';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { CanActivate, ExecutionContext, INestApplication, Injectable } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminAccessService } from './admin-access.service';
import { AgentsService } from './agents.service';
import { AuditService } from '../audit/audit.service';
import { AdminAuthority } from '../auth/admin-authority';
import { RequiredScopesGuard } from '../auth/required-scopes.guard';
import { BOARD_ADMIN, BOARD_READ } from '../auth/scopes';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { IdentityController } from '../identity/identity.controller';
import { IDENTITY_REPOSITORY, IdentityRecord, IdentityRepository } from '../identity/identity.repository';
import { fakeIdentityStore } from '../identity/identity.test-double';
import { WriteIdentityService } from '../sources/write-identity.service';
import { GithubLoginResolver } from '../identity/github-login.resolver';
import { AdminEmailCache } from '../auth/group-admins/admin-email-cache';

/**
 * The admin surface's scope contract (#471), driven over real HTTP through the
 * real guard chain (RequiredScopesGuard globally, then the controllers' own
 * AdminGuard / HumanOnlyGuard) so the assertions cover the actual route
 * decorators, not a hand-built ExecutionContext.
 *
 * The bug: the admin READS declared no scope, and RequiredScopesGuard defaults
 * an undecorated GET to board:read — which every personal access token carries.
 * An admin's read-only token therefore satisfied AdminGuard (email) and the
 * scope gate alike, and could read the org's whole token inventory and audit
 * log. Promoting somebody to admin silently widened every token they already
 * held.
 *
 * Only JwtAuthGuard is stubbed, and only to inject the actor shapes it produces:
 * a human session (no `scopes`), and a scoped actor with the scopes its token
 * carries. Everything downstream is the production wiring.
 */

const ADMIN = 'admin@example.com';
const TEAMMATE = 'dev@example.com';
/** A static agent's synthetic address, sitting in the admin set (#551). */
const AGENT_ADDRESS = 'agent:ci';

type Actor = { sub: string; email: string; agent?: boolean; staticAgent?: boolean; scopes?: string[] };

/** A signed-in admin's browser session — humans carry no scopes. */
const adminHuman: Actor = { sub: 'u-admin', email: ADMIN };
/** A non-admin teammate's browser session. */
const teammateHuman: Actor = { sub: 'u-dev', email: TEAMMATE };
/** An admin's read-only personal access token — the actor at the heart of #471. */
const adminReadToken: Actor = { sub: ADMIN, email: ADMIN, agent: true, scopes: [BOARD_READ] };
/** An admin's token that actually carries the admin scope. */
const adminFullToken: Actor = { sub: ADMIN, email: ADMIN, scopes: [BOARD_READ, BOARD_ADMIN] };
/**
 * A static `BOARD_AGENT_TOKENS` actor whose synthetic address is in the admin
 * set, carrying board:admin so the scope gate lets it reach AdminGuard (#551).
 *
 * The scope half is not reachable today — the static preset is board:read — and
 * that is the point: the two refusals #551 describes are independent, and this
 * actor removes the scope one so the guard's own answer is what the assertion
 * reads. Personhood is the `staticAgent` flag `jwt-auth.guard` writes (#525),
 * never the shape of the address.
 */
const staticAgentAdmin: Actor = {
  sub: AGENT_ADDRESS,
  email: AGENT_ADDRESS,
  agent: true,
  staticAgent: true,
  scopes: [BOARD_READ, BOARD_ADMIN],
};

/** Stands in for JwtAuthGuard: reads the actor a test wants from a header. */
@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const raw = req.headers['x-test-actor'];
    if (raw) req.user = JSON.parse(String(raw)) as Actor;
    return true;
  }
}

const identityRecord: IdentityRecord = {
  id: 'id-1',
  displayName: 'Dev',
  emails: [TEAMMATE],
  githubLogin: null,
  clickupUserId: null,
  clickupNames: [],
  role: null,
};

describe('admin surface scope contract (#471)', () => {
  let app: INestApplication;
  let port: number;
  let revoked: string[];

  beforeAll(async () => {
    revoked = [];
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController, IdentityController],
      providers: [
        AdminGuard,
        HumanOnlyGuard,
        { provide: APP_GUARD, useClass: StubAuthGuard },
        { provide: APP_GUARD, useClass: RequiredScopesGuard },
        // The REAL authority, not a hand-written `{ isAdmin }` stub: since #551
        // the guard consults `isAdminActor`, and a stub that answers one of the
        // two methods is exactly the drift this spec exists to catch. It reads
        // the AdminEmailCache below — the module's one admin snapshot, rather
        // than a second list living here.
        {
          provide: AdminAuthority,
          inject: [AdminEmailCache],
          useFactory: (cache: AdminEmailCache) =>
            new AdminAuthority(
              {
                get: (key: string, def?: unknown) => (key === 'BOARD_ADMIN_EMAILS' ? '' : def),
              } as unknown as ConfigService,
              cache,
            ),
        },
        {
          provide: AdminAccessService,
          useValue: { getModel: async () => ({ admins: [], people: [], rosterUnavailable: false }) },
        },
        {
          provide: AgentsService,
          useValue: {
            getModel: async () => ({ scopes: [], presets: [], tools: [], mcpUrl: null, agents: [] }),
            revokeAgent: async (id: string) => {
              revoked.push(id);
              return true;
            },
          },
        },
        { provide: AuditService, useValue: { record: async () => {}, list: async () => [], health: () => ({ recording: 'ok', failures: 0, lastFailureAt: null }) } },
        {
          provide: IDENTITY_REPOSITORY,
          useValue: {
            ...fakeIdentityStore([identityRecord]),
            upsert: async () => identityRecord,
          } as IdentityRepository,
        },
        // The admin snapshot `StoredRoleAdminSource` builds in production: the
        // addresses on every row stored with the `admin` role. `AGENT_ADDRESS`
        // is on it because a roster row CAN carry a synthetic address — one of
        // the two ways #551 names for such an address to become an admin.
        {
          provide: AdminEmailCache,
          useValue: { emails: () => [ADMIN, AGENT_ADDRESS], invalidate: () => {} },
        },
        // The identity upsert drops the roster memo (#541), so the controller
        // needs the resolver. Real one over the same store — it is a memo, not
        // an authority, and stubbing it would test nothing.
        {
          provide: GithubLoginResolver,
          inject: [IDENTITY_REPOSITORY],
          useFactory: (identities: IdentityRepository) => new GithubLoginResolver(identities),
        },
        // #756. A stub, and deliberately: this spec is about who may reach the
        // route, not what it answers, and the real service would make a Github
        // call from a unit test to say so.
        {
          provide: WriteIdentityService,
          useValue: {
            resolve: async () => ({
              state: 'unknown',
              login: null,
              reason: 'no credential in this test',
              checkedAt: '2026-09-01T00:00:00.000Z',
              writesEnabled: false,
              separateWriteToken: false,
            }),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo | string | null;
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
    port = address.port;
  });

  afterAll(async () => {
    await app?.close();
  });

  function call(
    method: string,
    path: string,
    actor: Actor,
    body?: unknown,
  ): Promise<{ status: number; json: unknown; headers: Record<string, string | string[] | undefined> }> {
    return new Promise((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'x-test-actor': JSON.stringify(actor),
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let json: unknown;
            try {
              json = data ? JSON.parse(data) : undefined;
            } catch {
              json = data;
            }
            resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const READS = ['/api/admin/access', '/api/admin/agents', '/api/admin/audit', '/api/admin/write-identity'];

  describe('an admin-owned read-only token is refused on every admin read', () => {
    for (const path of READS) {
      it(`GET ${path} → 403 for a board:read token owned by an admin`, async () => {
        const res = await call('GET', path, adminReadToken);
        expect(res.status).toBe(403);
        expect(String((res.json as { message?: string }).message)).toMatch(/board:admin/);
      });
    }
  });

  describe('an admin-owned token holding board:admin still reaches the reads', () => {
    for (const path of READS) {
      it(`GET ${path} → 200`, async () => {
        expect((await call('GET', path, adminFullToken)).status).toBe(200);
      });
    }
  });

  describe('every admin read forbids a shared cache', () => {
    // `@Header('Cache-Control', 'no-store')` sits on all four handlers and was
    // asserted nowhere: the helper above used to throw `res.headers` away, so
    // the decorator could come off any of them and every test here would stay
    // green. An admin-scoped read of who this deployment writes as, or of the
    // audit trail, has no business in a proxy cache.
    for (const path of READS) {
      it(`GET ${path} answers Cache-Control: no-store`, async () => {
        const res = await call('GET', path, adminHuman);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
      });
    }
  });

  describe('a signed-in admin human is unaffected on every admin route', () => {
    for (const path of READS) {
      it(`GET ${path} → 200`, async () => {
        expect((await call('GET', path, adminHuman)).status).toBe(200);
      });
    }

    it('DELETE /api/admin/agents/:id → 204', async () => {
      expect((await call('DELETE', '/api/admin/agents/live', adminHuman)).status).toBe(204);
      expect(revoked).toContain('live');
    });

    it('PUT /api/admin/identity → 200', async () => {
      const res = await call('PUT', '/api/admin/identity', adminHuman, {
        email: TEAMMATE,
        displayName: 'Dev',
        emails: [TEAMMATE],
      });
      expect(res.status).toBe(200);
    });
  });

  // #551 — the gate's own answer, on a real route through the real chain. The
  // address IS in the admin set here, and the scope layer has nothing left to
  // say, so a 403 can only be AdminGuard. Before #551 every one of these was a
  // 200: AdminGuard asked about the address alone, while /api/auth/me had
  // already stopped resolving that address as a person's (#546).
  describe('a caller with no person behind it cannot pass the admin gate (#551)', () => {
    it('the synthetic address really is in the admin set (so the 403s below are the gate, not a miss)', () => {
      expect(app.get(AdminAuthority).isAdmin(AGENT_ADDRESS)).toBe(true);
    });

    for (const path of READS) {
      it(`GET ${path} → 403 for a static agent holding board:admin`, async () => {
        const res = await call('GET', path, staticAgentAdmin);
        expect(res.status).toBe(403);
        // Pin WHICH gate refused. RequiredScopesGuard is satisfied by the
        // board:admin on this actor, so a scope-worded refusal here would mean
        // the assertion is reading the wrong denial and the guard is untested.
        expect(String((res.json as { message?: string }).message)).toMatch(/admin access required/);
      });
    }

    // The gate's OTHER route. IdentityController is the second controller behind
    // AdminGuard, and looping the reads alone left the guard's changed answer
    // unpinned there. Two other refusals could plausibly land first, and the
    // message says which one did: the PUT declares board:admin and this actor
    // carries it, so RequiredScopesGuard passes it through; and Nest runs
    // controller guards in the order @UseGuards(AdminGuard, HumanOnlyGuard)
    // lists them, so AdminGuard answers before HumanOnlyGuard sees the caller at
    // all. A 'signed-in users only' body here would mean the order is the other
    // way round and this asserts nothing about AdminGuard.
    it('PUT /api/admin/identity → 403 for a static agent holding board:admin', async () => {
      const res = await call('PUT', '/api/admin/identity', staticAgentAdmin, {
        email: TEAMMATE,
        displayName: 'Dev',
        emails: [TEAMMATE],
      });
      expect(res.status).toBe(403);
      expect(String((res.json as { message?: string }).message)).toMatch(/admin access required/);
    });
  });

  describe('a non-admin teammate is still refused by AdminGuard', () => {
    for (const path of READS) {
      it(`GET ${path} → 403`, async () => {
        expect((await call('GET', path, teammateHuman)).status).toBe(403);
      });
    }
  });

  // The write protections were already correct; pin them so a later refactor
  // (e.g. hoisting @RequiredScopes to the controller class) can't reopen them.
  describe('write protections stay closed to every token', () => {
    it('DELETE /api/admin/agents/:id → 403 even with board:admin (undecorated write, fail-closed)', async () => {
      const res = await call('DELETE', '/api/admin/agents/live', adminFullToken);
      expect(res.status).toBe(403);
      expect(revoked).not.toContain('never-reached');
    });

    it('DELETE /api/admin/agents/:id → 403 for a board:read token', async () => {
      expect((await call('DELETE', '/api/admin/agents/live', adminReadToken)).status).toBe(403);
    });

    // The static agent from the #551 block reaches this write no further than
    // any other token does. The refusal is the fail-closed default for an
    // undecorated write (RequiredScopesGuard, a global guard, answers before
    // AdminGuard) — asserted for the belt, not because AdminGuard needs it.
    it('DELETE /api/admin/agents/:id → 403 for a static agent, and nothing is revoked', async () => {
      const before = [...revoked];
      expect((await call('DELETE', '/api/admin/agents/live', staticAgentAdmin)).status).toBe(403);
      expect(revoked).toEqual(before);
    });

    it('PUT /api/admin/identity → 403 for a board:read token (missing board:admin)', async () => {
      const res = await call('PUT', '/api/admin/identity', adminReadToken, {
        email: TEAMMATE,
        displayName: 'Dev',
        emails: [TEAMMATE],
      });
      expect(res.status).toBe(403);
      expect(String((res.json as { message?: string }).message)).toMatch(/board:admin/);
    });

    it('PUT /api/admin/identity → 403 for a board:admin token (HumanOnlyGuard)', async () => {
      const res = await call('PUT', '/api/admin/identity', adminFullToken, {
        email: TEAMMATE,
        displayName: 'Dev',
        emails: [TEAMMATE],
      });
      expect(res.status).toBe(403);
      expect(String((res.json as { message?: string }).message)).toMatch(/signed-in users only/);
    });
  });
});

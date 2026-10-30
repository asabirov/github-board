import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { request as httpRequest } from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CanActivate, ExecutionContext, INestApplication, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ConnectedClientsController } from './connected-clients.controller';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { RequiredScopesGuard } from '../auth/required-scopes.guard';
import { BOARD_READ } from '../auth/scopes';
import { AuditService } from '../audit/audit.service';
import type { RecordAudit } from '../audit/audit.types';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { InMemoryMcpGrantRepository, MCP_GRANT_REPOSITORY } from './mcp-grant.repository';
import { InMemoryClientsStore, MCP_CLIENTS_STORE } from './oauth-store';

/**
 * The account area's connected-clients surface (#456), driven over real HTTP
 * through the real guard chain so the assertions cover the route decorators the
 * controller actually wears. Instantiating `HumanOnlyGuard` and calling it would
 * prove the guard works and say nothing about whether this controller is
 * wearing one — which is the only question the refusal test is asking.
 *
 * Only JwtAuthGuard is stubbed, and only to inject the actor shapes it produces:
 * a human session (no `scopes`), and a scoped actor carrying a token's scopes.
 */

type Actor = { sub: string; email: string; agent?: boolean; scopes?: string[] };

const OWNER: Actor = { sub: 'u-owner', email: 'owner@example.com' };
const OTHER: Actor = { sub: 'u-other', email: 'other@example.com' };
/** A personal access token owned by the same person — never a way in here. */
const OWNER_TOKEN: Actor = { ...OWNER, agent: true, scopes: [BOARD_READ] };

@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const raw = req.headers['x-test-actor'];
    if (raw) req.user = JSON.parse(String(raw)) as Actor;
    return true;
  }
}

/** Prisma maps DateTime to millisecond precision, so two grants created inside
 *  one millisecond tie on `createdAt` and their order is unspecified. The
 *  ordering assertion below wants a real gap, not a coin flip. */
const tick = () => new Promise((r) => setTimeout(r, 3));

describe('GET/DELETE /api/account/clients (#456)', () => {
  let app: INestApplication;
  let port: number;
  let repo: InMemoryMcpGrantRepository;
  let clients: InMemoryClientsStore;
  let revocation: SessionRevocationService;
  let audited: RecordAudit[];
  let identitySource: string;

  beforeEach(async () => {
    repo = new InMemoryMcpGrantRepository();
    clients = new InMemoryClientsStore();
    revocation = new SessionRevocationService();
    audited = [];
    identitySource = 'db';

    const moduleRef = await Test.createTestingModule({
      controllers: [ConnectedClientsController],
      providers: [
        HumanOnlyGuard,
        { provide: APP_GUARD, useClass: StubAuthGuard },
        { provide: APP_GUARD, useClass: RequiredScopesGuard },
        { provide: MCP_GRANT_REPOSITORY, useValue: repo },
        { provide: MCP_CLIENTS_STORE, useValue: clients },
        { provide: SessionRevocationService, useValue: revocation },
        {
          provide: AuditService,
          useValue: { record: async (e: RecordAudit) => void audited.push(e) },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, def?: unknown) =>
              key === 'IDENTITY_SOURCE' ? identitySource : def,
          } as unknown as ConfigService,
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

  afterEach(async () => {
    await app?.close();
  });

  function call(method: string, path: string, actor: Actor): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: { 'x-test-actor': JSON.stringify(actor) },
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
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  const registerClient = (clientId: string, name?: string) =>
    clients.registerClient({
      client_id: clientId,
      client_name: name,
      redirect_uris: ['http://127.0.0.1/cb'],
    } as never);

  const grantFor = (actor: Actor, clientId: string, scopes = [BOARD_READ]) =>
    repo.createGrant({ sub: actor.sub, email: actor.email, clientId, scopes });

  describe('the list', () => {
    it('returns the caller’s own un-revoked grants, newest first', async () => {
      await registerClient('c-old', 'Claude Desktop');
      await registerClient('c-new', 'Cursor');
      const older = await grantFor(OWNER, 'c-old');
      await tick();
      const newer = await grantFor(OWNER, 'c-new');
      await tick();
      const revoked = await grantFor(OWNER, 'c-gone');
      await repo.revokeGrant(revoked.id, new Date());
      await grantFor(OTHER, 'c-new');

      const res = await call('GET', '/api/account/clients', OWNER);

      expect(res.status).toBe(200);
      expect(res.json.enabled).toBe(true);
      expect(res.json.clients.map((c: { id: string }) => c.id)).toEqual([newer.id, older.id]);
      expect(res.json.clients[0].clientName).toBe('Cursor');
      expect(res.json.clients[1].clientName).toBe('Claude Desktop');
    });

    it('never returns a token value or the grant’s refresh pointer', async () => {
      await registerClient('c1', 'Claude Desktop');
      const grant = await repo.createGrant({
        sub: OWNER.sub,
        email: OWNER.email,
        clientId: 'c1',
        scopes: [BOARD_READ],
        currentRefreshHash: 'a'.repeat(64),
      });
      await repo.recordRefreshToken({
        tokenHash: 'a'.repeat(64),
        grantId: grant.id,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const res = await call('GET', '/api/account/clients', OWNER);

      expect(JSON.stringify(res.json)).not.toContain('a'.repeat(64));
      expect(Object.keys(res.json.clients[0]).sort()).toEqual(
        ['clientId', 'clientName', 'createdAt', 'id', 'lastRefreshedAt', 'scopes'].sort(),
      );
    });

    it('carries both stamps, so two grants from the same client name can be told apart', async () => {
      // One person can hold several grants from one client — authorizing it
      // twice, running it on two machines, or re-authorizing after a stolen
      // refresh token killed the last one, where the older row is the thief's.
      // The dates are the only thing on the row that separates them.
      await registerClient('c-mine', 'Claude Desktop');
      await registerClient('c-theirs', 'Claude Desktop');
      const mine = await grantFor(OWNER, 'c-mine');
      await repo.touchRefreshed(mine.id, new Date());
      await tick();
      await grantFor(OWNER, 'c-theirs');

      const res = await call('GET', '/api/account/clients', OWNER);

      expect(res.json.clients).toHaveLength(2);
      expect(new Set(res.json.clients.map((c: { clientName: string }) => c.clientName))).toEqual(
        new Set(['Claude Desktop']),
      );
      const listed = res.json.clients.find((c: { id: string }) => c.id === mine.id);
      expect(typeof listed.createdAt).toBe('string');
      expect(typeof listed.lastRefreshedAt).toBe('string');
      const never = res.json.clients.find((c: { id: string }) => c.id !== mine.id);
      expect(never.lastRefreshedAt).toBeNull();
    });

    it('falls back to the client id when the registration carries no name', async () => {
      await registerClient('c-nameless');
      await grantFor(OWNER, 'c-nameless');

      const res = await call('GET', '/api/account/clients', OWNER);

      expect(res.json.clients[0].clientName).toBeNull();
      expect(res.json.clients[0].clientId).toBe('c-nameless');
    });

    it('reports enabled:false with no rows when there is no database', async () => {
      identitySource = 'fixture';
      await grantFor(OWNER, 'c1');

      const res = await call('GET', '/api/account/clients', OWNER);

      expect(res.json).toEqual({ enabled: false, clients: [] });
    });
  });

  describe('the revoke', () => {
    it('revokes the caller’s own grant and primes the denylist', async () => {
      const grant = await grantFor(OWNER, 'c1');
      await repo.recordAccessToken({
        jti: 'jti-live',
        grantId: grant.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const res = await call('DELETE', `/api/account/clients/${grant.id}`, OWNER);

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ revoked: true });
      expect(revocation.isRevoked('jti-live')).toBe(true);
      expect(await repo.listGrantsForSubject(OWNER.sub)).toEqual([]);
      expect(audited.map((e) => e.action)).toEqual(['oauth.revoke']);
      expect(audited[0].actorEmail).toBe(OWNER.email);
    });

    it('succeeds on the caller’s own grant whose access tokens have all expired', async () => {
      // `revokeGrantForOwner` answers `[]` here, not `null`. A handler that reads
      // every empty result as "not found" passes the test above and tells this
      // person their revoke failed when it worked.
      const grant = await grantFor(OWNER, 'c1');
      await repo.recordAccessToken({
        jti: 'jti-dead',
        grantId: grant.id,
        expiresAt: new Date(Date.now() - 1_000),
      });

      const res = await call('DELETE', `/api/account/clients/${grant.id}`, OWNER);

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ revoked: true });
      expect(await repo.findGrant(grant.id)).toMatchObject({ revokedAt: expect.any(Date) });
    });

    it('404s on another person’s grant and leaves it live', async () => {
      const victim = await grantFor(OTHER, 'c1');

      const res = await call('DELETE', `/api/account/clients/${victim.id}`, OWNER);

      expect(res.status).toBe(404);
      // A handler that revoked first and threw afterwards would pass a
      // status-only check, so the victim's row is what the assertion reads.
      expect(await repo.findGrant(victim.id)).toMatchObject({ revokedAt: null });
      expect(await repo.listGrantsForSubject(OTHER.sub)).toHaveLength(1);
      expect(audited).toEqual([]);
    });

    it('404s on a grant id that does not exist', async () => {
      const res = await call('DELETE', '/api/account/clients/no-such-grant', OWNER);
      expect(res.status).toBe(404);
    });
  });

  describe('the guard', () => {
    it('refuses a scoped actor on the list, even one owned by the caller', async () => {
      await grantFor(OWNER, 'c1');
      const res = await call('GET', '/api/account/clients', OWNER_TOKEN);
      expect(res.status).toBe(403);
    });

    it('refuses a scoped actor on the revoke, and revokes nothing', async () => {
      const grant = await grantFor(OWNER, 'c1');
      const res = await call('DELETE', `/api/account/clients/${grant.id}`, OWNER_TOKEN);
      expect(res.status).toBe(403);
      expect(await repo.findGrant(grant.id)).toMatchObject({ revokedAt: null });
    });
  });
});

describe('the connected-clients controller wears HumanOnlyGuard', () => {
  it('declares it in metadata', () => {
    const guards = Reflect.getMetadata('__guards__', ConnectedClientsController) as unknown;
    // `expect(undefined).toContain(x)` passes silently in vitest, so the shape is
    // asserted before the membership is.
    expect(Array.isArray(guards)).toBe(true);
    expect(guards as unknown[]).toContain(HumanOnlyGuard);
  });
});

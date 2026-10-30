import { createPrismaClient } from '../prisma';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CODE_TTL_MS,
  PENDING_TTL_MS,
  PrismaClientsStore,
  PrismaCodeStore,
  PrismaPendingAuthStore,
} from './oauth-store';
import { PrismaMcpGrantRepository } from './mcp-grant.repository';

/**
 * The OAuth state that used to live in process memory, against a real Postgres
 * (#456). Run with `pnpm run test:db`; `pnpm test` does not collect `.db-spec.ts`.
 *
 * What only this lane can prove: that a registration survives the restart that
 * every merge causes, and that a code which leaked and was never redeemed stops
 * being redeemable at its TTL. The second one is not a property of the schema —
 * `createdAt` sits on the row whether or not anything reads it back, which is how
 * a five-minute credential quietly becomes permanent.
 */

const prisma = createPrismaClient();

/** Namespaced per run, so two runs against one database cannot collide. */
const ns = `store-db-spec-${process.pid}-${Date.now()}`;

/** Every id this file writes, so teardown can find rows that have no `sub`. */
const pendingIds: string[] = [];
const codeHashes: string[] = [];

afterAll(async () => {
  await prisma.mcpClient.deleteMany({ where: { clientId: { startsWith: ns } } });
  if (pendingIds.length > 0) {
    await prisma.mcpPendingAuth.deleteMany({ where: { id: { in: pendingIds } } });
  }
  if (codeHashes.length > 0) {
    await prisma.mcpAuthCode.deleteMany({ where: { codeHash: { in: codeHashes } } });
  }
  await prisma.$disconnect();
});

const pendingInput = (clientId: string) => ({
  clientId,
  redirectUri: 'http://localhost:1234/cb',
  codeChallenge: 'ch',
  state: 'st',
  requestedScopes: ['board:read'],
  initiator: 'browser-secret-that-is-long-enough',
});

const codeInput = (clientId: string) => ({
  clientId,
  redirectUri: 'http://localhost:1234/cb',
  codeChallenge: 'ch',
  scopes: ['board:read'],
  sub: 'u1',
  email: 'u1@example.com',
});

describe('PrismaClientsStore', () => {
  it('a registered client survives a new store instance over the same database', async () => {
    const clientId = `${ns}-survivor`;
    const registering = new PrismaClientsStore(prisma);
    await registering.registerClient({
      client_id: clientId,
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:1234/cb'],
    } as never);

    // A second instance stands in for the restart every merge causes. The old
    // in-memory registry died with the process, and the SDK's token handler
    // answers `invalid_client` for a registration that is gone — so this is the
    // difference between a deploy and a re-authorization for everybody.
    const afterRestart = new PrismaClientsStore(prisma);
    const back = await afterRestart.getClient(clientId);

    expect(back).toMatchObject({ client_id: clientId, client_name: 'Claude Code' });
    expect(await afterRestart.getClient(`${ns}-never-registered`)).toBeUndefined();
  });

  it('stores no client secret, because it hands the client none', async () => {
    const clientId = `${ns}-public`;
    const store = new PrismaClientsStore(prisma);

    const registered = await store.registerClient({
      client_id: clientId,
      client_secret: 'a-secret-the-sdk-minted',
      client_secret_expires_at: 0,
      redirect_uris: ['http://localhost:1234/cb'],
    } as never);

    // What the client is told, which the SDK sends back verbatim.
    expect(registered.client_secret).toBeUndefined();
    expect(registered.token_endpoint_auth_method).toBe('none');
    // And what is at rest. Read the raw row, not the store's own answer: a store
    // that stripped the secret only on the way out would pass the assertions
    // above and still have written it down.
    const row = await prisma.mcpClient.findUnique({ where: { clientId } });
    expect(JSON.stringify(row)).not.toContain('a-secret-the-sdk-minted');
  });
});

describe('PrismaPendingAuthStore', () => {
  it('does not return a pending record older than its TTL', async () => {
    let t = Date.parse('2026-08-12T10:00:00Z');
    const store = new PrismaPendingAuthStore(prisma, () => t);
    const id = await store.create(pendingInput(`${ns}-pending`));
    pendingIds.push(id);

    // Live before, dead after — the same record through the same store, so this
    // cannot pass against a `peek` that always answered null.
    expect(await store.peek(id)).not.toBeNull();
    t += PENDING_TTL_MS + 1;
    expect(await store.peek(id)).toBeNull();
  });

  it('holds the initiator hashed, never the secret the browser was given', async () => {
    const store = new PrismaPendingAuthStore(prisma);
    const id = await store.create(pendingInput(`${ns}-init`));
    pendingIds.push(id);

    const row = await prisma.mcpPendingAuth.findUnique({ where: { id } });
    expect(row!.initiatorHash).not.toBe('browser-secret-that-is-long-enough');
    expect(row!.initiatorHash).toMatch(/^[0-9a-f]{64}$/);
    // And what comes back out is that same hash, which is what the consent
    // screen compares the browser's hashed cookie against.
    expect((await store.peek(id))!.initiator).toBe(row!.initiatorHash);
  });
});

describe('PrismaCodeStore', () => {
  it('a code is single-use, so a second consume finds nothing', async () => {
    const store = new PrismaCodeStore(prisma);
    const code = await store.create(codeInput(`${ns}-once`));
    codeHashes.push(...(await hashesFor(code)));

    expect(await store.consume(code)).toMatchObject({ sub: 'u1', scopes: ['board:read'] });
    expect(await store.consume(code)).toBeNull();
  });

  it('refuses a code past its TTL from both peekChallenge and consume', async () => {
    // The one that matters most. `createdAt` sits on the row whether or not
    // anything reads it, so a store that persisted the column and never
    // consulted it would keep a leaked, never-redeemed code redeemable forever
    // — and every other test in this file would still pass.
    let t = Date.parse('2026-08-12T10:00:00Z');
    const store = new PrismaCodeStore(prisma, () => t);
    const code = await store.create(codeInput(`${ns}-stale`));
    codeHashes.push(...(await hashesFor(code)));

    expect(await store.peekChallenge(code)).toBe('ch');
    t += CODE_TTL_MS + 1;
    expect(await store.peekChallenge(code)).toBeNull();
    expect(await store.consume(code)).toBeNull();
  });

  it('stores the hash of the code, never the code', async () => {
    const store = new PrismaCodeStore(prisma);
    const code = await store.create(codeInput(`${ns}-hashed`));
    codeHashes.push(...(await hashesFor(code)));

    const rows = await prisma.mcpAuthCode.findMany({ where: { clientId: `${ns}-hashed` } });
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).not.toBe(code);
    expect(rows[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('pruneExpired covers the pending and code tables too', () => {
  it('drops a pending record and a code past their TTLs, keeping fresh ones', async () => {
    // Task 1's version stopped at the three token tables because these two did
    // not exist yet. An auth table nobody prunes is a table nobody audits, and
    // this is the seam where each half could assume the other did it.
    const now = new Date('2026-08-12T12:00:00Z');
    const stale = () => now.getTime() - PENDING_TTL_MS - CODE_TTL_MS - 60_000;

    const stalePending = new PrismaPendingAuthStore(prisma, stale);
    const freshPending = new PrismaPendingAuthStore(prisma, () => now.getTime());
    const staleId = await stalePending.create(pendingInput(`${ns}-prune`));
    const freshId = await freshPending.create(pendingInput(`${ns}-prune`));
    pendingIds.push(staleId, freshId);

    const staleCodes = new PrismaCodeStore(prisma, stale);
    const freshCodes = new PrismaCodeStore(prisma, () => now.getTime());
    const staleCode = await staleCodes.create(codeInput(`${ns}-prune`));
    const freshCode = await freshCodes.create(codeInput(`${ns}-prune`));
    codeHashes.push(...(await hashesFor(staleCode)), ...(await hashesFor(freshCode)));

    await new PrismaMcpGrantRepository(prisma).pruneExpired(now);

    expect(await prisma.mcpPendingAuth.findUnique({ where: { id: staleId } })).toBeNull();
    expect(await prisma.mcpPendingAuth.findUnique({ where: { id: freshId } })).not.toBeNull();
    // Read through the store at the stale clock, so the fresh code's own TTL is
    // not what answers here.
    expect(await freshCodes.peekChallenge(staleCode)).toBeNull();
    expect(await freshCodes.peekChallenge(freshCode)).toBe('ch');
  });
});

/** The row key a plaintext code is stored under, for teardown. */
async function hashesFor(code: string): Promise<string[]> {
  const { createHash } = await import('node:crypto');
  return [createHash('sha256').update(code).digest('hex')];
}

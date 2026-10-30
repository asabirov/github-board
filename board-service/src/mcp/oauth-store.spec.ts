import { describe, it, expect } from 'vitest';
import { CODE_TTL_MS, CodeStore, hashSecret, InMemoryClientsStore, PENDING_TTL_MS, PendingAuthStore } from './oauth-store';

const PENDING = {
  clientId: 'c1',
  redirectUri: 'http://localhost:1234/cb',
  codeChallenge: 'ch',
  state: 's1',
};
const RECORD = {
  clientId: 'c1',
  redirectUri: 'http://localhost:1234/cb',
  codeChallenge: 'ch',
  scopes: ['board:read', 'board:admin'],
  sub: 'u1',
  email: 'a@example.com',
};

describe('InMemoryClientsStore', () => {
  it('stores and returns registered clients', async () => {
    const store = new InMemoryClientsStore();
    const client = { client_id: 'c1', redirect_uris: ['http://localhost:1234/cb'] };
    await store.registerClient(client as any);
    expect(await store.getClient('c1')).toMatchObject({ client_id: 'c1' });
    expect(await store.getClient('nope')).toBeUndefined();
  });

  it('normalizes a client to public, so there is no secret to keep (#456)', async () => {
    // The same normalization the Postgres store applies, for the same reason:
    // the SDK mints a secret for every client that does not ask to be public,
    // and board declines to hold one. Both implementations, or the seam and the
    // store would hand a client two different registrations.
    const store = new InMemoryClientsStore();
    const registered = await store.registerClient({
      client_id: 'c1',
      client_secret: 'minted-by-the-sdk',
      client_secret_expires_at: 0,
      redirect_uris: ['http://localhost:1234/cb'],
    } as any);

    expect(registered.client_secret).toBeUndefined();
    expect(registered.token_endpoint_auth_method).toBe('none');
    expect(JSON.stringify(await store.getClient('c1'))).not.toContain('minted-by-the-sdk');
  });
});

describe('PendingAuthStore', () => {
  it('create/consume is one-time', async () => {
    const store = new PendingAuthStore();
    const id = await store.create(PENDING);
    expect(await store.consume(id)).toMatchObject(PENDING);
    expect(await store.consume(id)).toBeNull();
  });

  it('expires after 10 minutes', async () => {
    let t = 0;
    const store = new PendingAuthStore(() => t);
    const id = await store.create(PENDING);
    t = PENDING_TTL_MS + 1;
    expect(await store.consume(id)).toBeNull();
  });

  it('ids are unguessable-length', async () => {
    const id = await new PendingAuthStore().create(PENDING);
    expect(id.length).toBeGreaterThanOrEqual(32);
  });

  it('a record created with no initiator still round-trips (#554)', async () => {
    // The initiator field is OPTIONAL, and this is what says so out loud.
    // `mcp-signout-revocation.integration.spec.ts` builds pending records from
    // three fields, so a required field here is a compile error there.
    const store = new PendingAuthStore();
    const id = await store.create(PENDING);
    const back = await store.consume(id);
    expect(back).toMatchObject(PENDING);
    expect(back?.initiator).toBeUndefined();
  });

  it('holds the initiator hashed, and hands back that hash (#554, #456)', async () => {
    // The seam stores what the Postgres store stores, because
    // `consent.controller.ts` compares them through one shared path. A seam
    // holding the plaintext would put a 32-character value beside a 64-character
    // hash, and `secretsMatch` fails on length before it ever reaches
    // `timingSafeEqual` — so every fixture-mode consent would be refused.
    const store = new PendingAuthStore();
    const id = await store.create({ ...PENDING, initiator: 'browser-secret' });
    expect((await store.peek(id))?.initiator).toBe(hashSecret('browser-secret'));
    expect((await store.peek(id))?.initiator).not.toBe('browser-secret');
    expect((await store.consume(id))?.initiator).toBe(hashSecret('browser-secret'));
  });
});

describe('CodeStore', () => {
  it('peekChallenge does not consume; consume is one-time', async () => {
    const store = new CodeStore();
    const code = await store.create(RECORD);
    expect(await store.peekChallenge(code)).toBe('ch');
    expect(await store.consume(code)).toMatchObject(RECORD);
    expect(await store.consume(code)).toBeNull();
    expect(await store.peekChallenge(code)).toBeNull();
  });

  it('expires after 5 minutes', async () => {
    let t = 0;
    const store = new CodeStore(() => t);
    const code = await store.create(RECORD);
    t = CODE_TTL_MS + 1;
    expect(await store.consume(code)).toBeNull();
  });

  it('keys the record on the hash of the code, never the code (#456)', async () => {
    const store = new CodeStore();
    const code = await store.create(RECORD);
    const rec = await store.consume(code);
    expect(rec!.codeHash).toBe(hashSecret(code));
    expect(rec!.codeHash).not.toBe(code);
  });

  it('CodeStore carries a scopes array (#56)', async () => {
    const store = new CodeStore(() => 1000);
    const code = await store.create({
      clientId: 'c', redirectUri: 'https://x/cb', codeChallenge: 'ch',
      scopes: ['board:read', 'board:admin'], sub: 'u', email: 'a@example.com',
    });
    const rec = await store.consume(code);
    expect(rec?.scopes).toEqual(['board:read', 'board:admin']);
  });
});

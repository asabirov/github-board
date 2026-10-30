import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ADMINS_UNREAD, fetchAdminAccess, fetchAuditLog, upsertIdentity, type AccessModel } from './api/account';
import { ApiError } from './api/core';
import { fetchMe } from './api/me';
import { onSessionExpired, resetSessionExpiry } from './auth/session-expiry';

function mockFetch(res: { ok?: boolean; status?: number; jsonValue?: unknown }) {
  const fn = vi.fn(async () => ({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    json: async () => res.jsonValue,
    text: async () => (res.jsonValue === undefined ? '' : JSON.stringify(res.jsonValue)),
    // A real Response has this, and `serverMessage` reads a failure body through
    // it so the body is still there for anybody else (#1079). Without it the
    // double answers `undefined` to a question the browser answers.
    clone: () => ({ json: async () => res.jsonValue }),
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => resetSessionExpiry());

describe('fetchMe (#11 isAdmin)', () => {
  it('coerces a missing isAdmin/canWrite/writesEnabled to false and an absent githubLogin to null (old-deploy skew)', async () => {
    mockFetch({ jsonValue: { email: 'a@x.com' } });
    expect(await fetchMe()).toEqual({ email: 'a@x.com', isAdmin: false, adminsUnread: false, writesEnabled: false, canWrite: false, githubLogin: null, capabilities: {}, orgs: [] });
  });

  it('passes through isAdmin=true', async () => {
    mockFetch({ jsonValue: { email: 'boss@x.com', isAdmin: true } });
    expect(await fetchMe()).toEqual({ email: 'boss@x.com', isAdmin: true, adminsUnread: false, writesEnabled: false, canWrite: false, githubLogin: null, capabilities: {}, orgs: [] });
  });

  // orgs (#650). `[]` is NO CLAIM — an old deploy that has never heard of the
  // field is indistinguishable here from one that read nothing, and neither may
  // put a word on a page. A malformed entry is dropped rather than surfaced: a
  // notice cannot name an org whose name did not arrive as a string.
  it('reads an absent, null or non-array orgs as [] (old-deploy skew)', async () => {
    mockFetch({ jsonValue: { email: 'a@x.com' } });
    expect((await fetchMe()).orgs).toEqual([]);
    mockFetch({ jsonValue: { email: 'a@x.com', orgs: null } });
    expect((await fetchMe()).orgs).toEqual([]);
    mockFetch({ jsonValue: { email: 'a@x.com', orgs: 'acme' } });
    expect((await fetchMe()).orgs).toEqual([]);
  });

  it('carries a well-formed orgs entry through, reason and all (#650)', async () => {
    mockFetch({ jsonValue: { email: 'a@x.com', orgs: [
      { org: 'acme', state: 'read', reason: null },
      { org: 'globex', state: 'unreadable', reason: 'Bad credentials' },
    ] } });
    expect((await fetchMe()).orgs).toEqual([
      { org: 'acme', state: 'read', reason: null },
      { org: 'globex', state: 'unreadable', reason: 'Bad credentials' },
    ]);
  });

  it('drops a malformed orgs entry without throwing, keeping the sound ones (#650)', async () => {
    mockFetch({ jsonValue: { email: 'a@x.com', orgs: [
      null,
      'globex',
      { state: 'unreadable', reason: 'Bad credentials' },
      { org: 'acme', state: 'sideways', reason: null },
      { org: '', state: 'unreadable', reason: null },
      { org: 'globex', state: 'unreadable' },
    ] } });
    expect((await fetchMe()).orgs).toEqual([{ org: 'globex', state: 'unreadable', reason: null }]);
  });

  it('passes through canWrite=true (#384)', async () => {
    mockFetch({ jsonValue: { email: 'a@x.com', isAdmin: false, canWrite: true } });
    expect(await fetchMe()).toEqual({ email: 'a@x.com', isAdmin: false, adminsUnread: false, writesEnabled: false, canWrite: true, githubLogin: null, capabilities: {}, orgs: [] });
  });

  // #626 — the session-and-config half, carried separately because every write
  // surface outside the issue editor gates on it. An old deploy that has never
  // heard of the field must read `false` and withhold the control, the way the
  // other two flags already degrade: drawing a picker over a write the server
  // will 403 is the failure this coercion exists to avoid.
  it('carries writesEnabled through, and reads an absent one as false (#626)', async () => {
    mockFetch({ jsonValue: { email: 'a@x.com', writesEnabled: true, canWrite: false } });
    const enabled = await fetchMe();
    expect(enabled.writesEnabled).toBe(true);
    // The pair the split exists for: writes are on, an issue capability is not.
    expect(enabled.canWrite).toBe(false);
    mockFetch({ jsonValue: { email: 'a@x.com', canWrite: true } });
    expect((await fetchMe()).writesEnabled).toBe(false);
  });

  it('passes through the linked Github login (#520)', async () => {
    mockFetch({ jsonValue: { email: 'anton.khovanskiy@example.com', githubLogin: 'anton-khovanskiy' } });
    expect((await fetchMe()).githubLogin).toBe('anton-khovanskiy');
  });

  it('keeps a null githubLogin null — an unmapped account is not an error (#520)', async () => {
    mockFetch({ jsonValue: { email: 'a@x.com', githubLogin: null } });
    expect((await fetchMe()).githubLogin).toBeNull();
  });

  it('treats a non-string githubLogin as unmapped rather than trusting it', async () => {
    mockFetch({ jsonValue: { email: 'a@x.com', githubLogin: 42 } });
    expect((await fetchMe()).githubLogin).toBeNull();
  });

  // #584 — what the board's own Github credential is known to be able to do.
  // Absent on an old deploy, and an empty map is the honest reading of that:
  // knowing nothing about a capability refuses nothing.
  it('carries the capability map through, and reads an absent one as empty', async () => {
    mockFetch({ jsonValue: { email: 'a@x.com', capabilities: { 'repo.dri': 'refused' } } });
    expect((await fetchMe()).capabilities).toEqual({ 'repo.dri': 'refused' });
    mockFetch({ jsonValue: { email: 'a@x.com' } });
    expect((await fetchMe()).capabilities).toEqual({});
  });
});

describe('fetchAdminAccess', () => {
  const model = { admins: [], people: [], tracking: {}, health: [], rosterUnavailable: false } as unknown as AccessModel;

  it('GETs /api/admin/access', async () => {
    const fn = mockFetch({ jsonValue: model });
    expect(await fetchAdminAccess()).toEqual(model);
    const [url, init] = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/api/admin/access');
    expect(init.credentials).toBe('include');
  });

  it('maps 403 to forbidden (a non-admin teammate) and 401 to unauthenticated', async () => {
    mockFetch({ ok: false, status: 403 });
    await expect(fetchAdminAccess()).rejects.toThrow('forbidden');
    mockFetch({ ok: false, status: 401 });
    await expect(fetchAdminAccess()).rejects.toThrow('unauthenticated');
    mockFetch({ ok: false, status: 502 });
    await expect(fetchAdminAccess()).rejects.toThrow('access 502');
  });

  it('never raises the session-expired signal on a 403 (#512)', async () => {
    // A teammate who is not an admin gets a 403 from /api/admin/access in
    // normal, correct use. Treating that as an expiry would throw them out of
    // the product for opening a page they are allowed to open.
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    mockFetch({ ok: false, status: 403 });
    await expect(fetchAdminAccess()).rejects.toThrow('forbidden');
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it('raises the session-expired signal on a 401 (#512)', async () => {
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    mockFetch({ ok: false, status: 401 });
    await expect(fetchAdminAccess()).rejects.toThrow('unauthenticated');
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('upsertIdentity', () => {
  const body = { email: 'maria@x.com', displayName: 'Maria', emails: ['maria@x.com'], githubLogin: 'm', clickupUserId: null, clickupNames: [], role: null };

  it('PUTs /api/admin/identity with the identity body', async () => {
    const fn = mockFetch({ jsonValue: {} });
    await upsertIdentity(body);
    const [url, init] = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/api/admin/identity');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body).email).toBe('maria@x.com');
  });

  it('maps 403 to forbidden and carries the validation body on 400 (#1079)', async () => {
    mockFetch({ ok: false, status: 403 });
    await expect(upsertIdentity(body)).rejects.toThrow('forbidden');
    // The service's words moved from `message` onto `serverMessage`, beside the
    // status (#1079). The dialog needs both: it prints the 400 word for word
    // and replaces a 500's body, and one collapsed string cannot say which it
    // has. `message` names the route and the status, as `submitFeedback` does.
    mockFetch({ ok: false, status: 400, jsonValue: { message: 'githubLogin: bad' } });
    const failed = await upsertIdentity(body).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ApiError);
    expect((failed as ApiError).status).toBe(400);
    expect((failed as ApiError).serverMessage).toBe('githubLogin: bad');
    expect((failed as ApiError).message).toBe('identity 400');
  });

  it('carries the 503’s machine code, which is what tells a transient one apart (#1102)', async () => {
    // The three write fetchers dropped `code` while three read fetchers in this
    // same file passed it, so `writeFailure` could not tell the auth layer's
    // four transient 503s from the roster's standing one and withdrew Save
    // under all of them.
    mockFetch({ ok: false, status: 503, jsonValue: { message: 'The board cannot confirm your sign-in right now. Try again in a moment.', code: 'access_not_now' } });
    const failed = await upsertIdentity(body).catch((e: unknown) => e);
    expect((failed as ApiError).status).toBe(503);
    expect((failed as ApiError).code).toBe('access_not_now');
    expect((failed as ApiError).serverMessage).toBe('The board cannot confirm your sign-in right now. Try again in a moment.');
    // A body with no code leaves it undefined, which is what a withdrawal is.
    mockFetch({ ok: false, status: 503, jsonValue: { message: 'Your GitHub connection changed while this was running. Try again.' } });
    const uncoded = await upsertIdentity(body).catch((e: unknown) => e);
    expect((uncoded as ApiError).code).toBeUndefined();
  });

  it('leaves the 400 body message alone and raises no signal (#512)', async () => {
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    mockFetch({ ok: false, status: 400, jsonValue: { message: 'githubLogin: bad' } });
    const failed = await upsertIdentity(body).catch((e: unknown) => e);
    expect((failed as ApiError).serverMessage).toBe('githubLogin: bad');
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});

/**
 * A 403 and a 503 are different answers, and the client keeps them apart (#811).
 *
 * `403 admin access required` is the board saying this reader is not an admin.
 * `503` with board's own code is the board saying it cannot read who its admins
 * are — nobody is let in either way, but only the first is a claim about the
 * reader, and only the second is worth telling an operator about.
 */
describe('fetchAuditLog and a board that cannot resolve its admins (#811)', () => {
  it('maps board\'s 503 to its own sentinel, not to forbidden', async () => {
    mockFetch({ ok: false, status: 503, jsonValue: { message: 'x', code: 'admins_unread' } });
    await expect(fetchAuditLog()).rejects.toThrow(ADMINS_UNREAD);
  });

  it('leaves an unrelated 503 alone — an ingress outage is not this one', async () => {
    // Matched on the code, never the status: a pane that drew board's sentence
    // for a proxy's 503 would name a failure board never observed.
    mockFetch({ ok: false, status: 503, jsonValue: { message: 'upstream unavailable' } });
    await expect(fetchAuditLog()).rejects.toThrow('audit 503');
  });

  it('still maps 403 to forbidden', async () => {
    mockFetch({ ok: false, status: 403 });
    await expect(fetchAuditLog()).rejects.toThrow('forbidden');
  });

  it('carries adminsUnread through from /me, and reads an absent one as false', async () => {
    mockFetch({ jsonValue: { email: 'a@x.com', adminsUnread: true } });
    expect((await fetchMe()).adminsUnread).toBe(true);
    mockFetch({ jsonValue: { email: 'a@x.com' } });
    expect((await fetchMe()).adminsUnread).toBe(false);
  });
});

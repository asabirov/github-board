import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { LOGOUT_TIMEOUT_MS, logout } from './api/core';
import { notifySessionExpired, onSessionExpired, resetSessionExpiry } from './auth/session-expiry';

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => resetSessionExpiry());

describe('logout (#112)', () => {
  it('POSTs the logout endpoint with credentials', async () => {
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fn);
    await logout();
    const [url, init] = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/api/auth/github/logout');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
  });

  it('resolves (never throws) when the request fails, and says the sign-out is unconfirmed', async () => {
    // Was "so the caller can still redirect" (#112). It must not: a request that
    // never arrived cleared no cookie, and '/' would sign them straight back in.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);
    await expect(logout()).resolves.toEqual({ kind: 'unconfirmed' });
  });

  it('never raises the session-expired signal — signing out is deliberate (#512)', async () => {
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    // Signing out with an already-dead cookie answers 401. That is the person
    // leaving on purpose, not the board losing them.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch);
    await expect(logout()).resolves.toEqual({ kind: 'unconfirmed' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);
    await expect(logout()).resolves.toEqual({ kind: 'unconfirmed' });
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});

// The endpoint answers 503 when the browser is signed out but the durable
// revocation was refused (#456, #679). Two different bodies, two different
// things for the person to do — so what comes back is carried, never restated.
const answering = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch);

const NOT_RECORDED =
  'Signed out of this browser, but the revocation was not recorded — a copy of this cookie still works until it expires. Sign out again from another browser where you are still signed in, or ask an admin to revoke the session.';
const NO_CLIENTS = 'Signed out of this browser, but connected clients could not be revoked.';

describe('logout tells its three outcomes apart (#682)', () => {
  it('carries the server’s sentence when the revocation was refused, whichever it was', async () => {
    answering(503, { ok: false, error: NOT_RECORDED });
    await expect(logout()).resolves.toEqual({ kind: 'refused', message: NOT_RECORDED });
    answering(503, { ok: false, error: NO_CLIENTS });
    await expect(logout()).resolves.toEqual({ kind: 'refused', message: NO_CLIENTS });
  });

  it('answers clean on a 2xx, and only on a 2xx', async () => {
    answering(200, { ok: true });
    await expect(logout()).resolves.toEqual({ kind: 'clean' });
  });

  it('answers unconfirmed for anything that neither succeeded nor said why', async () => {
    // A gateway's HTML, an empty body, a 503 whose body is unreadable: the board
    // never confirmed the sign-out, so it must not be reported as one. Redirecting
    // is what signs the person back in on a cookie that was never cleared.
    for (const body of [{ ok: false }, { ok: false, error: '' }, { ok: false, error: ' ' }, { ok: false, error: 7 }, null, 'boom']) {
      answering(503, body);
      await expect(logout()).resolves.toEqual({ kind: 'unconfirmed' });
    }
    answering(502, { message: 'Bad Gateway' });
    await expect(logout()).resolves.toEqual({ kind: 'unconfirmed' });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    })) as unknown as typeof fetch);
    await expect(logout()).resolves.toEqual({ kind: 'unconfirmed' });
  });

  it('silences the expiry signal for the 401s its own sign-out causes (#512)', async () => {
    // The tree stays mounted on a refused revocation, and the 2-minute poll then
    // 401s against a cleared cookie. Without the gate that reads as "your session
    // ended" over this notice — and App stashes the deep link on the way out.
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    answering(503, { ok: false, error: NOT_RECORDED });
    await logout();
    notifySessionExpired();
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it('lowers that gate again when the sign-out did not leave (#682)', async () => {
    // An unconfirmed sign-out keeps the person on the board, on a cookie that may
    // well still be live. Every 401 after it is an ordinary 401 again — leaving
    // the gate up would silence the real expiry, for the rest of the page load.
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);
    await expect(logout()).resolves.toEqual({ kind: 'unconfirmed' });
    notifySessionExpired();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it('keeps it up on a refused revocation — that browser IS signed out', async () => {
    // The other half of the case above, and the reason this is not simply
    // "lower it whenever logout returns": here the cookie is gone, the notice
    // cannot be dismissed, and its only way out finishes the redirect.
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    answering(503, { ok: false, error: NOT_RECORDED });
    await expect(logout()).resolves.toEqual({ kind: 'refused', message: NOT_RECORDED });
    notifySessionExpired();
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it('settles a request that never does, and lets go of the gate when it fires', async () => {
    // No browser puts a default timeout on fetch, and the handler makes four
    // database round-trips: a hung query writes no response and holds the socket
    // open. Without a deadline `logout()` never returns — no dialog is drawn at
    // all, and the gate stays up for the life of the tab, muting the real expiry
    // that the 401s behind it are reporting.
    vi.useFakeTimers();
    try {
      const seen = vi.fn();
      const off = onSessionExpired(seen);
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);
      const pending = logout();
      let settled = false;
      void pending.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      notifySessionExpired();
      expect(seen).not.toHaveBeenCalled(); // still the sign-out's own 401s

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ kind: 'unconfirmed' });
      notifySessionExpired();
      expect(seen).toHaveBeenCalledTimes(1);
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cut off a slow answer that arrives inside the deadline', async () => {
    // The other side of the same constant: four database round-trips under load
    // are slow, not hung, and a sign-out that worked must not be reported as
    // unconfirmed for taking a second.
    const SLOW = 2_000; // slow, not hung — and the deadline has to clear it
    expect(LOGOUT_TIMEOUT_MS).toBeGreaterThan(SLOW);
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }), SLOW);
      })) as unknown as typeof fetch);
      const pending = logout();
      await vi.advanceTimersByTimeAsync(SLOW);
      await expect(pending).resolves.toEqual({ kind: 'clean' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('raises that gate before the request, not after it', async () => {
    // A 401 landing while the sign-out is still in flight is the same 401.
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    vi.stubGlobal('fetch', vi.fn(async () => {
      notifySessionExpired();
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch);
    await logout();
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});

it('clears the readable hint before sign-out even when the network fails', async () => {
  const document = { cookie: 'board_session_hint=old' };
  vi.stubGlobal('document', document);
  vi.stubGlobal('fetch', vi.fn(async () => {
    expect(document.cookie).toContain('board_session_hint=;');
    expect(document.cookie).toContain('Max-Age=0');
    throw new Error('offline');
  }));
  await expect(logout()).resolves.toEqual({ kind: 'unconfirmed' });
});

it('still signs out when the browser refuses cookie writes', async () => {
  vi.stubGlobal('document', { set cookie(_value: string) { throw new Error('denied'); } });
  const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
  vi.stubGlobal('fetch', fetch);
  await expect(logout()).resolves.toEqual({ kind: 'clean' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

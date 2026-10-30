import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fetchPeople, type Person } from './api/people';
import { onSessionExpired, resetSessionExpiry } from './auth/session-expiry';

const person: Person = {
  id: 'octocat@example.com',
  displayName: 'Octocat',
  emails: ['octocat@example.com'],
  clickupNames: ['Octocat'],
  githubLogin: 'octocat',
};

function mockFetch(res: { ok?: boolean; status?: number; jsonValue?: unknown }) {
  const fn = vi.fn(async () => ({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    json: async () => res.jsonValue,
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => resetSessionExpiry());

describe('fetchPeople', () => {
  it('GETs /api/people and unwraps { people }', async () => {
    const fn = mockFetch({ jsonValue: { people: [person] } });
    expect(await fetchPeople()).toEqual([person]);
    const [url, init] = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/api/people');
    // The Team page loading gate blocks on this call — it must carry a timeout
    // signal so a hung backend degrades to the legacy roster instead of
    // pinning the page on "Loading…".
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects on 401/403/5xx so TeamView can fall back to the legacy roster', async () => {
    mockFetch({ ok: false, status: 401 });
    await expect(fetchPeople()).rejects.toThrow('unauthenticated');
    mockFetch({ ok: false, status: 403 });
    await expect(fetchPeople()).rejects.toThrow('forbidden');
    mockFetch({ ok: false, status: 502 });
    await expect(fetchPeople()).rejects.toThrow('people 502');
  });

  it('raises the session-expired signal on a 401, once per burst (#512)', async () => {
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    mockFetch({ ok: false, status: 401 });
    await expect(fetchPeople()).rejects.toThrow('unauthenticated');
    expect(seen).toHaveBeenCalledTimes(1);
    // The dead-session burst: the next surface's 401 must not tell them again.
    await expect(fetchPeople()).rejects.toThrow('unauthenticated');
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it('does not raise the signal on a 502 (#512)', async () => {
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    mockFetch({ ok: false, status: 502 });
    await expect(fetchPeople()).rejects.toThrow('people 502');
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});

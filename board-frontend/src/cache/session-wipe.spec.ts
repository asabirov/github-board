/**
 * Every way out of a session, and whether the copy on disk goes with it (#824).
 *
 * Three lines carry the whole of what makes a per-person cache on a shared
 * browser acceptable, and before this file existed all three could be deleted
 * with 2745 tests still passing: `session-expiry.ts`'s wipe on the first 401,
 * `logout()`'s wipe before the request goes out, and `fetchMe`'s claim on the
 * answer. The review of #824 found a fourth that was never written at all — a
 * refusal from the mount probe reached no wipe — and a fifth in `beginLogin`,
 * which is the ordinary shared-machine path.
 *
 * What separates the exits is whether the board SAID anything about who is
 * reading it. A 403 and a 4xx are things it said; a 5xx, an abort, a timeout and
 * a dropped connection are the board saying nothing, and the copy survives all
 * four. The 5xx moved from one column to the other after #824 shipped, and the
 * test below carries the reading.
 *
 * These drive the real functions against a fake store and a stubbed `fetch`.
 * The suite has no DOM and no `localStorage` (`docs/traps.md`), which is why
 * `setPayloadStore` exists and why `window` is stubbed for the one test that
 * needs it, the way `Pulse.spec.tsx` stubs it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ME_TIMEOUT_MS, fetchMe } from '../api/me';
import { WithdrawnReadError, logout } from '../api/core';
import apiSource from '../api/me.ts?raw';
import { beginLogin } from '../auth/oauth';
import { notifySessionExpired, resetSessionExpiry } from '../auth/session-expiry';
import {
  PAYLOAD_CACHE_PREFIX,
  PAYLOAD_OWNER_KEY,
  cachedOwner,
  claimFor,
  currentPayloadGeneration,
  forgetPayloads,
  forgetSensitivePayloads,
  setPayloadStore,
  writePayload,
  type PayloadStore,
} from './payload-cache';

class FakeStore implements PayloadStore {
  readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

/** A store holding one person's board, which is the state every one of these
 *  exits is about. */
function held(email = 'octocat@example.com'): FakeStore {
  const store = new FakeStore();
  setPayloadStore(store);
  claimFor(email);
  writePayload('issues/mine', { issues: ['one of Octocat’s'] });
  writePayload('people', [{ id: 'octocat@example.com' }]);
  return store;
}

/** Whether anything of the cache is left: the entries and the owner stamp. An
 *  owner with no entries still opens the board optimistically, so both count. */
function anythingLeft(store: FakeStore): string[] {
  return [...store.map.keys()].filter(
    (k) => k.startsWith(PAYLOAD_CACHE_PREFIX) || k === PAYLOAD_OWNER_KEY,
  );
}

function answers(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch,
  );
}

beforeEach(() => resetSessionExpiry());
afterEach(() => {
  vi.unstubAllGlobals();
  setPayloadStore(undefined);
});

describe('the mount probe keeps the cache only for the person it confirmed', () => {
  it('wipes when the board refuses the session with a 403', async () => {
    // Team-group membership lost since the last visit. `fetchMe` threw before
    // it reached `claimFor`, so nothing wiped, and the whole cache sat on the
    // disk under an owner stamp inside the freshness ceiling — repainting this
    // person's board on every visit for the next day.
    const store = held();
    answers(403, {});
    await expect(fetchMe()).rejects.toThrow('forbidden');
    expect(anythingLeft(store)).toEqual([]);
  });

  it('KEEPS the copy when the board answers 5xx, because a 5xx names nobody', async () => {
    // This pinned the opposite until it was read again, and the opposite is
    // what shipped. `CONTRIBUTING.md` says every merge to `main` is a
    // production deploy with no staging, and `sync/sync-status.tsx` fires this
    // probe on every focus and every two-minute tick — so a 502 or a 503 from
    // Caddy with no healthy upstream is a routine window, and wiping in it
    // emptied every open tab and put the next visit back on the network. That
    // is the wait #824 exists to remove, reached through #824's own new code.
    //
    // `ApiError.serverMessage`'s own docblock records the same reading from the
    // other side: a reverse proxy with no upstream and a rolling deploy "name
    // nothing". Learning nothing is not a refusal.
    const store = held();
    answers(503, {});
    await expect(fetchMe()).rejects.toThrow('me 503');
    expect(anythingLeft(store)).not.toEqual([]);
  });

  it('wipes when the board refuses the request with a 4xx', async () => {
    // The half that does NOT move with it, and the reason the narrowing is a
    // status test rather than a removal: below 500 the board answered about
    // this request, which is a claim about the caller, and a copy held under
    // one is a copy held under a refusal.
    const store = held();
    answers(400, {});
    await expect(fetchMe()).rejects.toThrow('me 400');
    expect(anythingLeft(store)).toEqual([]);
  });

  it('KEEPS the copy when the request never arrives, because nothing was learned', async () => {
    // This is the one that shipped the other way round for an afternoon and
    // silently removed the whole feature. `sync/sync-status.tsx` fires this
    // probe on every focus and every two-minute tick, and a reload aborts
    // whatever is in flight; with the wipe on this path, that abort emptied the
    // cache on the way out of every page, so the next visit had nothing to
    // paint. `scripts/measure-visit-wait.mjs` put the return visit back at
    // 1272ms against 82ms, and the browser showed `board_payload_owner` null
    // 120ms into a reload that had written it seconds before.
    //
    // An abort, a timeout, a dropped connection and an offline tab all mean the
    // board heard nothing about who is reading it, and throwing the copy away
    // over hearing nothing is not the safer answer: the session it declined to
    // trust may be perfectly alive. A refusal is a thing the server SAID, and
    // the three tests around this one are the ones that pin those.
    const store = held();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch);
    await expect(fetchMe()).rejects.toThrow();
    expect(anythingLeft(store)).not.toEqual([]);
  });

  it('wipes when the answer is not the JSON it claims to be', async () => {
    // An ingress page or a half-written body: a 200 that is not this service's.
    const store = held();
    answers(200, '{not json');
    await expect(fetchMe()).rejects.toThrow();
    expect(anythingLeft(store)).toEqual([]);
  });

  it('keeps the cache for the person it confirmed, and re-stamps the claim', async () => {
    // The other side of the rule, and the reason the wipe cannot simply be
    // unconditional: a confirmed session is what the whole cache is for.
    const store = held();
    // A stamp from earlier today, not from 1970: a claim older than the
    // freshness ceiling is one `claimFor` wipes on purpose, and planting one
    // here would test that rule instead of this one.
    const earlier = Date.now() - 60_000;
    store.map.set(PAYLOAD_OWNER_KEY, JSON.stringify({ o: 'octocat@example.com', t: earlier }));
    answers(200, { email: 'octocat@example.com' });
    await expect(fetchMe()).resolves.toMatchObject({ email: 'octocat@example.com' });
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}issues/mine`)).toBe(true);
    expect(cachedOwner()?.at).toBeGreaterThan(earlier);
  });

  it('takes the last person’s board with it when the probe names somebody else', async () => {
    const store = held('octocat@example.com');
    answers(200, { email: 'someone-else@example.com' });
    await fetchMe();
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}issues/mine`)).toBe(false);
    expect(cachedOwner()?.email).toBe('someone-else@example.com');
  });

  it('gives the probe a deadline, so the window it opens is bounded', async () => {
    // Nothing in a browser times a `fetch` out. Without this the board draws a
    // remembered person for as long as a hung upstream holds the socket, and
    // the 401 that eventually fires wipes the disk without taking the page off
    // the screen — `App` ignores an expiry while the session is `remembered`.
    const fn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fn);
    setPayloadStore(new FakeStore());
    await fetchMe();
    const init = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // And it is the deadline the board decided on. The line above passes over
    // `AbortSignal.timeout(0)`, which gives up before the request starts and is
    // an `AbortSignal` all the same, so on its own it says nothing about a
    // bound. A signal carries no readable timeout, so the number and the wiring
    // are pinned instead.
    expect(ME_TIMEOUT_MS).toBe(15_000);
    const probe = apiSource.slice(apiSource.indexOf('async function probeMe()'));
    expect(probe.slice(0, probe.indexOf('\n}\n'))).toContain('AbortSignal.timeout(ME_TIMEOUT_MS)');
  });
});

describe('every other way out of a session', () => {
  it('wipes on the first 401 of an expired session', async () => {
    const store = held();
    notifySessionExpired();
    expect(anythingLeft(store)).toEqual([]);
  });

  it('wipes on a sign-out, whatever the sign-out answers', async () => {
    const store = held();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);
    await expect(logout()).resolves.toEqual({ kind: 'unconfirmed' });
    expect(anythingLeft(store)).toEqual([]);
  });

  it('wipes before the browser leaves to sign somebody in', () => {
    // The shared-machine path: person B presses Sign in and comes back to `/`
    // with their own cookie. Without this the board painted person A's queue,
    // roster and figures for the probe's whole round trip — after B had
    // authenticated.
    const store = held('octocat@example.com');
    const location = { pathname: '/team', search: '', href: '' };
    vi.stubGlobal('window', { location });
    beginLogin();
    expect(anythingLeft(store)).toEqual([]);
    expect(location.href).toContain('/api/auth/github/login');
  });
});

/**
 * What a claim is allowed to withdraw, and what it is not (#1061).
 *
 * `forgetPayloads` does two things under one name: it takes the entries off the
 * disk, and it moves both generations, which makes `api.ts` refuse every read
 * issued before the move when it lands. The second half is a statement about
 * AUTHORITY — these reads were authorized under somebody who is gone — and
 * `claimFor` was making it on the first load of a fresh browser, where there is
 * no somebody and nothing was ever stored.
 *
 * Measured, not reasoned about: on the fixture lane through `vite dev`, 19 of
 * 20 first loads in a fresh browser session drew "the board couldn't verify
 * your session" while every `/api/*` request answered 200. React's StrictMode
 * runs `App`'s mount effect twice in development, each run drops the sensitive
 * generation before asking, so the two `/api/auth/me` reads do not join; the
 * first one to answer claimed the browser, the move landed on the second, and
 * the gate read a 409 the browser had raised about its own bookkeeping as a
 * session it could not verify.
 */
describe('a claim withdraws a read only when it names somebody else (#1061)', () => {
  /** Let the pending `fetch` and `res.json()` calls get as far as they can. */
  async function flush(times = 8): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  }

  /** `/api/auth/me` answering 200 with a body this test releases by hand. The
   *  shape is the one `response-deadline.spec.ts` uses: a real `Response` has
   *  no seam between the headers landing and the body finishing, and that seam
   *  is where the whole defect lives. */
  function heldBodies(): ((body: unknown) => void)[] {
    const release: ((body: unknown) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: () => new Promise((resolve) => { release.push(resolve); }),
    })) as unknown as typeof fetch);
    return release;
  }

  it('resolves the second of two first-load probes, because both answered 200', async () => {
    setPayloadStore(new FakeStore());
    const release = heldBodies();

    // The mount effect, run twice, the way StrictMode runs it in development.
    const first = fetchMe();
    forgetSensitivePayloads();
    const second = fetchMe();
    await flush();
    expect(release).toHaveLength(2);

    // The first answer lands and claims the browser for this person.
    release[0]({ email: 'octocat@example.com' });
    await expect(first).resolves.toMatchObject({ email: 'octocat@example.com' });

    // The second answered 200 as well, so 200 is what it has to resolve as.
    release[1]({ email: 'octocat@example.com' });
    await expect(second).resolves.toMatchObject({ email: 'octocat@example.com' });
  });

  it('leaves the cache generation alone when nobody held the browser', () => {
    setPayloadStore(new FakeStore());
    const before = currentPayloadGeneration();
    claimFor('octocat@example.com');
    expect(currentPayloadGeneration()).toBe(before);
    // And again for the same person, which is every re-probe of a live session.
    claimFor('octocat@example.com');
    expect(currentPayloadGeneration()).toBe(before);
  });

  it('still moves it when the claim names somebody else', () => {
    // The half that must not move with the fix: a read in flight under the last
    // person is a read this person may not be shown.
    held('octocat@example.com');
    const before = currentPayloadGeneration();
    claimFor('someone-else@example.com');
    expect(currentPayloadGeneration()).toBeGreaterThan(before);
  });

  it('still takes an unowned entry off the disk on a first claim', () => {
    // Not withdrawing is not the same as not wiping. An entry under no owner is
    // unreadable rather than harmless, and the top of `payload-cache.ts`
    // promises a shared browser holds nothing it cannot attribute.
    const store = held('octocat@example.com');
    store.map.delete(PAYLOAD_OWNER_KEY);
    claimFor('octocat@example.com');
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}issues/mine`)).toBe(false);
  });

  it('KEEPS the copy when the board withdraws its own read, because nothing was refused', async () => {
    // `probeMe` read every throw out of `res.json()` as a body it could not
    // parse. `apiFetch` wraps that method to assert the answer is still
    // current, so the board's own withdrawal came out of there too — and wiping
    // on it deleted the owner stamp `claimFor` had just written, which put the
    // next `/api/auth/me` back on the first-load path and withdrew a second
    // round of reads behind it.
    setPayloadStore(new FakeStore());
    const release = heldBodies();
    const probe = fetchMe();
    await flush();
    expect(release).toHaveLength(1);

    // Something real moves the generation under the read — an access change,
    // which is the one thing this assertion exists for. The store is restocked
    // afterwards so what survives is measured against this wipe and not that
    // one.
    forgetPayloads();
    const store = held('octocat@example.com');

    release[0]({ email: 'octocat@example.com' });
    await expect(probe).rejects.toBeInstanceOf(WithdrawnReadError);
    expect(anythingLeft(store)).not.toEqual([]);
  });
});

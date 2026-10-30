import { afterEach, expect, it, vi } from 'vitest';
import { fetchMe } from './api/me';
import { fetchMyIssues } from './api/issues';
import { claimFor, forgetPayloads, forgetSensitivePayloads, setPayloadStore } from './cache/payload-cache';
import { setResponseIdentity } from './auth/response-deadline';

const key = 'opening-reader';
function setup(previousOwner = 'reader@example.test:' + key) {
  vi.useFakeTimers();
  const store = new Map<string, string>();
  setPayloadStore({ getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); },
    removeItem: k => { store.delete(k); }, key: i => [...store.keys()][i] ?? null, get length() { return store.size; } });
  forgetPayloads();
  claimFor(previousOwner);
  setResponseIdentity(null, false);
  const deadline = Date.now() + 60_000;
  let release!: (response: Response) => void;
  const me = new Promise<Response>(resolve => { release = resolve; });
  const fetch = vi.fn((path: string) => path === '/api/auth/me' ? me : Promise.resolve(new Response(JSON.stringify({ issues: ['fresh private issue'] }), {
    headers: { 'X-Board-Sensitive': '1', 'X-Board-Access-Expires-At': String(deadline), 'X-Board-Visibility': key },
  })));
  vi.stubGlobal('fetch', fetch);
  const identity = fetchMe();
  // The zone is explicit because the asserted URL below carries it, and an
  // implicit one is the machine's own zone: UTC in CI, something else on a
  // developer's laptop (#1415).
  const mine = fetchMyIssues('acme', identity, 'UTC');
  const answer = (status = 200) => release(new Response(JSON.stringify({ email: 'reader@example.test',
    github: { visibilityKey: key, expiresAt: deadline, responseDeadlines: true } }), { status }));
  return { fetch, mine, answer };
}
afterEach(() => { setPayloadStore(undefined); forgetPayloads(); setResponseIdentity(null, false); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('starts both reads together but releases the scoped queue only after identity is verified', async () => {
  const { fetch, mine, answer } = setup();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/auth/me', '/api/issues/mine?org=acme&timeZone=UTC']);
  let released = false;
  void mine.then(() => { released = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(released).toBe(false);
  answer();
  await expect(mine).resolves.toEqual({ issues: ['fresh private issue'] });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([401, 403, 500])('discards a fresh queue when the identity probe fails with %s', async status => {
  const { mine, answer } = setup();
  const refused = expect(mine).rejects.toThrow(status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : 'me 500');
  answer(status);
  await refused;
});
it('withdraws a response started under another cached owner, allowing a fresh verified retry', async () => {
  const { mine, answer, fetch } = setup('previous@example.test:old-key');
  const withdrawn = expect(mine).rejects.toMatchObject({ status: 409 });
  answer();
  await withdrawn;
  await expect(fetchMyIssues('acme', undefined, 'UTC')).resolves.toEqual({ issues: ['fresh private issue'] });
  expect(fetch).toHaveBeenCalledTimes(3);
});
it('accepts a successful queue past its old deadline once identity is verified', async () => {
  const { mine, answer } = setup();
  const withdrawn = expect(mine).resolves.toEqual({ issues: ['fresh private issue'] });
  vi.advanceTimersByTime(60_000);
  answer();
  await withdrawn;
});
it('withdraws the parallel response when an explicit identity boundary invalidates it', async () => {
  const { mine, answer } = setup();
  const withdrawn = expect(mine).rejects.toMatchObject({ status: 409 });
  forgetSensitivePayloads();
  answer();
  await withdrawn;
});

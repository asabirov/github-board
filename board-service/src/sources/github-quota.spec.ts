import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { buildOctokitClient } from './github-client';
import { GithubQuotaCooldown, GithubQuotaCooldownError, quotaRetryAt } from './github-quota';

const now = Date.UTC(2026, 8, 9, 12);
const config = (token = 'deployment') => ({ get: (key: string, fallback?: unknown) => key === 'GITHUB_TOKEN' ? token : fallback }) as ConfigService;
let sequence = 0;
function person(id: string, token: string): GithubPrincipal {
  return { githubUserId: id, key: `${id}:${token}`, email: `${id}@example.test`, login: id, token, owners: [], repositories: [], cache: new WeakMap(), permissionCache: new WeakMap() };
}
function client(id: string, token = 'first', purpose: 'read' | 'write' = 'read') {
  return githubContext.run({ principal: person(id, token) }, () => buildOctokitClient(config(), purpose));
}
function response(data: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const quotaHeaders = () => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 60_000) / 1000) });
const success = () => response({ data: { viewer: { login: 'reader' } } });
const query = '{ viewer { login } }';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Github GraphQL cooldown through real Octokit request hooks', () => {
  it('shares HTTP-200 RATE_LIMIT across clients, renewed tokens and write purpose, while allowing REST and other users', async () => {
    const id = `renewal-${sequence++}`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ errors: [{ type: 'RATE_LIMIT', message: 'API rate limit already exceeded' }] }, quotaHeaders()))
      .mockImplementation(() => Promise.resolve(success()));
    vi.stubGlobal('fetch', fetch);
    await expect(client(id).graphql(query)).rejects.toThrow('rate limit');
    await expect(client(id, 'rotated', 'write').graphql(query)).rejects.toBeInstanceOf(GithubQuotaCooldownError);
    expect(fetch).toHaveBeenCalledTimes(1);
    await client(id).request('GET /user');
    await client(`other-${sequence++}`).graphql(query);
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.setSystemTime(now + 61_000);
    await expect(client(id, 'renewed').graphql(query)).resolves.toEqual({ viewer: { login: 'reader' } });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('records the last successful response when it consumes the remaining quota', async () => {
    const id = `last-${sequence++}`;
    const fetch = vi.fn().mockResolvedValue(response({ data: { viewer: { login: 'reader' } } }, quotaHeaders()));
    vi.stubGlobal('fetch', fetch);
    await expect(client(id).graphql(query)).resolves.toEqual({ viewer: { login: 'reader' } });
    await expect(client(id).graphql(query)).rejects.toBeInstanceOf(GithubQuotaCooldownError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('observes a thrown HTTP limit and respects the longer Retry-After instruction', async () => {
    const id = `secondary-${sequence++}`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ message: 'You have exceeded a secondary rate limit' }, { ...quotaHeaders(), 'retry-after': '120' }, 403))
      .mockImplementation(() => Promise.resolve(success()));
    vi.stubGlobal('fetch', fetch);
    await expect(client(id).graphql(query)).rejects.toThrow('secondary rate limit');
    vi.setSystemTime(now + 61_000);
    await expect(client(id).graphql(query)).rejects.toMatchObject({ retryAt: now + 121_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now + 121_000);
    await client(id).graphql(query);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not turn permission errors into a cooldown or retry a failed request', async () => {
    const id = `permission-${sequence++}`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ message: 'Resource not accessible by integration' }, {}, 403))
      .mockImplementation(() => Promise.resolve(success()));
    vi.stubGlobal('fetch', fetch);
    await expect(client(id).graphql(query)).rejects.toThrow('Resource not accessible');
    expect(fetch).toHaveBeenCalledTimes(1);
    await client(id).graphql(query);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to one minute for a positively identified limit with malformed timing', async () => {
    const id = `bad-headers-${sequence++}`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ errors: [{ type: 'RATE_LIMIT', message: 'Limited' }] }, { 'x-ratelimit-reset': 'Infinity', 'retry-after': '-1' }))
      .mockImplementation(() => Promise.resolve(success()));
    vi.stubGlobal('fetch', fetch);
    await expect(client(id).graphql(query)).rejects.toThrow('Limited');
    await expect(client(id).graphql(query)).rejects.toMatchObject({ retryAt: now + 60_000 });
    vi.setSystemTime(now + 60_000);
    await client(id).graphql(query);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares identical detached PATs across purposes without blocking a different credential', async () => {
    const token = `detached-secret-${sequence++}`;
    const fetch = vi.fn().mockResolvedValueOnce(response({ errors: [{ type: 'RATE_LIMIT' }] }, quotaHeaders()))
      .mockImplementation(() => Promise.resolve(success()));
    vi.stubGlobal('fetch', fetch);
    await expect(buildOctokitClient(config(token)).graphql(query)).rejects.toThrow();
    const blocked = buildOctokitClient(config(token), 'write').graphql(query);
    await expect(blocked).rejects.toBeInstanceOf(GithubQuotaCooldownError);
    await expect(blocked).rejects.not.toThrow(token);
    await buildOctokitClient(config(`${token}-other`)).graphql(query);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('bounded negative quota state', () => {
  it('honors a zero Retry-After with only the clock margin', () => {
    const gate = new GithubQuotaCooldown();
    gate.observe('zero-retry', { status: 429, headers: { 'retry-after': '0' } });
    expect(() => gate.admit('zero-retry')).toThrow(GithubQuotaCooldownError);
    vi.setSystemTime(now + 1000);
    expect(() => gate.admit('zero-retry')).not.toThrow();
  });

  it('expires deadlines and bounds distinct identities by evicting the earliest deadline', () => {
    const gate = new GithubQuotaCooldown();
    for (let i = 0; i <= 4096; i++) {
      gate.observe(String(i), { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': (now + 60_000 + i * 1000) / 1000 } });
    }
    expect(() => gate.admit('0')).not.toThrow();
    expect(() => gate.admit('1')).toThrow(GithubQuotaCooldownError);
    vi.setSystemTime(now + 5_000_000);
    expect(() => gate.admit('4096')).not.toThrow();
  });
});

describe('telling a quota refusal from any other failure (#986)', () => {
  it('reads the cooldown board already holds', () => {
    expect(quotaRetryAt(new GithubQuotaCooldownError(now + 5_000), now)).toBe(now + 5_000);
  });

  it('reads a REST refusal whose headers say the budget is spent, the shape #986 logged', () => {
    const err = Object.assign(new Error('API rate limit already exceeded for user ID 733858.'), {
      status: 403,
      response: { status: 403, headers: quotaHeaders(), data: { message: 'API rate limit already exceeded for user ID 733858.' } },
    });
    expect(quotaRetryAt(err, now)).toBe(now + 61_000);
  });

  it('reads a GraphQL RATE_LIMITED answer the way @octokit/graphql throws it', () => {
    const errors = [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 733858.' }];
    const err = Object.assign(new Error('Request failed due to following response errors'), { headers: quotaHeaders(), response: { data: null, errors }, errors });
    expect(quotaRetryAt(err, now)).toBe(now + 61_000);
  });

  it('reads a secondary limit by its Retry-After', () => {
    const err = Object.assign(new Error('You have exceeded a secondary rate limit.'), {
      status: 403,
      response: { status: 403, headers: { 'retry-after': '30' }, data: { message: 'You have exceeded a secondary rate limit.' } },
    });
    expect(quotaRetryAt(err, now)).toBe(now + 31_000);
  });

  it('answers nothing for a refusal about the reader, or a failure with no response at all', () => {
    const forbidden = [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }];
    expect(quotaRetryAt(Object.assign(new Error('forbidden'), { headers: {}, response: { data: null, errors: forbidden }, errors: forbidden }), now)).toBeUndefined();
    expect(quotaRetryAt(Object.assign(new Error('Resource not accessible by integration'), {
      status: 403, response: { status: 403, headers: { 'x-ratelimit-remaining': '4999' }, data: { message: 'Resource not accessible by integration' } },
    }), now)).toBeUndefined();
    expect(quotaRetryAt(new Error('Bad credentials'), now)).toBeUndefined();
    expect(quotaRetryAt(undefined, now)).toBeUndefined();
  });

  it('answers nothing for a failure that merely used the last point: the headers alone are not the refusal (#986 review)', () => {
    for (const [status, message] of [[401, 'Bad credentials'], [403, 'Resource not accessible by integration'], [500, 'Server Error']] as const) {
      const err = Object.assign(new Error(message), { status, response: { status, headers: quotaHeaders(), data: { message } } });
      expect(quotaRetryAt(err, now), `${status}`).toBeUndefined();
    }
    // A 429 is Github's rate limit whatever its body says.
    const tooMany = Object.assign(new Error('Too Many Requests'), { status: 429, response: { status: 429, headers: quotaHeaders(), data: {} } });
    expect(quotaRetryAt(tooMany, now)).toBe(now + 61_000);
  });

  it('still starts the cooldown on a spent budget alone, which only ever stops sending', () => {
    const gate = new GithubQuotaCooldown();
    gate.observe('spent', { status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) }, data: {} });
    expect(() => gate.admit('spent')).toThrow(GithubQuotaCooldownError);
  });
});

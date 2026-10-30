// Opening a board has to fetch THAT board (#697). `/api/projects/:n` without
// `?org=` resolves the first configured org holding the number, so a card that
// knows its org must say so or a two-org deployment opens the wrong board.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api/core';
import { fetchProject } from './api/projects';

/** Answer the next fetch with a board body, and hand back the spy so the URL
 *  that was asked for can be read off it. */
function mockProject(body: Record<string, unknown>) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn>;
}

const BOARD = { org: 'globex', number: 3, name: 'Delivery', url: '', status: 'OPEN', open: 1, closed: 1, pct: 50, lastClosed: null, items: [] };

/** Answer the next fetch with a failure, as Nest writes one. */
function mockFailure(status: number, body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch);
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchProject narrows to the org it was given (#697)', () => {
  it('asks for the named org’s board', async () => {
    const fn = mockProject(BOARD);
    await fetchProject(3, 'globex');
    expect(String(fn.mock.calls[0][0])).toContain('/api/projects/3?org=globex');
  });

  it('encodes an org that needs it, rather than splicing it into the path', async () => {
    const fn = mockProject(BOARD);
    await fetchProject(3, 'a b&c');
    expect(String(fn.mock.calls[0][0])).toContain('/api/projects/3?org=a+b%26c');
  });

  it('asks exactly what it asked before when no org qualifies the number', async () => {
    const fn = mockProject(BOARD);
    await fetchProject(3);
    const url = String(fn.mock.calls[0][0]);
    expect(url).toContain('/api/projects/3');
    expect(url).not.toContain('?');
  });

  it('carries the org the board answered with back to its caller', async () => {
    mockProject(BOARD);
    await expect(fetchProject(3, 'globex')).resolves.toMatchObject({ org: 'globex', number: 3 });
  });
});

/**
 * The two fields this fetcher used to throw away (#1065).
 *
 * Since #1060 a board page decides whether a failed read may leave its board
 * drawn, and that decision is `servableFailure`'s, which reads the body's code
 * and the server's own message. Neither reached it: `readProject` threw the
 * status and nothing else, so the coded 503 #1066 added to be ridden out was
 * indistinguishable here from a withdrawal, and a 502 carrying board-api's own
 * verdict was indistinguishable from Caddy having no upstream to reach.
 */
describe('a failed board read carries the server’s own message and code', () => {
  it('keeps the code off a coded 503', async () => {
    mockFailure(503, { message: 'GitHub credential is refreshing; retry or reconnect', code: 'access_not_now' });
    const err = await fetchProject(3, 'globex').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).code).toBe('access_not_now');
    expect((err as ApiError).serverMessage).toBe('GitHub credential is refreshing; retry or reconnect');
  });

  it('leaves both undefined when the body carries neither, which is Caddy’s 502', async () => {
    mockFailure(502, {});
    const err = await fetchProject(3, 'globex').catch((e: unknown) => e);
    expect((err as ApiError).code).toBeUndefined();
    expect((err as ApiError).serverMessage).toBeUndefined();
  });

  it('carries the message on a 403, whose own wording stays the board’s', async () => {
    mockFailure(403, { message: 'unknown org gtm' });
    const err = await fetchProject(3, 'gtm').catch((e: unknown) => e);
    expect((err as ApiError).message).toBe('forbidden');
    expect((err as ApiError).serverMessage).toBe('unknown org gtm');
  });
});

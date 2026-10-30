import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOwnerRename } from './me';

afterEach(() => vi.unstubAllGlobals());

/** Every answer the route can give, and the one the screen falls back to. */
function answering(make: (url: string) => Response | Promise<Response>) {
  const fetch = vi.fn((url: string) => Promise.resolve(make(url)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('asking where an owner went', () => {
  it('asks about the owner in the address, under the session it already holds', async () => {
    const fetch = answering(() => new Response('{"login":"globex","renamedTo":"acme"}'));
    expect(await fetchOwnerRename('globex')).toBe('acme');
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/owners/globex');
    expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ credentials: 'include' });
  });

  it('escapes what it was handed, which came off an address bar', async () => {
    const fetch = answering(() => new Response('{"renamedTo":null}'));
    await fetchOwnerRename('a/../b');
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/owners/a%2F..%2Fb');
  });

  it('reads a proven absence as an absence', async () => {
    answering(() => new Response('{"login":"private-org","renamedTo":null}'));
    expect(await fetchOwnerRename('private-org')).toBeNull();
  });

  it('reads an older deploy that has no such route as an absence too', async () => {
    // The refusal screen behind this answer is the one the board drew before
    // the route existed, so a 404 needs no state of its own.
    answering(() => new Response('{}', { status: 404 }));
    expect(await fetchOwnerRename('acme')).toBeNull();
  });

  it('refuses a body that is not the shape this board speaks', async () => {
    for (const body of ['{"renamedTo":""}', '{"renamedTo":123}', '{"renamedTo":{"login":"acme"}}', 'null']) {
      answering(() => new Response(body));
      expect(await fetchOwnerRename('acme'), body).toBeNull();
    }
  });
});

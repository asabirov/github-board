import { describe, expect, it } from 'vitest';
import { githubContext, PrincipalState, type GithubPrincipal } from './github-principal';
import { CredentialCipher } from './github-credential-cipher';

const person = (key: string): GithubPrincipal => ({ key, email: `${key}@example.test`, login: key, token: key, owners: [], repositories: [], cache: new WeakMap() });

describe('per-person Github isolation', () => {
  it('isolates equal-repository principals, deployment state, and post-response work', async () => {
    const state = new PrincipalState(() => ({ rows: [] as string[] }));
    state.current.rows.push('deployment');
    const a = person('a'); const b = person('b');
    let finish!: () => void;
    const delayed = githubContext.run({ principal: a }, async () => {
      state.current.rows.push('private-a');
      await new Promise<void>((r) => { finish = r; });
      state.current.rows.push('refilled-a');
    });
    githubContext.run({ principal: b }, () => {
      expect(state.current.rows).toEqual([]);
      state.current.rows.push('private-b');
    });
    finish(); await delayed;
    expect(state.current.rows).toEqual(['deployment']);
    githubContext.run({ principal: a }, () => expect(state.current.rows).toEqual(['private-a', 'refilled-a']));
    githubContext.run({ principal: b }, () => expect(state.current.rows).toEqual(['private-b']));
  });
  it('does not resolve an uninitialized request to deployment state', () => {
    const state = new PrincipalState(() => ({ secret: '' }));
    state.current.secret = 'deployment-private';
    githubContext.run({ principal: null }, () => expect(() => state.current).toThrow());
  });
});

/**
 * `peek` — what a holder has for this person, read without reading it (#1169).
 *
 * The Board sync panel reports WHEN each of six sources last refreshed. Two of
 * the six hold their state under a `KeptWhileUnchanged` scope, and `current`
 * marks the request permission-sensitive the moment it is touched, whether or
 * not there is anything in it. A poll that runs every two minutes in every open
 * tab on every page cannot be that request: marked, it is refused outright once
 * the check behind it expires, and the answer it does return carries the
 * withdrawal headers that invalidate the whole board.
 */
describe('a moment read out of a holder without reading the holder (#1169)', () => {
  const marked = (run: () => void) => {
    const read: { principal: GithubPrincipal; sensitive?: boolean } = { principal: person('p') };
    githubContext.run(read, run);
    return read.sensitive;
  };

  it('marks the request when the state is read and not when it is peeked', () => {
    const state = new PrincipalState(() => ({ rows: [] as string[] }), { maxAgeMs: () => 60_000 });
    expect(marked(() => { state.current.rows.push('read'); })).toBe(true);
    expect(marked(() => { state.peek(); })).toBeUndefined();
  });

  it('answers with what is there and never makes it', () => {
    const state = new PrincipalState(() => ({ rows: [] as string[] }), { maxAgeMs: () => 60_000 });
    const p = person('p');
    githubContext.run({ principal: p }, () => {
      // Nothing has read this source under this person: the honest answer is
      // that there is no record, and a `peek` that CREATED one would report a
      // state it had just made itself.
      expect(state.peek()).toBeUndefined();
      state.current.rows.push('read');
      expect(state.peek()?.rows).toEqual(['read']);
    });
  });

  it('sees the state an unchanged re-check carried over, as a read would', () => {
    const state = new PrincipalState(() => ({ rows: [] as string[] }), { maxAgeMs: () => 60_000 });
    const carried = { ...person('p'), permissionCache: new WeakMap(), expiresAt: Date.now() + 30_000 } as GithubPrincipal;
    githubContext.run({ principal: carried }, () => { state.current.rows.push('read'); });
    // A new check of the same visibility: its own per-check cache is empty, and
    // #1007 lets it go on with what the check before it left. A peek that
    // reported nothing here would say "not recorded" about a source the board is
    // still serving from — which is the whole of #1169.
    const recheck = { ...carried, permissionCache: new WeakMap(), expiresAt: Date.now() + 30_000 } as GithubPrincipal;
    githubContext.run({ principal: recheck }, () => expect(state.peek()?.rows).toEqual(['read']));
  });

  it('reads deployment state where there is no person, as `current` does', () => {
    const state = new PrincipalState(() => ({ rows: [] as string[] }));
    state.current.rows.push('deployment');
    expect(state.peek()?.rows).toEqual(['deployment']);
  });
});

describe('credential encryption', () => {
  const cipher = new CredentialCipher({ key: () => Buffer.alloc(32, 7) });
  it('uses randomized authenticated encryption bound to person and token kind', () => {
    const one = cipher.encrypt('synthetic-access', 'a:access');
    expect(one).not.toContain('synthetic-access');
    expect(cipher.encrypt('synthetic-access', 'a:access')).not.toEqual(one);
    expect(cipher.decrypt(one, 'a:access')).toBe('synthetic-access');
    expect(() => cipher.decrypt(one, 'b:access')).toThrow();
    expect(() => cipher.decrypt(one, 'a:refresh')).toThrow();
    expect(() => cipher.decrypt(one.slice(0, -3) + 'abc', 'a:access')).toThrow();
  });
});

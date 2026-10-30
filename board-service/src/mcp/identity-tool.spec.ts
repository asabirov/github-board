import { describe, it, expect } from 'vitest';
import { whoAmI, type IdentityDeps } from './identity-tool';
import { BOARD_ADMIN, BOARD_READ } from '../auth/scopes';
import type { McpActor } from './overview-tools';

/**
 * A resolver stub that records every address it was asked for.
 *
 * `derived` answers `forEmail` ONLY — the two methods must be able to disagree,
 * or a test asserting that board_whoami withholds an inferred handle passes
 * just as well when the tool calls `forEmail` (#535).
 */
function stubResolver(
  answer: string | null = null,
  derived: string | null = null,
  /** What this request's Github principal resolved to. `null` is "no person
   *  context at all", which is the fixture lane and the only case that still
   *  falls through to the roster tier below (#892). */
  connected: { login: string | null } | null = null,
): IdentityDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    connectedGithub: () => connected,
    githubLogins: {
      async forEmail(email: string) {
        asked.push(email);
        return derived ?? answer;
      },
      async typedLoginFor(email: string) {
        asked.push(email);
        return answer;
      },
    },
  };
}

const person = (over: Partial<McpActor> = {}): McpActor => ({
  sub: 'sub-1',
  email: 'octocat@example.com',
  agent: false,
  staticAgent: false,
  ...over,
});

describe('whoAmI', () => {
  it("returns the caller's address and the resolver's handle", async () => {
    const deps = stubResolver('octocat');
    const actor = person({ agent: true });

    const result = await whoAmI(actor, [BOARD_READ], deps);

    expect(result).toEqual({
      email: 'octocat@example.com',
      githubLogin: 'octocat',
      scopes: [BOARD_READ],
    });
    expect(deps.asked).toEqual(['octocat@example.com']);
  });

  it('a null handle is an ordinary answer', async () => {
    const deps = stubResolver(null);

    const result = await whoAmI(person({ email: 'nobody@example.com' }), [BOARD_READ], deps);

    expect(result.email).toBe('nobody@example.com');
    expect(result.githubLogin).toBeNull();
    expect(deps.asked).toEqual(['nobody@example.com']);
  });

  it('a static agent gets a null handle and the resolver is never asked', async () => {
    // Defence in depth: no person is behind a BOARD_AGENT_TOKENS token, so there
    // is no right answer for a lookup to return. Assert the CALL COUNT, not just
    // the value — a resolver that answered null would pass on the value alone.
    const deps = stubResolver('should-never-be-returned');

    const result = await whoAmI(
      person({ email: 'agent:ci', agent: true, staticAgent: true }),
      [BOARD_READ],
      deps,
    );

    expect(result.githubLogin).toBeNull();
    expect(result.email).toBe('agent:ci');
    expect(deps.asked).toEqual([]);
  });

  it('an unscoped session reports [], which is no limits and not no authority', async () => {
    const deps = stubResolver('octocat');

    const result = await whoAmI(person({ agent: false, staticAgent: false }), [], deps);

    // `[]` here is the browser cookie session (jwt-auth.guard.ts:132 builds
    // { sub, email } with no scopes). It is registered for EVERY tool, write
    // list included, because toolNamesForScope keys on !actor.agent. So `[]`
    // is the highest authority on this surface, not the lowest — do not
    // "fix" this into a fourth field, and do not read it as "holds nothing".
    // The tool description and the /docs line say the same thing in prose.
    expect(result.scopes).toEqual([]);
  });

  it('the answer has exactly three keys', async () => {
    // The guard against a later widening — isAdmin, a roster field, an
    // `unrestricted` flag. The tool describes the caller and nothing else.
    const result = await whoAmI(person(), [BOARD_READ, BOARD_ADMIN], stubResolver('octocat'));

    expect(Object.keys(result).sort()).toEqual(['email', 'githubLogin', 'scopes']);
  });
});

describe('board_whoami and derived handles (#535)', () => {
  it('withholds a handle the board only inferred', async () => {
    // Octocat's call: the MCP surface is never told an identity the board
    // guessed. `forEmail` would answer 'newbie' here; `typedLoginFor` must not.
    const deps = stubResolver(null, 'newbie');
    const res = await whoAmI(person({ email: 'new@example.com' }), [BOARD_READ], deps);
    expect(res.githubLogin).toBeNull();
  });

  it('still reports a handle somebody typed', async () => {
    const deps = stubResolver('octocat');
    const res = await whoAmI(person({ email: 'octocat@example.com' }), [], deps);
    expect(res.githubLogin).toBe('octocat');
  });
});

/**
 * `board_whoami` reports the CONNECTED account (#892 review).
 *
 * The roster tier answers a handle for anybody it has ever seen in a commit or
 * an alias table. After #892 that handle is not who the session acts as: an
 * unconnected person's Github calls are all refused, so telling an agent it is
 * `@someone` invites it to plan work it cannot do, under a name that is not its
 * own. `typedLoginFor` itself is untouched — Board-local derived roles read it
 * and still get the same answer.
 */
describe('the Github login board_whoami reports (#892)', () => {
  const actor = { sub: 's', email: 'alice@example.test', agent: false, staticAgent: false };

  it('reports the connected login and never asks the roster', async () => {
    const deps = stubResolver('roster-handle', 'derived-handle', { login: 'alice-connected' });
    expect(await whoAmI(actor, [], deps)).toEqual({
      email: 'alice@example.test',
      githubLogin: 'alice-connected',
      scopes: [],
    });
    expect(deps.asked, 'the roster was not consulted').toEqual([]);
  });

  it('reports no Github identity for an unconnected person, roster handle or not', async () => {
    const deps = stubResolver('roster-handle', 'derived-handle', { login: null });
    expect((await whoAmI(actor, [], deps)).githubLogin).toBeNull();
    expect(deps.asked).toEqual([]);
  });

  it('still reports nothing at all for a static agent token', async () => {
    const deps = stubResolver('roster-handle', 'derived-handle', { login: 'someone' });
    const agent = { sub: 'agent:ci', email: 'agent:ci', agent: true, staticAgent: true };
    expect((await whoAmI(agent, ['board:read'], deps)).githubLogin).toBeNull();
    expect(deps.asked).toEqual([]);
  });

  it('falls back to the typed roster tier only when there is no person context', async () => {
    const deps = stubResolver('roster-handle', 'derived-handle', null);
    expect((await whoAmI(actor, [], deps)).githubLogin).toBe('roster-handle');
    expect(deps.asked, 'and reaches it through typedLoginFor, not forEmail').toEqual([
      'alice@example.test',
    ]);
  });
});

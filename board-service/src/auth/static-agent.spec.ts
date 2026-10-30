import { describe, it, expect } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { isStaticAgent, type AuthenticatedActor } from './static-agent';
import { NoStaticAgentGuard } from './no-static-agent.guard';

/** Exactly what JwtAuthGuard builds for a `BOARD_AGENT_TOKENS` bearer. */
const STATIC_TOKEN = {
  sub: 'agent:ci-bot',
  email: 'agent:ci-bot',
  agent: true,
  staticAgent: true,
  scopes: ['board:read'],
};
const READ_ONLY_PAT = { sub: 'ivan.roslov@example.com', email: 'ivan.roslov@example.com', agent: true, scopes: ['board:read'] };
const MCP_SESSION = { sub: 'g-123', email: 'octocat@example.com', agent: true, scopes: ['board:read'] };
const HUMAN = { sub: 'g-123', email: 'octocat@example.com' };

function ctx(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('isStaticAgent (#482)', () => {
  it('is true for a BOARD_AGENT_TOKENS actor — the flag JwtAuthGuard sets where it builds one', () => {
    expect(isStaticAgent(STATIC_TOKEN)).toBe(true);
  });

  it('is false for a personal access token — the agent flag is set, but no static-agent flag is', () => {
    expect(isStaticAgent(READ_ONLY_PAT)).toBe(false);
  });

  it('is false for an MCP agent-scoped session (real Google identity)', () => {
    expect(isStaticAgent(MCP_SESSION)).toBe(false);
  });

  it('is false for a human session', () => {
    expect(isStaticAgent(HUMAN)).toBe(false);
  });
});

/**
 * #525. The predicate used to read the address — agent flag set AND no `@` in
 * the email — so an agent NAME containing an `@` produced `agent:claude@ci`,
 * which passed the `@` test and made the token read as a person. Every rule
 * keyed on `isStaticAgent` inverted at once.
 *
 * `parseAgentTokens` now refuses such a name, and `config.schema.ts` already
 * did, so no such token can be configured. This is the durable half: the
 * predicate no longer consults the address AT ALL, so a future bug in name
 * handling cannot re-open the hole. The flag is written in exactly one place —
 * the `BOARD_AGENT_TOKENS` branch of `jwt-auth.guard` — and no branch there
 * spreads anything from a token's claims into `req.user`, so nothing a caller
 * controls can set it.
 */
describe('what a caller IS does not depend on the shape of its address (#525)', () => {
  it('a static agent whose address reads as a person is still a static agent', () => {
    const impostorName = { ...STATIC_TOKEN, sub: 'agent:claude@ci', email: 'agent:claude@ci' };
    expect(isStaticAgent(impostorName)).toBe(true);
  });

  it('an actor whose address merely LOOKS synthetic is not one without the flag', () => {
    expect(isStaticAgent({ agent: true, email: 'agent:ci-bot' })).toBe(false);
  });

  /**
   * The one behaviour this changes. The old predicate answered true for an agent
   * actor carrying no email, because an absent address has no `@` in it. Only
   * `TeamAccessGuard` reads that answer before checking for an address of its
   * own, and there true meant "skip the group check" — so the new answer is the
   * stricter one: such an actor now falls through to the guard's own fail-closed
   * `no email` branch. Every other call site tests for an address first.
   */
  it('is false for an agent actor carrying no email and no flag — it is not a token we minted', () => {
    expect(isStaticAgent({ agent: true })).toBe(false);
  });
});

/**
 * The predicate answers from the actor's OWN flag, never from an inherited one.
 *
 * This is a constraint being written down, not a hole being closed. Nothing can
 * reach `Object.prototype` today: `parseCookies` assigns only strings onto a
 * fresh object literal, `main.ts` configures the urlencoded parser with
 * `extended: false` so a query string cannot build a nested key, and no
 * dependency does a deep merge. The board simply relied on that in three places
 * without saying so anywhere.
 *
 * It is worth saying because the three do not fail the same way. A stray `true`
 * would make `AdminAuthority.isAdminActor` refuse everyone — closed, and
 * harmless. `TeamAccessGuard` returns early on the same answer and would skip
 * the Google group check for every caller — open. One predicate, opposite
 * consequences, so it holds the stricter of the two.
 */
describe('what a caller IS comes from its own flag, not from Object.prototype', () => {
  it('ignores an inherited staticAgent property', () => {
    const human: AuthenticatedActor = { email: 'octocat@example.com' };
    try {
      // Non-enumerable, so even inside this window no spread, `for...in` or
      // JSON.stringify anywhere in the process changes shape; configurable, so
      // the `finally` can always take it back off; and nothing awaits in
      // between, so no other test can interleave with it.
      Object.defineProperty(Object.prototype, 'staticAgent', {
        value: true,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      expect('staticAgent' in human).toBe(true); // the property really is reachable
      expect(isStaticAgent(human)).toBe(false); // and the predicate still says person
    } finally {
      delete (Object.prototype as { staticAgent?: boolean }).staticAgent;
    }
    expect('staticAgent' in {}).toBe(false); // ...and the process is clean again
  });

  it('an inherited property cannot mask a real static agent either', () => {
    try {
      Object.defineProperty(Object.prototype, 'staticAgent', {
        value: false,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      expect(isStaticAgent(STATIC_TOKEN)).toBe(true);
    } finally {
      delete (Object.prototype as { staticAgent?: boolean }).staticAgent;
    }
    expect('staticAgent' in {}).toBe(false);
  });
});

describe('NoStaticAgentGuard (#482)', () => {
  const guard = new NoStaticAgentGuard();

  it('denies a static agent token', () => {
    expect(() => guard.canActivate(ctx(STATIC_TOKEN))).toThrow(ForbiddenException);
  });

  it('denies a static agent token whose address reads as a person (#525)', () => {
    const impostorName = { ...STATIC_TOKEN, sub: 'agent:claude@ci', email: 'agent:claude@ci' };
    expect(() => guard.canActivate(ctx(impostorName))).toThrow(ForbiddenException);
  });

  it('allows a personal access token', () => {
    expect(guard.canActivate(ctx(READ_ONLY_PAT))).toBe(true);
  });

  it('allows a human session', () => {
    expect(guard.canActivate(ctx(HUMAN))).toBe(true);
  });

  // `isStaticAgent` answers false for an absent user, which is right where
  // TeamAccessGuard uses it and wrong here, where false means allow. Unreachable
  // behind JwtAuthGuard; pinned so a guard reorder cannot make it reachable.
  it('refuses a request carrying no user rather than treating it as a human', () => {
    expect(() => guard.canActivate(ctx(undefined))).toThrow(UnauthorizedException);
  });
});

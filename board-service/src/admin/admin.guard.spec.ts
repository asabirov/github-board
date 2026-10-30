import { describe, expect, it } from 'vitest';
import { ExecutionContext, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AdminGuard } from './admin.guard';
import { ADMINS_UNREAD_CODE, ADMINS_UNREAD_REFUSAL, AdminAuthority } from '../auth/admin-authority';
import { BOARD_ADMIN, BOARD_READ } from '../auth/scopes';

function ctxFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

/** AdminAuthority over an env break-glass list + a board-assigned admin snapshot. */
function authority(opts: { env?: string; assigned?: string[] } = {}): AdminAuthority {
  const config = {
    get: (key: string, def?: unknown) => (key === 'BOARD_ADMIN_EMAILS' ? (opts.env ?? '') : def),
  } as unknown as ConfigService;
  return new AdminAuthority(config, { emails: () => opts.assigned ?? [] });
}

describe('AdminGuard (#11)', () => {
  const guard = new AdminGuard(authority({ env: 'boss@example.com' }));

  it('allows a break-glass override admin actor', () => {
    expect(guard.canActivate(ctxFor({ email: 'boss@example.com' }))).toBe(true);
  });

  it('allows a board-assigned admin with no env override (#143, #332)', () => {
    const g = new AdminGuard(authority({ assigned: ['owner@example.com'] }));
    expect(g.canActivate(ctxFor({ email: 'owner@example.com' }))).toBe(true);
  });

  it('403s a non-admin teammate', () => {
    expect(() => guard.canActivate(ctxFor({ email: 'dev@example.com' }))).toThrow(ForbiddenException);
  });

  it('403s when there is no user (defensive — global chain should have 401d first)', () => {
    expect(() => guard.canActivate(ctxFor(undefined))).toThrow(ForbiddenException);
  });
});

// #551 — the gate asked only whether the address was in an admin set, while
// /api/auth/me had already stopped resolving a static agent's synthetic address
// as a person's (#546). Reported and enforced disagreed by construction. Both
// now read `AdminAuthority.isAdminActor`, so the cases below are the gate's half
// of one decision.
describe('AdminGuard and a caller with no person behind it (#551)', () => {
  /** The two ways `agent:<name>` reaches the admin set, per #551: the
   *  unvalidated break-glass env var, and a roster row carrying the address. */
  const viaBreakGlass = () => new AdminGuard(authority({ env: 'agent:ci' }));
  const viaStoredRole = () => new AdminGuard(authority({ assigned: ['agent:ci'] }));

  const staticAgent = { email: 'agent:ci', agent: true, staticAgent: true, scopes: [BOARD_READ] };

  it('403s a static agent whose address sits in BOARD_ADMIN_EMAILS', () => {
    expect(() => viaBreakGlass().canActivate(ctxFor(staticAgent))).toThrow(ForbiddenException);
  });

  it('403s a static agent whose address sits on a stored admin row', () => {
    expect(() => viaStoredRole().canActivate(ctxFor(staticAgent))).toThrow(ForbiddenException);
  });

  // The refusal must not depend on the scopes the actor happens to carry: the
  // scope layer is a separate gate, and #551 is about what the guard itself
  // decides once a caller is past it. `board:admin` on a static token is not
  // reachable today (its preset is board:read), which is precisely why the guard
  // is the only thing that would say no if it ever became reachable.
  it('403s a static agent even when it carries board:admin', () => {
    const carrying = { ...staticAgent, scopes: [BOARD_READ, BOARD_ADMIN] };
    expect(() => viaBreakGlass().canActivate(ctxFor(carrying))).toThrow(ForbiddenException);
  });

  // #525: personhood is read from the flag, never from the shape of the address.
  // A token named `claude@ci` authenticates as `agent:claude@ci`, which every
  // address test reads as an ordinary person.
  it('403s a static agent whose name is person-shaped', () => {
    const g = new AdminGuard(authority({ env: 'agent:claude@ci' }));
    const personShaped = { email: 'agent:claude@ci', agent: true, staticAgent: true, scopes: [BOARD_READ] };
    expect(() => g.canActivate(ctxFor(personShaped))).toThrow(ForbiddenException);
  });

  // The other half of the rule, and the reason HumanOnlyGuard is the wrong tool
  // here: it tests `isHumanSession` (`!user?.scopes`), so it would refuse these
  // two as well. Only the static agent is a caller with nobody behind it (#546).
  it('admits an admin holding a board:admin personal access token', () => {
    const g = new AdminGuard(authority({ assigned: ['boss@example.com'] }));
    const pat = { email: 'boss@example.com', scopes: [BOARD_READ, BOARD_ADMIN] };
    expect(g.canActivate(ctxFor(pat))).toBe(true);
  });

  it('admits an admin on an MCP agent-scoped session — a real address that passed the group check', () => {
    const g = new AdminGuard(authority({ assigned: ['boss@example.com'] }));
    const mcp = { email: 'boss@example.com', agent: true, scopes: [BOARD_READ] };
    expect(g.canActivate(ctxFor(mcp))).toBe(true);
  });

  // #371: with zero board-assigned admins the env var activates, and the person
  // recovering an empty admin set must still get through the gate.
  it('admits the break-glass person while zero assigned admins exist (#371)', () => {
    const g = new AdminGuard(authority({ env: 'boss@example.com' }));
    expect(g.canActivate(ctxFor({ email: 'boss@example.com' }))).toBe(true);
  });
});

/**
 * The board cannot say who its admins are, and says THAT (#811).
 *
 * `AdminEmailCache.emails()` answers `null` until a read succeeds, and on a
 * `db` board that read is Postgres. With Postgres unreachable from boot there
 * has never been a successful read, so nobody resolves as admin — correctly,
 * because the break-glass must not arm on an unread roster (#588) — and every
 * caller got `403 admin access required`.
 *
 * That answer is a claim the board is in no position to make, and it is the
 * expensive one to make wrongly: `/api/admin/audit` is where the lost-record
 * count lives (#781), so the one page that would name the outage told the
 * operator they were not an admin. Nobody is let in by the tests below; the
 * refusal just stops lying about its reason.
 */
describe('AdminGuard when the admin roster has never been read (#811)', () => {
  /** The cache before its first SUCCESSFUL read — `null`, not `[]` (#588). */
  const unread = (env?: string) => {
    const config = {
      get: (key: string, def?: unknown) => (key === 'BOARD_ADMIN_EMAILS' ? (env ?? '') : def),
    } as unknown as ConfigService;
    return new AdminGuard(new AdminAuthority(config, { emails: () => null }));
  };

  it('answers 503, not 403 — the caller is refused, not judged', () => {
    // The whole issue in one assertion: this used to be a ForbiddenException.
    expect(() => unread().canActivate(ctxFor({ email: 'dev@example.com' })))
      .toThrow(ServiceUnavailableException);
  });

  it('names the outage instead of accusing the reader of not being an admin', () => {
    try {
      unread().canActivate(ctxFor({ email: 'dev@example.com' }));
      expect.unreachable('the guard must refuse an unread roster');
    } catch (e) {
      const body = (e as ServiceUnavailableException).getResponse() as {
        message: string;
        code: string;
      };
      expect(body.message).toBe(ADMINS_UNREAD_REFUSAL);
      // The machine half, so a pane can tell board's 503 from an ingress's and
      // only draws that sentence for the state board actually observed.
      expect(body.code).toBe(ADMINS_UNREAD_CODE);
      expect(body.message).not.toContain('admin access required');
    }
  });

  it('still refuses the BOARD_ADMIN_EMAILS break-glass — #588 holds', () => {
    // The option #588 already turned down, listed in #811 so nobody re-proposes
    // it: arming here would grant admin from an env var while the real admins
    // sat unread in the database. A different STATUS is not a different door.
    expect(() => unread('boss@example.com').canActivate(ctxFor({ email: 'boss@example.com' })))
      .toThrow(ServiceUnavailableException);
  });

  it('403s a static agent all the same — no person is behind it, and that is not an outage', () => {
    // #546's refusal is settled, so reporting it as a store failure would tell a
    // static agent a false story about the board's health.
    const agent = { email: 'agent:ci', agent: true, staticAgent: true, scopes: [BOARD_READ] };
    expect(() => unread('agent:ci').canActivate(ctxFor(agent))).toThrow(ForbiddenException);
  });

  it('goes back to 403 for a non-admin the moment a read succeeds', () => {
    // The 503 describes the roster, not the caller: once the board has an answer
    // it is entitled to say this person is not on it.
    const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;
    let snapshot: string[] | null = null;
    const g = new AdminGuard(new AdminAuthority(config, { emails: () => snapshot }));

    expect(() => g.canActivate(ctxFor({ email: 'dev@example.com' }))).toThrow(ServiceUnavailableException);
    snapshot = ['owner@example.com'];
    expect(() => g.canActivate(ctxFor({ email: 'dev@example.com' }))).toThrow(ForbiddenException);
    expect(g.canActivate(ctxFor({ email: 'owner@example.com' }))).toBe(true);
  });
});

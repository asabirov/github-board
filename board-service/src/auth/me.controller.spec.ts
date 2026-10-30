import { githubContext } from './github-principal';
import { describe, expect, it, vi } from 'vitest';
import {
  ExecutionContext,
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MeController } from './me.controller';
import { CapabilityRegistry } from '../capability/capability.registry';
import { cfg as capCfg } from '../capability/capability-testing.contract';
import { capabilityGuardEnforcing } from '../capability/guard-enforcing';
import { CAPABILITIES, ISSUE_EDITOR_CAPABILITIES } from '../capability/capability';
import type { Refusal } from '../capability/github-refusal';
import { AdminAuthority } from './admin-authority';
import { AdminGuard } from '../admin/admin.guard';
import { GithubLoginResolver } from '../identity/github-login.resolver';
import type { IdentityRecord, IdentityRepository } from '../identity/identity.repository';
import {
  fakeIdentityStore,
  identityRecordFor,
  unreachableIdentityStore,
} from '../identity/identity.test-double';
import {
  IssuesCacheService,
  type OrgReadOutcome,
} from '../issues-metrics/issues-cache.service';
import { composeOrgReadState } from '../issues-metrics/org-read-state';

/** AdminAuthority over an env break-glass list + a board-assigned admin snapshot. */
function authority(opts: { env?: string; assigned?: string[] } = {}): AdminAuthority {
  const config = {
    get: (key: string, def?: unknown) => (key === 'BOARD_ADMIN_EMAILS' ? (opts.env ?? '') : def),
  } as unknown as ConfigService;
  return new AdminAuthority(config, { emails: () => opts.assigned ?? [] });
}

/**
 * A ConfigService answering the two flags this controller reads:
 * GITHUB_WRITE_ENABLED (the `canWrite` input) and CAPABILITY_GUARD_ENFORCING
 * (whether the capability map reports verdicts or `unknown`). Everything else
 * falls through to the caller's default, so a third flag added to the handler
 * arrives here as its own default rather than as `undefined`.
 *
 * Enforcing defaults to FALSE here, which since task 8 is no longer
 * production's default — the schema defaults it to true. It stays false because
 * the twenty-odd constructions below are about the other fields /me returns and
 * pass no registry, so their capability map is `{}` whichever way the flag
 * points; every case that reads a capability hands the flag in explicitly.
 */
const cfg = (writes: boolean, enforcing = false) => {
  const answers: Record<string, boolean | string> = {
    GITHUB_WRITE_ENABLED: writes,
    CAPABILITY_GUARD_ENFORCING: enforcing,
    // No default since #1175, and `IssuesCacheService` builds the
    // submission-visibility scope from it in its constructor.
    FEEDBACK_REPO: 'acme/board',
  };
  return {
    get: (key: string, def?: unknown) => (key in answers ? answers[key] : def),
  } as unknown as ConfigService;
};

/**
 * The real resolver over a roster holding these records. Real resolver on
 * purpose: /me's contract is now "whatever the one handle path answers", so a
 * stub here would test nothing but itself.
 */
function logins(records: IdentityRecord[]): GithubLoginResolver {
  return new GithubLoginResolver(fakeIdentityStore(records));
}

/** A roster that maps nobody. The checked-in table still answers underneath. */
const nobody = logins([]);

describe('MeController', () => {
  const ctl = new MeController(authority({ env: 'boss@example.com' }), cfg(false), nobody);

  it('reflects the guard-attached session email and admin flag', async () => {
    expect(await ctl.me({ user: { email: 'anon@example.com' } })).toEqual({
      email: 'anon@example.com',
      isAdmin: false,
      adminsUnread: false,
      writesEnabled: false,
      canWrite: false,
      githubLogin: null,
      capabilities: {},
    });
  });

  it('marks a break-glass override admin isAdmin=true (case-insensitive)', async () => {
    expect(await ctl.me({ user: { email: 'BOSS@example.com' } })).toEqual({
      email: 'BOSS@example.com',
      isAdmin: true,
      adminsUnread: false,
      writesEnabled: false,
      canWrite: false,
      githubLogin: null,
      capabilities: {},
    });
  });

  it('marks a board-assigned admin isAdmin=true even with no env override (#143, #332)', async () => {
    const c = new MeController(authority({ assigned: ['owner@example.com'] }), cfg(false), nobody);
    expect((await c.me({ user: { email: 'owner@example.com' } })).isAdmin).toBe(true);
  });

  it('401s when the request carries no user — a guard regression must be loud', async () => {
    await expect(ctl.me({})).rejects.toThrow(UnauthorizedException);
  });

  it('401s on an empty email claim', async () => {
    await expect(ctl.me({ user: { email: '' } })).rejects.toThrow(UnauthorizedException);
  });
});

/**
 * `isAdmin: false` has two causes and /me reported one (#811).
 *
 * On a `db` board whose Postgres was already unreachable when it booted, the
 * admin cache has never had a successful read, so `emails()` answers `null` and
 * nobody resolves as admin — the break-glass deliberately included (#588). Every
 * caller therefore got `isAdmin: false`, and the frontend drew "This page is for
 * admins only" over an outage.
 *
 * `adminsUnread` is why that `false` is `false`. It grants nothing: `AdminGuard`
 * re-decides per request through the same authority and still refuses everybody.
 * What it buys is the account menu keeping the admin door visible, so the Audit
 * pane — the one place the lost-record count lives (#781) — is reachable to say
 * what is wrong.
 */
describe('MeController adminsUnread (#811)', () => {
  /** The admin cache before its first SUCCESSFUL read: `null`, not `[]`. */
  const unread = (env?: string) => {
    const config = {
      get: (key: string, def?: unknown) => (key === 'BOARD_ADMIN_EMAILS' ? (env ?? '') : def),
    } as unknown as ConfigService;
    return new AdminAuthority(config, { emails: () => null });
  };

  it('is true when the roster has never been read, beside an isAdmin nobody may trust', async () => {
    const c = new MeController(unread(), cfg(false), nobody);
    await expect(c.me({ user: { email: 'dev@example.com' } })).resolves.toMatchObject({
      isAdmin: false,
      adminsUnread: true,
    });
  });

  it('is false on an ordinary board, where isAdmin: false means what it says', async () => {
    const c = new MeController(authority({ assigned: ['owner@example.com'] }), cfg(false), nobody);
    await expect(c.me({ user: { email: 'dev@example.com' } })).resolves.toMatchObject({
      isAdmin: false,
      adminsUnread: false,
    });
  });

  it('is false for a read that SUCCEEDED and found no admins — empty is not unknown (#588)', async () => {
    const c = new MeController(authority({ assigned: [] }), cfg(false), nobody);
    expect((await c.me({ user: { email: 'dev@example.com' } })).adminsUnread).toBe(false);
  });

  it('grants nothing — the break-glass address is still not an admin on an unread roster', async () => {
    const c = new MeController(unread('boss@example.com'), cfg(false), nobody);
    await expect(c.me({ user: { email: 'boss@example.com' } })).resolves.toMatchObject({
      isAdmin: false,
      adminsUnread: true,
    });
  });

  // The report and the gate are one decision (#551), so the field a client reads
  // and the status the guard throws must describe the same board.
  it('agrees with what AdminGuard will actually do', () => {
    const authority = unread();
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user: { email: 'dev@example.com' } }) }),
    } as unknown as ExecutionContext;

    expect(authority.adminsUnread()).toBe(true);
    expect(() => new AdminGuard(authority).canActivate(ctx)).not.toThrow(ForbiddenException);
  });
});

describe('MeController canWrite', () => {
  const admin = authority({ env: 'boss@example.com' });

  it('true for a human session when writes are enabled', async () => {
    const c = new MeController(admin, cfg(true), nobody);
    expect(await c.me({ user: { email: 'a@x.io' } })).toEqual({
      email: 'a@x.io',
      isAdmin: false,
      adminsUnread: false,
      writesEnabled: true,
      canWrite: true,
      githubLogin: null,
      capabilities: {},
    });
  });

  it('false when GITHUB_WRITE_ENABLED is off', async () => {
    const c = new MeController(admin, cfg(false), nobody);
    expect((await c.me({ user: { email: 'a@x.io' } })).canWrite).toBe(false);
  });

  it('false for a scoped (PAT/agent) actor even when writes are enabled', async () => {
    const c = new MeController(admin, cfg(true), nobody);
    expect((await c.me({ user: { email: 'a@x.io', scopes: ['board:read'] } })).canWrite).toBe(false);
  });
});

// #520 — both ends of the account↔GitHub link already existed (the session email,
// the roster's login); /me never joined them, so the client had no way to know
// who the signed-in person is on GitHub.
describe('MeController githubLogin (#520)', () => {
  const admin = authority();

  it('answers the roster login for the signed-in address', async () => {
    const store = logins([
      identityRecordFor({
        emails: ['monalisa@example.com'],
        displayName: 'Monalisa',
        githubLogin: 'monalisa',
      }),
    ]);
    const c = new MeController(admin, cfg(false), store);
    expect(await c.me({ user: { email: 'monalisa@example.com' } })).toEqual({
      email: 'monalisa@example.com',
      isAdmin: false,
      adminsUnread: false,
      writesEnabled: false,
      canWrite: false,
      githubLogin: 'monalisa',
      capabilities: {},
    });
  });

  it('asks the store with the session email verbatim', async () => {
    const asked: string[] = [];
    const base = fakeIdentityStore([]);
    const watched: IdentityRepository = {
      ...base,
      identityForEmail: async (email: string) => {
        asked.push(email);
        return base.identityForEmail(email);
      },
    };
    const c = new MeController(admin, cfg(false), new GithubLoginResolver(watched));
    await c.me({ user: { email: 'Someone@example.com' } });
    expect(asked).toEqual(['Someone@example.com']);
  });

  it('null is a normal answer when nobody is mapped — not an error', async () => {
    const c = new MeController(admin, cfg(false), nobody);
    await expect(c.me({ user: { email: 'unmapped@x.io' } })).resolves.toMatchObject({ githubLogin: null });
  });

  // /me is also App's mount auth probe: it renders no chrome until this call
  // answers. Before #520 it touched no store at all, so a database hiccup could
  // not blank the app. It must not start being able to.
  it('degrades when the identity store fails — the session still answers', async () => {
    const broken = new GithubLoginResolver(unreachableIdentityStore());
    const c = new MeController(admin, cfg(true), broken);
    expect(await c.me({ user: { email: 'a@x.io' } })).toEqual({
      email: 'a@x.io',
      isAdmin: false,
      adminsUnread: false,
      writesEnabled: true,
      canWrite: true,
      githubLogin: null,
      capabilities: {},
    });
  });

  // Second #520 cycle: /me and "Your work" must give the same answer, so /me
  // reads the same resolver — roster first, checked-in table underneath.
  it('an address the roster does not map still answers from the checked-in table', async () => {
    const c = new MeController(admin, cfg(false), nobody);
    expect((await c.me({ user: { email: 'octocat@example.com' } })).githubLogin).toBe('octocat');
  });

  it('a broken store does not cost a person the handle the checked-in table holds', async () => {
    const broken = new GithubLoginResolver(unreachableIdentityStore());
    const c = new MeController(admin, cfg(false), broken);
    expect((await c.me({ user: { email: 'monalisa@example.com' } })).githubLogin).toBe(
      'monalisa',
    );
  });

  it('the roster wins over the checked-in table when they disagree', async () => {
    const store = logins([
      identityRecordFor({
        emails: ['octocat@example.com'],
        displayName: 'Octocat',
        githubLogin: 'renamed-handle',
      }),
    ]);
    const c = new MeController(admin, cfg(false), store);
    expect((await c.me({ user: { email: 'octocat@example.com' } })).githubLogin).toBe(
      'renamed-handle',
    );
  });

  // #540, end to end. The Access page said the handle was gone while /me went on
  // reporting it, because a cleared handle and an unknown person were one null.
  // `octocat@example.com` → `octocat` is a real PEOPLE_ALIASES row, so
  // this only passes if the roster's row stops the file from answering.
  it('reports no handle once an admin has cleared it', async () => {
    const store = logins([
      identityRecordFor({
        emails: ['octocat@example.com'],
        displayName: 'Octocat',
        githubLogin: null,
      }),
    ]);
    const c = new MeController(admin, cfg(false), store);
    expect((await c.me({ user: { email: 'octocat@example.com' } })).githubLogin).toBeNull();
  });
});

// #546 — a BOARD_AGENT_TOKENS actor authenticates as `agent:<name>`, an address
// built from a name in an environment variable. Nobody is behind it, so there is
// no handle to find; putting it through a lookup meant for people is what the
// board already refuses to do on the MCP side (whoAmI, #536).
describe('MeController githubLogin for a static agent (#546)', () => {
  const admin = authority();

  /** A roster that WOULD answer for the pseudo-address, and records who asked.
   *  The trap row is the point: a resolver returning null anyway would let a
   *  value-only assertion pass while the lookup still happened. */
  function trapped(address = 'agent:ci'): { resolver: GithubLoginResolver; asked: string[] } {
    const asked: string[] = [];
    const base = fakeIdentityStore([
      identityRecordFor({
        emails: [address],
        displayName: 'Somebody Real',
        githubLogin: 'should-never-be-returned',
      }),
    ]);
    const watched: IdentityRepository = {
      ...base,
      identityForEmail: async (email: string) => {
        asked.push(email);
        return base.identityForEmail(email);
      },
    };
    return { resolver: new GithubLoginResolver(watched), asked };
  }

  it('answers a static agent without asking the roster', async () => {
    const { resolver, asked } = trapped();
    const c = new MeController(admin, cfg(true), resolver);

    const answer = await c.me({
      user: { email: 'agent:ci', agent: true, staticAgent: true, scopes: ['board:read'] },
    });

    // Assert the CALL as well as the value — a lookup that happened and came
    // back empty is the defect, and null alone cannot tell the two apart.
    expect(asked).toEqual([]);
    // No `capabilities` key: it is absent for a static agent (#584).
    expect(answer).toEqual({
      email: 'agent:ci',
      isAdmin: false,
      adminsUnread: false,
      writesEnabled: false,
      canWrite: false,
      githubLogin: null,
    });
  });

  it('gives the same answer as board_whoami does for the same caller', async () => {
    // Two surfaces answering "who am I" differently for one caller is the
    // divergence the resolver exists to end. whoAmI short-circuits on
    // `staticAgent`; so must this route, off the same flag.
    const { resolver } = trapped();
    const c = new MeController(admin, cfg(false), resolver);

    const answer = await c.me({
      user: { email: 'agent:ci', agent: true, staticAgent: true, scopes: ['board:read'] },
    });

    expect(answer.email).toBe('agent:ci');
    expect(answer.githubLogin).toBeNull();
  });

  // The predicate must not be re-derivable from the address (#525). A token named
  // `claude@ci` produced `agent:claude@ci`, which passed the old "no @ in the
  // email" test and read as an ordinary person. `parseAgentTokens` refuses such a
  // name now, but that is a gate on a STRING; this pins the part that does not
  // depend on one. Mirrors `staticAgentWithPersonShapedName` in
  // people.controller.spec.ts, which holds the same line on that route.
  it('a static agent whose name is person-shaped is still asked for nothing', async () => {
    const { resolver, asked } = trapped('agent:claude@ci');
    const c = new MeController(admin, cfg(false), resolver);

    const answer = await c.me({
      user: { email: 'agent:claude@ci', agent: true, staticAgent: true, scopes: ['board:read'] },
    });

    expect(asked).toEqual([]);
    expect(answer.githubLogin).toBeNull();
  });

  it('a person carrying the same scopes still resolves their handle', async () => {
    // The short-circuit keys on `staticAgent`, never on `agent` or on the shape
    // of the address (#525) — a personal access token is its owner's, and its
    // owner has a handle.
    const store = logins([
      identityRecordFor({
        emails: ['monalisa@example.com'],
        displayName: 'Monalisa',
        githubLogin: 'monalisa',
      }),
    ]);
    const c = new MeController(admin, cfg(false), store);

    const answer = await c.me({
      user: { email: 'monalisa@example.com', agent: true, scopes: ['board:read'] },
    });

    expect(answer.githubLogin).toBe('monalisa');
  });
});

// #546, the second lookup on the same handler. `isAdmin` reaches the roster too:
// `StoredRoleAdminSource` flattens the `emails` array of every row whose stored
// role is `admin`, and that is the SAME array `identityForEmail` matches an
// address against. So one colliding row answers both questions, and withholding
// the handle while reporting `isAdmin: true` off the same collision closes half
// the door.
describe('MeController isAdmin for a static agent (#546)', () => {
  // The colliding row: one record, both lookups. Its address is the pseudo-address
  // and its stored role is admin, so the admin snapshot and the roster carry the
  // same string — which is exactly how the two lookups meet in production.
  const collision = identityRecordFor({
    emails: ['agent:ci'],
    displayName: 'Somebody Real',
    githubLogin: 'should-never-be-returned',
    role: 'admin',
  });
  /** AdminAuthority over the admin snapshot `StoredRoleAdminSource` would build
   *  from that row — the row's own `emails`, which is all that source selects. */
  const adminFromCollision = () => authority({ assigned: collision.emails });

  it('answers isAdmin false — a static agent is not a person and cannot be one', async () => {
    const c = new MeController(adminFromCollision(), cfg(false), logins([collision]));

    const answer = await c.me({
      user: { email: 'agent:ci', agent: true, staticAgent: true, scopes: ['board:read'] },
    });

    expect(answer).toEqual({
      email: 'agent:ci',
      isAdmin: false,
      adminsUnread: false,
      writesEnabled: false,
      canWrite: false,
      githubLogin: null, // and no `capabilities` — see #584 below
    });
  });

  it('takes admin from nobody else — a person on that same snapshot still reads true', async () => {
    // The guard against fixing the hint by breaking it: the withholding is keyed
    // on the caller, not on the snapshot, so an ordinary admin is untouched.
    const admins = authority({ assigned: ['boss@example.com'] });
    const c = new MeController(admins, cfg(false), nobody);

    expect((await c.me({ user: { email: 'boss@example.com' } })).isAdmin).toBe(true);
  });
});

// #551 — #546 fixed the REPORT and left the GATE asking a different question, so
// the board said one thing and enforced another. This is the drift test: one
// authority, one actor, both surfaces, asserted together. It fails the moment
// either side starts composing personhood on its own again.
describe('/api/auth/me and AdminGuard answer from one decision (#551)', () => {
  const ctxFor = (user: unknown) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

  it('a static agent in the admin set is told no, and is refused', async () => {
    const admins = authority({ assigned: ['agent:ci'] });
    const actor = { email: 'agent:ci', agent: true, staticAgent: true, scopes: ['board:read'] };

    const reported = (await new MeController(admins, cfg(false), nobody).me({ user: actor })).isAdmin;
    expect(reported).toBe(false);
    expect(() => new AdminGuard(admins).canActivate(ctxFor(actor))).toThrow(ForbiddenException);
  });

  it('a real admin is told yes, and is admitted', async () => {
    const admins = authority({ assigned: ['boss@example.com'] });
    const actor = { email: 'boss@example.com' };

    const reported = (await new MeController(admins, cfg(false), nobody).me({ user: actor })).isAdmin;
    expect(reported).toBe(true);
    expect(new AdminGuard(admins).canActivate(ctxFor(actor))).toBe(true);
  });
});

/**
 * #584 — what the board will ACT on per capability, reported beside `canWrite`
 * and never folded into it.
 *
 * The registry is the real one: /me's contract is "whatever the guard would do",
 * and a stub here would let the two drift into agreeing only by inspection. The
 * enforcing flag is the other half of that contract, so every case below states
 * which side of it it is on.
 */
describe('MeController capabilities (#584)', () => {
  const admin = authority();
  const refused: Refusal = {
    reason: 'not-permitted',
    message: 'The board may not set a DRI',
    status: 403,
    retryable: false,
    scope: 'credential',
  };

  it('reports the registry it was given, per capability, once the guard enforces', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = new CapabilityRegistry(capCfg());
    registry.recordRefusal('repo.dri', refused);
    const c = new MeController(admin, cfg(true, true), nobody, registry);

    const { capabilities } = await c.me({ user: { email: 'a@x.io' } });
    // A human session always carries the key, so this asserts presence before
    // reading through it rather than optional-chaining the assertion away.
    expect(capabilities).toBeDefined();
    expect(capabilities?.['repo.dri']).toBe('refused');
    // Everything unattempted stays `unknown`, which refuses nothing — a refusal
    // reported where none was learned is the failure that matters here.
    expect(capabilities?.['issue.labels']).toBe('unknown');
    vi.restoreAllMocks();
  });

  it('leaves canWrite alone when a capability is refused', async () => {
    // The trap this test exists for: `canWrite` gates the WHOLE in-board issue
    // editor, so folding one capability into it would turn every issue control
    // off the moment an unrelated capability was refused.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = new CapabilityRegistry(capCfg());
    registry.recordRefusal('repo.dri', refused);
    const c = new MeController(admin, cfg(true, true), nobody, registry);

    const answer = await c.me({ user: { email: 'a@x.io' } });
    expect(answer.canWrite).toBe(true);
    expect(answer.capabilities?.['repo.dri']).toBe('refused');
    vi.restoreAllMocks();
  });

  it('tells a static agent nothing about the credential’s refusal footprint', async () => {
    // MeController declares no @RequiredScopes, so a `board:read` static agent
    // token reaches this route — and the map is the whole shape of what the
    // board's credential has been refused, which is the credential's business
    // and not a token's. It is omitted for an agent the way `githubLogin` is
    // short-circuited for one, off the same `isStaticAgent` flag.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = new CapabilityRegistry(capCfg());
    registry.recordRefusal('repo.dri', refused);
    const c = new MeController(admin, cfg(true, true), nobody, registry);
    const agent = { email: 'agent:ci', agent: true, staticAgent: true, scopes: ['board:read'] };

    const forAgent = await c.me({ user: agent });
    // The KEY, not the value: an empty map is still an answer, and `{}` would
    // read as "nothing is refused" while the human answer says otherwise.
    expect(Object.keys(forAgent)).not.toContain('capabilities');
    expect(forAgent.capabilities).toBeUndefined();

    // …and the same registry, the same controller, a human session: unchanged.
    // The frontend reader is a human session, and CI renders the built SPA over
    // scripts/fixtures/team-api.json, so a shape that moved here would break it
    // while every unit suite stayed green.
    const forHuman = await c.me({ user: { email: 'a@x.io' } });
    expect(Object.keys(forHuman).sort()).toEqual([
      'adminsUnread',
      'canWrite',
      'capabilities',
      'email',
      'githubLogin',
      'isAdmin',
      'writesEnabled',
    ]);
    expect(forHuman.capabilities?.['repo.dri']).toBe('refused');
    vi.restoreAllMocks();
  });

  it('answers an empty map when no registry was injected', async () => {
    // The parameter is optional-with-a-default because this controller is built
    // 21 times in this file; an absent registry must answer, not throw. Both
    // sides of the flag, because the reporting-mode answer is derived from the
    // snapshot and an absent snapshot must not become a different shape.
    for (const enforcing of [false, true]) {
      const c = new MeController(admin, cfg(true, enforcing), nobody);
      expect((await c.me({ user: { email: 'a@x.io' } })).capabilities).toEqual({});
    }
  });

  /**
   * The reported capability and the enforced one are ONE calculation.
   *
   * These two cases are a single argument apart — same registry, same recorded
   * refusal, same controller class, only the enforcing flag differs — so neither
   * direction can be satisfied by hardcoding a constant. The first also asserts
   * that the registry still says `refused` while the handler says `unknown`:
   * nothing is being hidden from the guard, the guard reads `state()` itself,
   * and this is only the handler declining to report a refusal that is not
   * happening.
   */
  const withRefusedDri = () => {
    const registry = new CapabilityRegistry(capCfg());
    registry.recordRefusal('repo.dri', refused);
    return registry;
  };

  it('reports unknown for a refused capability while the guard only reports', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = withRefusedDri();
    // The registry's own answer, unchanged by any of this.
    expect(registry.state('repo.dri').state).toBe('refused');

    const c = new MeController(admin, cfg(true, false), nobody, registry);
    const { capabilities } = await c.me({ user: { email: 'a@x.io' } });

    expect(capabilities?.['repo.dri']).toBe('unknown');
    // Every capability, not just the refused one — and the key set is the same
    // one enforcing mode reports, so a client cannot tell the modes apart by
    // which capabilities are named.
    expect(Object.values(capabilities ?? {})).not.toContain('refused');
    expect(Object.keys(capabilities ?? {})).toContain('issue.labels');
    vi.restoreAllMocks();
  });

  it('falls back to what the GUARD will do when the config answers nothing at all', async () => {
    // `cfg` above answers the key, so it cannot catch a wrong DEFAULT — and the
    // default is no longer this handler's own (#626). Both this handler and
    // `CapabilityGuard` read `capabilityGuardEnforcing`, whose single fallback
    // is `true`; the handler used to carry its own `false` here, so a board that
    // could not read the env would have refused the write at the guard while
    // reporting that nothing was refused.
    // Neither reading survives into a validated boot — Joi applies `true` when
    // the key is unset and aborts the boot when it is unreadable — so what this
    // pins is the direction of that unreachable branch, and that there is now
    // one of it.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const silent = {
      get: (key: string, def?: unknown) => (key === 'GITHUB_WRITE_ENABLED' ? true : def),
    } as unknown as ConfigService;

    const c = new MeController(admin, silent, nobody, withRefusedDri());
    const { capabilities } = await c.me({ user: { email: 'a@x.io' } });

    expect(capabilities?.['repo.dri']).toBe('refused');
    // The guard, asked the same question through the same accessor, agrees.
    expect(capabilityGuardEnforcing(silent)).toBe(true);
    vi.restoreAllMocks();
  });

  it('reports refused for that same capability once the guard enforces', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = withRefusedDri();

    const c = new MeController(admin, cfg(true, true), nobody, registry);
    const { capabilities } = await c.me({ user: { email: 'a@x.io' } });

    expect(capabilities?.['repo.dri']).toBe('refused');
    expect(capabilities?.['issue.labels']).toBe('unknown');
    vi.restoreAllMocks();
  });
});

/**
 * #626 — `canWrite` and the `capabilities` map are ONE reading.
 *
 * The flag used to be assembled separately from the map beside it, so a request
 * could ship `canWrite: true` next to a refused issue capability and the editor
 * would draw controls that 403. The aggregation is over the issue-editor set
 * only: a refused `repo.dri` is the repos page's business, and ReposPage.tsx
 * reads that key itself.
 *
 * Which is why `writesEnabled` ships beside it: two readings of one
 * calculation. `writesEnabled` is the session-and-config half — what `canWrite`
 * meant before this issue — and it is what a surface outside the issue editor
 * composes with its own capability. Gating such a surface on `canWrite` reads
 * the issue set's refusals into a page that writes none of them, which is the
 * defect the pair below pins.
 */
describe('MeController canWrite is derived from the capability map (#626)', () => {
  const admin = authority();
  const refusedLabels: Refusal = {
    reason: 'not-permitted',
    message: 'The board may not label issues',
    status: 403,
    retryable: false,
    scope: 'credential',
  };
  const refusedDri: Refusal = {
    reason: 'not-permitted',
    message: 'The board may not set a DRI',
    status: 403,
    retryable: false,
    scope: 'credential',
  };

  const withRefusal = (cap: 'issue.labels' | 'repo.dri', r: Refusal) => {
    const registry = new CapabilityRegistry(capCfg());
    registry.recordRefusal(cap, r);
    return registry;
  };

  it('false when an issue-editor capability reads refused, and the map says so too', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const c = new MeController(admin, cfg(true, true), nobody, withRefusal('issue.labels', refusedLabels));

    const answer = await c.me({ user: { email: 'a@x.io' } });

    // Both halves of the one reading, asserted together — a flag derived from a
    // second `snapshot()` call could differ from this map and this is what
    // catches it.
    expect(answer.canWrite).toBe(false);
    expect(answer.capabilities?.['issue.labels']).toBe('refused');
    vi.restoreAllMocks();
  });

  it('a refused issue capability turns canWrite off and leaves writesEnabled on', async () => {
    // The whole point of the split, and the seam the repos-page defect crossed:
    // `issue.labels` is refused credential-wide, so the ISSUE editor must go
    // dark — but the session is still a human one on a deployment with writes
    // turned on, and `repo.dri` is not refused, so the owner picker must not.
    // ReposPage.tsx gates on `writesEnabled` for exactly this reason; before
    // this field existed it had nothing but `canWrite` to read, and a labels
    // refusal took the picker off every tile.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const c = new MeController(admin, cfg(true, true), nobody, withRefusal('issue.labels', refusedLabels));

    const answer = await c.me({ user: { email: 'a@x.io' } });

    expect(answer.canWrite).toBe(false);
    expect(answer.writesEnabled).toBe(true);
    expect(answer.capabilities?.['issue.labels']).toBe('refused');
    // …and the capability the picker actually reads is untouched by that.
    expect(answer.capabilities?.['repo.dri']).toBe('unknown');
    vi.restoreAllMocks();
  });

  it('writesEnabled is off for a switched-off deployment and for a scoped actor', async () => {
    // Neither half of it produces a capability refusal — the write envelope
    // stops one and the write guard stops the other, both before any capability
    // is consulted — so a surface gated on its own capability ALONE would draw a
    // control over a write that 403s. That is why the field is not `canWrite`
    // minus the issue set, and why a page composes it rather than dropping it.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = () => withRefusal('repo.dri', refusedDri);

    const writesOff = new MeController(admin, cfg(false, true), nobody, registry());
    const off = await writesOff.me({ user: { email: 'a@x.io' } });
    expect(off.writesEnabled).toBe(false);
    expect(off.canWrite).toBe(false);

    const scoped = new MeController(admin, cfg(true, true), nobody, registry());
    const pat = await scoped.me({ user: { email: 'a@x.io', scopes: ['board:read'] } });
    expect(pat.writesEnabled).toBe(false);
    expect(pat.canWrite).toBe(false);
    vi.restoreAllMocks();
  });

  it('true when only a NON-editor capability is refused', async () => {
    // The trap the old comment was written against, kept: `repo.dri` must not
    // turn off every issue control. It is asserted beside the refused value so
    // the pass cannot come from the refusal having failed to register.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const c = new MeController(admin, cfg(true, true), nobody, withRefusal('repo.dri', refusedDri));

    const answer = await c.me({ user: { email: 'a@x.io' } });

    expect(answer.canWrite).toBe(true);
    expect(answer.capabilities?.['repo.dri']).toBe('refused');
    vi.restoreAllMocks();
  });

  it('unchanged in reporting mode — the map is all unknown, so nothing is refused', async () => {
    // One argument apart from the first case: same registry, same refusal, same
    // controller, only the enforcing flag differs. Which is the contract — the
    // flag reports what the GUARD will do, and in reporting mode the guard
    // refuses nothing.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const c = new MeController(admin, cfg(true, false), nobody, withRefusal('issue.labels', refusedLabels));

    const answer = await c.me({ user: { email: 'a@x.io' } });

    expect(answer.canWrite).toBe(true);
    expect(answer.capabilities?.['issue.labels']).toBe('unknown');
    vi.restoreAllMocks();
  });

  it('every capability in the editor set can turn it off, and only that set', async () => {
    // The set is nine names; testing one of them would leave eight unpinned, and
    // an aggregation that read a single hardcoded capability would pass.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const cap of ISSUE_EDITOR_CAPABILITIES) {
      const c = new MeController(admin, cfg(true, true), nobody, withRefusal(cap as 'issue.labels', refusedLabels));
      expect((await c.me({ user: { email: 'a@x.io' } })).canWrite, cap).toBe(false);
    }
    for (const cap of CAPABILITIES.filter((c) => !ISSUE_EDITOR_CAPABILITIES.includes(c))) {
      const c = new MeController(admin, cfg(true, true), nobody, withRefusal(cap as 'repo.dri', refusedDri));
      expect((await c.me({ user: { email: 'a@x.io' } })).canWrite, cap).toBe(true);
    }
    vi.restoreAllMocks();
  });

  it('a static agent is still false, and is still told nothing about the map', async () => {
    // Both kept (#584): the flag is false at `isHumanSession` before the
    // aggregation is reached, and the map is computed for the request without
    // being put on the wire for one.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const c = new MeController(admin, cfg(true, true), nobody, withRefusal('issue.labels', refusedLabels));

    const answer = await c.me({
      user: { email: 'agent:ci', agent: true, staticAgent: true, scopes: ['board:read'] },
    });

    expect(answer.canWrite).toBe(false);
    expect(Object.keys(answer)).not.toContain('capabilities');
    vi.restoreAllMocks();
  });
});

/**
 * #650 — /me says which configured orgs the board could actually READ.
 *
 * The failure it ends: with `GITHUB_ORGS=acme,globex` and globex's
 * grant revoked, acme enumerates normally, the ingest correctly keeps
 * going, and the union it produces cannot say which orgs it covers. Every
 * globex member's throughput reads zero and their aging tiles draw empty —
 * served 200, and indistinguishable on screen from a quiet week.
 *
 * Everything below runs the REAL composition: the real `IssuesCacheService` as
 * the ingest's record, the real `CapabilityRegistry` as the boot probe, the real
 * `composeOrgReadState` joining them. A stub for either record would test the
 * stub's precedence rule rather than production's, and precedence between those
 * two records is the whole of this feature.
 */
describe('/api/auth/me — which orgs the board could read (#650)', () => {
  const admin = authority();
  const person = { user: { email: 'anon@example.com' } };

  type IssuesSourceArg = ConstructorParameters<typeof IssuesCacheService>[0];

  /** The real cache over a source that reports these outcomes. Not warmed —
   *  `warm()` below is what makes an ingest have happened. */
  const ingestCache = (outcomes: OrgReadOutcome[] | 'cannot say'): IssuesCacheService => {
    const source = {
      listIssues: async () => [],
      ...(outcomes === 'cannot say' ? {} : { orgOutcomes: () => outcomes }),
    } as IssuesSourceArg;
    return new IssuesCacheService(source, cfg(false));
  };

  const warm = async (cache: IssuesCacheService): Promise<IssuesCacheService> => {
    await cache.getIssues();
    return cache;
  };

  /** The real boot probe, run through `probe()` — the entry point
   *  `capability.module.ts` calls — so what it retains is what boot retains. */
  const bootedRegistry = async (readable: Record<string, boolean>) => {
    const r = new CapabilityRegistry(
      capCfg({ GITHUB_ORGS: Object.keys(readable).join(',') }),
      undefined,
      async () => ({}),
      async (org: string) => {
        if (!readable[org]) throw new Error('403 Forbidden — no grant on this org');
      },
    );
    await r.probe();
    return r;
  };

  const controller = (cache: IssuesCacheService, boot?: CapabilityRegistry) =>
    new MeController(admin, cfg(false), nobody, undefined, composeOrgReadState(cache, boot));

  it('names an unreadable org, and what Github said, when the ingest could not enumerate it', async () => {
    const cache = await warm(
      ingestCache([
        { org: 'acme', state: 'read', reason: null, calls: 4 },
        { org: 'globex', state: 'unreadable', reason: '403 Forbidden', calls: 1 },
      ]),
    );

    const { orgs } = await controller(cache).me(person);

    expect(orgs).toContainEqual({ org: 'globex', state: 'unreadable', reason: '403 Forbidden' });
    // The reason travels, because "globex is unreadable" with nothing to say
    // whether that is a credential, a 404 or a Github outage leaves the person
    // reading it with no next step. Before this, the cause existed only in a log
    // line, and no surface can read a log line.
    expect(orgs?.find((o) => o.org === 'globex')?.reason).toMatch(/403/);
  });

  it('names an org as read when the ingest enumerated it', async () => {
    const cache = await warm(
      ingestCache([{ org: 'acme', state: 'read', reason: null, calls: 4 }]),
    );

    expect((await controller(cache).me(person)).orgs).toEqual([
      { org: 'acme', state: 'read', reason: null },
    ]);
  });

  it('never puts `calls` on the wire', async () => {
    // A cost measurement — "what does a second org cost" — which is an
    // operator's question, not this field's. It stays on the server-side record.
    const cache = await warm(
      ingestCache([{ org: 'acme', state: 'read', reason: null, calls: 4 }]),
    );

    const { orgs } = await controller(cache).me(person);

    expect(Object.keys(orgs![0]).sort()).toEqual(['org', 'reason', 'state']);
    expect(cache.lastIngestOrgs()![0].calls).toBe(4);
  });

  it('answers from the boot probe before any ingest has succeeded', async () => {
    // The one window the probe exists for. A cache that has never completed a
    // run holds no snapshot, and the alternative to the probe here is the board
    // saying nothing about any org for the whole of the first TTL.
    const boot = await bootedRegistry({ 'acme': true, globex: false });
    const cold = ingestCache([]); // constructed, never warmed

    const { orgs } = await controller(cold, boot).me(person);

    expect(orgs?.map((o) => [o.org, o.state])).toEqual([
      ['acme', 'read'],
      ['globex', 'unreadable'],
    ]);
    expect(orgs?.find((o) => o.org === 'globex')?.reason).toMatch(/403 Forbidden/);
  });

  it('stops reading the boot probe once an ingest has succeeded — the ingest wins', async () => {
    // THE anti-drift case. The probe runs once, at process start, and never
    // again; the ingest describes the run that produced the numbers a person is
    // looking at. An org whose grant was restored ten minutes after boot must
    // read `read` here, or the surface lies about the exact thing this field
    // exists to stop it lying about — in the direction that says "we cannot see
    // globex" while globex's work is on screen.
    const boot = await bootedRegistry({ globex: false });
    const cache = await warm(
      ingestCache([{ org: 'globex', state: 'read', reason: null, calls: 2 }]),
    );

    expect((await controller(cache, boot).me(person)).orgs).toEqual([
      { org: 'globex', state: 'read', reason: null },
    ]);
  });

  it('an ingest that claims nothing still ends the boot window — no claim, not a stale one', async () => {
    // The other direction of the same rule, and the one an early-return `||`
    // would get wrong: a run HAPPENED and could say nothing about any org (a
    // source with no orgs to report), which is not the same as no run at all.
    // Falling back to the probe here would republish a boot-time verdict as
    // though the run had confirmed it.
    const boot = await bootedRegistry({ 'acme': true, globex: false });
    const cache = await warm(ingestCache('cannot say'));

    // `[]` is "the board makes NO CLAIM about any org" — never "every org is
    // fine", and never a fabricated `read` for an org nothing measured. Every
    // surface must draw exactly what it drew before this field existed.
    expect((await controller(cache, boot).me(person)).orgs).toEqual([]);
  });

  it('ships to a static agent, unlike the capability map', async () => {
    // ARGUED, because #584 omits `capabilities` for one and the two look alike.
    // They are different kinds of fact. `capabilities` is the complete map of
    // what the board's CREDENTIAL has been refused — enumerable nowhere else, so
    // handing it to a `board:read` token tells a token about the deployment.
    // This says which orgs the DATA are drawn from. An agent reads the same
    // holed union through /api/issues/mine and the metrics routes, so
    // withholding the hole protects nothing and only moves the silent wrong
    // answer from a human's screen into an agent's context — which is the
    // failure this field exists to end.
    const cache = await warm(
      ingestCache([{ org: 'globex', state: 'unreadable', reason: '403 Forbidden', calls: 1 }]),
    );

    const answer = await controller(cache).me({
      user: { email: 'agent:ci', agent: true, staticAgent: true, scopes: ['board:read'] },
    });

    expect(answer.orgs).toEqual([{ org: 'globex', state: 'unreadable', reason: '403 Forbidden' }]);
    // …and the map it is still told nothing about, so this is a distinction the
    // handler makes rather than a rule it dropped.
    expect(Object.keys(answer)).not.toContain('capabilities');
  });

  it('answers exactly what it answered before when no accessor is wired', async () => {
    // The key is ABSENT, not `[]`: a deployment that wired nothing has measured
    // nothing, and an empty array is a claim about a question nobody asked.
    const answer = await new MeController(admin, cfg(false), nobody).me(person);

    expect(Object.keys(answer)).not.toContain('orgs');
    expect(answer).toEqual({
      email: 'anon@example.com',
      isAdmin: false,
      adminsUnread: false,
      writesEnabled: false,
      canWrite: false,
      githubLogin: null,
      capabilities: {},
    });
  });
});

it('refreshes the readable hint only for a verified human and only until session expiry', async () => {
  const config = { get: (key: string, fallback?: unknown) => ({ BOARD_SESSION_SECRET: 'secret', BOARD_BASE_URL: 'https://board.test' } as Record<string, string>)[key] ?? fallback } as ConfigService;
  const ctl = new MeController(authority(), config, nobody);
  const cookie = vi.fn();
  const expires = Math.floor(Date.now() / 1000) + 120;
  const body = await ctl.me({ user: { email: 'reader@example.test', boardSub: 'subject', sessionExpiresAt: expires } }, { cookie } as any);
  expect(body.sessionHintId).toMatch(/^[a-f0-9]{64}$/);
  expect(cookie).toHaveBeenCalledTimes(1);
  const [name, value, options] = cookie.mock.calls[0];
  expect(name).toBe('board_session_hint');
  expect(JSON.parse(value)).toEqual({ id: body.sessionHintId, visibilityKey: null });
  expect(options).toMatchObject({ httpOnly: false, secure: true, sameSite: 'lax', path: '/' });
  expect(options.maxAge).toBeGreaterThan(118000);
  expect(options.maxAge).toBeLessThanOrEqual(120000);
  cookie.mockClear();
  const agent = await ctl.me({ user: { email: 'reader@example.test', boardSub: 'subject', scopes: ['board:read'], sessionExpiresAt: expires } }, { cookie } as any);
  expect(agent.sessionHintId).toBeUndefined();
  expect(cookie).not.toHaveBeenCalled();
});

it('keys the cookie and JSON visibility by the server secret, including unconnected people', async () => {
  const { createHash } = await import('node:crypto');
  const key = 'unconnected:reader@example.test\0subject';
  const principal = { key, email: 'reader@example.test', login: null, token: null, owners: [], repositories: [], cache: new WeakMap() };
  const read = async (secret: string) => {
    const cookie = vi.fn();
    const config = new ConfigService({ BOARD_SESSION_SECRET: secret, BOARD_BASE_URL: 'https://board.test' });
    const body = await githubContext.run({ principal }, () => new MeController(authority(), config, nobody).me(
      { user: { email: principal.email, boardSub: 'subject', sessionExpiresAt: Math.floor(Date.now() / 1000) + 120 } }, { cookie } as any,
    ));
    return { body, cookie };
  };
  const first = await read('synthetic-server-key');
  const repeated = await read('synthetic-server-key');
  const rotated = await read('rotated-server-key');
  expect(first.body.github!.visibilityKey).toMatch(/^[a-f0-9]{64}$/);
  expect(first.body.github!.visibilityKey).not.toBe(createHash('sha256').update(key).digest('hex'));
  expect(first.body.github!.visibilityKey).toBe(repeated.body.github!.visibilityKey);
  expect(first.body.github!.visibilityKey).not.toBe(rotated.body.github!.visibilityKey);
  expect(JSON.parse(first.cookie.mock.calls[0][1]).visibilityKey).toBe(first.body.github!.visibilityKey);
  const unsafe = await read('dev-insecure-session-secret-change-me');
  expect(unsafe.body.sessionHintId).toBeUndefined();
  expect(unsafe.body.github!.visibilityKey).toBe('');
  expect(unsafe.cookie).not.toHaveBeenCalled();
});

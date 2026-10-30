import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { GithubCredential, PrismaClient } from '../generated/prisma/client';
import { GithubUserService } from './github-user.service';
import { GithubAuthController } from './github-auth.controller';
import { MeController } from './me.controller';
import { CredentialCipher } from './github-credential-cipher';
import { githubContext, type GithubPrincipal } from './github-principal';
import {
  GITHUB_AUTHORIZATIONS_URL,
  appInstallUrl,
  installationManageUrl,
} from './github-app-links';
import type { AdminAuthority } from './admin-authority';
import type { GithubLoginResolver } from '../identity/github-login.resolver';
import type { SessionService } from './session.service';
import type { SessionRevocationService } from './session-revocation.service';
import { configValidationSchema } from '../config/config.schema';

/**
 * Account > Github (#892): the backend behind the page that shows what a person
 * has consented to on Github and sends them somewhere to change it.
 *
 * The whole surface is READ plus one invalidation. Nothing here writes a consent
 * — the board has no endpoint that installs, uninstalls or approves anything —
 * so what these tests pin is that the read tells the truth about a consent, that
 * one person's consents never appear under another's, that every link is one the
 * board built rather than one a provider handed it, and that the invalidation is
 * a browser-session control keyed to its own caller.
 */

const KEY = Buffer.alloc(32, 7);
const cipher = new CredentialCipher({ key: () => KEY });
const config = new ConfigService({
  GITHUB_USER_APP_CLIENT_ID: 'synthetic-client-id',
  GITHUB_USER_APP_CLIENT_SECRET: 'synthetic-client-secret',
  BOARD_CREDENTIAL_KEY: KEY.toString('base64'),
});

function row(email: string, githubUserId: string): GithubCredential {
  const login = email.split('@')[0];
  return {
    ownerEmail: login, boardSub: githubUserId, githubUserId, githubLogin: login,
    accessCipher: cipher.encrypt(email, `${githubUserId}:access`),
    refreshCipher: cipher.encrypt('refresh', `${githubUserId}:refresh`),
    version: `v-${githubUserId}`,
    accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000),
    scopes: '', refreshLeaseUntil: null, signInAdmittedAt: null, revokedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

/** One synthetic Github, answering the two routes `discover` calls and counting
 *  every request so a test can assert that this feature added none. */
function github(installationsFor: (token: string) => unknown[], reposFor: (installationId: number) => unknown[]) {
  const wire: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get('authorization') ?? '';
    wire.push(`${String(url)}`);
    const path = String(url);
    const repos = path.match(/\/user\/installations\/(\d+)\/repositories/);
    const data = repos
      ? { total_count: 0, repositories: reposFor(Number(repos[1])) }
      : { total_count: 0, installations: installationsFor(token.replace('token ', '')) };
    const response = new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: path });
    return response;
  }));
  return wire;
}

const repo = (id: number, owner: string) => ({ id, name: `repo${id}`, full_name: `${owner}/repo${id}`, owner: { login: owner }, permissions: { admin: false, push: true } });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('the consents a person holds, read off the discovery that was happening anyway', () => {
  /**
   * `alice` is in `acme` (live), `dormant` (SUSPENDED) and her own namespace.
   * `bob@example.test`'s personal installation is visible to nobody but bob.
   */
  const INSTALLATIONS = [
    { id: 10, app_slug: 'board-app', account: { id: 100, login: 'acme', type: 'Organization' }, suspended_at: null, repository_selection: 'selected', permissions: { issues: 'write', metadata: 'read' } },
    { id: 11, app_slug: 'board-app', account: { id: 101, login: 'dormant', type: 'Organization' }, suspended_at: '2026-09-01T00:00:00Z', permissions: { issues: 'read' } },
    { id: 12, app_slug: 'board-app', account: { id: 900, login: 'alice', type: 'User' }, suspended_at: null, repository_selection: 'all', permissions: { metadata: 'read' } },
    { id: 13, app_slug: 'board-app', account: { id: 901, login: 'bob', type: 'User' }, suspended_at: null, repository_selection: 'all', permissions: { metadata: 'read' } },
  ];
  const REPOS: Record<number, unknown[]> = { 10: [repo(1, 'acme'), repo(2, 'acme')], 11: [repo(9, 'dormant')], 12: [repo(3, 'alice')], 13: [repo(4, 'bob')] };

  function service() {
    const rows = new Map([['900', row('alice@example.test', '900')], ['901', row('bob@example.test', '901')]]);
    const db = { githubCredential: { findUnique: vi.fn(async ({ where }: { where: { githubUserId: string } }) => rows.get(where.githubUserId) ?? null) } } as unknown as PrismaClient;
    return new GithubUserService(config, db);
  }

  it('lists a suspended installation as a consent while granting nothing through it', async () => {
    github(() => INSTALLATIONS, (id) => REPOS[id] ?? []);
    const alice = await service().principal('alice@example.test', '900');

    // The management list carries the suspension; access does not carry the org.
    expect(alice.installations?.map((i) => [i.account.login, i.suspended])).toEqual([
      ['acme', false], ['dormant', true], ['alice', false],
    ]);
    expect(alice.owners.map((o) => o.login)).toEqual(['acme', 'alice']);
    expect(alice.repositories.map((r) => r.full_name).sort()).toEqual(['acme/repo1', 'acme/repo2', 'alice/repo3']);
    expect(alice.repositories.some((r) => r.owner.login === 'dormant')).toBe(false);

    // Never enumerated, so never counted — `null` says "not counted", where `0`
    // would claim the installation covers nothing.
    const dormant = alice.installations!.find((i) => i.account.login === 'dormant')!;
    expect(dormant.repositoryCount).toBeNull();
    expect(dormant.repositorySelection).toBe('unknown');
  });

  it('counts the repositories this person reaches, and reports the app grants as grants of the app', async () => {
    github(() => INSTALLATIONS, (id) => REPOS[id] ?? []);
    const alice = await service().principal('alice@example.test', '900');
    const acme = alice.installations!.find((i) => i.account.login === 'acme')!;
    expect(acme.repositoryCount).toBe(2);
    expect(acme.repositorySelection).toBe('selected');
    // The APP's grants, verbatim and unmerged with the person's own repo roles:
    // `issues: write` here sits beside `permissions.admin === false` on both of
    // the repositories the same person reaches.
    expect(acme.permissions).toEqual({ issues: 'write', metadata: 'read' });
    expect(alice.repositories.every((r) => r.permissions?.admin === false)).toBe(true);
  });

  it('shows a person their own namespace and never another person’s', async () => {
    github(() => INSTALLATIONS, (id) => REPOS[id] ?? []);
    const svc = service();
    const alice = await svc.principal('alice@example.test', '900');
    const bob = await svc.principal('bob@example.test', '901');

    // The User filter is on the immutable Github user id, so the same payload
    // yields a different personal installation to each of them, and no leak of
    // the other's — even though both tokens saw both rows.
    expect(alice.installations!.filter((i) => i.account.type === 'User').map((i) => i.account.login)).toEqual(['alice']);
    expect(bob.installations!.filter((i) => i.account.type === 'User').map((i) => i.account.login)).toEqual(['bob']);
    expect(alice.installations).not.toBe(bob.installations);
    expect(JSON.stringify(alice.installations)).not.toContain('bob');
    expect(JSON.stringify(bob.installations)).not.toContain('alice');
  });

  it('builds every manage link itself, from the id and the account type', async () => {
    github(() => INSTALLATIONS, (id) => REPOS[id] ?? []);
    const alice = await service().principal('alice@example.test', '900');
    expect(alice.installations!.map((i) => i.manageUrl)).toEqual([
      'https://github.com/organizations/acme/settings/installations/10',
      'https://github.com/organizations/dormant/settings/installations/11',
      'https://github.com/settings/installations/12',
    ]);
  });

  it('drops an installation whose account login is not a login, and keeps the access it grants', async () => {
    // A provider anomaly: a login that would escape the path it is interpolated
    // into. It costs a row on the management page and nothing else.
    const hostile = [
      { id: 20, app_slug: 'board-app', account: { id: 100, login: '../../evil?x=', type: 'Organization' }, suspended_at: null, repository_selection: 'all', permissions: {} },
      ...INSTALLATIONS.slice(0, 1),
    ];
    github(() => hostile, () => [repo(7, 'acme')]);
    const alice = await service().principal('alice@example.test', '900');
    expect(alice.installations!.map((i) => i.id)).toEqual([10]);
    expect(alice.installations!.every((i) => i.manageUrl.startsWith('https://github.com/'))).toBe(true);
    expect(alice.owners.map((o) => o.login)).toEqual(['../../evil?x=', 'acme']);
  });

  it('adds no Github request: one installations page, one repository page per unsuspended installation', async () => {
    const wire = github(() => INSTALLATIONS, (id) => REPOS[id] ?? []);
    await service().principal('alice@example.test', '900');
    expect(wire.filter((u) => u.includes('/user/installations?')).length).toBe(1);
    // Installations 10 and 12 only — 11 is suspended, 13 is somebody else's.
    expect(wire.filter((u) => /\/user\/installations\/\d+\/repositories/.test(u)).map((u) => u.match(/installations\/(\d+)/)![1])).toEqual(['10', '12']);
    expect(wire).toHaveLength(3);
  });

  it('learns the app slug from an installation, and reports none when Github names none', async () => {
    github(() => INSTALLATIONS, (id) => REPOS[id] ?? []);
    expect((await service().principal('alice@example.test', '900')).appSlug).toBe('board-app');

    vi.unstubAllGlobals();
    github(() => INSTALLATIONS.map((i) => ({ ...i, app_slug: undefined })), (id) => REPOS[id] ?? []);
    expect((await service().principal('alice@example.test', '900')).appSlug).toBeNull();
  });
});

describe('the links, which the board constructs and never forwards', () => {
  it('refuses anything that is not a Github login or slug, rather than interpolating it', () => {
    for (const bad of ['../evil', 'a/b', 'x?y', 'x#y', 'x%2f', 'a b', '-lead', 'trail-', '', 'a'.repeat(40)]) {
      expect(installationManageUrl(1, { login: bad, type: 'Organization' })).toBeNull();
      expect(appInstallUrl(bad)).toBeNull();
    }
    expect(appInstallUrl(null)).toBeNull();
    expect(appInstallUrl(undefined)).toBeNull();
    expect(appInstallUrl('Board-App')).toBe('https://github.com/apps/board-app/installations/new');
  });

  it('refuses an installation id that is not a positive integer', () => {
    const acme = { login: 'acme', type: 'Organization' } as const;
    for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      expect(installationManageUrl(bad, acme)).toBeNull();
    }
    expect(installationManageUrl(42, acme)).toBe('https://github.com/organizations/acme/settings/installations/42');
  });

  it('refuses a badly shaped GITHUB_USER_APP_SLUG at boot rather than at render', () => {
    const validate = (value: string) => configValidationSchema.validate(
      // `GITHUB_ORGS` and `FEEDBACK_REPO` are named because #1175 requires them
      // of every deployment; this case is about neither.
      { GITHUB_USER_APP_SLUG: value, IDENTITY_SOURCE: 'fixture', GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board', ISSUES_SOURCE: 'fixture' },
      { allowUnknown: true, abortEarly: true },
    ).error?.message;
    expect(validate('https://github.com/apps/board-app')).toMatch(/GITHUB_USER_APP_SLUG/);
    expect(validate('board app')).toMatch(/must be a Github App slug/);
    expect(validate('board-app')).toBeUndefined();
    // Unset is a supported deployment, not an error: the observed slug covers it.
    expect(validate('')).toBeUndefined();
  });
});

describe('/api/auth/me reports the consents and where to change them', () => {
  const authority = { isAdminActor: () => false, adminsUnread: () => false } as unknown as AdminAuthority;
  const logins = { forEmail: async () => null } as unknown as GithubLoginResolver;
  const cfg = (answers: Record<string, unknown> = {}) => ({
    get: (key: string, def?: unknown) => (key in answers ? answers[key] : def),
  } as unknown as ConfigService);

  const principal = (over: Partial<GithubPrincipal> = {}): GithubPrincipal => ({
    key: 'visibility-key', email: 'alice@example.test', login: 'alice', token: 'synthetic-token',
    owners: [{ login: 'acme', type: 'Organization' }], repositories: [], cache: new WeakMap(), ...over,
  });

  const me = (c: MeController, p: GithubPrincipal) =>
    githubContext.run({ principal: p }, () => c.me({ user: { email: 'alice@example.test' } }));

  it('answers the whole contract, withholding visibility without a session secret', async () => {
    const held = [{ id: 10, account: { login: 'acme', type: 'Organization' as const }, repositorySelection: 'selected' as const, repositoryCount: 2, permissions: { issues: 'write' }, suspended: false, manageUrl: 'https://github.com/organizations/acme/settings/installations/10' }];
    const body = await me(
      new MeController(authority, cfg({ GITHUB_USER_APP_CLIENT_ID: 'id', GITHUB_USER_APP_SLUG: 'board-app' }), logins),
      principal({ installations: held, expiresAt: 1_700_000_000_000 }),
    );
    expect(body.github).toEqual({
      configured: true, connected: true, owners: [{ login: 'acme', type: 'Organization' }], repositories: [],
      visibilityKey: '', expiresAt: 1_700_000_000_000, responseDeadlines: true,
      login: 'alice',
      installUrl: 'https://github.com/apps/board-app/installations/new',
      authorizationsUrl: GITHUB_AUTHORIZATIONS_URL,
      installations: held,
    });
    // An unconfigured session secret must not expose the raw key or token.
    expect(JSON.stringify(body)).not.toContain('visibility-key');
    expect(JSON.stringify(body)).not.toContain('synthetic-token');
  });

  it('prefers the configured slug over the observed one, and falls back when unset', async () => {
    const observed = principal({ appSlug: 'observed-app' });
    expect((await me(new MeController(authority, cfg({ GITHUB_USER_APP_SLUG: 'configured-app' }), logins), observed)).github!.installUrl)
      .toBe('https://github.com/apps/configured-app/installations/new');
    expect((await me(new MeController(authority, cfg(), logins), observed)).github!.installUrl)
      .toBe('https://github.com/apps/observed-app/installations/new');
  });

  it('answers null rather than guessing when no slug is known, and still answers the rest', async () => {
    const body = await me(new MeController(authority, cfg({ GITHUB_USER_APP_CLIENT_ID: 'id' }), logins), principal({ appSlug: null }));
    expect(body.github!.installUrl).toBeNull();
    expect(body.github!.authorizationsUrl).toBe(GITHUB_AUTHORIZATIONS_URL);
  });

  it('never lets a bad configured slug reach the response, even if the schema were bypassed', async () => {
    const body = await me(new MeController(authority, cfg({ GITHUB_USER_APP_SLUG: '../../evil' }), logins), principal());
    expect(body.github!.installUrl).toBeNull();
  });

  it('is honest about an unconnected person on an unconfigured board, and still offers the links it knows', async () => {
    const body = await me(
      new MeController(authority, cfg({ GITHUB_USER_APP_SLUG: 'board-app' }), logins),
      principal({ token: null, login: null, owners: [], installations: [] }),
    );
    expect(body.github).toMatchObject({
      configured: false, connected: false, owners: [], login: null, installations: [],
      installUrl: 'https://github.com/apps/board-app/installations/new',
      authorizationsUrl: GITHUB_AUTHORIZATIONS_URL,
    });
  });

  it('answers [] for a principal that predates the field, never undefined', async () => {
    const body = await me(new MeController(authority, cfg(), logins), principal());
    expect(body.github!.installations).toEqual([]);
  });

  it('omits the whole github object where it always did — no principal, no claim', async () => {
    const c = new MeController(authority, cfg({ GITHUB_USER_APP_SLUG: 'board-app' }), logins);
    expect((await c.me({ user: { email: 'alice@example.test' } })).github).toBeUndefined();
  });
});

describe('POST /api/auth/github/refresh-access', () => {
  function controller() {
    const github = { refreshAccess: vi.fn(), db: { githubCredential: { findUnique: vi.fn() } } };
    const c = new GithubAuthController(
      github as unknown as GithubUserService,
      { admits: vi.fn() } as never,
      {} as unknown as SessionService,
      {} as unknown as SessionRevocationService,
      { revokeAllForSubject: vi.fn() } as never,
      new ConfigService({ BOARD_BASE_URL: 'https://board.example.test', BOARD_SESSION_SECRET: 'synthetic-secret' }),
    );
    return { github, c };
  }
  const req = (user?: unknown) => ({ user }) as Request & { user?: { email: string; boardSub?: string; scopes?: string[] } };

  it('refreshes the caller and nobody else, and answers no body', async () => {
    const { github, c } = controller();
    await expect(c.refreshAccess(req({ email: 'alice', boardSub: '900' }))).resolves.toBeUndefined();
    expect(github.refreshAccess.mock.calls).toEqual([['900']]);
  });

  it('does not answer before the service finishes refreshing access', async () => {
    const { github, c } = controller();
    let release = () => {};
    github.refreshAccess.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    let settled = false;
    const response = Promise.resolve(c.refreshAccess(req({ email: 'alice', boardSub: '900' }))).then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeRelease = settled;
    release();
    await response;
    expect(settledBeforeRelease).toBe(false);
  });

  it('refuses a scoped actor — a PAT and a static agent token alike', async () => {
    for (const scopes of [[], ['board:read'], ['board:admin']]) {
      const { github, c } = controller();
      await expect(c.refreshAccess(req({ email: 'alice', boardSub: '900', scopes }))).rejects.toBeInstanceOf(ForbiddenException);
      expect(github.refreshAccess).not.toHaveBeenCalled();
    }
  });

  it('refuses a request with no session at all', async () => {
    const { github, c } = controller();
    await expect(c.refreshAccess(req(undefined))).rejects.toBeInstanceOf(ForbiddenException);
    expect(github.refreshAccess).not.toHaveBeenCalled();
  });

  it('is declared human-only on the REST↔MCP parity map, so no agent tool mirrors it', async () => {
    const { MCP_BACKED_WRITES, MCP_HUMAN_ONLY_WRITES } = await import('../mcp/overview-tools.js');
    expect(MCP_HUMAN_ONLY_WRITES['POST auth/github/refresh-access']).toContain('human-only');
    expect(MCP_BACKED_WRITES['POST auth/github/refresh-access']).toBeUndefined();
  });
});

describe('what the refresh actually invalidates', () => {
  const INSTALLATIONS = [{ id: 10, app_slug: 'board-app', account: { id: 100, login: 'acme', type: 'Organization' }, suspended_at: null, repository_selection: 'all', permissions: {} }];
  const org = (id: number, login: string) => ({ ...INSTALLATIONS[0], id, account: { id: id * 10, login, type: 'Organization' } });

  function service(rows: Map<string, GithubCredential>) {
    const db = { githubCredential: { findUnique: vi.fn(async ({ where }: { where: { githubUserId: string } }) => rows.get(where.githubUserId) ?? null) } } as unknown as PrismaClient;
    return new GithubUserService(config, db);
  }

  /** A synthetic Github that can be held open at one person's installations
   *  page, with the payload SNAPSHOT taken before the hold — so a gated
   *  discovery answers what Github said when it asked, not what the test
   *  changed while it waited. */
  function gated(installationsFor: (email: string) => unknown[]) {
    const wire: string[] = [];
    const gates = new Map<string, { gate: Promise<void>; reached: () => void }>();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const email = (new Headers(init.headers).get('authorization') ?? '').replace(/^token /, '');
      wire.push(String(url));
      const data = String(url).includes('/repositories')
        ? { total_count: 0, repositories: [] }
        : { total_count: 0, installations: installationsFor(email) };
      const waiting = gates.get(email);
      if (waiting && String(url).includes('/user/installations?')) { gates.delete(email); waiting.reached(); await waiting.gate; }
      const response = new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'url', { value: String(url) });
      return response;
    }));
    /** Hold this person's next installations page. `at` resolves once that
     *  request is genuinely out at Github. */
    const holdNext = (email: string) => {
      let reached = () => {};
      let release = () => {};
      const at = new Promise<void>((r) => { reached = r; });
      const gate = new Promise<void>((r) => { release = r; });
      gates.set(email, { gate, reached });
      return { at, release };
    };
    return { wire, holdNext };
  }

  it('re-checks the person who asked and leaves everyone else on their cached check', async () => {
    let installations = INSTALLATIONS;
    const wire = github(() => installations, () => []);
    const rows = new Map([['900', row('alice@example.test', '900')], ['901', row('bob@example.test', '901')]]);
    const svc = service(rows);
    await svc.principal('alice@example.test', '900');
    await svc.principal('bob@example.test', '901');
    const before = wire.length;

    await svc.refreshAccess('900'); // Normalized, as every other entry point does.
    installations = [...INSTALLATIONS, org(11, 'new-org')];

    // Alice sees the org she just installed, inside the same TTL window.
    expect((await svc.principal('alice@example.test', '900')).owners.map((o) => o.login)).toEqual(['acme', 'new-org']);
    // Bob's own check is untouched — it cost him nothing and told him nothing new.
    expect((await svc.principal('bob@example.test', '901')).owners.map((o) => o.login)).toEqual(['acme']);
    expect(wire.length).toBeGreaterThan(before);
  });

  it('holds the answer until the discovery it raced has settled, so the very next read is fresh', async () => {
    // The race the barrier exists for, and the one a bare cache-drop loses. A
    // check is out at Github with the OLD consents; the person presses refresh;
    // the check comes back and re-caches what they asked the board to drop. The
    // browser's `/api/auth/me` then joins that snapshot and paints stale grants
    // for a whole TTL — so the press has to outlive the check it raced.
    let installations = INSTALLATIONS;
    const gh = gated(() => installations);
    const svc = service(new Map([['900', row('alice@example.test', '900')]]));

    const stale = gh.holdNext('alice@example.test');
    const inFlight = svc.principal('alice@example.test', '900');
    await stale.at; // Genuinely out at Github, on the old payload, before the press.

    let refreshSettled = false;
    const nextRead = Promise.resolve(svc.refreshAccess('900')).then(() => {
      refreshSettled = true;
      return svc.principal('alice@example.test', '900');
    });
    installations = [org(11, 'new-org')];
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeRelease = refreshSettled;
    stale.release();

    // The request that predates the press keeps the answer it asked for.
    expect((await inFlight).owners.map((o) => o.login)).toEqual(['acme']);
    const fresh = await nextRead;
    expect(settledBeforeRelease).toBe(false);
    expect(fresh.owners.map((o) => o.login)).toEqual(['new-org']);
  });

  it('waits on the caller alone — another person keeps their in-flight check, and it still caches', async () => {
    const gh = gated((email) => (email.startsWith('bob') ? [org(20, 'bob-org')] : INSTALLATIONS));
    const svc = service(new Map([['900', row('alice@example.test', '900')], ['901', row('bob@example.test', '901')]]));

    const bob = gh.holdNext('bob@example.test');
    const bobInFlight = svc.principal('bob@example.test', '901');
    await bob.at;
    // Resolves while Bob is still out at Github: a barrier that waited on him
    // would hang here.
    await svc.refreshAccess('900');
    bob.release();
    expect((await bobInFlight).owners.map((o) => o.login)).toEqual(['bob-org']);

    // And his check was CACHED, not withheld — one person's refresh spends
    // nothing of another's.
    const before = gh.wire.length;
    expect((await svc.principal('bob@example.test', '901')).owners.map((o) => o.login)).toEqual(['bob-org']);
    expect(gh.wire.length).toBe(before);
  });
});

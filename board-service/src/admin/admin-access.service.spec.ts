import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AdminAccessService } from './admin-access.service';
import { AdminAuthority } from '../auth/admin-authority';
import type { IPeopleSource } from '../people/people-source';
import { FixtureIdentityRepository } from '../identity/fixture-identity.repository';
import type { IdentityRecord, IdentityRepository } from '../identity/identity.repository';
import type { DerivedLoginsService } from '../identity/derived-logins.service';
import type { MemberRole } from '../identity/role';

/**
 * Real PEOPLE_ALIASES anchors these tests via the fixture identity store:
 * octocat@example.com → octocat, hubot@example.com → hubot,
 * and an unmapped example.com email (maria.lopez) → githubLogin null. Board roles
 * are decoupled from the Google group (#332): admin = a board-assigned `admin`
 * role (from the identity store) ∪ the BOARD_ADMIN_EMAILS bootstrap.
 */
function configStub(overrides: Record<string, unknown> = {}): ConfigService {
  const base: Record<string, unknown> = {
    GITHUB_WRITE_ENABLED: true,
    ...overrides,
  };
  return { get: (key: string, def?: unknown) => (key in base ? base[key] : def) } as unknown as ConfigService;
}

function sourceOf(emails: string[]): IPeopleSource {
  return { listMemberEmails: async () => emails };
}

/** Title-case a display name from an email local part ("maria.lopez" → "Maria Lopez"). */
function nameFromEmail(email: string): string {
  return email
    .split('@')[0]
    .split('.')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

/** A fixture identity store with board-assigned roles overlaid by email (#332). A
 *  roled email with no alias gets a synthesized record, mirroring the editor
 *  upserting an identity the first time it assigns a role to a roster-only member. */
function repoWithRoles(roles: Record<string, MemberRole> = {}): IdentityRepository {
  const base = new FixtureIdentityRepository();
  return {
    list: async () => {
      const records = (await base.list()).map((r) => ({
        ...r,
        role: r.emails.map((e) => roles[e.toLowerCase()]).find(Boolean) ?? null,
      }));
      const covered = new Set(records.flatMap((r) => r.emails.map((e) => e.toLowerCase())));
      for (const [email, role] of Object.entries(roles)) {
        if (!covered.has(email.toLowerCase())) {
          records.push({
            id: `syn-${email}`,
            displayName: nameFromEmail(email),
            emails: [email],
            githubLogin: null,
            clickupUserId: null,
            clickupNames: [],
            role,
          });
        }
      }
      return records;
    },
    identityForEmail: (e: string) => base.identityForEmail(e),
    upsert: (k: string, d) => base.upsert(k, d),
  };
}

/** A warmed DerivedLoginsService over a fixed map — no timer, no Github (#535). */
function derivedOf(pairs: Record<string, string> = {}): DerivedLoginsService {
  const map = new Map(Object.entries(pairs).map(([e, l]) => [e.toLowerCase(), l]));
  return { loginFor: (e: string) => map.get(e.trim().toLowerCase()) ?? null } as DerivedLoginsService;
}

/** Adds identity records the fixture table does not carry — used to build a
 *  person whose addresses differ from the one the derived map is keyed on. */
function repoWith(base: IdentityRepository, extra: IdentityRecord[]): IdentityRepository {
  return { ...base, list: async () => [...(await base.list()), ...extra] };
}

function svc(opts: {
  adminEmails?: string[]; // break-glass bootstrap (BOARD_ADMIN_EMAILS)
  roles?: Record<string, MemberRole>; // board-assigned roles by email
  emails?: string[];
  config?: Record<string, unknown>;
  source?: IPeopleSource;
  derived?: Record<string, string>; // #535: commit-derived email → login
  extraIdentities?: IdentityRecord[];
}): AdminAccessService {
  const config = configStub({ BOARD_ADMIN_EMAILS: (opts.adminEmails ?? []).join(','), ...(opts.config ?? {}) });
  // getModel derives admins from the identity records + the env bootstrap, so the
  // cache mock is unused here; pass an empty one to satisfy the constructor.
  const access = new AdminAuthority(config, { emails: () => [] });
  const source =
    opts.source ??
    sourceOf(opts.emails ?? ['octocat@example.com', 'hubot@example.com', 'maria.lopez@example.com']);
  const repo = opts.extraIdentities
    ? repoWith(repoWithRoles(opts.roles), opts.extraIdentities)
    : repoWithRoles(opts.roles);
  return new AdminAccessService(config, access, source, repo, derivedOf(opts.derived));
}

describe('AdminAccessService (#11, #332)', () => {
  it('defaults role from bootstrap admin + linked GitHub identity', async () => {
    const m = await svc({ adminEmails: ['octocat@example.com'] }).getModel();
    const byName = Object.fromEntries(m.people.map((p) => [p.displayName, p.role]));
    expect(byName['Octocat']).toBe('admin'); // bootstrap
    expect(byName['Hubot']).toBe('writer'); // github-linked default
    expect(byName['Maria Lopez']).toBe('reader'); // no linked identity
  });

  it('a board-assigned admin role makes an admin, tagged source=assigned (#332)', async () => {
    const m = await svc({ roles: { 'hubot@example.com': 'admin' } }).getModel();
    const byName = Object.fromEntries(m.people.map((p) => [p.displayName, p.role]));
    expect(byName['Hubot']).toBe('admin');
    expect(m.admins.find((a) => a.email === 'hubot@example.com')?.source).toBe('assigned');
  });

  it('a stored writer/reader override wins over the derived default (#332)', async () => {
    const m = await svc({
      roles: { 'hubot@example.com': 'reader', 'maria.lopez@example.com': 'writer' },
    }).getModel();
    const byName = Object.fromEntries(m.people.map((p) => [p.displayName, p.role]));
    expect(byName['Hubot']).toBe('reader'); // override beats github-linked writer
    expect(byName['Maria Lopez']).toBe('writer'); // override beats reader default
  });

  it('exposes roleOverride + derivedRole so the editor can show the default (#332)', async () => {
    const m = await svc({ roles: { 'hubot@example.com': 'reader' } }).getModel();
    const hubot = m.people.find((p) => p.displayName === 'Hubot')!;
    expect(hubot.roleOverride).toBe('reader');
    expect(hubot.derivedRole).toBe('writer'); // github-linked
    const maria = m.people.find((p) => p.displayName === 'Maria Lopez')!;
    expect(maria.roleOverride).toBeNull();
    expect(maria.derivedRole).toBe('reader');
  });

  it('resolves admin emails to roster people and flags one that matches nobody', async () => {
    const m = await svc({
      adminEmails: ['octocat@example.com', 'ghost@example.com'],
    }).getModel();
    expect(m.admins.find((a) => a.email === 'octocat@example.com')?.person?.githubLogin).toBe('octocat');
    expect(m.admins.find((a) => a.email === 'ghost@example.com')?.person).toBeNull();
  });

  it('tags a rostered bootstrap admin source=bootstrap (#332)', async () => {
    const m = await svc({ adminEmails: ['octocat@example.com'] }).getModel();
    expect(m.admins.find((a) => a.email === 'octocat@example.com')?.source).toBe('bootstrap');
  });

  it('once a stored admin exists, the env bootstrap goes dormant in the panel too (#371)', async () => {
    const m = await svc({
      adminEmails: ['octocat@example.com'], // bootstrap
      roles: { 'hubot@example.com': 'admin' }, // durable stored admin
    }).getModel();
    const admins = m.admins.map((a) => a.email);
    expect(admins).toContain('hubot@example.com'); // the stored admin
    expect(admins).not.toContain('octocat@example.com'); // env dormant
    expect(m.admins.every((a) => a.source === 'assigned')).toBe(true); // no bootstrap entries
    // Octocat's effective role falls back to his derived default (no stored role).
    expect(m.people.find((p) => p.displayName === 'Octocat')?.role).toBe('writer');
  });

  it('degrades to an empty roster on a cold roster failure', async () => {
    const failing: IPeopleSource = {
      listMemberEmails: async () => {
        throw new Error('boom');
      },
    };
    const m = await svc({ adminEmails: ['octocat@example.com'], source: failing }).getModel();
    expect(m.rosterUnavailable).toBe(true);
    expect(m.people).toEqual([]);
    expect(m.admins[0]).toMatchObject({ email: 'octocat@example.com', person: null });
  });

  /**
   * #551 follow-up. The panel applies `AdminAuthority`'s break-glass rule, but to
   * the identity records it has just loaded rather than to the admin cache — one
   * rule, two data paths, deliberately.
   *
   * The paths are not interchangeable. `AdminEmailCache` is
   * stale-while-revalidate and `identity.controller` calls `invalidate()`
   * without awaiting it, so on the request right after a role write the snapshot
   * is still the pre-write one. This pins the panel to the fresh side of that
   * gap: swap it to the cache-backed `listAdminEmails()` and this goes red.
   */
  it('shows an admin the cache has not caught up with yet', async () => {
    const config = configStub({ BOARD_ADMIN_EMAILS: 'boss@example.com' });
    // An empty cache is exactly the state one request after the role write:
    // invalidate() has fired, its source read has not resolved.
    const access = new AdminAuthority(config, { emails: () => [] });
    // Constructed directly rather than through `svc()` because this test needs
    // its own AdminAuthority — the one above, holding the empty cache the
    // assertion below reads. The derived map is empty: #535's handles are not
    // what this pins, and an empty one is the honest stand-in.
    const service = new AdminAccessService(
      config,
      access,
      sourceOf(['hubot@example.com']),
      repoWithRoles({ 'hubot@example.com': 'admin' }),
      derivedOf(),
    );
    const m = await service.getModel();

    // The cache-backed view is still on the break-glass, one write behind...
    expect(access.listAdminEmails()).toEqual(['boss@example.com']);
    // ...while the panel already shows the admin that write created, and has
    // already gone dormant on the bootstrap that admin displaced.
    const admins = m.admins.map((a) => a.email);
    expect(admins).toContain('hubot@example.com');
    expect(admins).not.toContain('boss@example.com');
    expect(m.admins.every((a) => a.source === 'assigned')).toBe(true);
    expect(m.people.find((p) => p.displayName === 'Hubot')?.role).toBe('admin');
  });

  it('never leaks a secret config value into the payload', async () => {
    const SECRETS = {
      GITHUB_TOKEN: 'ghp_secretTOKEN',
      GITHUB_PRIVATE_KEY: 'PRIVATE_KEY_MATERIAL',
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key":"SA_KEY"}',
      UNRELATED_API_KEY: 'synthetic-secret',
      DATABASE_URL: 'postgresql://u:SECRETPW@host/db',
      BOARD_SESSION_SECRET: 'session-secret',
    };
    const m = await svc({ config: SECRETS }).getModel();
    const json = JSON.stringify(m);
    for (const value of Object.values(SECRETS)) {
      expect(json).not.toContain(value);
    }
  });
});

/**
 * #535. A handle the board DERIVED from commit authorship reaches this panel,
 * and an admin has to be able to tell it from one somebody typed — otherwise
 * they either "correct" a good guess or trust a bad one.
 */
describe('AdminAccessService and derived handles (#535)', () => {
  it('shows a derived handle for somebody neither store claims', async () => {
    // maria.lopez is a real fixture case: on the roster, no alias, handle null.
    const m = await svc({ derived: { 'maria.lopez@example.com': 'mlopez' } }).getModel();
    expect(m.people.find((p) => p.displayName === 'Maria Lopez')).toMatchObject({
      githubLogin: 'mlopez',
      githubLoginSource: 'derived',
    });
  });

  it('marks a handle somebody typed as typed', async () => {
    const m = await svc({ derived: {} }).getModel();
    expect(m.people.find((p) => p.displayName === 'Octocat')).toMatchObject({
      githubLogin: 'octocat',
      githubLoginSource: 'typed',
    });
  });

  it('reports no source at all for somebody with no handle anywhere', async () => {
    const m = await svc({ derived: {} }).getModel();
    expect(m.people.find((p) => p.displayName === 'Maria Lopez')).toMatchObject({
      githubLogin: null,
      githubLoginSource: null,
    });
  });

  it('places a person whose commit address is an ALIAS, not their group address', async () => {
    // Person.id is the group address; the derived map is keyed on the commit
    // author address, which is frequently one of the aliases instead. Looking
    // up p.id alone has this panel and "Your work" answer differently.
    const m = await svc({
      emails: ['dana.k@example.com'],
      extraIdentities: [
        {
          id: 'dana',
          displayName: 'Dana K',
          emails: ['dana.k@example.com', 'dana@personal.dev'],
          githubLogin: null,
          clickupUserId: null,
          clickupNames: [],
          role: null,
        },
      ],
      derived: { 'dana@personal.dev': 'danak' },
    }).getModel();
    expect(m.people.find((p) => p.displayName === 'Dana K')).toMatchObject({
      githubLogin: 'danak',
      githubLoginSource: 'derived',
    });
  });

  it('keeps derivedRole reading the TYPED handle only', async () => {
    // The panel presents derivedRole as this person's effective role. An
    // inference must not move somebody reader -> writer.
    const m = await svc({ derived: { 'maria.lopez@example.com': 'mlopez' } }).getModel();
    expect(m.people.find((p) => p.displayName === 'Maria Lopez')).toMatchObject({
      githubLogin: 'mlopez',
      derivedRole: 'reader',
      role: 'reader',
    });
  });

  it('leaves a typed writer a writer', async () => {
    // The regression guard: a fix keyed on the wrong field flips EVERYONE to
    // reader, and the derived test above still passes.
    const m = await svc({ derived: {} }).getModel();
    expect(m.people.find((p) => p.displayName === 'Hubot')).toMatchObject({
      derivedRole: 'writer',
    });
  });
});

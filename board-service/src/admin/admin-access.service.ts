import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAuthority, AdminSourceKind } from '../auth/admin-authority';
import { IPeopleSource, PEOPLE_SOURCE } from '../people/people-source';
import { Person, buildPeople } from '../people/people-aliases';
import { DerivedLoginsService } from '../identity/derived-logins.service';
import { IDENTITY_REPOSITORY, IdentityRecord, IdentityRepository, recordToAlias } from '../identity/identity.repository';
import { MemberRole } from '../identity/role';

/** A member's role. Board-assigned + authoritative (#332): the stored override
 *  wins; absent it, the default is derived from the linked GitHub login. */
export type Role = MemberRole;

const norm = (s: string) => s.trim().toLowerCase();

export interface AccessPerson extends Person {
  /** Effective role: `roleOverride` if set, else 'admin' when the person is an
   *  admin (assigned or bootstrap), else `derivedRole`. */
  role: Role;
  /** The board-assigned role stored on the identity, or null (no override). */
  roleOverride: Role | null;
  /** The default role absent any override: writer if a GitHub login was TYPED,
   *  else reader. Lets the editor show "group default: X". */
  derivedRole: Role;
  /** Whether `githubLogin` was typed by a person or inferred from commit
   *  authorship (#535); null when there is no handle at all.
   *
   *  Two values, not three: `buildPeople` merges the roster and the checked-in
   *  table before anyone sees the result, so "which of the two typed sources"
   *  is not a question this can answer — and the panel does not ask it. */
  githubLoginSource: 'typed' | 'derived' | null;
}

/** A roster person with #535's provenance attached. A distinct type on purpose:
 *  assigning the mapped array back onto a `Person[]` narrows the extra property
 *  straight back out of the type, so the value survives at runtime while the
 *  read below fails to compile — and `pnpm test` would not catch that, only
 *  `tsc --noEmit` does. */
type SourcedPerson = Person & { githubLoginSource: 'typed' | 'derived' | null };

export interface AdminEntry {
  email: string;
  /** Resolved roster person, or null when the admin email matches nobody on the team. */
  person: Pick<Person, 'id' | 'displayName' | 'githubLogin'> | null;
  /** 'assigned' = a board-assigned admin role (durable); 'bootstrap' = BOARD_ADMIN_EMAILS env only. */
  source: AdminSourceKind;
}

export interface AccessModel {
  admins: AdminEntry[];
  people: AccessPerson[];
  /** True when the roster could not be fetched (Google cold failure); people[] is then empty. */
  rosterUnavailable: boolean;
}

/**
 * Assembles the read-only access model for the Access panel (#11): the team
 * roster (PEOPLE_SOURCE × the identity store) with each person's effective role
 * (#332) and the admin list. A person's role is the board-assigned override, else
 * the derived default (writer if a GitHub login is linked, else reader); an admin
 * (assigned or bootstrap) writes anything. Never reads a secret value.
 */
@Injectable()
export class AdminAccessService {
  private readonly logger = new Logger(AdminAccessService.name);
  private readonly nameMatchDomains: string[];

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AdminAuthority) private readonly access: AdminAuthority,
    @Inject(PEOPLE_SOURCE) private readonly source: IPeopleSource,
    @Inject(IDENTITY_REPOSITORY) private readonly identity: IdentityRepository,
    // #535. The derived map, not the resolver: `loginFor` is synchronous and
    // reads memory, so filling the gap below costs this no-store route no await
    // and no second trip to the identity store for records it already holds.
    @Inject(DerivedLoginsService) private readonly derived: DerivedLoginsService,
  ) {
    // No email-domain name matching under GitHub-only sign-in.
    this.nameMatchDomains = [];
  }

  async getModel(): Promise<AccessModel> {
    let roster: Person[] = [];
    let records: IdentityRecord[] = [];
    let rosterUnavailable = false;
    try {
      const [emails, recs] = await Promise.all([
        this.source.listMemberEmails(),
        this.identity.list(),
      ]);
      records = recs;
      roster = buildPeople(emails, records.map(recordToAlias), { nameMatchDomains: this.nameMatchDomains });
    } catch (err) {
      // Cold roster failure (no creds / first call down). Degrade rather than
      // blank the whole panel — admins still tell part of the story and a health
      // finding names the gap. Never echo the error (a bad SA key throws with raw
      // key material in the message).
      this.logger.error(`admin access: roster unavailable: ${err instanceof Error ? err.message : String(err)}`);
      rosterUnavailable = true;
    }

    // Stored role per email, from the fresh identity records — the authoritative
    // override (#332).
    const roleByEmail = new Map<string, MemberRole>();
    for (const r of records) {
      if (r.role) for (const e of r.emails) roleByEmail.set(norm(e), r.role);
    }
    const assignedAdminEmails = new Set(
      records.filter((r) => r.role === 'admin').flatMap((r) => r.emails.map(norm)),
    );
    // The break-glass rule (#371) is AdminAuthority's, applied here rather than
    // restated — one rule, so the badge this panel draws and the gate that lets
    // someone through cannot come to different conclusions about who is an admin.
    //
    // What this panel does keep is its own data: the identity records it has just
    // loaded, not the AdminEmailCache the gates read. The two are the same rows by
    // different routes, but the cache is stale-while-revalidate and
    // identity.controller calls invalidate() without awaiting it, so on the request
    // right after a role write its snapshot is still the pre-write one. Reading it
    // here would show the admin you just made as not an admin. In db mode both
    // routes reach the same role='admin' rows (StoredRoleAdminSource reads them
    // too), so the panel is simply the earlier of the two to see a write. In
    // fixture mode the gates additionally honour BOARD_FIXTURE_ADMINS while this
    // panel does not — but role editing is 503 there, so it is a dev-only nuance.
    const adminSet = new Set(this.access.effectiveAdminEmails(assignedAdminEmails));

    // buildPeople answers from the roster and the checked-in table. Somebody
    // neither claims may still be placed by commit authorship (#535).
    //
    // Looked up across EVERY address the person appears under, not `p.id`.
    // `p.id` is the group address; the derived map is keyed on the commit author
    // address, which is frequently one of the aliases instead. Keying on `p.id`
    // alone would have this panel and "Your work" give two different answers for
    // one person, which is the split #520 closed.
    const sourced: SourcedPerson[] = roster.map((p) => {
      if (p.githubLogin) return { ...p, githubLoginSource: 'typed' as const };
      const derived = p.emails.map((e) => this.derived.loginFor(e)).find(Boolean) ?? null;
      return derived
        ? { ...p, githubLogin: derived, githubLoginSource: 'derived' as const }
        : { ...p, githubLoginSource: null };
    });

    const people = sourced.map<AccessPerson>((p) => {
      const keys = p.emails.map(norm);
      const roleOverride = keys.map((e) => roleByEmail.get(e)).find(Boolean) ?? null;
      const isAdmin = keys.some((e) => adminSet.has(e));
      // Default absent any override: a TYPED GitHub login means they can be a DRI
      // (writer); otherwise read-only. Deliberately not `p.githubLogin`, which now
      // carries a derived handle too — an inference must not move somebody's
      // effective role on the strength of a guess (#535).
      const derivedRole: Role = p.githubLoginSource === 'typed' ? 'writer' : 'reader';
      // Admin (assigned or bootstrap) always shows as admin so the badge matches
      // real access; otherwise the stored override wins over the derived default.
      const role: Role = isAdmin ? 'admin' : roleOverride ?? derivedRole;
      return { ...p, role, roleOverride, derivedRole };
    });

    const admins = [...adminSet].map<AdminEntry>((email) => {
      const person = roster.find((p) => p.emails.some((e) => norm(e) === email));
      return {
        // Assigned (a board-assigned admin role) is the durable path; bootstrap
        // means admin only via the BOARD_ADMIN_EMAILS env break-glass.
        email,
        source: assignedAdminEmails.has(email) ? 'assigned' : 'bootstrap',
        person: person
          ? { id: person.id, displayName: person.displayName, githubLogin: person.githubLogin }
          : null,
      };
    });

    return { admins, people, rosterUnavailable };
  }
}

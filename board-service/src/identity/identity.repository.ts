import type { PersonAliases } from '../people/people-aliases';
import type { MemberRole } from './role';

/** One person's cross-system identity, as stored (DB) or seeded (fixture). */
export interface IdentityRecord {
  id: string;
  displayName: string;
  emails: string[];
  githubLogin: string | null;
  clickupUserId: string | null;
  clickupNames: string[];
  /** Board-assigned role override (#332), or null to use the derived default. */
  role: MemberRole | null;
}

/** The full identity fields an admin submits when saving a person's mapping. */
export interface IdentityData {
  displayName: string;
  emails: string[];
  githubLogin?: string | null;
  clickupUserId?: string | null;
  clickupNames?: string[];
  /** Board-assigned role (#332): null clears the override → derived default. */
  role?: MemberRole | null;
}

/**
 * The identity/alias store. `list()` feeds buildPeople (replacing the old
 * PEOPLE_ALIASES constant); `upsert` is the admin edit surface, keyed by the
 * person's roster email so editing and first-time-creating are one path. The
 * fixture implementation is read-only and throws on writes, so dev/test without
 * a database still serves the roster but can't mutate it.
 */
export interface IdentityRepository {
  list(): Promise<IdentityRecord[]>;
  /**
   * Update the identity owning `keyEmail`, or create one if none matches. The
   * key email (the person's stable roster address) is always kept in `emails`.
   */
  upsert(keyEmail: string, data: IdentityData): Promise<IdentityRecord>;
  /**
   * The stored identity owning `email`, or null when the roster has no row for
   * them. A row whose `githubLogin` is null is an answer, not a silence: this
   * person has no handle, and the checked-in table must not supply one (#540).
   *
   * The record shape is the point — returning the bare handle flattened "no row"
   * and "a row saying no handle" into one null, so a cleared handle came straight
   * back from the file. Read by `GithubLoginResolver` (feeding /me's githubLogin
   * and "Your work" attribution) and by the identity controller's role audit.
   * Nothing gates a write on a handle.
   */
  identityForEmail(email: string): Promise<IdentityRecord | null>;
}

export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY');

/** Map a stored identity to the PersonAliases shape buildPeople consumes. */
export function recordToAlias(r: IdentityRecord): PersonAliases {
  return {
    displayName: r.displayName,
    emails: r.emails,
    clickupNames: r.clickupNames,
    githubLogin: r.githubLogin,
    clickupUserId: r.clickupUserId,
  };
}

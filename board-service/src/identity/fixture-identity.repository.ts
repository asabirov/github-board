import { ServiceUnavailableException } from '@nestjs/common';
import { PEOPLE_ALIASES, type PersonAliases } from '../people/people-aliases';
import { IdentityData, IdentityRecord, IdentityRepository } from './identity.repository';

const norm = (s: string) => s.trim().toLowerCase();

/** One mapping for both reads, so the two directions can never disagree. */
function toRecord(a: PersonAliases, i: number): IdentityRecord {
  return {
    id: `fixture-${i}`,
    displayName: a.displayName,
    emails: [...new Set(a.emails.map(norm).filter(Boolean))],
    githubLogin: a.githubLogin,
    clickupUserId: a.clickupUserId ?? null,
    clickupNames: a.clickupNames,
    // No stored roles in fixture mode — every effective role is the derived
    // default; role editing needs the DB (IDENTITY_SOURCE=db).
    role: null,
  };
}

/**
 * Read-only identity store for dev/test without a database. Serves the same
 * PEOPLE_ALIASES the file always did, so the roster works offline; writes throw
 * 503 (editing identity requires the Postgres-backed store, IDENTITY_SOURCE=db).
 */
export class FixtureIdentityRepository implements IdentityRepository {
  async list(): Promise<IdentityRecord[]> {
    return PEOPLE_ALIASES.map(toRecord);
  }

  async identityForEmail(email: string): Promise<IdentityRecord | null> {
    const e = norm(email);
    const i = PEOPLE_ALIASES.findIndex((a) => a.emails.some((x) => norm(x) === e));
    // Here the store IS the file, so "no row" and "a row with no handle" both
    // resolve to what the file says — there is no second source underneath.
    return i === -1 ? null : toRecord(PEOPLE_ALIASES[i], i);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async upsert(_keyEmail: string, _data: IdentityData): Promise<IdentityRecord> {
    // The Admin Access dialog draws this one word for word. It named the
    // setting that switches the store until #1056, which is the operator's
    // business and not the reader's.
    throw new ServiceUnavailableException('This board is reading a fixed roster, so it cannot be edited here.');
  }
}

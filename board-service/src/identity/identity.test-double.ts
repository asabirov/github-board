import { IdentityRecord, IdentityRepository } from './identity.repository';

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The one identity double for specs. Both directions come off ONE array, so a
 * test can never accidentally assert against a store whose `list()` and whose
 * per-email lookup describe different teams — which is what every hand-rolled
 * `list: async () => []` double in this repo used to do.
 *
 * Deliberately not cast. An `as unknown as IdentityRepository` double compiles
 * after the interface moves on, the resolver then calls an undefined method,
 * and `fromRoster`'s best-effort catch swallows the TypeError — a half-done
 * contract change looks exactly like the bug it was fixing, with a green suite.
 */
export function fakeIdentityStore(records: IdentityRecord[]): IdentityRepository {
  const store: IdentityRepository = {
    list: async () => records,
    identityForEmail: async (email: string) => {
      const e = norm(email);
      return records.find((r) => r.emails.some((x) => norm(x) === e)) ?? null;
    },
    upsert: async () => {
      throw new Error('fakeIdentityStore is read-only');
    },
  };
  return store;
}

/** A store that is down. BOTH reads throw — a double that only fails on one of
 *  them lets a "degrades safely" test pass with no error handling in place. */
export function unreachableIdentityStore(): IdentityRepository {
  const store: IdentityRepository = {
    list: async () => {
      throw new Error('db down');
    },
    identityForEmail: async () => {
      throw new Error('db down');
    },
    upsert: async () => {
      throw new Error('db down');
    },
  };
  return store;
}

/** A record with the boring fields filled in, so a spec writes only what it means. */
export function identityRecordFor(over: Partial<IdentityRecord> & { emails: string[] }): IdentityRecord {
  return {
    id: `fake-${over.emails[0]}`,
    displayName: 'Somebody',
    githubLogin: null,
    clickupUserId: null,
    clickupNames: [],
    role: null,
    ...over,
  };
}

/**
 * Where a derived Github handle comes from (#535).
 *
 * Derivation is the THIRD tier under the precedence `GithubLoginResolver` owns —
 * roster row first (cleared handle included, #540), checked-in table second, and
 * only an address neither claims reaches here. An empty map is therefore not a
 * degraded mode: it is the board's behaviour before this existed, which is why
 * the fixture is a real implementation rather than a throw.
 */

/**
 * What one derivation run produced, and whether it saw everything it meant to.
 *
 * `complete` is load-bearing. Github's search API allows 30 requests a minute,
 * and the failure that will actually happen is some of those being refused —
 * not the org listing failing. Without this flag a run that placed nobody
 * because it was rate-limited looks exactly like a run that placed nobody
 * because there was nobody to place, and the service caches the wrong one.
 */
export interface DerivedLoginsResult {
  /** Lowercased email → Github login, for every address this run could place. */
  map: Map<string, string>;
  /** True only when every intended request succeeded. */
  complete: boolean;
}

export interface DerivedLoginsSource {
  derive(): Promise<DerivedLoginsResult>;
}

export const DERIVED_LOGINS_SOURCE = Symbol('DERIVED_LOGINS_SOURCE');

/** The no-Github implementation. Selected whenever `ISSUES_SOURCE=fixture`. */
export class EmptyDerivedLoginsSource implements DerivedLoginsSource {
  derive(): Promise<DerivedLoginsResult> {
    return Promise.resolve({ map: new Map(), complete: true });
  }
}

/**
 * The board's one selected org, and the union that is still the default (#714).
 *
 * Union is the default and stays it (#614): an unscoped board reads exactly the
 * requests it read before this directory existed, byte for byte.
 *
 * WHERE THE SCOPE LIVES: in the address, and nowhere else. `/acme/repos`
 * is that org's Repos, `/repos` is every org's, and `route.ts` is what reads one
 * into the other. The prototype held a second copy in a module variable so
 * `api.ts` could reach it; that copy is gone, because two homes for one answer
 * is the drift this file used to warn about. So is the seam that replaced it —
 * a `requestOrg()` reading `window.location` for three fetchers that took no
 * argument. They take one now, from the page that knows what the address said,
 * which is what made the feature testable at all (`api-scoped-reads.spec.ts`).
 */
import { routeOrg, type Route } from '../route';

/** Union, or exactly one org. Two cases, never a nullable string. */
export type OrgScope = { kind: 'union' } | { kind: 'org'; org: string };

export const UNION: OrgScope = { kind: 'union' };

/** The id a menu would key the union row on. Not a legal Github org login, so it
 *  can never collide with a real one. */
export const UNION_ID = '*all';

export const scopeId = (s: OrgScope): string => (s.kind === 'union' ? UNION_ID : s.org);

/** The org a request should carry, or null for the union — which sends nothing. */
export const scopedOrg = (s: OrgScope): string | null => (s.kind === 'union' ? null : s.org);

export const scopeFromId = (id: string): OrgScope => (id === UNION_ID ? UNION : { kind: 'org', org: id });

/** The scope an address names. One direction only: the route decides. */
export const scopeOfRoute = (r: Route): OrgScope => {
  const org = routeOrg(r);
  return org ? { kind: 'org', org } : UNION;
};

// The copy a union row draws. One string, so a menu and any sentence about the
// scope cannot spell it two ways.
export const UNION_LABEL = 'All orgs';

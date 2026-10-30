/** URL state for order, ownership, and health. Typed search remains session state. */
import { DEFAULT_ORDER, ORDERS, REPO_LENSES, type RepoLens, type RepoHealthFilter, type RepoOrderKey } from './repos-vm';

export interface ReposUrlState {
  order: RepoOrderKey;
  lens?: RepoLens;
  health?: RepoHealthFilter;
  /** Whose repos are showing: a login, `null` for the repos the org records no
   *  owner for, and absent for the whole map. Three states rather than two,
   *  because "nobody owns these" is a narrowing like any other. */
  owner?: string | null;
}

/** The params this page owns. `unowned` is its own flag rather than a reserved
 *  `owner` value, because a Github login is alphanumerics and inner hyphens —
 *  so any word chosen to mean "nobody" is a word somebody could hold as a
 *  handle. The IssuesViewer carries `unassigned` the same way. */
const ORDER_PARAM = 'order';
const OWNER_PARAM = 'owner';
const UNOWNED_PARAM = 'unowned';

const params = (search: string) =>
  new URLSearchParams(search.startsWith('?') ? search : search ? `?${search}` : '');

export function encodeRepos(s: ReposUrlState): string {
  const p = new URLSearchParams();
  if (s.order !== DEFAULT_ORDER) p.set(ORDER_PARAM, s.order);
  if (s.owner === null) p.set(UNOWNED_PARAM, '1');
  else if (s.owner) p.set(OWNER_PARAM, s.owner);
  if (s.health && s.health !== 'all') p.set('health', s.health);
  if (s.lens && s.lens !== 'issues') p.set('lens', s.lens);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** What the URL says about the map, and nothing it does not say. A key is absent
 *  — rather than present holding the default — so a caller can tell "the link
 *  chose the default" from "the link said nothing", and so an unrelated query
 *  can never masquerade as this page's state. On `owner` that distinction is
 *  load-bearing twice over: absent is the whole map, and present-and-null is the
 *  repos nobody owns. */
export function decodeRepos(search: string): Partial<ReposUrlState> {
  const p = params(search);
  const state: Partial<ReposUrlState> = {};

  const known = ORDERS.find((o) => o.key === p.get(ORDER_PARAM));
  if (known) state.order = known.key;

  // The flag wins over a login, so a hand-edited URL naming both lands
  // somewhere definite instead of on whichever param was read first.
  const login = p.get(OWNER_PARAM);
  if (p.get(UNOWNED_PARAM) === '1') state.owner = null;
  else if (login) state.owner = login;

  const health = p.get('health');
  if (health === 'ci' || health === 'security' || health === 'secrets' || health === 'dependencies' || health === 'code-scanning') state.health = health;
  const lens = REPO_LENSES.find(item => item.key === p.get('lens'));
  if (lens) state.lens = lens.key;
  return state;
}

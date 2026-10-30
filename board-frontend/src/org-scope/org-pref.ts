import { ownerId } from '../auth/github-target';
/**
 * The org this device was last narrowed to (#714), remembered across page loads.
 *
 * Per-device, no backend — the same shape `account/prefs.ts` uses for the
 * timezone and `issues-viewer/viewer-prefs.ts` for a board's arrangement: one
 * flat `board_*` key, every read validated, every failure degrading to "nothing
 * stored" rather than throwing.
 *
 * It is ADVISORY and it is consulted in exactly one place — a page load whose
 * address names nothing at all, `/`. Every other address is taken literally, so
 * a `/team` link sent to a colleague opens as the union for them rather than in
 * whichever org the sender was last in, showing them the sender's numbers under
 * their own name. `route.ts`'s `initialRoute` is where that rule lives; this
 * file only answers what was stored.
 */
import { isOrgLogin, isReservedSegment, routeOrg, takesOrgShell, type Route } from '../route';

/** Beside `board_theme` and `board_timezone` — a single flat key, not a
 *  prefix: there is one scope for the device, not one per anything. */
export const ORG_PREF_KEY = 'board_org';

/** The board's old org key, carried forward once (#1450). */
const LEGACY_ORG_PREF_KEY = 'lessly_org';

/** Carry a saved scope over from `lessly_org` (and its `_v2` id form) once:
 *  read the old key, write the new one, remove the old one. Nothing is written
 *  when the new key already holds a value. */
function migrateOrgPref(): void {
  try {
    if (localStorage.getItem(ORG_PREF_KEY + '_v2') !== null || localStorage.getItem(ORG_PREF_KEY) !== null) return;
    const legacyV2 = localStorage.getItem(LEGACY_ORG_PREF_KEY + '_v2');
    const legacy = localStorage.getItem(LEGACY_ORG_PREF_KEY);
    if (legacyV2 !== null) localStorage.setItem(ORG_PREF_KEY + '_v2', legacyV2);
    if (legacy !== null) localStorage.setItem(ORG_PREF_KEY, legacy);
    if (legacyV2 !== null || legacy !== null) {
      localStorage.removeItem(LEGACY_ORG_PREF_KEY + '_v2');
      localStorage.removeItem(LEGACY_ORG_PREF_KEY);
    }
  } catch {
    // ignore — a device without storage starts on the union each time
  }
}

/**
 * A stored value the board could actually address, or null.
 *
 * Two ways a string fails. It may not be a Github org login at all — Github
 * allows alphanumerics and hyphens, up to 39 characters, and anything else here
 * came from somewhere other than this board. Or it may be spelled like a segment
 * the app has spoken for — a tab, by `parseRoute`'s tab-wins rule (#697), or one
 * of the addresses #712 retired: remembering such an org would silently open the
 * wrong page, so it is refused rather than trusted.
 */
function usableOrg(raw: string | null): string | null {
  if (raw === null) return null;
  // The same charset `route.ts` reads an address with — one validator, because
  // two copies of "what a Github login looks like" is two things to keep in step
  // (#714 review).
  if (!isOrgLogin(raw)) return null;
  // `route.ts`'s one predicate, not a second reading of the same question: when
  // #712 cut five names out of `Tab` this guard silently stopped refusing them.
  return isReservedSegment(raw) ? null : raw;
}

/** The remembered org, or null when there is nothing usable. Never throws:
 *  absent storage, a denied getter and a junk value all read as null. */
export function readOrgPref(): string | null {
  try {
    migrateOrgPref();
    const saved = localStorage.getItem(ORG_PREF_KEY + '_v2');
    if (saved && /^[1-9]\d*$/.test(saved)) return 'id:' + saved;
    return usableOrg(localStorage.getItem(ORG_PREF_KEY));
  } catch {
    return null;
  }
}

/**
 * Whether ARRIVING at this route should forget the remembered org (#714 review).
 *
 * True on exactly one shape: an address that takes the org shell and names no
 * org — `/`, `/team`, `/repos`, `/projects`. Asking for the union by name is
 * how the union stays reachable at `/` once an org has been opened, and it is
 * the only thing a navigation may say about the memory.
 *
 * False everywhere else, and each false matters. An address NAMING an org says
 * nothing here: whether that org is worth remembering is the page's answer, once
 * its narrowed read came back served (`use-scope-state.ts`) — one visit to a
 * stale `/roadmap` bookmark used to write `roadmap` into storage on sight. An
 * opened board narrows no shell, so it is not the union either. And a repo page,
 * an issue page or the account pages take no shell at all: this ran on every
 * route change, so opening one repo cleared the org the shell was in.
 *
 * Pure, so the rule is testable without a browser — App just obeys it.
 */
export function forgetOnRoute(r: Route): boolean {
  return takesOrgShell(r) && routeOrg(r) === null && r.ownerId === undefined;
}

/** Remember the scope the board is in — an org, or null for the union, which
 *  forgets. Writing the union rather than leaving the last org is what keeps the
 *  union reachable at `/`: the address is the truth and this only mirrors it. */
export function writeOrgPref(org: string | null): void {
  try {
    if (org && usableOrg(org)) {
      const id = ownerId(org);
      if (id) localStorage.setItem(ORG_PREF_KEY + '_v2', String(id));
      else localStorage.setItem(ORG_PREF_KEY, org);
    } else {
      localStorage.removeItem(ORG_PREF_KEY + '_v2');
      localStorage.removeItem(ORG_PREF_KEY);
    }
  } catch {
    // ignore — a device without storage just starts on the union each time
  }
}

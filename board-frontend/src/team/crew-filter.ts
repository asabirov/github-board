/**
 * The Unit page's Crew selection, as URL state (#461).
 *
 * The URL is the single source of truth for who the page is filtered to. The
 * Crew cards and the queue's own assignee filter write the SAME `?assignee`
 * param — the viewer through its `commit`, a card press through `withAssignees`
 * — so `TeamView` holds no selection state of its own and the two cannot
 * disagree. `gotoPath` fires a synthetic popstate, which is what re-reads both
 * sides after either writes.
 *
 * Every function here is pure, so the round-trip that keeps page and queue in
 * step is settled in a test rather than by reading two components side by side.
 */
import { decodeViewer } from '../issues-viewer/viewer-url';
import { toggleValue } from '../issues-viewer/controlled-filter';

/** The param the viewer's own codec carries assignees in. Named once here so a
 *  card press and `encodeViewer` cannot drift; the spec pins them together by
 *  round-tripping a written URL back through `decodeViewer`. */
const ASSIGNEE_PARAM = 'assignee';

/** Every distinct assignee spelling the org queue carries — the only authority on
 *  how Github spells a login on this page.
 *
 *  Not the roster: `Person.githubLogin` is board-assigned and admin-typed, so a
 *  roster entry may differ from Github's spelling in either direction. Correcting
 *  a URL against it would rewrite a working `?assignee=IvanRoslov` into a broken
 *  `?assignee=ivanroslov` whenever an admin typed the latter — on every load, and
 *  with the URL itself no longer holding what it takes to recover. */
export function dataLogins(issues: readonly { assignees: readonly string[] }[]): string[] {
  const seen = new Set<string>();
  for (const i of issues) for (const a of i.assignees) seen.add(a);
  return [...seen];
}

/**
 * Who the page is filtered to, read from the URL and spelled the way the DATA
 * spells it.
 *
 * A login the queue holds under another casing is rewritten to the queue's
 * spelling: `filter-group.ts` matches assignees case-sensitively — and so, since
 * #461, does the tiles' own count — so `?assignee=ivanroslov` would otherwise
 * light a Crew card over an empty queue.
 *
 * A login the data does not hold is kept exactly as written. It counts nothing
 * and matches nothing, in the tiles and in the queue alike, because both compare
 * the same way; and filtering to an assignee with no open work is a legitimate
 * thing to have done — the queue's own FilterBar writes this same dimension.
 *
 * Empty tokens go, and so do duplicates once the spellings have been settled:
 * `?assignee=ivanroslov&assignee=IvanRoslov` is one person, and left as two it
 * is two identical React keys in the FilterBar and the login twice over in every
 * drill-in href.
 */
export function selectedLogins(search: string, knownLogins: readonly string[]): string[] {
  const canonical = new Map(knownLogins.map((l) => [l.toLowerCase(), l]));
  const fromUrl = decodeViewer(search).filters?.assignees ?? [];
  const out: string[] = [];
  for (const raw of fromUrl) {
    const login = canonical.get(raw.toLowerCase()) ?? raw;
    if (login && !out.includes(login)) out.push(login);
  }
  return out;
}

/**
 * The URL this page should be at when the one in the bar spells a login
 * differently from the data, repeats one, or carries an empty token — or `null`
 * when it is already right.
 *
 * Correcting the URL fixes both halves at once, rather than only the half this
 * page draws. With no data yet there is nothing to correct against and this
 * returns `null` for a casing difference: a guess is precisely what would break
 * a working URL.
 *
 * The comparison is on the assignee VALUES as the URL literally holds them, not
 * on the whole query string. Rewriting whenever the string differs would fire on
 * every commit the queue makes — it re-encodes the whole query from its own
 * state, which can order the params differently — and that is one extra
 * navigation per keystroke in its search box.
 */
export function canonicalisation(search: string, knownLogins: readonly string[]): string | null {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const written = p.getAll(ASSIGNEE_PARAM);
  const canonical = selectedLogins(search, knownLogins);
  if (canonical.length === written.length && canonical.every((l, i) => l === written[i])) return null;
  return withAssignees(search, canonical);
}

/**
 * The `?search` a Crew press should produce, or `null` when the press means
 * nothing and the page should not navigate at all.
 *
 * `null` is the card of a member with no linked Github login. The queue matches
 * on login, so pressing them could only ever filter to nobody — the card is
 * inert rather than a filter that empties the page.
 *
 * The toggle runs against the SELECTION this page derived, not against whatever
 * the URL literally holds. The two differ whenever a login was spelled another
 * way (`?assignee=ivanroslov` against ingest data spelling `IvanRoslov`), and
 * toggling on the raw text would add a second spelling of one person instead of
 * releasing them.
 */
export function pressCrewCard(
  search: string,
  selection: readonly string[],
  login: string | null | undefined,
): string | null {
  if (!login) return null;
  return withAssignees(search, toggleValue(selection, login));
}

/**
 * The next `?search` after a Crew press: the selection replaced, everything else
 * left exactly as it was.
 *
 * Deliberately NOT a round-trip through `decodeViewer`/`encodeViewer`. That
 * codec omits whatever equals the caller's defaults, so re-encoding here would
 * quietly rewrite params this page has no business touching — the Unit queue
 * leads with `view=board`, so an explicit `?view=board` would vanish — and it
 * drops any param the codec does not know. Editing one key in place cannot do
 * either.
 */
export function withAssignees(search: string, logins: readonly string[]): string {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  p.delete(ASSIGNEE_PARAM);
  for (const l of logins) p.append(ASSIGNEE_PARAM, l);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

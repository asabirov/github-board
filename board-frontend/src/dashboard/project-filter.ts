/**
 * Your work's board selection, as URL state (#750).
 *
 * The URL is the single source of truth for which boards the page is narrowed
 * to. The Contributions rings and the queue's own Project filter write the SAME
 * `?project` param — the viewer through its `commit`, a ring press through
 * `withProjects` — so `Dashboard` holds no selection state of its own and the
 * two cannot disagree. This is `team/crew-filter.ts` for boards, and it is the
 * same move #461 made for people on Unit.
 *
 * The value carried is the board's NAME: `ViewerIssue.projects` is a list of
 * GitHub Project names (`api.ts`), and `filterIssues` matches against exactly
 * those strings. A number alone would light a ring over an empty queue.
 *
 * A name is not a board, though, and #782 is what that cost: two orgs can each
 * hold a "Roadmap", and a selection that was only a name lit both rings and
 * narrowed the queue to both. The board's whole ADDRESS rides beside the name in
 * `?board=`, qualifying it — so the selection here is a list of boards, and a
 * name arriving with no address (the chip writes one, and so does a board-api
 * predating `org`) still speaks for every board wearing it, which is all it ever
 * said.
 *
 * Every function here is pure, so the round-trip that keeps the rings and the
 * queue in step is settled in a test rather than by reading two components side
 * by side.
 */
import { type BoardRef, boardToken, parseBoardToken } from '../issues-viewer/filter-group';
import { decodeViewer, hasViewerParams } from '../issues-viewer/viewer-url';
import type { ViewerPrefs } from '../issues-viewer/viewer-prefs';

/** The param the viewer's own codec carries board names in. Named once here so a
 *  ring press and `encodeViewer` cannot drift; the spec pins them together by
 *  round-tripping a written URL back through `decodeViewer`. */
const PROJECT_PARAM = 'project';
/** And the one carrying the ADDRESS that says which board of that name (#782).
 *  Same reason it is named once. */
const BOARD_PARAM = 'board';

/**
 * One board the page is narrowed to.
 *
 * `name` is what the queue matches on and is always there. The address is there
 * when the URL said it — a ring press writes one, the queue's own Project chip
 * does not, and neither does a board-api predating `org` (#697). An entry with
 * no address speaks for EVERY board wearing the name, which is exactly what a
 * name-only URL says.
 */
export interface BoardSelection {
  org?: string;
  number?: number;
  name: string;
}

/** A board as the strip knows it, which is by its whole address (#697). */
export interface BoardAt {
  org?: string;
  number: number;
  name: string;
}

/** Whether `sel` speaks for this board — the one predicate the pressed ring and
 *  the toggle both ask, so a ring cannot light for a board the press would not
 *  clear. An unaddressed entry presses every board of its name; an addressed one
 *  presses that board and no other. */
const speaksFor = (sel: BoardSelection, at: BoardAt): boolean =>
  sel.name === at.name && (sel.org === undefined || (sel.org === at.org && sel.number === at.number));

/** Whether this board's ring is pressed under the current selection (#782). */
export function isPressed(selection: readonly BoardSelection[], at: BoardAt): boolean {
  return selection.some((s) => speaksFor(s, at));
}

/**
 * Which boards the page is narrowed to, read from the URL.
 *
 * Names are kept exactly as written. Unlike a Github login, a Projects v2 board
 * name is free text the board owner typed and `filterIssues` compares it
 * verbatim, so there is no canonical casing to correct toward — the queue's own
 * FilterBar writes this same dimension, with this same spelling.
 *
 * Empty tokens go, and so do duplicates: `?project=A&project=A` is one board,
 * and left as two it is two identical React keys in the FilterBar.
 */
export function selectedProjects(search: string): string[] {
  const fromUrl = decodeViewer(search).filters?.projects ?? [];
  const out: string[] = [];
  for (const name of fromUrl) if (name && !out.includes(name)) out.push(name);
  return out;
}

/**
 * The boards the page is narrowed to, each carrying whatever address the URL
 * gave it (#782).
 *
 * Driven by the NAMES, not by the addresses: `?project=` is the dimension the
 * queue filters on, and an address qualifies a name it is standing beside. So a
 * `?board=` whose name is no longer selected — the chip can drop a name without
 * knowing an address exists — speaks for nothing, and a name with no address
 * speaks for every board wearing it.
 */
export function selectedBoards(search: string): BoardSelection[] {
  const addressed = (decodeViewer(search).filters?.boards ?? [])
    .map(parseBoardToken)
    .filter((b): b is BoardRef => b !== null);
  const out: BoardSelection[] = [];
  for (const name of selectedProjects(search)) {
    const forName = addressed.filter((b) => b.name === name);
    if (forName.length === 0) out.push({ name });
    for (const b of forName) if (!out.some((o) => o.org === b.org && o.number === b.number && o.name === b.name)) out.push(b);
  }
  return out;
}

/**
 * The `?search` a ring press should produce, or `null` when the press means
 * nothing and the page should not navigate at all.
 *
 * `null` is a row with no board name — the queue matches on the name, so
 * pressing it could only ever filter to nobody. The ring is inert rather than a
 * filter that empties the page, which is what `pressCrewCard` does for a member
 * carrying no Github login.
 *
 * The toggle runs against the SELECTION this page derived, not against whatever
 * the URL literally holds, so a duplicated token is released rather than halved.
 *
 * It toggles a BOARD, not a name (#782). Releasing takes out every entry that
 * was pressing this ring, which is how a name-only selection covering two
 * same-named boards is released rather than left half-on; adding puts the whole
 * address in, so the other board keeps its own ring to itself.
 */
export function pressBoardRing(
  search: string,
  selection: readonly BoardSelection[],
  at: BoardAt | null | undefined,
  stored?: ViewerPrefs | null,
): string | null {
  if (!at || !at.name) return null;
  const next: BoardSelection[] = isPressed(selection, at)
    ? selection.filter((s) => !speaksFor(s, at))
    : [...selection, { org: at.org, number: at.number, name: at.name }];
  return withArrangement(search, withBoards(withProjects(search, namesOf(next)), tokensOf(next)), stored);
}

/** The names the selection narrows the queue to, deduped: two boards sharing a
 *  name are one `?project=` token, because the queue's dimension IS the name and
 *  a doubled token draws two identical FilterBar chips. */
function namesOf(selection: readonly BoardSelection[]): string[] {
  const out: string[] = [];
  for (const s of selection) if (!out.includes(s.name)) out.push(s.name);
  return out;
}

/** The addresses worth writing. A selection entry that named no org has none —
 *  see `boardToken` — and is carried by its name alone, exactly as it was
 *  before #782. */
function tokensOf(selection: readonly BoardSelection[]): string[] {
  const out: string[] = [];
  for (const s of selection) {
    const token = s.number === undefined ? null : boardToken({ org: s.org, number: s.number, name: s.name });
    if (token !== null && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * The arrangement the press would otherwise have thrown away (#750 review).
 *
 * `initViewer` reads a host's remembered grouping and view ONLY while the query
 * carries no viewer state at all — `hasViewerParams` is the whole-state test,
 * and it is deliberate: a shared link must open as the sender left it, not as
 * the receiver last arranged the page. A ring press is the one write that
 * crosses that line, from a bare URL to one naming `?project=`, and it silences
 * storage on the way through.
 *
 * The queue's own Project chip never meets this, because `useViewerState`'s
 * `commit` claims the URL it wrote and so is never re-derived from it. This page
 * cannot claim anything — it writes the URL beside the viewer — so the URL has
 * to carry what storage was saying. Which is what the chip writes anyway:
 * `encodeViewer` states the arrangement whenever it departs from the default.
 *
 * The symptom without it: `persistKey="dashboard"` remembers Status grouping,
 * `encodeViewer` omits `status` as the app-wide default, and `initViewer` falls
 * to Your work's own `['project', 'type']` lead. So every ring press snapped the
 * queue from the grouping the reader chose back to Board — on the one gesture
 * this feature is about.
 *
 * Only that one crossing is carried. A URL already naming viewer state has
 * already silenced storage, and a press that clears the last board hands the
 * page back to a bare URL, where storage speaks again and says the same thing.
 * Written in place, like `withProjects` and for the same reason.
 */
function withArrangement(search: string, next: string, stored: ViewerPrefs | null | undefined): string {
  if (!stored) return next;
  if (hasViewerParams(search) || !hasViewerParams(next)) return next;
  const p = new URLSearchParams(next.startsWith('?') ? next.slice(1) : next);
  // Written EXPLICITLY, both halves, even when one equals a default: the point
  // is that the next reader must not have to guess, and `hasExplicitGroup` /
  // `hasExplicitView` are what it will ask.
  if (stored.group) p.set('group', stored.group);
  if (stored.view) p.set('view', stored.view);
  return `?${p.toString()}`;
}

/**
 * The next `?search` after a ring press: the board selection replaced,
 * everything else left exactly as it was.
 *
 * Deliberately NOT a round-trip through `decodeViewer`/`encodeViewer`, for the
 * reason `withAssignees` states: that codec omits whatever equals the caller's
 * defaults, so re-encoding here would quietly rewrite params this page has no
 * business touching — Your work's queue leads with `view=board`, so an explicit
 * `?view=board` would vanish — and it drops any param the codec does not know.
 * Editing one key in place cannot do either.
 */
export function withProjects(search: string, names: readonly string[]): string {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  p.delete(PROJECT_PARAM);
  for (const n of names) p.append(PROJECT_PARAM, n);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** The same edit for the addresses (#782), written the same way and for the same
 *  reason. Replaced wholesale rather than merged: the press knows the whole
 *  selection, and a leftover token from the URL it is replacing would qualify a
 *  name nobody pressed. */
export function withBoards(search: string, tokens: readonly string[]): string {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  p.delete(BOARD_PARAM);
  for (const t of tokens) p.append(BOARD_PARAM, t);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

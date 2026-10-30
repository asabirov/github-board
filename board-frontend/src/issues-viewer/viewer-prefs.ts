/**
 * Per-page memory for the IssuesViewer's arrangement (#463). A Project page that
 * you left grouped by status, in list view, should open that way next time —
 * and the project next to it should keep its own arrangement, not inherit this
 * one.
 *
 * Deliberately narrow on three axes:
 *
 * - **Opt-in.** Nothing persists unless a host hands the viewer a storage key.
 *   One IssuesViewer serves Your work, the Unit queue, triage and the Project
 *   page; a global default would make every one of them start remembering things
 *   nobody asked them to remember. Three have taken it up and no more (#727):
 *   the Project page, per board; Your work under `dashboard`, and Queue, the
 *   same page's compact form, under `queue` since #1050; the Unit queue under
 *   `team`. Those are the queues a person LIVES in and re-groups to
 *   suit the work in front of them, and re-picking the same grouping on every
 *   visit is the cost #463 named. Their keys are flat where a board's is not,
 *   because `/api/issues/mine` and `/api/issues/all` take no org: the issue set
 *   is the same whatever `?org=` the address carries, so an org in the key would
 *   split one arrangement into several nobody can tell apart. A fourth host is a
 *   decision, and `viewer-prefs.spec.ts` fails until somebody makes it.
 * - **Grouping, view, and sort only.** The search text is NOT stored. A remembered
 *   query would silently hide rows on arrival, and an empty-looking board is a
 *   worse page than one you have to re-group.
 * - **Advisory.** Every read is validated and every failure degrades to "nothing
 *   stored", so a cleared/locked/corrupt storage lands on the page defaults
 *   instead of breaking the page.
 */
import { isViewerSort, type ViewerSort } from './triage-sort';
import type { GroupDim } from './filter-group';
import { asGroupDim } from './viewer-url';
import type { ViewerAction } from './use-viewer-state';

/** Namespace for every stored arrangement. Distinct from the theme (`board_theme`)
 *  and timezone (`board_timezone`) keys, which are single flat keys — this one is
 *  a prefix, since it holds one entry per host key. */
export const VIEWER_PREFS_PREFIX = 'board_viewer:';

/** The board's old viewer-arrangement prefix, carried forward once (#1450). */
const LEGACY_VIEWER_PREFS_PREFIX = 'lessly_viewer:';

/** Carry every arrangement over from `lessly_viewer:*` once: read each old key,
 *  write the new one, remove the old one. A new key that already holds a value
 *  wins, so an arrangement made after the rename is never overwritten. */
function migrateViewerPrefs(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key === null || !key.startsWith(LEGACY_VIEWER_PREFS_PREFIX)) continue;
      const value = localStorage.getItem(key);
      const next = VIEWER_PREFS_PREFIX + key.slice(LEGACY_VIEWER_PREFS_PREFIX.length);
      if (value !== null && localStorage.getItem(next) === null) localStorage.setItem(next, value);
      localStorage.removeItem(key);
    }
  } catch {
    // ignore — a device without storage remembers nothing
  }
}

/** What a host page remembers. All fields are optional: a partial record still
 *  restores what it has and leaves the rest on the page's defaults. */
export interface ViewerPrefs {
  sort?: ViewerSort;
  group?: GroupDim;
  view?: 'list' | 'board';
}

/**
 * A host key, or the key it wants PLUS the keys this page used to be stored
 * under, newest first (#697).
 *
 * A key is a promise to a person that the arrangement they left is the one they
 * come back to, so renaming one is a silent loss unless the old name is still
 * read. `projectViewerKey` gained the board's org — a number alone is not
 * per-board across a union of orgs — and a single-org deployment would otherwise
 * have paid for that with every stored grouping it had.
 */
export type HostKey = string | readonly string[];

/** The keys to try, in order. A plain string is a list of one, which is what
 *  every host but the Project page passes. */
const keysOf = (key: HostKey): readonly string[] => (typeof key === 'string' ? [key] : key);

const isView = (v: unknown): v is 'list' | 'board' => v === 'list' || v === 'board';

/** The stored arrangement for a host key, or null when there is nothing usable.
 *  Never throws: absent storage, a denied getter, malformed JSON and unknown
 *  values all read as "nothing stored". */
export function readViewerPrefs(key: HostKey): ViewerPrefs | null {
  migrateViewerPrefs();
  for (const k of keysOf(key)) {
    const prefs = readOne(k);
    if (prefs) {
      if (k !== keysOf(key)[0] && keysOf(key)[0].startsWith('project:account-id:')) writeViewerPrefs(key, prefs);
      return prefs;
    }
  }
  return null;
}

/** One key's stored arrangement. The loop above stops at the first that answers,
 *  so a page that has been arranged under its CURRENT key never sees an older
 *  one — the fallback is only reached by a board nobody has arranged since the
 *  rename. */
function readOne(key: string): ViewerPrefs | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(VIEWER_PREFS_PREFIX + key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { group, view, sort } = parsed as Record<string, unknown>;
  const prefs: ViewerPrefs = {};
  // `asGroupDim` rather than a bare predicate: it is both the gate and the
  // normaliser, so an entry stored under an older spelling reads back as the
  // dimension this page actually offers instead of falling off `resolveGroupDim`.
  const dim = asGroupDim(group);
  if (dim) prefs.group = dim;
  if (isViewerSort(sort)) prefs.sort = sort;
  if (isView(view)) prefs.view = view;
  // A record that survives validation with nothing left in it is no different
  // from an absent one.
  return prefs.group || prefs.view || prefs.sort ? prefs : null;
}

/**
 * Remember an arrangement under a host key. A device without writable storage
 * just doesn't remember.
 *
 * Given a list, this writes FORWARD — to the first key only — and leaves every
 * older one exactly as it found it. Writing to all of them would keep two names
 * for one board alive forever; deleting the old one is a destructive write
 * against a key a board-api predating `ProjectSummary.org` still produces during
 * a deploy window, and losing that arrangement is the thing this whole
 * arrangement exists to avoid. So the old entry is left: it is two fields of
 * advisory JSON, it is unreachable once the current key has been written, and
 * leaving it costs nobody anything.
 */
export function writeViewerPrefs(key: HostKey, prefs: ViewerPrefs): void {
  const body: ViewerPrefs = {};
  // The write is bounded by the same reader (#1108). A crafted
  // `?group=triage:<anything>` reaches this through the state the View toggle
  // persists, and without a ceiling on what a dimension may be, one click parks
  // an arbitrary unbounded string here in place of the arrangement this queue
  // had. `asGroupDim` admits only a grouping the page could resolve, and stores
  // it in the one spelling it would be offered under.
  const dim = asGroupDim(prefs.group);
  if (dim) body.group = dim;
  if (isViewerSort(prefs.sort)) body.sort = prefs.sort;
  if (isView(prefs.view)) body.view = prefs.view;
  try {
    localStorage.setItem(VIEWER_PREFS_PREFIX + keysOf(key)[0], JSON.stringify(body));
  } catch {
    // ignore — the page still works, it just won't reopen this way
  }
}

/** Whether an action is a deliberate arrangement choice, and therefore the moment
 *  to write. Grouping, view, and sort qualify.
 *
 *  Current preferences are not overwritten on mount: arriving through a shared
 *  `?group=…&view=…` link shows you the sender's arrangement without overwriting
 *  the one this project already had for you. Change the grouping yourself once
 *  you're there and THAT is remembered. */
export function isPrefAction(action: ViewerAction): boolean {
  return action.type === 'setSort' || action.type === 'setGroup' || action.type === 'setView';
}

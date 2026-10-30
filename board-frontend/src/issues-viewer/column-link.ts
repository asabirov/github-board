/**
 * Where a board column's own heading goes, when it heads a Github Project
 * (#1191).
 *
 * The Queue opens grouped by board (#727), so the first thing a reader sees is
 * a row of project names — and they were plain text, which is what was
 * reported. This is the one decision behind making them links, kept pure so it
 * is settled in a test rather than by reading the header component.
 *
 * A column's key is what it was grouped ON, so under `project` it is the board's
 * NAME and nothing more (`groupIssues`). A name is not an address: #697 and #782
 * are both about two orgs each holding a board called the same thing, and
 * `/api/issues/filter-options` is the only place this page holds the other half
 * — the org and the number that address one board. So the name is resolved
 * against that catalog, and a name it does not answer for stays plain text.
 *
 * Which is also what settles the ambiguous case. `groupByMulti` files a row
 * under every board name it carries, so two same-named boards are ONE column
 * holding both their issues — there is no single page for it, and picking the
 * first of the two would send half this column's readers to the wrong board. A
 * column that cannot name one board is not a link.
 *
 * "No project" needs no case of its own here, and that is by construction:
 * `NO_PROJECT_KEY` leads with a NUL, which `filter-group.ts` chose because a
 * board title cannot carry one, so it matches no catalog entry and falls
 * through the same door as an unknown name. The stack is an absence rather than
 * a board, and an absence has no page to open.
 */
import type { FilterProject } from '../api/issues';
import { routePath } from '../route';
import type { GroupDim } from './filter-group';
import type { RenderGroup } from './viewer-groups';

/**
 * The in-board path this column's name opens, or `null` when it opens nothing.
 *
 * Tolerant of an absent catalog for `projectFilterNames`' reason and not out of
 * habit: `fetchFilterOptions` returns `res.json()` unnarrowed, so a 200 whose
 * body carries no `projects` reaches here, and on the Queue this runs once per
 * column on every render.
 */
export function columnBoardPath(
  group: Pick<RenderGroup, 'key'>,
  dim: GroupDim,
  boards: readonly FilterProject[] | undefined,
): string | null {
  if (dim !== 'project') return null;
  const wearing = (boards ?? []).filter((b) => b && b.name === group.key);
  // De-duped by the whole address, so one board listed twice still reads as one
  // board. The endpoint already de-dupes this way; doing it again here is what
  // keeps the ambiguity test below about two DIFFERENT boards.
  const distinct = wearing.filter(
    (b, i) => wearing.findIndex((o) => o.org === b.org && o.number === b.number) === i,
  );
  if (distinct.length !== 1) return null;
  const { org, number } = distinct[0];
  // A number the wire made up is a link to nowhere: `parseRoute` keeps a
  // `/projects/:number` only for a positive integer, so anything else would
  // format an address that resolves back to Your work.
  if (!Number.isInteger(number) || number <= 0) return null;
  // The org rides along when the catalog states it, which addresses exactly one
  // board. Without it the path is `/projects/:number`, which resolves the way
  // `/api/projects/:n` resolves it — the first configured org holding that
  // number. That is the deploy-window shape `FilterProject.org` being optional
  // describes, and it is the answer this board gave before addresses existed.
  return routePath({ tab: 'projects', org, project: number });
}

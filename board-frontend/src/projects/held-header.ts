import { copyResponseDeadline } from '../auth/response-deadline';
/**
 * The board's header, off the boards rollup already on disk (#879).
 *
 * #824 gave the board page its own copy of the last answer, and it works — for
 * a board you have opened before. The FIRST open of a board has nothing under
 * `projects/<n>`, so the page drew a nameless silhouette for a whole
 * `/api/projects/<n>` read while the browser was already holding that board's
 * name, number, url and completion: `Pulse` stores every board the reader can
 * see under `projectsKey(org)`, and `ProjectDetail extends ProjectSummary`
 * adding exactly one field, `items`. So the header is data the board had and
 * was throwing away.
 *
 * What comes back is the header's own facts and nothing else. A `ProjectSummary`
 * carries `contributors`, `weeklyClosed` and the rest, and none of it belongs on
 * this path: the ring's SEGMENTS are read off the board's items, which is the
 * thing that has not arrived, and a header seeded with more than it can prove is
 * how a cache-first paint starts stating figures nobody has.
 *
 * `items` is deliberately absent rather than empty. "No issues on this board" is
 * a sentence the board page says off `items.length === 0`, and a synthesized
 * empty list would say it to every reader opening a board for the first time —
 * the false zero #714 took a whole page down for.
 *
 * WHEN THIS IS REACHED NOW, which is not when it was written (#1249 item 2).
 *
 * It was written for a board still LOADING: the first open of a board has
 * nothing under its own key, and the rollup on disk already names it. That path
 * closed. `projects` is an `isSensitivePayloadKey` entry, so a page LOAD of a
 * board has never reached this — the mount wipe empties the key before the page
 * renders — and #1243 made the seed ask the wipe's own question, which took the
 * WALK too. For one release this function was unreachable in production, and
 * #1249 records the decision not to delete it in the same change that made it
 * so, because deleting a path in the change that closed it hides one decision
 * inside another.
 *
 * What reaches it is the FAILED read. The rollup's SAVED copy lives outside the
 * permission wipe (`keepSaved`, #1035) and may be read only after a live read
 * failed in a way that says "not now", which is exactly the state a board page
 * is in when it has nothing of its own to draw: its own saved copy is missing or
 * past the ceiling, and the rollup's still names the board. The page then draws
 * this header, marks it as a copy, and leaves the items as still placeholders —
 * `items` absent, for the reason the paragraph above gives, which is the same
 * reason it was absent when this was a loading path.
 *
 * So nothing about the function changed. What changed is the one caller's
 * question: it used to be "the board has not arrived yet", and it is now "the
 * board is not coming, and this is what the disk can still prove about it".
 */
import type { ProjectSummary } from '../api/projects';

/** What `BoardHeader` needs, and no more. */
export interface HeldHeader {
  name: string;
  number: number;
  url: string;
  pct: number;
  itemsComplete?: boolean;
}

/** Whether a stored row can be drawn as a header without inventing any of it.
 *  The `accept` this key is read under is `Array.isArray`, which says nothing
 *  about the rows inside, and a build that changes `ProjectSummary` leaves a
 *  day of rows behind speaking the old shape. */
function drawable(row: unknown): row is ProjectSummary {
  if (typeof row !== 'object' || row === null) return false;
  const { name, number, url, pct } = row as Record<string, unknown>;
  return (
    typeof name === 'string' && name !== ''
    && typeof number === 'number' && Number.isFinite(number)
    && typeof url === 'string' && url !== ''
    && typeof pct === 'number' && Number.isFinite(pct)
  );
}

/**
 * The one board this address names, out of the rollup stored for it — or null.
 *
 * IDENTITY IS THE WHOLE OF THIS FUNCTION, because being wrong here means
 * drawing one board's name over another one's page, and across a union of orgs
 * (#697) a Projects v2 number is unique only WITHIN an org. So the rule is
 * "exactly one, provably", and every other case is a miss:
 *
 * - The address names an org. Only a row that SAYS it is that org's counts.
 *   `ProjectSummary.org` is optional — a board-api that predates #697 does not
 *   send it — and a row that does not say is a row that cannot be proven, not a
 *   row that may be assumed. The API's own unqualified fallback is not borrowed
 *   here: it resolves against the live configuration, and this is a guess made
 *   against a copy on a disk.
 * - The address names no org, which is the pre-#697 link the API answers by
 *   resolving the first configured org holding the number. One row holding that
 *   number means every resolution reaches that row, whichever org it is in. Two
 *   rows means the copy cannot say which, and nothing is drawn.
 *
 * Pure and exported for its own spec: no effect fires in this suite, so this
 * is where the decision can actually be tested.
 */
export function heldHeader(held: unknown, number: number, org?: string): HeldHeader | null {
  if (!Array.isArray(held)) return null;
  const sameNumber = held.filter((row): row is ProjectSummary => drawable(row) && row.number === number);
  const candidates = org != null && org !== ''
    ? sameNumber.filter((row) => row.org === org)
    : sameNumber;
  if (candidates.length !== 1) return null;
  const { name, url, pct, itemsComplete } = candidates[0];
  return copyResponseDeadline(held, { name, number, url, pct, itemsComplete });
}

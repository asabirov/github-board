import type { PersonalIssues } from '../api/issues';
import { loadFailureText } from '../auth/session-copy';

/** What the queue is called on screen, in the sentence a failed read draws and
 *  in the console line `Dashboard` writes beside it (#1055). */
export const QUEUE_SUBJECT = 'your queue';

/**
 * What Your work holds when its fetch failed.
 *
 * `updatedAt` is empty on purpose (#512). This handler used to stamp
 * `new Date().toISOString()`, and a page's payload time was then fed straight
 * into the global "Synced" clock — so a dead session showed a green "Synced just
 * now" in the top bar over three zeros. A failed fetch knows nothing about
 * freshness, and an empty time is what says so.
 *
 * The clock no longer reads a page's payload at all: since #1169 both it and the
 * Board sync panel read the server's own per-source record, so a stamp invented
 * here could not reach the header even if one were written. What it would still
 * do is put a fabricated time on this payload, which is reason enough.
 */
export const MINE_UNAVAILABLE: PersonalIssues = {
  updatedAt: '',
  login: null,
  issues: [],
  throughput: { opened: 0, closed: 0 },
  throughputWeeks: [],
};

/** What the empty queue says. `title` is null for the one-line states, which is
 *  every state but the one below that needs a person to go and do something. */
export interface QueueEmptyState {
  title: string | null;
  body: string;
}

/**
 * What the queue says when it has no rows.
 *
 * The distinction this function exists for (#512): "the server told us you have
 * no Github identity" and "nothing loaded" are different facts, and the board
 * used to say the first when it only knew the second. `login: null` out of a
 * rejection handler is not a statement about the person's account — it is the
 * absence of an answer. A failed fetch therefore never reaches the identity
 * line; it says what actually happened, in the same words the other surfaces
 * use for the same condition.
 *
 * The no-login state gained a title and changed its words in #535. Before that
 * the board never tried to work a handle out, so "not linked yet" was the whole
 * story. Now it derives one from commit authorship first, and this state is only
 * reached once that has been tried and found nothing — so it says which route
 * was tried, and that a person has to finish the job. Deliberately not a link:
 * the Access page is admin-gated, and a link most readers cannot open is a dead
 * end rather than a fix.
 */
export function queueEmptyState(o: { error: string | null; login: string | null }): QueueEmptyState {
  if (o.error !== null) return { title: null, body: loadFailureText(QUEUE_SUBJECT, o.error) };
  if (o.login === null) {
    return {
      title: 'No GitHub login on your account',
      body: 'Nothing in your commits matched, so the login has to be typed in by hand. Ask an admin to add it on the Access page.',
    };
  }
  return { title: null, body: 'Nothing assigned to you right now.' };
}

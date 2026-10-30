/**
 * Personal triage counts (#412) — how many of MY open, assigned issues are bug
 * reports vs feedback. One reader: the Cockpit's "Assigned to you" bug
 * sub-count. Pure over `mine.issues` — the same assigned-to-me, open list the
 * queue below renders — so the sub-count is scoped to me by construction rather
 * than by a second query (the bug #412 reported: org-wide buckets on a surface
 * whose card counted my queue).
 */
import type { PersonalIssue } from '../api/issues';

export interface TriageCounts {
  bugs: number;
  feedback: number;
}

/** Count the caller's bug / feedback issues by their derived `type`. The input
 *  is already the caller's list (assigned + open on Your work), so no scoping
 *  happens here — this only tallies by type. */
export function triageCounts(issues: PersonalIssue[]): TriageCounts {
  let bugs = 0;
  let feedback = 0;
  for (const i of issues) {
    if (i.type === 'bug') bugs++;
    else if (i.type === 'feedback') feedback++;
  }
  return { bugs, feedback };
}

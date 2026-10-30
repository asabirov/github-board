import { ownerId } from '../auth/github-target';
/**
 * The storage key a Project page hands the IssuesViewer so the board reopens the
 * way you left it (#463). Derived from the Github Project (v2) NUMBER, which is
 * what the route already carries and what makes the key stable across renames.
 *
 * Its one real job is to differ per board: grouping one board by status and
 * another by assignee is a normal thing to want, and a shared key would make the
 * second visit overwrite the first.
 *
 * `org` is the other half of a board's identity (#697). A Projects v2 number is
 * unique only WITHIN an org, so on a deployment serving two orgs the number
 * alone is not "per board" at all — acme's 3 and globex's 3 shared one
 * arrangement and each visit overwrote the other's, which is precisely the
 * failure this key exists to prevent.
 *
 * It is optional because the route it comes from is: a `/projects/3` link
 * shared before #697 names no org, and the key it produces is the one it always
 * produced.
 *
 * This is the key a board WRITES. What it READS is `projectViewerKeys` below,
 * which is what stops the org costing anybody an arrangement they had.
 */
export function projectViewerKey(number: number, org?: string): string {
  const id = org ? ownerId(org) : undefined;
  if (id) return `project:account-id:${id}/${number}`;
  return org ? `project:${org}/${number}` : `project:${number}`;
}

/**
 * The keys this board's arrangement may be stored under, newest first — what the
 * page hands `IssuesViewer`, and what `viewer-prefs.ts` reads in order and
 * writes only the head of.
 *
 * The org went into the key because a number alone is not per-board across a
 * union of orgs. A key that changes is an arrangement a person silently loses,
 * though, and a single-org deployment — the only kind anyone is running — would
 * have paid for a two-org fix with every grouping and view it had. So the key
 * this board used to have stays readable behind the one it has now: the
 * arrangement is found, then copied forward under the current account-ID key.
 *
 * The fallback is the pre-#697 key and nothing else, so it can only ever be a
 * board reading its OWN past. Two orgs' board 7 do share it, and there the first
 * one opened inherits the legacy arrangement while the other keeps reading it
 * until it is arranged itself — a cost paid only on a deployment nobody runs
 * yet, and the only shape that costs a single-org deployment nothing.
 */
export function projectViewerKeys(number: number, org?: string): readonly string[] {
  const current = projectViewerKey(number, org);
  return [...new Set([current, ...(org ? [`project:${org}/${number}`] : []), `project:${number}`])];
}

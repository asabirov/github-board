/**
 * What the board can be permitted to do on Github (#584).
 *
 * These are the AUDIT ACTION KEYS already in `audit/audit.types.ts:21-31`,
 * spelled exactly as they are spelled there, so audit and capability share one
 * vocabulary instead of two kept in sync. `boot-alert.file` is the one
 * addition: the boot notifier writes Github (`boot-alert.notifier.ts:81,91`)
 * and is audited by nothing, so it has no audit key to borrow.
 */
export const CAPABILITIES = [
  'issue.close',
  'issue.state',
  'issue.assignees',
  'issue.labels',
  'issue.milestone',
  'issue.body.task',
  'issue.comment',
  'issue.project.add',
  /** Make a new Projects v2 project from the issue page, under the issue's own
   *  owner, and put the issue on it (#982). The add half is `issue.project.add`. */
  'issue.project.create',
  'issue.project.remove',
  'issue.field',
  'repo.dri',
  'boot-alert.file',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(x: string): x is Capability {
  return (CAPABILITIES as readonly string[]).includes(x);
}

/**
 * The eleven the in-board issue editor writes (#626, #693, #982), DERIVED from the list
 * above by the `issue.` prefix rather than retyped — a second spelling of these names
 * is a second thing to keep in sync, and the one that drifts is silent.
 *
 * `/api/auth/me` aggregates `canWrite` over exactly this set, and
 * `issue-editor-capabilities.spec.ts` pins it to the union of `@Writes` on
 * `IssueDetailController`'s write routes, read through the same metadata
 * discovery `writes-declared.spec.ts` uses. That is what stops the set from
 * drifting away from what the editor actually writes: adding an eleventh issue route
 * without a capability, or a capability the editor never exercises, reddens that
 * spec rather than quietly widening or narrowing what one refusal darkens.
 */
export const ISSUE_EDITOR_CAPABILITIES: readonly Capability[] = CAPABILITIES.filter((c) =>
  c.startsWith('issue.'),
);

/**
 * The issue action model (#446, #751) — the one list of actions an issue row offers,
 * kept PURE so the items and the two eligibility rules — close, and assign —
 * are unit-tested exactly as they render. `IssueActions.tsx` renders this list twice, into the
 * right-click ContextMenu and the hover-⋮ DropdownMenu, so the two never drift.
 *
 * Effects are injected rather than imported here (open a tab, copy with a flash,
 * raise the close confirm, take the issue, raise the assign picker) — that keeps
 * this module DOM-free for the board's
 * `node` test environment and makes each item's handler assertable.
 *
 * The close guard itself is not re-implemented: it stays in
 * `issues-viewer/board-card.ts` (`canCloseIssue` / `closeTargetOf`), which this
 * module composes with the caller's `mayClose` verdict.
 */
import { canCloseIssue, issueReference } from '../issues-viewer/board-card';

/** The least an issue must carry to be actionable. `ViewerIssue`, the Oldest-open
 *  `IssueRowData` both satisfy it structurally. */
export interface ActionableIssue {
  /** Short repo key — the `repo` half of the copyable `repo#number` reference. */
  repo: string;
  number: number;
  title: string;
  /** Canonical Github URL — every action reads from it. */
  htmlUrl: string;
}

export type IssueActionKey =
  | 'open-github'
  | 'copy-link'
  | 'copy-reference'
  | 'assign-self'
  | 'assign-other'
  | 'close';

export interface IssueActionItem {
  key: IssueActionKey;
  label: string;
  /** Danger-toned and preceded by a separator — board's one edit-existing-state write. */
  danger?: boolean;
  /** Preceded by a separator, with no tone (#752) — the first item of a group
   *  that does a different KIND of thing from the one above it. */
  separator?: boolean;
  run: () => void;
}

export interface IssueActionOptions {
  /** The issue already reads as closed → no Close action. */
  closed?: boolean;
  /**
   * May this menu offer the close write at all — the caller's composed answer,
   * REQUIRED (#653).
   *
   * Two rules feed it and neither belongs here. The surface's: a read-only
   * mirror (product feedback) never closes, whatever the session may do. And
   * the board credential's: `Close issue…` performs the write board-service
   * declares as `@Writes('issue.close')`, so a credential already refused that
   * capability must not be offered it — `mayCloseIssue(me)` in
   * `IssueActions.tsx` is where that half is read.
   *
   * It has no default on purpose. The optional-with-a-default this replaced
   * (`allowClose = true`) is precisely how the credential half went missing for
   * three of the four surfaces: every one of them said nothing, and saying
   * nothing meant yes. Required, a mount that has not thought about it does not
   * compile.
   */
  mayClose: boolean;
  /**
   * May this menu offer the two assign writes at all (#751) — the caller's
   * composed answer, REQUIRED and undefaulted for the reason `mayClose` is.
   *
   * Same two rules feed it and neither belongs here. The surface's: a read-only
   * mirror never hands an issue to anybody, whatever the session may do. And the
   * board credential's: both items perform the write board-service declares as
   * `@Writes('issue.assignees')`, so a credential already refused that
   * capability must not be offered it — `mayAssignIssue(me)` in
   * `IssueActions.tsx` is where that half is read.
   *
   * It is a SECOND question and not a synonym for `mayClose`: the two capability
   * keys are refused independently, so a credential may close and not assign, or
   * assign and not close. Deriving one from the other would take a control off
   * over a refusal that was never about it — which is #635, again.
   */
  mayAssign: boolean;
  /**
   * Who the reader is on Github (`me.githubLogin`), or null where the roster maps
   * this account to nobody. `Assign to me` is the one item that needs a value
   * from the session rather than a verdict: there is no "me" to PATCH without a
   * handle, so an unmapped account is offered `Assign to…` and not `Assign to
   * me`. Optional, and absent means withheld — the safe direction, unlike the
   * default this menu's close verdict had to lose.
   */
  viewerLogin?: string | null;
  /**
   * Who this issue's repo will assign — `IssueEditOptions.assignableLogins`,
   * read once by the surface that owns the rows (#752).
   *
   * `Assign to me` is the one item that WRITES without asking anything else
   * first, and a capability verdict is not the same question: `mayAssign` says
   * the board's credential may perform `issue.assignees`, and this says Github
   * will accept THIS reader on THIS repo. `PATCH …/assignees` replaces the set
   * and silently drops a login the repo will not assign, answering 200 with what
   * it kept — so pressing it without this check took whoever was triaging the
   * issue off it and put nobody on, and the issue left their Your-work queue.
   *
   * `Assign to…` needs no such gate: its list is this list, so it can only
   * offer somebody Github will take.
   *
   * Optional, and absent means WITHHELD — the safe direction, and the one a
   * surface that has not read the list yet needs. It is not defaulted to
   * permissive for the reason `mayClose` is not: saying nothing meant yes is
   * #635.
   */
  assignableLogins?: string[] | null;
}

/**
 * Will this repo assign this person? Case-folded on both sides, because the two
 * strings come from different systems: `me.githubLogin` is the handle somebody
 * typed into the roster (`github-login.resolver.ts`), and `assignableLogins` is
 * Github's canonical casing. `identity/team-roster.ts` canonicalises for exactly
 * this reason, and the fixture ships `IvanRoslov`.
 */
function repoWillAssign(assignable: string[] | null | undefined, login: string): boolean {
  return !!assignable && assignable.some((a) => a.toLowerCase() === login.toLowerCase());
}

/** The side effects the items fire, injected so they can be asserted. */
export interface IssueActionEffects {
  openExternal: (url: string) => void;
  copy: (text: string, confirm: string) => void;
  requestClose: () => void;
  /** Take it: write the reader's own login as the issue's assignee (#751). It
   *  carries the login rather than reading it back out of the options, so the
   *  handler under test states which account it is about to write. */
  assignSelf: (login: string) => void;
  /** Hand it over: raise the picker that asks who. */
  requestAssign: () => void;
}

/**
 * Close is offered only when the caller says this menu may close AND the issue
 * is still open AND its URL is a real Github issue URL (the `canCloseIssue`
 * guard). The two halves ask different questions and neither implies the other:
 * `mayClose` is about the session and the surface, `canCloseIssue` about the
 * issue in hand.
 *
 * Withheld means the item is GONE, not present-and-dead — see the note above
 * `issueActionItems` for why this menu answers that differently from a panel row.
 */
export function canOfferClose(issue: ActionableIssue, opts: IssueActionOptions): boolean {
  return opts.mayClose && canCloseIssue(issue, opts.closed ?? false);
}

/**
 * The assign items are offered on the same terms: the caller says this menu may
 * assign, the issue is still open, and its URL is a real Github issue URL.
 *
 * That last guard is `canCloseIssue`, and the name is the only thing about it
 * that is close-specific — what it answers is "is this a still-open issue whose
 * owner and repo can be read off its URL", which is exactly what an assign write
 * needs and for the same reason: a row carries a short repo key and no owner at
 * all. Composing the existing guard keeps the two menus' idea of an actionable
 * issue one function; a second copy under a better name would be a second thing
 * to keep in step, and renaming this one reaches `issues-viewer/board-card.ts`.
 *
 * Still-open is a judgement rather than a Github rule — Github assigns a closed
 * issue perfectly well. The menu withholds it because this surface already
 * treats a closed row as done with (it hides the ⋮ handle entirely), and an
 * assignment made there moves nothing anybody is looking at.
 */
export function canOfferAssign(issue: ActionableIssue, opts: IssueActionOptions): boolean {
  return opts.mayAssign && canCloseIssue(issue, opts.closed ?? false);
}

/**
 * The action list, in the order it renders on every surface.
 *
 * A withheld Close leaves no trace, where the issue editor's rows do the
 * opposite: a row governed by a refused capability stays in place, sits its
 * value back and writes `REFUSED_REASON` underneath, so a person reads "the
 * board isn't allowed" instead of wondering where the control went. That is
 * right there and wrong here, for the reason
 * `facet-editors.tsx` already gives about the four issue controls that are not
 * rows: `REFUSED_REASON` names no subject, and only a label column beside it
 * supplies one. A dropdown item has no label column — a dead `Close issue…`
 * with a grey sentence under it would be a sentence about nothing in
 * particular, in a menu the reader opened to do something else.
 *
 * The second half is `PropertyRow`'s: a permanent refusal offers no button at
 * all, "because a button that cannot work is the thing that sent people round
 * the loop". A menu item IS a button, and one that reports its own uselessness
 * on hover is the loop. `repos/ReposPage`'s `canSetDri` settles the same
 * question the same way — the owner picker simply is not there.
 *
 * So the menu shortens by one line, and the three read actions stay. What a
 * person loses is an item that could not have worked; what they gain is a menu
 * whose every entry does.
 */
export function issueActionItems(
  issue: ActionableIssue,
  opts: IssueActionOptions,
  fx: IssueActionEffects,
): IssueActionItem[] {
  const reference = issueReference(issue);
  const items: IssueActionItem[] = [
    { key: 'open-github', label: 'Open on GitHub', run: () => fx.openExternal(issue.htmlUrl) },
    { key: 'copy-link', label: 'Copy link', run: () => fx.copy(issue.htmlUrl, 'Copied issue link') },
    { key: 'copy-reference', label: 'Copy reference', run: () => fx.copy(reference, `Copied ${reference}`) },
  ];
  if (canOfferAssign(issue, opts)) {
    // `Assign to me` only where the session HAS a Github handle AND the repo
    // will assign it — see `viewerLogin` and `assignableLogins`. `Assign to…`
    // asks who and lists that same set, so it stands on its own.
    const login = opts.viewerLogin;
    const assign: IssueActionItem[] = [];
    if (login && repoWillAssign(opts.assignableLogins, login)) {
      assign.push({ key: 'assign-self', label: 'Assign to me', run: () => fx.assignSelf(login) });
    }
    assign.push({ key: 'assign-other', label: 'Assign to…', run: () => fx.requestAssign() });
    // The rule opens the GROUP, so it survives `Assign to me` being withheld —
    // which happens on any repo that will not assign the reader. Three actions
    // that leave the issue exactly as it was, then the ones that change who owns
    // it: with no line between them the pair read as a third way to copy (#752).
    assign[0].separator = true;
    items.push(...assign);
  }
  if (canOfferClose(issue, opts)) {
    items.push({ key: 'close', label: 'Close issue…', danger: true, run: () => fx.requestClose() });
  }
  return items;
}

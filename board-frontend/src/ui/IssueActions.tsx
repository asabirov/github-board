/**
 * The ONE issue action menu (#446, #751) — Open on GitHub, Copy link, Copy
 * reference, Assign to me, Assign to…, Close issue — wrapped around anything
 * that renders an issue. The shell that draws the list into both the right-click
 * menu and the hover-⋮ menu is `ActionMenu` (#472); this composes it with the
 * issue action list, the close write's confirm and the assign write's picker, so
 * an issue surface mounts one component and gets both paths.
 *
 * Each write is gated by its own required verdict — `mayClose`, `mayAssign` —
 * and a surface that answers no to one is the menu it was before that item
 * existed.
 *
 * Before this, the menu lived only on the kanban card; the list rows, the Oldest
 * open block had no actions at all. The card's
 * behaviour is the reference: same labels, same order, same handlers, the ⋮
 * hidden at rest and revealed on hover or keyboard focus, and the close write
 * still routed through `CloseIssueAlert`.
 *
 * Layout is the caller's job — see `ActionMenu` for what `className` and
 * `handleClassName` each style.
 */
import { useRef, useState, type ReactNode } from 'react';
import { closeTargetOf } from '../issues-viewer/board-card';
import { mayWrite, type Me } from '../use-me';
import { ActionMenu } from './ActionMenu';
import type { HandleAppearance } from './action-handle';
import { AssignIssueDialog, assignGate, runAssign, sameAssignees, useAssignEffects, type AssignGate } from './AssignIssueDialog';
import { CloseIssueAlert } from './CloseIssueAlert';
import { copyToClipboard } from './clipboard';
import {
  canOfferAssign,
  issueActionItems,
  type ActionableIssue,
  type IssueActionEffects,
  type IssueActionOptions,
} from './issue-actions';

/**
 * The capability `Close issue…` spends (#653). `board-service` declares it on
 * `POST :owner/:repo/:number/close` as `@Writes('issue.close')`; the two words
 * are the same word, and that is the whole join between the control and the
 * write it performs.
 *
 * It is deliberately not in `facet-editors`' `ISSUE_CAP`: that map is the issue
 * PANEL's editors, and Close is not one — it lives on this menu, which is
 * mounted on rows and cards all over the app. `ISSUE_CAP` says so in as many
 * words, and this is the home that sentence was waiting for.
 */
const CLOSE_CAP = 'issue.close';

/**
 * The capability both assign items spend (#751). `board-service` declares it on
 * `PATCH :owner/:repo/:number/assignees` as `@Writes('issue.assignees')` — the
 * same word on both sides, the way `issue.close` is — and on
 * `POST :owner/:repo/:number/assignees/change`, which the several picker saves
 * through (#1009).
 *
 * Unlike Close, this key IS one of the issue panel's editors: `facet-editors`'
 * `ISSUE_CAP` maps `assignees` to it for the `AssigneeEditor`. The two controls
 * are the same write reached from two places, so they read the same key rather
 * than each inventing one, and neither owns it.
 */
const ASSIGN_CAP = 'issue.assignees';

/**
 * May this session close an issue? Exported so the verdict is asserted
 * directly, the way `canSetDri` is.
 *
 * `mayWrite` owns the rule and is not re-derived here: a human session on a
 * deployment where writes are on, AND a board credential not already refused
 * this exact capability. The session half is `writesEnabled` and never
 * `canWrite` — `canWrite` folds in all nine issue refusals, so reading it here
 * would take Close off every row the moment an unrelated `issue.labels` refusal
 * landed, with `issue.close` still available and the close still landing (#626).
 */
export const mayCloseIssue = (me: Me | null): boolean => mayWrite(me, CLOSE_CAP);

/**
 * May this session hand an issue to somebody? Exported so the verdict is
 * asserted directly, the way `mayCloseIssue` is.
 *
 * A separate question from the close verdict and never derived from it: the two
 * capabilities are refused independently, so a credential may close and not
 * assign. The session half is `writesEnabled` and never `canWrite`, for the
 * reason spelled out above `mayCloseIssue` and at length in `use-me.ts`.
 */
export const mayAssignIssue = (me: Me | null): boolean => mayWrite(me, ASSIGN_CAP);

/** Github's answer to an assignment made from a row, and the read it replaced. */
export interface AssignedHere {
  over: readonly string[];
  to: string[];
}

/**
 * Who a row draws as holding its issue (#1009). Github's answer to the last
 * assignment made from the row, while the row is still handed the read that
 * answer replaced; a newer read that says anything else wins, because somebody
 * may have changed the assignees since.
 */
export function assigneesShown(read: string[], here: AssignedHere | null): string[] {
  return here && sameAssignees(here.over, read) ? here.to : read;
}

/** `assigneesShown` as a row's state: the set to draw, and what `onAssigned` calls. */
export function useAssignedHere(read: string[]): [string[], (to: string[]) => void] {
  const [here, setHere] = useState<AssignedHere | null>(null);
  return [assigneesShown(read, here), (to) => setHere({ over: read, to })];
}

/** What the wrapper tells its children about the menu — the board card fades its
 *  avatar out while the ⋮ menu is open so the two never overlap. */
export interface IssueActionsState {
  menuOpen: boolean;
}

export function IssueActions({
  issue,
  closed = false,
  mayClose,
  mayAssign,
  viewerLogin = null,
  assignableLogins = null,
  heldBy,
  assignSeveral = false,
  onClosed,
  onAssigned,
  className = '',
  handleClassName = '',
  appearance = 'quiet',
  children,
}: {
  issue: ActionableIssue;
  /** The issue already reads as closed → no Close item and no ⋮ handle
   *  (right-click still reaches the read-only actions). */
  closed?: boolean;
  /**
   * Whether this menu may offer the close write — the caller's composed answer,
   * required and undefaulted (#653). A read-only mirror passes a flat `false`;
   * every surface that does close passes `mayCloseIssue(me)`, resolved once by
   * the container that owns the rows rather than once per row.
   *
   * Withheld, the item is absent rather than dead — `issue-actions.ts` sets out
   * why this menu answers that differently from the issue panel's rows.
   */
  mayClose: boolean;
  /**
   * Whether this menu may offer the two assign writes — the caller's composed
   * answer, required and undefaulted for exactly the reason `mayClose` is.
   *
   * A surface lights the pair by passing `mayAssignIssue(me)` here (resolved once
   * by the container that owns the rows, never once per row) together with
   * `viewerLogin={me?.githubLogin}`. A surface where handing an issue over is not
   * this page's business passes a flat `false` and says why.
   */
  mayAssign: boolean;
  /**
   * The reader's Github login (`me.githubLogin`) — what `Assign to me` writes.
   * Null, and that item alone is withheld: there is no handle to PATCH, and
   * `Assign to…`, which asks who, still works. Defaulting to null is the safe
   * direction, since saying nothing withholds rather than offers.
   */
  viewerLogin?: string | null;
  /**
   * Who this issue's repo will assign, resolved once by the container that owns
   * the rows (#752) — never once per row, which would be a read per issue on a
   * list.
   *
   * This is the gate on `Assign to me`, and `issue-actions.ts` has the whole
   * argument: one press, no confirm, and a route that answers 200 having
   * dropped a login the repo will not take. Null defaults to WITHHELD, which is
   * also what a surface that has not read the list says, and is the direction
   * #635 exists to keep.
   */
  assignableLogins?: string[] | null;
  /**
   * Who holds the issue right now, where the surface knows — so a one-press
   * assign can name the person it took it from (#752). `ActionableIssue` carries
   * no assignees; the Feedback block is already drawing them one column left of
   * the ⋮ and passes what it draws.
   */
  heldBy?: readonly string[];
  /** `Assign to…` edits the issue's whole assignee set, up to Github's cap,
   *  rather than handing it to one person (#1009) — see `AssignIssueDialog`'s
   *  `several`. For a surface that redraws its assignees from `onAssigned`. */
  assignSeveral?: boolean;
  /** Fired after a confirmed close, so the caller can reflect the new state. */
  onClosed?: () => void;
  /** Fired after an assignment with the set Github ACCEPTED — which is not
   *  always the one that was sent, see `AssignIssueDialog`. */
  onAssigned?: (logins: string[]) => void;
  /** Classes for the wrapper — the right-click target and the hover group. */
  className?: string;
  /** Classes that place the ⋮ within the wrapper (reserved cell, or absolute). */
  handleClassName?: string;
  appearance?: HandleAppearance;
  children: ReactNode | ((state: IssueActionsState) => ReactNode);
}) {
  // The ⋯ handle, so the assign picker can put the reader back on it. Radix
  // cannot: this menu has unmounted and dropped focus by the time the dialog
  // mounts a frame later, so the focus scope captures `<body>` and restores
  // `<body>` (#1077 review, S3). The handle stays drawn and reachable behind the
  // dialog, and focusing it reveals it — `action-handle.ts`'s `REVEAL` answers
  // `focus-visible` as well as hover.
  const assignTrigger = useRef<HTMLButtonElement>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignRaised, setAssignRaised] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [closedHere, setClosedHere] = useState(false);
  const isClosed = closed || closedHere;
  const target = closeTargetOf(issue);

  // `Assign to me` writes without a dialog — one press, and nothing to dismiss
  // afterwards. It is the picker's write all the same, built by the picker's own
  // hook so the two cannot drift apart.
  const assignEffects = useAssignEffects({ assigned: onAssigned, dismiss: () => {} });

  // ONE gate for both paths (#752). `Assign to me` had no busy guard at all
  // while the picker had its own, so pressing the item and then picking somebody
  // in `Assign to…` put two PATCHes on the wire and `onAssigned` landed in
  // arrival order rather than request order. Two separate flags is that bug
  // written twice, so the gate is made here and handed to the picker.
  const gate = useRef<AssignGate>(undefined);
  if (!gate.current) gate.current = assignGate();
  const writing = gate.current;

  const effects: IssueActionEffects = {
    openExternal: (url) => { window.open(url, '_blank', 'noopener'); },
    copy: (text, confirm) => { void copyToClipboard(text, confirm); },
    // Let the menu finish closing before the alert takes the focus trap.
    requestClose: () => requestAnimationFrame(() => setCloseOpen(true)),
    // `target` is non-null wherever the item was offered — both share the guard
    // that resolves it — so this is the impossible branch, not a silent refusal.
    assignSelf: (login) => {
      if (!target || !writing.begin()) return;
      void runAssign(target, login, assignEffects, heldBy).finally(() => writing.end());
    },
    requestAssign: () => requestAnimationFrame(() => { setAssignRaised(true); setAssignOpen(true); }),
  };
  const options: IssueActionOptions = { closed: isClosed, mayClose, mayAssign, viewerLogin, assignableLogins };
  const items = issueActionItems(issue, options, effects);
  // The picker is mounted only where the menu can actually raise it (#752), and
  // only once it has been (#1009). It was gated on `target` alone, so every row
  // of the org queue carried an unreachable Radix dialog root plus its state and
  // effects; since #1009 the list and the board offer assign on every row, so
  // it waits for the first `Assign to…` and then stays for the row's life.
  const offersAssign = canOfferAssign(issue, options);

  const content = typeof children === 'function' ? children({ menuOpen }) : children;

  return (
    <>
      <ActionMenu
        items={items}
        handle={!isClosed}
        handleLabel="Issue actions"
        handleRef={assignTrigger}
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
        className={className}
        handleClassName={handleClassName}
        appearance={appearance}
      >
        {content}
      </ActionMenu>
      {target && offersAssign && assignRaised && (
        <AssignIssueDialog
          target={target}
          open={assignOpen}
          onOpenChange={setAssignOpen}
          trigger={assignTrigger}
          onAssigned={onAssigned}
          heldBy={heldBy}
          gate={writing}
          several={assignSeveral}
        />
      )}
      {target && (
        <CloseIssueAlert
          target={target}
          open={closeOpen}
          onOpenChange={setCloseOpen}
          onClosed={() => { setClosedHere(true); onClosed?.(); }}
        />
      )}
    </>
  );
}

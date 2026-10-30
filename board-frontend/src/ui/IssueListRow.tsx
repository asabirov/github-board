/**
 * The ONE shared issue list-row (#315) — the arrangement every flat list of
 * issues on this board is built to. Columns: title + `repo#id`, assignee
 * avatar(s), days open.
 *
 * NOTHING IN PRODUCTION MOUNTS IT AS OF #815. It was the "Oldest open" block's
 * row on Home and Unit, and that block came off the board; the oldest issue is
 * the flow strip's third tile now, which draws one issue rather than a list.
 * What still reads this file is `issue-age.spec.ts`, which pins the shared age
 * tone against the private `ageClass` this row used to own. Deleting it is a
 * separate call from #815's and has not been made.
 *
 * The day count is plain text — never bold (the old bold weight was the drift
 * #315 removes). Age carries the only colour, and only once it's genuinely old:
 * muted amber past 60 days, red past 90 — thresholds this row shares with the
 * issues list since #822, and no longer owns. Assignees ride as the shared
 * `AssigneeCluster` (dashed placeholder when unassigned); omit the `assignees`
 * prop entirely on personal scope, where every row is you and an avatar is noise.
 * The whole row is one clickable target into the in-board issue page, and since
 * #446 it also carries the shared issue actions — right-click anywhere on the
 * row, or the ⋮ parked in the block's right padding.
 */

import { AssigneeCluster } from './AssigneeCluster';
import { IssueActions } from './IssueActions';
import { ageToneClass } from './issue-age';
import { gotoPath, issuePathFromUrl } from '../route';

/** This block's cold rows rest a step brighter than the issues list's, so the
 *  resting class travels with the call rather than living in the shared module. */
const AGE_RESTING = 'text-dim';

// The row stays one clickable target, so the ⋮ can't live inside the anchor — it's
// absolutely placed, and nothing is reserved for it in the flow, so the row's
// resting geometry is untouched (#446).
//
// It parks in the block's padding rather than on top of the row: the "Oldest open"
// block padded 18px, the row's own right padding is 10px, so `-right-[14px]` lands
// the 24px handle flush against the age column's right edge with 4px still clear
// of the block. The day count therefore stays readable while you reach for the
// menu — it must never fade on hover (that trick is the board card's, where the
// avatar genuinely has nowhere else to go).
//
// `min-w-0` on the link is what makes the title's `truncate` fire (#508). A flex
// item's automatic minimum size is its min-content width, and the link's
// min-content is the whole nowrap title — so without it the link cannot shrink to
// the row, and on a 390px phone it ran ~197px past the block's right edge, where
// `.shell-main{overflow-x:clip}` (#329) cut it mid-word instead of scrolling. The
// rule is the pair: a box told to take the leftover room (`flex-1`) must also be
// told it may give room back (`min-w-0`).
const ROW = 'flex items-center rounded-[9px] hover:bg-elevated';
const ROW_LINK =
  'flex min-w-0 flex-1 items-center gap-[14px] rounded-[9px] px-2.5 py-[9px] no-underline';
const ROW_HANDLE = 'absolute -right-[14px] top-1/2 -translate-y-1/2';
const AGE = 'w-[62px] flex-none text-right text-[12.5px] tabular-nums';

export interface IssueRowData {
  repo: string;
  number: number;
  title: string;
  ageDays: number;
  htmlUrl: string;
}

export function IssueListRow({
  row,
  assignees,
  mayClose,
}: {
  row: IssueRowData;
  /** GitHub assignee logins. Provided → the avatar column shows (org scope);
   *  omitted → no avatar column (personal scope). Empty array → dashed placeholder. */
  assignees?: string[];
  /** Whether this session may close an issue (#653). Required and undefaulted:
   *  the row is mounted in a loop, so the container that owns the loop resolves
   *  the session once and hands the answer down. `IssueActions.spec.ts` names
   *  the containers that owe this. */
  mayClose: boolean;
}) {
  const path = issuePathFromUrl(row.htmlUrl);
  return (
    // `mayAssign={false}` (#751): nobody has asked the session whether it may
    // assign, and a menu must never answer that question on the session's
    // behalf — an assumed yes is #635, which is why the prop is required and
    // undefaulted. `mayClose` arrives here already resolved, once per block, by
    // whichever container owns the loop; the assign verdict has no such answer
    // to arrive with, so the honest one is no.
    //
    // What lights it: a container resolving `mayAssignIssue(me)` and
    // `me?.githubLogin` beside the close verdict it already resolves, and this
    // row taking both as props and passing them through. `flow-strip/OldestTile`
    // is in the same position for the same reason.
    <IssueActions issue={row} mayClose={mayClose} mayAssign={false} className={ROW} handleClassName={ROW_HANDLE}>
      <a href={path} onClick={(e) => { e.preventDefault(); gotoPath(path); }} className={ROW_LINK}>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] text-fg" title={row.title}>{row.title}</span>
          <span className="mt-[3px] block text-[11.5px] tabular-nums text-muted">
            {row.repo}#{row.number}
          </span>
        </span>
        {assignees !== undefined && <AssigneeCluster logins={assignees} />}
        <span className={`${AGE} ${ageToneClass(row.ageDays, AGE_RESTING)}`}>
          {row.ageDays} {row.ageDays === 1 ? 'day' : 'days'}
        </span>
      </a>
    </IssueActions>
  );
}

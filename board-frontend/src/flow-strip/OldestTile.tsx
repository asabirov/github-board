/**
 * The third tile of the flow strip (#816): the oldest still-open issue, stated
 * as its age.
 *
 * It took the slot "Released yesterday" held. That tile counted a day's releases,
 * which on this board is 0 on most days, and a reader could do nothing with the
 * number either way. This one names something with an owner and an action on it.
 *
 * IT IS NOT THE SHAPE OF ITS TWO NEIGHBOURS and must not be pushed into it.
 * "Issues" and "Closed" are counts over many things, so a caption, a figure and a
 * shape are the whole of what they can say. This is one thing, so it carries the
 * thing's title, who holds it, and the same action menu every issue row on this
 * board carries. Three tiles in a row that all look alike would say the third is
 * a third count, which is the one thing it is not.
 *
 * IT IS ALSO THE ONE PART OF THE STRIP THAT KNOWS THERE IS A SESSION. `FlowStrip`
 * fetches nothing and knows no login, and that promise is worth keeping for the
 * two tiles and the lattice it covers; the action menu cannot be drawn without
 * asking what this session may write, so the asking lives down here in its own
 * file rather than being pushed up into the strip or out onto every caller.
 */
import { Placeholder } from '../ui/LoadingStructure';
import { AssigneeCluster } from '../ui/AssigneeCluster';
import { IssueActions, mayCloseIssue } from '../ui/IssueActions';
import { ageToneClass } from '../ui/issue-age';
import { useMe } from '../use-me';
import { gotoPath, issuePathFromUrl } from '../route';
import type { OldestView } from './flow-strip.vm';
import { BLOCK, CARD_PADDING } from '../ui/block';

/** The tile's own surface, matching the two beside it. `relative` is what the ⋮
 *  is placed against, and `group` is what reveals it on hover; both come from
 *  `ActionMenu`'s wrapper, which is why the wrapper IS the tile here rather than
 *  a box inside it.
 *
 *  It said it matched them and was `py-[13px]` against their 16px, so its
 *  caption sat 3px above theirs on the same row (#944). It stretches to the
 *  row like them, so the three cards end on one line (#1450). */
const SHELL = `flex min-w-0 flex-col ${BLOCK} ${CARD_PADDING}`;

/** Parked level with the caption in the tile's own right padding, the way
 *  `IssueListRow` parks it in the block's. Absolutely placed, so nothing in the
 *  flow moves when it appears. 3px under where it was, with the caption. */
const HANDLE = 'absolute right-2 top-[14px]';

const CAP = 'text-[11.5px] text-dim';
/** The figure, in the strip's own headline slot minus its colour: `ageToneClass`
 *  supplies that, because an age is the one figure on this row that means
 *  something by being large. `text-fg` is what a young one rests at,
 *  which is where the two neighbours' figures sit permanently. */
const BIG = 'text-[27px] font-semibold leading-none tracking-[-0.02em] tabular-nums';
const BIG_RESTING = 'text-fg';
const UNIT = 'text-[11px] tabular-nums text-muted';
const NOTE = 'text-[11px] leading-[1.4] text-muted';

function Cap({ note, pending }: { note?: string; pending?: boolean }) {
  return (
    // `leading-none` on the note, for the reason `FlowStrip.tsx`'s `Tile` gives.
    <div className="flex items-baseline gap-2 [&>span+span]:leading-none">
      <span className={CAP}>The oldest</span>
      {note && <span className={UNIT}>{note}</span>}
      {pending !== undefined && <span role="status" aria-label={pending ? 'Loading the oldest open issue' : 'The oldest open issue couldn’t be read just now.'} className={UNIT}>{pending ? 'Loading' : 'Unavailable'}</span>}
    </div>
  );
}

export function OldestTile({ view, note, pending = false }: {
  view: OldestView;
  pending?: boolean;
  /** Said beside the caption when the issue is from a copy (#1046). */
  note?: string;
}) {
  // Resolved once, here, and not inside anything that renders in a loop: this
  // tile draws one issue, so one `/api/auth/me` is one request. The row
  // containers do the same for the same reason (`IssueActions.spec.ts` holds it).
  const { me } = useMe();

  if (view.kind === 'unread') {
    return (
      <div className={SHELL} aria-busy={pending}>
        <Cap pending={pending} />
        <div aria-hidden="true">
          <Placeholder still={!pending} className="mt-2 h-[27px] w-16 bg-elevated" />
          <Placeholder still={!pending} className="mt-4 h-[1.35em] w-3/4 text-[13.5px] bg-elevated" />
          <div className="mt-1.5 flex items-center gap-2">
            <Placeholder still={!pending} className="size-5 rounded-full bg-elevated" />
            <Placeholder still={!pending} className="h-3 w-24 bg-elevated" />
          </div>
        </div>
      </div>
    );
  }

  if (view.kind === 'none') {
    return (
      <div className={SHELL}>
        <Cap note={note} />
        <div className={`mt-2 ${NOTE}`}>Nothing open.</div>
      </div>
    );
  }

  const issue = view.issue;
  const path = issuePathFromUrl(issue.htmlUrl);
  return (
    // `mayAssign={false}` for `IssueListRow`'s reason (#751): nobody has asked
    // this session whether it may assign, and a menu must never answer that on
    // the session's behalf. What lights it here is the same thing that would
    // light it there, and neither surface has it yet.
    <IssueActions issue={issue} mayClose={mayCloseIssue(me)} mayAssign={false} className={SHELL} handleClassName={HANDLE}>
      <Cap note={note} />
      {/* The age is the figure, in the same 27px slot the two neighbours state
          their counts in, so the three still scan as one row of readings. The
          unit rides beside it rather than in the caption: "The oldest" is a
          superlative and not a unit, so unlike "Issues" it cannot carry one. */}
      <div className="mt-2 flex h-[27px] items-baseline gap-2.5">
        <span className={`${BIG} ${ageToneClass(issue.ageDays, BIG_RESTING)}`}>{issue.ageDays}</span>
        <span className={UNIT}>{issue.ageDays === 1 ? 'day' : 'days'}</span>
      </div>
      {/* `min-w-0` is what makes `truncate` fire (#508): a flex item told to take
          the leftover room must also be told it may give room back, or its
          min-content width is the whole nowrap title and it runs past the tile. */}
      <a
        href={path}
        onClick={(e) => { e.preventDefault(); gotoPath(path); }}
        className="mt-4 block min-w-0 truncate text-[13.5px] leading-[1.35] text-fg text-link"
        title={issue.title}
      >
        {issue.title}
      </a>
      <div className="mt-1.5 flex items-center gap-2">
        <AssigneeCluster logins={issue.assignees} />
        <span className="min-w-0 truncate text-[11.5px] tabular-nums text-muted">
          {issue.repo}#{issue.number}
        </span>
      </div>
    </IssueActions>
  );
}

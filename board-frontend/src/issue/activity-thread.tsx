import type { Actor, IssueActivity, IssueActivityEvent, IssueComment } from '../api/issues';
import { Person } from './atoms';
import { threadOrder } from './comment-composer';

type ThreadRow =
  | { kind: 'event'; key: string; event: IssueActivityEvent }
  | { kind: 'comment'; key: string; comment: IssueComment }
  | { kind: 'gap'; key: string };
const time = (iso: string) => Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : Infinity;

/** Same-time events retain Github's page order, then comments retain their
 * read order. No timestamp is invented for an event that has lost its date. */
export function activityOrder(
  comments: readonly IssueComment[], events: readonly IssueActivityEvent[], truncated: boolean, postedHere: number,
): ThreadRow[] {
  const seen = new Set<string>();
  const activity: ThreadRow[] = events.filter(e => {
    if (!Number.isFinite(time(e.createdAt)) || seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  }).map(event => ({kind:'event', key:`event-${event.id}`, event}));
  const commentRows = (items: readonly IssueComment[], offset = 0): ThreadRow[] => items.map((comment,i) => ({
    kind:'comment', key:`comment-${comment.htmlUrl ?? comment.createdAt}-${offset+i}`, comment,
  }));
  const stamp = (row: ThreadRow) => row.kind === 'event' ? time(row.event.createdAt) : row.kind === 'comment' ? time(row.comment.createdAt) : Infinity;
  const sort = (rows: ThreadRow[]) => rows.sort((a,b) => stamp(a)-stamp(b));
  if (!truncated) return sort([...activity, ...commentRows(comments)]);
  const {before,after} = threadOrder(comments, truncated, postedHere);
  const cut = before.length ? Math.max(...before.map(c=>time(c.createdAt))) : -Infinity;
  return [
    ...sort([...activity.filter(e=>stamp(e)<=cut), ...commentRows(before)]),
    {kind:'gap',key:'comments-gap'},
    ...sort([...activity.filter(e=>stamp(e)>cut), ...commentRows(after,before.length)]),
  ];
}

const safeGithubLink = (url: string) => /^https:\/\/github\.com\/[a-z\d][a-z\d-]*\/(?!\.{1,2}\/)[a-z\d_.-]+\/(?:(?:issues|pull)\/[1-9]\d*|commit\/[a-f\d]{40})$/i.test(url);
const action: Record<IssueActivityEvent['kind'], string> = {
  labeled: 'added label', unlabeled: 'removed label', assigned: 'assigned', unassigned: 'unassigned',
  milestoned: 'added to milestone', demilestoned: 'removed from milestone',
  closed: 'closed this', reopened: 'reopened this', 'cross-referenced': 'mentioned this', referenced: 'referenced this in a commit',
};

export function ActivityEvent({event, name}: {event: IssueActivityEvent; name: (p: Actor | null) => string}) {
  if (!Object.hasOwn(action,event.kind)) return null;
  const target = event.kind === 'labeled' || event.kind === 'unlabeled' ? event.label ?? null
    : event.kind === 'assigned' || event.kind === 'unassigned' ? event.assignee ?? null
    : event.kind === 'milestoned' || event.kind === 'demilestoned' ? event.milestone ?? null : null;
  const missing: Partial<Record<IssueActivityEvent['kind'], string>> = {
    labeled: 'added a label', unlabeled: 'removed a label', assigned: 'assigned someone', unassigned: 'unassigned someone',
    milestoned: 'added to a milestone', demilestoned: 'removed from a milestone',
  };
  const verb = target ? action[event.kind] : missing[event.kind] ?? action[event.kind];
  const actor = event.actor && /^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i.test(event.actor.login) ? event.actor : null;
  const validDate = Number.isFinite(time(event.createdAt));
  return (
    <div className="iss-event flex-wrap" data-activity-id={event.id}>
      <span className="font-medium text-dim"><Person login={actor?.login ?? null} name={actor ? name(actor) : 'Someone'} avatar={null} /></span>
      <span className="min-w-0 break-words">{verb}{target && <> <span className="text-dim">{target}</span></>}</span>
      {event.reference && safeGithubLink(event.reference.url) && (
        <a href={event.reference.url} target="_blank" rel="noopener noreferrer" className="min-w-0 break-all text-accent text-link">{event.reference.label}</a>
      )}
      {validDate && <time className="text-[12px] tabular-nums" dateTime={event.createdAt} title={event.createdAt}>
        {new Date(event.createdAt).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})}
      </time>}
    </div>
  );
}

export function ActivityNotice({activity, url}: {activity?: IssueActivity; url: string}) {
  if (activity?.state === 'read') return null;
  return <div className="mb-5 text-[13px] text-muted" role="status">
    {activity?.state === 'partial' ? 'Some activity is missing.' : "Activity couldn’t be read."}{' '}
    {safeGithubLink(url) && <a href={url} target="_blank" rel="noopener noreferrer" className="text-accent text-link">View activity on GitHub</a>}
  </div>;
}

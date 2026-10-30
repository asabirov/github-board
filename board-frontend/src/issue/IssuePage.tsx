import { EditableText } from './EditableText';
import { useBoardRead } from '../cache/use-board-read';
import { patchIssueResponse } from './held-issue';
import { copyResponseDeadline } from '../auth/response-deadline';
/**
 * The issue body, linked PRs and a chronological activity/comment thread.
 * Comment cards keep the shared author links, markdown and native composer;
 * undated linked PRs remain a separate section above the activity spine.
 */
import { useEffect, useRef, useState } from 'react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../ui/kit';
import { type IssueComment, type IssueDetail, type LinkedPr, type Actor, toggleIssueTask } from '../api/issues';
import { setTaskChecked } from './body-tasks';
import { type RepoRef } from './github-refs';
import { IssueRef } from '../route';
import { resolvePerson, usePeople } from '../people-ctx';
import { mayWrite, useMe } from '../use-me';
import { useReportCrumbTitle } from '../crumb-title';
import { useAccessEpoch } from '../sync/sync-status';
import { PageCrumb } from '../PageCrumb';
import { PageHeading, PAGE_RAIL, PAGE_READING, H1_NUMBER_LINK } from '../ui/PageHeading';
import { Avatar } from '../ui/avatar';
import { copyToClipboard } from '../ui/clipboard';
import { BLOCK as CARD } from '../ui/block';
import { ISSUE_GRID, IssueLoading } from './IssueLoading';
import { CommentHeader, COMMENT_HEADER_ASIDE, COMMENT_PROSE, Person } from './atoms';
import { ISSUE_CAP, StatePill, issuePageVerdict } from './facet-editors';
import { PropertiesPanel } from './PropertiesPanel';
import { RelationsPanel } from './RelationsPanel';
import { Markdown, type ToggleTask } from './markdown';
import { activityOrder, ActivityEvent, ActivityNotice } from './activity-thread';
import { CommentComposer } from './CommentComposer';
import { postedPatch, type IssueName } from './comment-composer';

/** Coarse "6 days ago" / "3h ago" from an ISO time — matches the app's other
 *  relative stamps; exact-to-the-second would read as noise on a mirror. */
function rel(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} ${d === 1 ? 'day' : 'days'} ago`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
}

/** A relative timestamp that deep-links to its source on Github (#383) — the
 *  opening post links to the issue, each comment to its `#issuecomment-…`
 *  permalink. Stays muted so it still reads as a timestamp, underlined on hover and focus
 *  like the author links; falls back to a plain span when there's no url so it
 *  never renders a dead link. Opens on Github in a new tab. */
function TimeLink({ href, iso, className }: { href: string | null; iso: string; className?: string }) {
  const cls = `tabular-nums${className ? ` ${className}` : ''}`;
  if (!href) return <span className={cls}>{rel(iso)}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${cls} hover:text-fg text-link`}
    >
      {rel(iso)}
    </a>
  );
}

function useName() {
  const people = usePeople();
  return (p: Actor | null): string => {
    if (!p) return 'unknown';
    return resolvePerson(people, p.login, null)?.displayName ?? p.name ?? p.login;
  };
}

const MoreIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="size-4 flex-none" aria-hidden="true">
    <path d="M4 8a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm5.25 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM13.25 9.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z" />
  </svg>
);

// A quiet overflow trigger (#384): no border, no caret, no label — just a muted
// ⋯ glyph that fills on hover. It sits at the far end of the properties column's
// leading line, off the title band, so it never crowds the H1.
const ACTIONS_TRIGGER =
  'flex size-8 flex-none cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-dim';

/** The one issue-actions control (#340): Copy link and Open on GitHub, behind a
 *  single quiet overflow menu. It used to carry "Close issue…" too, but #423
 *  made the state pill next to it the state control — two ways to close the same
 *  issue 30px apart, one confirming and one not, was the worse answer. Closing
 *  now goes through the pill, like every other editable facet. Nothing in here
 *  writes. */
function ActionsMenu({ issue }: { issue: IssueDetail }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Issue actions" className={ACTIONS_TRIGGER}>
          <MoreIcon />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => copyToClipboard(issue.htmlUrl, 'Copied issue link')}>
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.open(issue.htmlUrl, '_blank', 'noopener')}>
          Open on GitHub
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The opening post keeps the author above a theme-aware reading surface.
 *  The timestamp deep-links to the issue on Github. */
function OpeningPost({ issue, name, onToggleTask, onSaved, canEdit }: {
  onSaved(body: string): void; canEdit: boolean;
  issue: IssueDetail; name: (p: Actor | null) => string; onToggleTask?: ToggleTask;
}) {
  return (
    <EditableText issue={issue} body={issue.bodyMarkdown} canEdit={canEdit && issue.viewerCanUpdate} onSaved={onSaved}>{(control, editor) => <div className="mt-4">
      <div className="flex items-center gap-1.5 text-[13px] text-muted">
        <span className="font-medium text-dim">
          <Person
            login={issue.author?.login ?? null}
            name={name(issue.author)}
            avatar={<Avatar name={name(issue.author)} login={issue.author?.login ?? null} px={40} className="pj-av-xs" />}
          />
        </span>
        <span>opened <TimeLink href={issue.htmlUrl} iso={issue.createdAt} />{control}</span>
      </div>
      {editor || <div className="pj-md mt-4 rounded-lg bg-surface p-4">
        {issue.bodyMarkdown.trim() ? <Markdown here={issue} onToggleTask={onToggleTask}>{issue.bodyMarkdown}</Markdown>
          : <p className="italic text-muted">No description.</p>}
      </div>}
    </div>}</EditableText>
  );
}

/** One comment card hung on the rail by its author's avatar. */
function Node({ author, iso, href, body, here, name, commentId, canEdit, onSaved }: {
  author: Actor | null; iso: string; href: string | null; body: string; here: IssueDetail;
  commentId?: number; canEdit?: boolean; onSaved(body: string): void;
  name: (p: Actor | null) => string;
}) {
  return (
    <EditableText issue={here} body={body} commentId={commentId} canEdit={canEdit && commentId !== undefined} onSaved={onSaved}>{(control, editor) => <div className="iss-node">
      <Avatar name={name(author)} login={author?.login ?? null} px={64} />
      <div className={CARD}>
        {/* Header, divider and prose inset all live in `atoms.tsx`, because the
            composer's preview draws the same card and its whole job is to be
            this one before it posts (#693 design review 3). */}
        <CommentHeader aside={<span className={COMMENT_HEADER_ASIDE}><TimeLink href={href} iso={iso} />{control}</span>}>
          <Person login={author?.login ?? null} name={name(author)} avatar={null} />
        </CommentHeader>
        {editor || <div className={`${COMMENT_PROSE} pb-5`}>
          {body.trim() ? <Markdown here={here}>{body}</Markdown>
            : <p className="italic text-muted">No description.</p>}
        </div>}
      </div>
    </div>}</EditableText>
  );
}

const PR_LABEL: Record<LinkedPr['state'], string> = { open: 'Open', closed: 'Closed', merged: 'Merged' };

function LinkedPrEvent({ pr }: { pr: LinkedPr }) {
  return (
    <div className="iss-event">
      Linked{' '}
      <a href={pr.url} target="_blank" rel="noreferrer" className="tabular-nums text-accent text-link">#{pr.number}</a>
      <span className="min-w-0 truncate text-dim">{pr.title}</span>
      <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-semibold text-dim">{PR_LABEL[pr.state]}</span>
    </div>
  );
}

// The outer column is the shared app rail (#390) — the same centered max-width and
// inset every list page uses, so the breadcrumb + H1 band keeps one stable left
// origin across page types and never jumps navigating list ↔ issue. The reading
// column below is left-aligned to that rail (not re-centered), so the issue prose
// keeps its narrower measure while sharing the rail's exact left edge.
const RAIL = `${PAGE_RAIL} pb-24 pt-8 max-[900px]:pt-4`;
const READING = PAGE_READING;

// The H1's #number deep-links to the issue on Github (#425), matching TimeLink's
// muted treatment: stays text-tertiary at rest, no ↗ glyph, underlines on hover.
// The class itself lives beside PAGE_H1 in ui/PageHeading, because a project
// board's header now says its id the same way (#510).

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className={RAIL}>
      <div className={`${READING} text-[14px] text-muted`}>
        {/* The breadcrumb is route-derived, so it shows even before the issue loads. */}
        <PageCrumb />
        {children}
      </div>
    </div>
  );
}

export function IssuePage({ issueRef }: { issueRef: IssueRef }) {
  const { owner, repo, number } = issueRef;
  const { data: issue, setData: setIssue, error, dataUpdatedAt } = useBoardRead<IssueDetail>(`/api/issues/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`);
  const status = error ? (error as { status?: number }).status === 404 ? 'not-found' : 'error' : 'loading';
  const name = useName();
  // Every control on this page asks about its OWN write (#635), by the `ISSUE_CAP`
  // name board-service's `@Writes(...)` gives it — never about one session-wide
  // boolean, which offered writes the board's credential had already been refused
  // and, worse, would have withheld the seven that still work. `unknown`, and a
  // key the map does not carry, both ARM the control: an unattempted capability
  // is not a refusal, and an old board-service sends no map at all.
  const { me } = useMe();
  // Owner-aware for one control: a new project is made under this issue's owner,
  // so what the board's Github App may do there decides it too (#982).
  const verdict = (capability: string) => issuePageVerdict(me, owner, capability);
  // Task 10's edit hook reflects a successful write back into the page's issue.
  const patchIssue = (next: Partial<IssueDetail>) =>
    setIssue((prev) => (prev ? copyResponseDeadline(issue, patchIssueResponse(prev, next)) : prev));
  // How many of the comments on screen were posted from this page (#693, finding
  // 10). It decides where they are DRAWN on a truncated thread, and it is reset
  // by every read that replaces the thread — a re-read has them in their real
  // place or not at all.
  const [postedHere, setPostedHere] = useState(0);
  // What is on screen RIGHT NOW, readable from a callback made on a previous
  // issue (#693, finding 7). This page is not keyed (`App.tsx`) and stays mounted
  // across issue navigation; only the composer is keyed, so a remount kills the
  // draft and not the request. The composer's own refs freeze at unmount, so
  // this is the only thing that can answer "is the page still on that issue?"
  // when a send resolves — the same rule `toggleGen` above enforces for a task
  // toggle, said as the issue's identity rather than as a counter, because a
  // pure comparison is testable in a suite with no DOM and a render-time counter
  // read is not.
  const showing = useRef<IssueDetail | null>(null);
  showing.current = issue;
  const applySaved = (sentFor: IssueDetail, bodyMarkdown: string, commentId?: number) => {
    const current = showing.current;
    if (!current || current.owner !== sentFor.owner || current.repo !== sentFor.repo || current.number !== sentFor.number) return;
    patchIssue(commentId === undefined ? { bodyMarkdown } : {
      comments: current.comments.map(comment => comment.id === commentId ? { ...comment, bodyMarkdown } : comment),
    });
  };
  const appendPosted = (comment: IssueComment, sentFor: IssueName) => {
    const patch = postedPatch(sentFor, showing.current, comment);
    if (!patch) return; // the page moved on; the comment is on Github, not here
    patchIssue(patch);
    setPostedHere((n) => n + 1);
  };
  // Body task-list checkbox toggle (#426): show the flip at once (optimistic), then
  // write it to Github and RECONCILE the body to the server's echoed markdown (B2) —
  // rolling back to the pre-click body if the write fails. Addressed by source LINE
  // (from the renderer's node), so the right box flips even among byte-identical
  // lines and never disagrees with the render.
  //
  // I2 — a per-issue request generation guards against out-of-order responses: only
  // the LATEST toggle's outcome may touch the body, so a slow earlier response (or a
  // failed earlier toggle's rollback) can't clobber a newer optimistic flip. The
  // generation resets when the issue identity changes (see the load effect below).
  const toggleGen = useRef(0);
  const toggleTask: ToggleTask = (line, checked) => {
    if (!issue) return;
    const prevBody = issue.bodyMarkdown;
    const gen = ++toggleGen.current;
    patchIssue({ bodyMarkdown: setTaskChecked(prevBody, line, checked) });
    toggleIssueTask(owner, repo, number, line, checked).then(
      ({ bodyMarkdown }) => { if (gen === toggleGen.current) patchIssue({ bodyMarkdown }); },
      () => { if (gen === toggleGen.current) patchIssue({ bodyMarkdown: prevBody }); },
    );
  };
  // Surface the loaded title to the shared crumb-title context (#288); null while
  // loading. The issue crumb itself is route-derived (Projects → owner/repo →
  // #number, #382), so the title's rendered home is the page heading below — but
  // the reporting stays wired so the mechanism is intact and available.
  useReportCrumbTitle(issue?.title ?? null);

  const accessEpoch = useAccessEpoch();
  useEffect(() => {
    toggleGen.current += 1;
    setPostedHere(0);
  }, [owner, repo, number, accessEpoch, dataUpdatedAt]);

  const ghUrl = `https://github.com/${owner}/${repo}/issues/${number}`;
  // Where the thread's two runs are cut (#693, finding 10) — everything the board
  // read, then the truncation line, then whatever was posted from this page.
  const thread = activityOrder(issue?.comments ?? [], issue?.activity?.events ?? [], issue?.commentsTruncated ?? false, postedHere);

  if (!issue) {
    if (status === 'loading') return <div className={RAIL}><PageCrumb /><IssueLoading /></div>;
    if (status === 'not-found') {
      return (
        <Page>
          <div className={`${CARD} p-6 text-[14px] text-dim`}>
            <div className="mb-1.5 text-fg">Issue not found</div>
            <p>Couldn’t find <span className="tabular-nums">{owner}/{repo} #{number}</span>. It may be in a repo the board doesn’t mirror, or it doesn’t exist. <a href={ghUrl} target="_blank" rel="noreferrer" className="text-accent text-link">Try it on GitHub</a>.</p>
          </div>
        </Page>
      );
    }
    return (
      <Page>
        <div className={`${CARD} p-6 text-[14px] text-dim`}>
          Couldn’t load this issue right now. <a href={ghUrl} target="_blank" rel="noreferrer" className="text-accent text-link">Open it on GitHub</a>.
        </div>
      </Page>
    );
  }

  return (
    <div className={RAIL}>
      {/* The crumb slot (#382, #664) — spans the rail above the two columns.
          Projects → the source board when the issue was opened from one, else a
          quiet back control, else nothing. */}
      <PageCrumb />
      {/* Two columns (#384): the reading spine left, the borderless properties
          panel (variant 2B) right at a fixed 264px; stacks to one column below
          `lg` so the panel drops under the thread on narrow screens. The gutter
          is kept tight so the columns read as one page, not two islands. */}
      <div className={ISSUE_GRID}>
        <div className="min-w-0">
          {/* The canonical page H1 (#391), with the muted issue number inline
              (2B). The issue-actions menu no longer shares this band — it moved to
              the top of the properties column so it never crowds the title. */}
          <PageHeading className="mb-[22px]">
            {issue.title}{' '}
            <a href={ghUrl} target="_blank" rel="noopener noreferrer" className={H1_NUMBER_LINK}>
              #{issue.number}
            </a>
          </PageHeading>

          {/* The body's task checkboxes (#426) are withdrawn SILENTLY when
              `issue.body.task` is refused — they fall back to the disabled boxes
              every reader sees, and nothing is written into the body to explain
              it. V4 puts the reason under the value because the row's label
              column names the subject; a checkbox in prose has no such column,
              and REFUSED_REASON names no subject on purpose, so a note beside
              the body would read as being about the description rather than
              about the box. See `WithheldRow` for the same call on the other
              three non-row controls. */}
          <OpeningPost
            key={`${issue.owner}/${issue.repo}/${issue.number}`}
            issue={issue}
            canEdit={mayWrite(me, ISSUE_CAP.comment)}
            onSaved={body => applySaved(issue, body)}
            name={name}
            onToggleTask={mayWrite(me, ISSUE_CAP.bodyTask) ? toggleTask : undefined}
          />

          {/* The issue's relations (#469) — parent, sub-issues, blockers — sit
              between the opening post and the thread: they belong to the issue
              as filed, not to the conversation about it, and at this measure a
              sub-issue title fits whole. Renders nothing when there are none, so
              an issue that stands alone reads exactly as it did before. */}
          <RelationsPanel issue={issue} layout="wide" className="mt-6" />

          {issue.linkedPrs.length > 0 && <div className="mt-6">
            <h2 className="mb-3 text-[13px] font-medium text-dim">Linked pull requests</h2>
            {issue.linkedPrs.map((pr) => <LinkedPrEvent key={pr.number} pr={pr} />)}
          </div>}
          <h2 className="mb-4 mt-6 text-[14px] font-semibold text-fg">Activity</h2>
          <ActivityNotice activity={issue.activity} url={issue.htmlUrl} />
          <div className="iss-spine mt-6">
            {thread.map(row => row.kind === 'event' ? (
              <ActivityEvent key={row.key} event={row.event} name={name} />
            ) : row.kind === 'comment' ? (
              <Node commentId={row.comment.id} canEdit={mayWrite(me, ISSUE_CAP.comment) && row.comment.viewerCanUpdate} onSaved={body => applySaved(issue, body, row.comment.id)} key={`${issue.owner}/${issue.repo}/${issue.number}/${row.key}`} author={row.comment.author} iso={row.comment.createdAt} href={row.comment.htmlUrl} body={row.comment.bodyMarkdown} here={issue} name={name} />
            ) : (
              <div key={row.key} className="iss-event">
                <a href={issue.htmlUrl} target="_blank" rel="noreferrer" className="text-accent text-link">
                  {issue.totalComments - issue.comments.length} more {issue.totalComments - issue.comments.length === 1 ? 'comment' : 'comments'} on GitHub
                </a>
              </div>
            ))}
            {/* Answering the issue from the board (#693) — the last node on the
                rail, so a draft hangs where the reply it becomes will. Keyed by
                the issue it is written on: this page can move to another issue
                without unmounting, and a draft must not follow it there. */}
            <CommentComposer
              key={`${issue.owner}/${issue.repo}/${issue.number}`}
              issue={issue}
              me={me}
              onPosted={appendPosted}
            />
          </div>
        </div>

        {/* The properties column tracks the reading scroll (#384): sticky under
            the app topbar so it never strands in a dead void beside a long
            thread. Its leading line carries the open/closed pill (#423) and, at
            the far end, the quiet ⋯ actions trigger — both clear of the title
            band, and the lifecycle clear of the boards' Status fields below. */}
        <div className="lg:sticky lg:top-20 lg:self-start">
          <div className="flex items-center justify-between gap-2">
            <StatePill issue={issue} armed={mayWrite(me, ISSUE_CAP.state)} onPatch={patchIssue} />
            <ActionsMenu issue={issue} />
          </div>
          <PropertiesPanel issue={issue} verdict={verdict} onPatch={patchIssue} name={name} />
        </div>
      </div>
    </div>
  );
}

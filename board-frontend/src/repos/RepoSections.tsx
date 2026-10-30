/**
 * The repo page's tab row, and the three tabs that are not Overview (#828).
 *
 * NAVIGATION, NOT A WIDGET. Each tab is an address of its own, so the row is a
 * `<nav>` of anchors with `aria-current="page"` on the one you are on. It is
 * deliberately not `role="tab"` / `aria-selected`: those describe a control that
 * swaps panels in place, and a screen reader that is told this is a tablist
 * announces a widget where a reader is about to change page. A link that is a
 * link also gets the browser's own gestures for free, and `boardLinkProps` is
 * what leaves them to it.
 *
 * ONE FETCH BEHIND ALL FOUR. Every tab draws from the `RepoPageView` the page
 * already has, so moving between them costs no request: `RepoPage`'s effect
 * depends on the owner and the name and not on which tab is open.
 *
 * Every list here says the three things apart that this page says apart
 * everywhere else — there is none of it, it could not be read, and it was not in
 * what the board was sent. `repo-tabs.ts` decides which; this file only draws.
 */
import { Avatar } from '../ui/avatar';
import type { RepoOpenIssue, RepoOpenPr, RepoPageView } from '../api/repos';
import { issueAge } from './repo-page-vm';
import { repoQueuePath } from './repo-actions';
import {
  MEMBERS_WINDOW,
  issuesTab,
  memberLine,
  membersTab,
  prsTab,
  type RepoTab,
} from './repo-tabs';
import {
  Absent,
  NOTHING,
  ROW,
  ROW_ALL,
  ROW_AGE,
  ROW_NUM,
  ROW_TITLE,
  SectionCard,
  boardLinkProps,
} from './repo-page-parts';

/**
 * The row of tabs, under the header band and inside the page rail.
 *
 * It WRAPS rather than scrolling. Four labels with their counts are about 300px
 * at this size, so at 390px they fit on one line with room to spare and a
 * three-digit count pushes the last of them onto a second line instead of out of
 * sight. A sideways-scrolling row hides whichever tab did not fit behind a
 * gesture nothing on the page advertises, and this board's phone guard measures
 * exactly that class of overflow on the two pages it visits.
 *
 * No full-width rule under it. The topbar band above already ends in a hairline,
 * and a second one 60px below reads as a second piece of app chrome rather than
 * as this page's own row; the mark under the current tab sits on its own label
 * and is the only line here.
 */
const NAV = 'mt-7 flex flex-wrap items-center gap-x-[18px] gap-y-1';
const TAB = 'inline-flex items-baseline gap-[6px] border-b-2 pb-[7px] text-[13px] leading-[1.3] no-underline transition-colors';
const TAB_ON = 'border-[var(--text)] font-[560] text-fg';
const TAB_OFF = 'border-transparent text-muted hover:text-dim';
const TAB_COUNT = 'text-[11.5px] tabular-nums text-muted';

export function RepoTabRow({ tabs }: { tabs: RepoTab[] }) {
  return (
    <nav aria-label="Repo sections" className={NAV}>
      {tabs.map((t) => (
        <a
          key={t.key}
          {...boardLinkProps(t.href)}
          // The current page is said once, in the attribute a screen reader
          // reads, and drawn once, in the mark under the label. No second
          // spelling: `aria-selected` here would describe a widget this is not.
          aria-current={t.current ? 'page' : undefined}
          className={`${TAB} ${t.current ? TAB_ON : TAB_OFF}`}
        >
          {t.label}
          {t.count !== null && <span className={TAB_COUNT}>{t.count}</span>}
        </a>
      ))}
    </nav>
  );
}

// ── Issues ───────────────────────────────────────────────────────────────────

/** One open issue. No state pill: under a block captioned "Open issues" a pill
 *  reading "Open" on every row is furniture that says nothing, and the greyed
 *  title it used to pair with had exactly one other state to mean anything
 *  against (#826). */
function IssueRow({ issue, now }: { issue: RepoOpenIssue; now: number }) {
  return (
    <div className={ROW}>
      <span className={ROW_NUM}>#{issue.number}</span>
      <a href={issue.htmlUrl} target="_blank" rel="noopener noreferrer" className={`${ROW_TITLE} text-fg`}>
        {issue.title}
      </a>
      <span className={ROW_AGE}>{issueAge(issue.createdAt, now)}</span>
    </div>
  );
}

/**
 * The whole open queue, which is what this tab took over from Overview's
 * five-row block.
 *
 * The block's count is the repo's open count and the rows are what the payload
 * carried, so where the two differ the difference is stated in words above the
 * list and offered as a way out below it. Neither of those is the cap drawn as
 * a count.
 */
export function IssuesSection({ view, now }: { view: RepoPageView; now: number }) {
  const tab = issuesTab(view);
  // `nothing` and `unreadable` draw the same furniture and never the same words
  // (#837) — the line each carries is the whole difference, and it is decided in
  // `issuesTab`, where a spec can reach it.
  if (tab.kind !== 'read') return <Absent label="Open issues" line={tab.line} />;
  const queue = repoQueuePath(view.repo.full);
  return (
    <SectionCard label="Open issues" meta={tab.meta} note={tab.capped}>
      <div className="flex flex-col">
        {tab.issues.map((i) => <IssueRow key={i.number} issue={i} now={now} />)}
        {tab.showAll && (
          <a {...boardLinkProps(queue)} className={ROW_ALL}>
            {/* The arrow is decoration; the name is the sentence. */}
            {tab.showAll} <span aria-hidden="true">→</span>
          </a>
        )}
      </div>
    </SectionCard>
  );
}

// ── Pull requests ────────────────────────────────────────────────────────────

/**
 * The quiet things a row says beside its title: who opened it, and the two
 * states that change what a reader should do about it.
 *
 * ONE class for the three, so a login, a `Bot` and a `Draft` sit at one weight
 * and one tone. None of them is louder than the title, and none is a coloured
 * pill: the issue rows next door dropped a pill that said the same word on
 * every line (#826), and a mark only earns its place when some rows carry it
 * and others do not.
 *
 * WHY THE AUTHOR IS HERE AT ALL. Measured against live Github on 2026-09-03,
 * all 8 open pull requests on acme/board.example.com are dependabot's.
 * Without the login and the tag the tab reads as eight people waiting on you,
 * where the true reading is eight dependency bumps and nobody waiting — on the
 * first repo page anybody here opens.
 *
 * A LOGIN, not a name: the payload carries no display name for a pull request's
 * author, and this page does not invent one. A null author is a ghost account,
 * which is a person nobody can name any more rather than a machine, so the row
 * says nothing rather than "unknown" and never marks it `Bot`.
 */
const PR_META = 'block truncate text-[11.5px] leading-[1.5] text-muted';
/** Each token inside that line, so a login, a `Bot` and a `Draft` are three
 *  things a reader's eye can separate rather than one run of words. Spaces
 *  between them and no dots: a `·` here would be joining facts a sentence
 *  relates. */
const PR_TAG = 'mr-[10px] last:mr-0';

/**
 * UNDER THE TITLE, NOT BESIDE IT, and that is a measurement rather than a
 * preference.
 *
 * Beside it, the login and the tags are `flex-none` and the title is the only
 * box left to shrink. Measured at 390px against the built CSS: the title of
 * dependabot's row laid out at 31.6px, "Bump vite from 7.3.5 to 7.3.6" rendered
 * as "Bu…", while "dependabot Bot" took its full width beside it. Nothing
 * overflowed — the row was inside its block to the hundredth — so a containment
 * check would have called it fine. The title is what a person came for.
 *
 * On its own line the row's first line is exactly an issue row (number, title,
 * age), so the two lists read alike, and the quiet line under it is the same
 * shape the members list already uses. Same weight and same tone as the `Draft`
 * tag that was there before, which is what the marking is.
 */
function PrRow({ pr, now }: { pr: RepoOpenPr; now: number }) {
  const marks = [pr.authorIsBot ? 'Bot' : null, pr.draft ? 'Draft' : null].filter(Boolean) as string[];
  return (
    <div className={ROW}>
      <span className={ROW_NUM}>#{pr.number}</span>
      <span className="min-w-0 flex-1">
        <a href={pr.htmlUrl} target="_blank" rel="noopener noreferrer" className={`${ROW_TITLE} block text-fg`}>
          {pr.title}
        </a>
        {(pr.author || marks.length > 0) && (
          <span className={PR_META}>
            {pr.author && <span className={PR_TAG}>{pr.author}</span>}
            {marks.map((m) => <span key={m} className={PR_TAG}>{m}</span>)}
          </span>
        )}
      </span>
      <span className={ROW_AGE}>{issueAge(pr.createdAt, now)}</span>
    </div>
  );
}

export function PrsSection({ view, now }: { view: RepoPageView; now: number }) {
  const tab = prsTab(view.pullRequests);
  if (tab.kind !== 'read') return <Absent label="Open pull requests" line={tab.line} />;
  return (
    <SectionCard label="Open pull requests" meta={tab.meta} note={tab.capped}>
      <div className="flex flex-col">
        {tab.prs.map((p) => <PrRow key={p.number} pr={p} now={now} />)}
      </div>
    </SectionCard>
  );
}

// ── Members ──────────────────────────────────────────────────────────────────

const MEMBER_ROW = 'flex items-center gap-[10px] py-[8px] min-w-0';
const MEMBER_NAME = 'text-[13px] font-[560] leading-[1.3] text-fg';
const MEMBER_LOGIN = 'text-[11.5px] leading-[1.3] text-muted';
/** The DRI's mark. A chip on ONE row of the list marks that row out, which is
 *  the job; the same chip on every row would be the furniture the issue rows
 *  above dropped. */
const MEMBER_DRI = 'ml-[6px] rounded-[5px] bg-elevated px-1.5 py-px text-[11px] text-dim';
const MEMBER_COUNTS = 'block truncate text-[11.5px] leading-[1.5] text-muted';

/**
 * Who works on this repo, and what each of them did.
 *
 * The list is derived from the issues and pull requests this page already read,
 * NOT from repo access: measured on 2026-09-03, the collaborator list is the
 * same three logins on all eight acme repos sampled, so an access list
 * would draw one identical answer on every repo page on the board.
 *
 * A row prints no zero. Where the pull-request read failed, the whole list says
 * so above it and no row counts a pull request at all, which is the same rule
 * the cards keep: a missing number is never drawn as a measured nought.
 */
export function MembersSection({ view }: { view: RepoPageView }) {
  const tab = membersTab(view.members);
  if (tab.kind !== 'read') return <Absent label="Members" line={tab.line} />;
  const prsUnreadable = view.members?.prsUnreadable ?? false;
  return (
    <SectionCard label="Members" meta={tab.meta} note={tab.short ?? MEMBERS_WINDOW}>
      <div className="flex flex-col">
        {tab.people.map((m) => {
          const line = memberLine(m, prsUnreadable);
          return (
            <div key={m.login} className={MEMBER_ROW}>
              <Avatar name={m.name} login={m.login} px={52} className="size-[26px] flex-none" showTitle={false} />
              <span className="min-w-0 flex-1">
                {/* The login is the row's name where the roster has none, and it
                    is then said ONCE: `name ?? login` followed by the login
                    unconditionally drew `anton-khovanskiy anton-khovanskiy` for
                    everybody the roster does not carry, which is most logins on
                    a repo with outside contributors. */}
                <span className={MEMBER_NAME}>{m.name ?? m.login}</span>
                {m.name && <> <span className={MEMBER_LOGIN}>{m.login}</span></>}
                {m.dri && <span className={MEMBER_DRI}>Owner</span>}
                {line && <span className={MEMBER_COUNTS}>{line}</span>}
              </span>
            </div>
          );
        })}
      </div>
      {/* Where the list is short because a read failed, its own window line
          still has to be said, and it goes under the list rather than replacing
          the sentence that explains the shortfall. */}
      {tab.short && <p className={`${NOTHING} mt-3`}>{MEMBERS_WINDOW}</p>}
    </SectionCard>
  );
}

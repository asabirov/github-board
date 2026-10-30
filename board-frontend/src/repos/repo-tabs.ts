/**
 * The repo page's four tabs, decided away from the page that draws them (#828).
 *
 * Same split `repo-page-vm.ts` makes for the cards, and for the same reason: the
 * board's test env is `node` with no DOM, so a decision written into the
 * component is a decision no spec can reach. Everything here is a pure function
 * of the one `RepoPageView` the page already fetched — switching tabs re-reads
 * that view and never the network.
 *
 * The tab bodies keep the shape the cards already take, three answers rather
 * than two, because the same distinction runs through this payload:
 *
 *   `read`       — there is something to list.
 *   `nothing`    — there is genuinely none of it. A fact about the repo.
 *   `unreadable` — Github did not answer. A fact about the read.
 *   `unlisted`   — this board was answered without the list. A fact about the
 *                  PAYLOAD, and the one this file adds: both services deploy
 *                  from `main` independently, so a board-web can meet a
 *                  board-api that predates the field (`RepoPageView.members`
 *                  carries the whole argument). Drawing it as `nothing` would
 *                  tell a reader that nobody works on a repo the board simply
 *                  has not been told about.
 */
import { openIssuesOf, type RepoMember, type RepoMembers, type RepoOpenIssue, type RepoOpenPr, type RepoPageView, type RepoPrFlow } from '../api/repos';
import { repoPath, type RepoSection } from '../route';
import { ISSUES_UNREADABLE, PR_UNREADABLE, REPO_PAGE_WINDOW, openIssuesHead, plural } from './repo-page-vm';

/** Overview is the bare path, so it is a tab here and not a `RepoSection` —
 *  `route.ts` says why the segment list excludes it. */
export type RepoTabKey = 'overview' | RepoSection;

export interface RepoTab {
  key: RepoTabKey;
  label: string;
  /**
   * The number a reader is choosing between, or null where there is none to
   * give. Overview carries none by design: it is three trends and a readme, and
   * no single count is what somebody picks it for.
   *
   * Null is also what a failed read gets. A tab labelled `PRs 0` over a read
   * Github refused claims a repo has no open pull requests, which is the one
   * thing this page's whole design is against — so the count comes off and the
   * tab says what happened once it is opened.
   */
  count: number | null;
  href: string;
  current: boolean;
}

const LABEL: Record<RepoTabKey, string> = {
  overview: 'Overview',
  issues: 'Issues',
  prs: 'PRs',
  members: 'Members',
};

/** `3 people`, `1 person` — the one noun in this file the `plural` helper cannot
 *  build, English having taken the s off it. */
export function people(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/**
 * The row of tabs: what each one is called, what it counts, and where it goes.
 *
 * Every tab is an ADDRESS — the row is navigation, not a widget that swaps
 * panels — so each carries a real href built by `repoPath`, and the page marks
 * the current one `aria-current="page"` rather than `aria-selected`.
 */
export function repoTabs(view: RepoPageView, section: RepoSection | undefined): RepoTab[] {
  const { repo, pullRequests, members } = view;
  const counts: Record<RepoTabKey, number | null> = {
    overview: null,
    // The repo's whole open count, not the length of the list below it: the list
    // is capped and the count is not, and the number on a tab is what a reader
    // is choosing between.
    // No count where the ingest could not read this repo's issues (#837): the
    // rolled-up `open` comes from the SAME ingest, so it is zero for the same
    // reason the list is empty, and a tab reading `Issues 0` would state as a
    // number the thing the tab says it does not know. Same rule as PRs below.
    issues: view.openIssuesState === 'unreadable' ? null : repo.open,
    prs: pullRequests.state === 'read' ? pullRequests.open : null,
    // No count where the pull-request read failed, even though the people found
    // in the issues are real: that list is short by everybody who only opens
    // pull requests, and a number on the tab would present it as the whole of
    // who works here. The tab says so inside instead.
    members: members && !members.prsUnreadable ? members.people.length : null,
  };
  const keys: RepoTabKey[] = ['overview', 'issues', 'prs', 'members'];
  return keys.map((key) => ({
    key,
    label: LABEL[key],
    count: counts[key],
    href: repoPath(repo.full, key === 'overview' ? undefined : key),
    current: key === (section ?? 'overview'),
  }));
}

// ── Issues ───────────────────────────────────────────────────────────────────

/** The open queue, and the two things it has to say about its own length: how
 *  many the repo has open (`meta`), and that the list stops short of them
 *  (`capped`). */
export type IssuesTab =
  | { kind: 'read'; issues: RepoOpenIssue[]; meta: string | null; capped: string | null; showAll: string | null }
  | { kind: 'nothing'; line: string }
  | { kind: 'unreadable'; line: string };

/** How the list says it is not the whole of the queue. The count above it is the
 *  repo's, so without this line a reader has a header saying 137 over a hundred
 *  rows and no account of the difference. One function for both lists: two
 *  sentences saying the same thing about two lists is one that goes stale. */
function cappedNote(open: number, shown: number, noun: string): string | null {
  if (open <= shown) return null;
  return `The newest ${plural(shown, noun)} are here.`;
}

export function issuesTab(view: RepoPageView): IssuesTab {
  // The third answer, and it is settled BEFORE the list is looked at (#837). An
  // unread repo contributes no rows, and `repo.open` is rolled up from the same
  // ingest and reads zero too, so both halves of "there is nothing here" agree
  // while neither of them looked. Absent is not `unreadable`: a board-api older
  // than #837 sends no state at all, and that is a fact about the payload.
  if (view.openIssuesState === 'unreadable') return { kind: 'unreadable', line: ISSUES_UNREADABLE };
  const issues = openIssuesOf(view);
  const head = openIssuesHead(view.repo.open, issues.length);
  if (issues.length === 0) {
    // True of a repo whose queue is entirely closed as well as of one that never
    // had an issue: this list is of OPEN issues, so what it can be empty of is
    // open issues and not issues (#826).
    return { kind: 'nothing', line: 'No open issues.' };
  }
  return {
    kind: 'read',
    issues,
    meta: head.meta,
    capped: cappedNote(view.repo.open, issues.length, 'issue'),
    showAll: head.showAll,
  };
}

// ── Pull requests ────────────────────────────────────────────────────────────

export type PrsTab =
  | { kind: 'read'; prs: RepoOpenPr[]; meta: string; capped: string | null }
  | { kind: 'nothing'; line: string }
  | { kind: 'unreadable'; line: string }
  | { kind: 'unlisted'; line: string };

export function prsTab(pr: RepoPrFlow): PrsTab {
  // The same words the trend card uses, from the same constant: one read, and
  // the two places drawing it may not describe its failure differently.
  if (pr.state === 'unreadable') return { kind: 'unreadable', line: PR_UNREADABLE };
  if (pr.open === 0 && pr.closedMerged === 0) {
    return { kind: 'nothing', line: 'No pull requests in this repo.' };
  }
  if (pr.open === 0) {
    // A repo with a merged history and an empty queue. Different sentence from
    // the one above, because "none open" and "none ever" are different facts.
    return { kind: 'nothing', line: 'No open pull requests.' };
  }
  const open = pr.openPrs ?? [];
  if (open.length === 0) {
    // The count says there are some and the list has none of them, which happens
    // in one situation: a board-api that predates this list. Never drawn as an
    // empty queue, which is the sentence directly above and is a different claim.
    return {
      kind: 'unlisted',
      line: `${plural(pr.open, 'pull request')} open, and none of them are in what this board was sent.`,
    };
  }
  return {
    kind: 'read',
    prs: open,
    meta: `${pr.open} open`,
    capped: cappedNote(pr.open, open.length, 'pull request'),
  };
}

// ── Members ──────────────────────────────────────────────────────────────────

export type MembersTab =
  | { kind: 'read'; people: RepoMember[]; meta: string | null; short: string | null }
  | { kind: 'nothing'; line: string }
  | { kind: 'unreadable'; line: string }
  | { kind: 'unlisted'; line: string };

/** What the tab says over a list the failed pull-request read left short. The
 *  list is still drawn: the people in it are real and their issue counts are
 *  right. What is missing is everybody whose work here is pull requests. */
const MEMBERS_SHORT =
  `${PR_UNREADABLE} Nobody’s pull requests are counted below, and anybody who only opens them is missing.`;

export function membersTab(members: RepoMembers | undefined): MembersTab {
  if (!members) {
    return { kind: 'unlisted', line: 'This board hasn’t been sent who works on this repo.' };
  }
  if (members.people.length === 0) {
    if (members.prsUnreadable) {
      // Empty AND half-blind. "Nobody works here" is not available as an answer:
      // the half of the evidence that failed is the half that would have named
      // somebody.
      return {
        kind: 'unreadable',
        line: `${PR_UNREADABLE} Nobody has opened or been assigned an issue here either, so this board can’t say who works on it.`,
      };
    }
    return {
      kind: 'nothing',
      line: `Nobody has opened an issue or a pull request here in ${REPO_PAGE_WINDOW}, and nothing open is assigned.`,
    };
  }
  return {
    kind: 'read',
    people: members.people,
    meta: members.prsUnreadable ? null : people(members.people.length),
    short: members.prsUnreadable ? MEMBERS_SHORT : null,
  };
}

/**
 * What one person's row says they did, and the one number it may not print.
 *
 * `openedPrs` is 0 for everybody when the pull-request read failed, so the
 * clause is dropped rather than printed as a zero — the page's rule everywhere
 * else, applied to a field instead of to a card. The whole list carries
 * `MEMBERS_SHORT` above it saying why.
 *
 * Null where there is nothing to say, which is the repo's DRI at three zeros:
 * they are in the list because the org names them, and the row says that with
 * its owner mark instead of with a line of noughts.
 */
export function memberLine(m: RepoMember, prsUnreadable: boolean): string | null {
  const parts: string[] = [];
  if (m.assigned > 0) parts.push(`${plural(m.assigned, 'open issue')} assigned`);
  const opened: string[] = [];
  if (m.openedIssues > 0) opened.push(plural(m.openedIssues, 'issue'));
  if (!prsUnreadable && m.openedPrs > 0) opened.push(plural(m.openedPrs, 'pull request'));
  if (opened.length > 0) parts.push(`opened ${opened.join(' and ')}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The line under the Members list saying which window its counts cover. The
 *  two halves are measured differently and a reader cannot tell from the numbers
 *  which is which, so the block says it. */
export const MEMBERS_WINDOW = `Opened counts cover ${REPO_PAGE_WINDOW}; assignments are as they stand now.`;

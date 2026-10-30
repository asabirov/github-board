import { describe, expect, it } from 'vitest';
import { FeedbackScope, HIDDEN_FEEDBACK_TITLE } from '../auth/feedback-visibility';
import { readableLastClosed, readableItems } from './project-visibility';
import type { SubmissionIndex } from '../issues-metrics/issues-cache.service';
import type { ProjectClose, ProjectItemRaw } from './project.types';

/**
 * The Projects half of #497. The decision itself lives in
 * `auth/feedback-visibility.ts` and is tested there; what is tested here is the
 * two ways a board applies it — a row's title, and which close the card names.
 */

const SCOPE: FeedbackScope = { owner: 'acme', repo: 'board', labels: ['feedback'] };
const STATIC_AGENT = { agent: true, staticAgent: true, email: 'agent:ci-bot' };
const HUMAN = { agent: false, email: 'octocat@example.com' };
/** A personal access token (#210) carries its owner's real address. */
const PAT = { agent: true, email: 'octocat@example.com' };

const SUBMISSION_TITLE = '[Bug] my weekly report never arrives and the button just spins';
const TEAM_TITLE = 'Reconcile legacy architecture docs';

/** A stand-in index: the rows it knows, and `null` — "no row for this issue" —
 *  for everything else (#516). */
const indexOf = (rows: Record<number, boolean>): SubmissionIndex => ({
  lookup: (_owner: string, _repo: string, number: number) => (number in rows ? rows[number] : null),
});

/** An index that read every body and found no footer anywhere. The #497/#488
 *  close-walk cases below are about labels and authors, so this is what lets
 *  them go on saying exactly what they always said. */
const NO_FOOTERS: SubmissionIndex = { lookup: () => false };

const item = (over: Partial<ProjectItemRaw>): ProjectItemRaw => ({
  repo: 'acme/board',
  number: 1,
  title: TEAM_TITLE,
  url: 'https://github.com/acme/board/issues/1',
  status: 'Todo',
  state: 'open',
  closedAt: null,
  // No reason given, which is the answer that COUNTS as delivery (#1014) —
  // so these rows keep saying what they said before the field existed.
  stateReason: null,
  assignees: [],
  prs: [],
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-02T00:00:00Z',
  lastActivity: { type: 'opened', atISO: '2026-07-01T00:00:00Z' },
  parent: null,
  labels: [],
  labelsComplete: true,
  // These rows are placed by their labels; the footer half is exercised in the
  // #516 block below (#516).
  submission: false,
  type: 'chore',
  ...over,
});

const submissionItem = item({
  number: 460,
  title: SUBMISSION_TITLE,
  url: 'https://github.com/acme/board/issues/460',
  labels: [{ name: 'feedback', color: '' }, { name: 'bug', color: '' }],
  type: 'bug',
});
const teamItem = item({
  number: 101,
  url: 'https://github.com/acme/board/issues/101',
  labels: [{ name: 'discovery', color: '' }],
});

const close = (over: Partial<ProjectClose>): ProjectClose => ({
  repo: 'acme/board',
  number: 1,
  title: TEAM_TITLE,
  url: 'https://github.com/acme/board/issues/1',
  by: 'octocat',
  author: 'octocat',
  atISO: '2026-07-02T00:00:00Z',
  labels: [],
  ...over,
});

/**
 * The production shape, copied off the card the issue was filed about:
 * `acme/compliance.example.com#149`, opened by `octocat`, closed by
 * `octocat`, labelled `dependencies`. Nothing about the people involved marks
 * it as housekeeping — only the label does. Every rule here is measured against
 * this row, because it is the one a live board actually holds.
 */
const LIVE_BUMP = close({
  repo: 'acme/compliance.example.com',
  number: 149,
  title: 'Upgrade @acme/ui from 0.19.1 to 0.26.1',
  url: 'https://github.com/acme/compliance.example.com/issues/149',
  author: 'octocat',
  by: 'octocat',
  atISO: '2026-08-01T00:00:00Z',
  labels: ['dependencies'],
});

describe('readableItems — a board row keeps everything but its title (#497)', () => {
  it('replaces a submission’s title for a static agent token', () => {
    const out = readableItems([submissionItem, teamItem], STATIC_AGENT, SCOPE);
    expect(out.map((i) => i.title)).toEqual([HIDDEN_FEEDBACK_TITLE, TEAM_TITLE]);
  });

  it('keeps the row itself intact — repo, labels, state, dates, URL', () => {
    const { submission: _decidedWith, ...served } = submissionItem;
    const [hidden] = readableItems([submissionItem], STATIC_AGENT, SCOPE);
    expect({ ...hidden, title: SUBMISSION_TITLE }).toEqual(served);
  });

  it('a human session reads every title', () => {
    const out = readableItems([submissionItem, teamItem], HUMAN, SCOPE);
    expect(out.map((i) => i.title)).toEqual([SUBMISSION_TITLE, TEAM_TITLE]);
  });

  it('a personal access token reads them too — it carries its owner’s address', () => {
    expect(readableItems([submissionItem], PAT, SCOPE)[0].title).toBe(SUBMISSION_TITLE);
  });

  it('a caller with no address at all is refused the words — a guard regression fails closed', () => {
    expect(readableItems([submissionItem], undefined, SCOPE)[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
  });

  it('never mutates the array it was given — the cache holds the originals', () => {
    const items = [submissionItem, teamItem];
    readableItems(items, STATIC_AGENT, SCOPE);
    expect(items[0].title).toBe(SUBMISSION_TITLE);
  });

  it('a row whose repo string is empty still places itself by its Github URL', () => {
    const orphan = item({
      repo: '',
      number: 460,
      title: SUBMISSION_TITLE,
      url: 'https://github.com/acme/board/issues/460',
      labels: [{ name: 'feedback', color: '' }],
    });
    expect(readableItems([orphan], STATIC_AGENT, SCOPE)[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
  });

  // The decision keys on the `feedback` label being PRESENT, so a row whose
  // label page truncated says "no feedback label here" and hands the words over
  // — with no error, and a fully green suite. `labelsComplete` is what tells
  // that apart from a row we really did read every label of.
  it('a row whose label page truncated is withheld, though the labels it shows do not match', () => {
    const truncated = item({
      number: 462,
      title: SUBMISSION_TITLE,
      url: 'https://github.com/acme/board/issues/462',
      labels: [{ name: 'bug', color: '' }],
      labelsComplete: false,
    });
    expect(readableItems([truncated], STATIC_AGENT, SCOPE)[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
  });

  it('…and a truncated row on a board in another repo is untouched — no submission can live there', () => {
    const elsewhere = item({
      repo: 'acme/acme',
      number: 101,
      url: 'https://github.com/acme/acme/issues/101',
      labels: [{ name: 'bug', color: '' }],
      labelsComplete: false,
    });
    expect(readableItems([elsewhere], STATIC_AGENT, SCOPE)[0].title).toBe(TEAM_TITLE);
  });

  it('a human session reads a truncated row either way', () => {
    const truncated = item({ number: 462, title: SUBMISSION_TITLE, labelsComplete: false });
    expect(readableItems([truncated], HUMAN, SCOPE)[0].title).toBe(SUBMISSION_TITLE);
  });
});

describe('readableLastClosed — which close the card names (#497)', () => {
  const submissionClose = close({
    number: 455,
    title: SUBMISSION_TITLE,
    atISO: '2026-07-30T00:00:00Z',
    labels: ['feedback'],
  });
  const teamClose = close({ number: 176, title: TEAM_TITLE, atISO: '2026-07-01T00:00:00Z' });

  it('a human reads the most recent close, whatever it is', () => {
    expect(readableLastClosed([submissionClose, teamClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({
      number: 455,
      title: SUBMISSION_TITLE,
      atISO: '2026-07-30T00:00:00Z',
    });
  });

  it('a static agent token skips back to the most recent close it may read, with that close’s own date', () => {
    expect(readableLastClosed([submissionClose, teamClose], STATIC_AGENT, SCOPE, NO_FOOTERS)).toMatchObject({
      number: 176,
      title: TEAM_TITLE,
      atISO: '2026-07-01T00:00:00Z',
    });
  });

  it('no readable close in the window → no recency line at all, rather than a withheld one', () => {
    expect(readableLastClosed([submissionClose], STATIC_AGENT, SCOPE, NO_FOOTERS)).toBeNull();
  });

  it('a board with nothing closed yet reads null for everyone', () => {
    expect(readableLastClosed([], HUMAN, SCOPE, NO_FOOTERS)).toBeNull();
    expect(readableLastClosed([], STATIC_AGENT, SCOPE, NO_FOOTERS)).toBeNull();
  });

  it('the pick never carries `labels` onward — that field exists to decide, not to serve', () => {
    const picked = readableLastClosed([teamClose], HUMAN, SCOPE, NO_FOOTERS);
    expect(picked).not.toHaveProperty('labels');
    expect(Object.keys(picked ?? {}).sort()).toEqual(['atISO', 'by', 'number', 'repo', 'title', 'url']);
  });

  it('a close whose labels could not be established is skipped past, not named', () => {
    const unknown = close({ number: 999, title: SUBMISSION_TITLE, atISO: '2026-07-31T00:00:00Z', labels: null });
    expect(readableLastClosed([unknown, teamClose], STATIC_AGENT, SCOPE, NO_FOOTERS)).toMatchObject({
      number: 176,
      title: TEAM_TITLE,
    });
    expect(readableLastClosed([unknown, teamClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({ number: 999 });
  });
});

/**
 * The same walk, its second reason (#488) — and the one the card's title line is
 * actually about: who WROTE the issue.
 *
 * A dependency bump is a genuine close and counts everywhere a close counts —
 * the ring, the total, the percentage, the board's own status chip. It just
 * isn't what the card's one human line is for. What makes it a bump is that
 * automation opened it; who eventually pressed Close is a fact about the repo's
 * merge habits. On a live board a person merges the bot's PR, and Github records
 * that person as the closer — which is exactly the card the issue was filed
 * about: "Upgrade @acme/ui from 0.19.1 to 0.26.1, closed by Octocat 31m ago".
 * So the walk keys on the author, and the reverse case (a person's issue that
 * automation closed) is still named: the work behind it was somebody's.
 */
describe('readableLastClosed — the card names a person’s work, by who wrote it (#488)', () => {
  const BUMP_TITLE = 'chore(deps): bump @acme/ui from 0.19.1 to 0.26.1';
  /** The live shape: dependabot opened it, a person merged it. */
  const mergedBump = close({
    number: 487,
    title: BUMP_TITLE,
    author: 'dependabot[bot]',
    by: 'octocat',
    atISO: '2026-07-31T00:00:00Z',
  });
  const humanClose = close({ number: 176, title: TEAM_TITLE, atISO: '2026-07-01T00:00:00Z' });

  it('skips a bump a PERSON closed — the card the issue quotes — for the human close behind it', () => {
    expect(readableLastClosed([mergedBump, humanClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({
      number: 176,
      title: TEAM_TITLE,
      atISO: '2026-07-01T00:00:00Z',
    });
  });

  it('skips a bump automation both wrote and closed', () => {
    const selfClosed = close({ number: 487, title: BUMP_TITLE, author: 'dependabot[bot]', by: 'dependabot[bot]' });
    expect(readableLastClosed([selfClosed, humanClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({ number: 176 });
  });

  it('skips every spelling the ring already files as a bot — bare, suffixed, any case', () => {
    for (const author of ['dependabot[bot]', 'dependabot', 'github-actions', 'renovate', 'copilot-swe-agent', 'Some-App[BOT]']) {
      expect(
        readableLastClosed([close({ number: 900, author, by: 'octocat', title: BUMP_TITLE }), humanClose], HUMAN, SCOPE, NO_FOOTERS),
      ).toMatchObject({ number: 176 });
    }
  });

  it('a board whose closes were all written by automation names nothing at all, rather than a bump', () => {
    const closes = [mergedBump, close({ number: 486, author: 'renovate', by: 'IvanRoslov', title: BUMP_TITLE })];
    expect(readableLastClosed(closes, HUMAN, SCOPE, NO_FOOTERS)).toBeNull();
  });

  it('an ordinary human close in front is named as it always was', () => {
    const newerHuman = close({ number: 300, title: 'Ship the compliance rails', atISO: '2026-08-01T00:00:00Z' });
    expect(readableLastClosed([newerHuman, mergedBump, humanClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({ number: 300 });
  });

  /**
   * The decision, recorded rather than left to fall out: a bot CLOSER does not
   * disqualify a close. A merge queue, a release bot or `github-actions` closing
   * an issue on merge is still a person's work landing — skipping it would blank
   * the card on any repo that automates closing, which is the opposite of what
   * the issue asks for. (Was: this same input asserted `null`, back when the
   * walk keyed on the closer.)
   */
  it('a PERSON’s issue that automation closed is still named — the work behind it was somebody’s', () => {
    const botMerged = close({ number: 301, title: 'Ship the compliance rails', author: 'octocat', by: 'github-actions[bot]' });
    expect(readableLastClosed([botMerged, humanClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({
      number: 301,
      title: 'Ship the compliance rails',
      // …and the record of the act is served as it stands: the card says
      // "Closed by …" about whoever closed it, bot or not.
      by: 'github-actions[bot]',
    });
  });

  it('a close with no recorded author is still named — unknown is not a bot', () => {
    const unattributed = close({ number: 302, title: 'Reconcile legacy architecture docs', author: null });
    expect(readableLastClosed([unattributed, humanClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({ number: 302 });
  });

  it('the author rides the candidate only — it never reaches the payload', () => {
    expect(readableLastClosed([humanClose], HUMAN, SCOPE, NO_FOOTERS)).not.toHaveProperty('author');
  });

  /**
   * (Was: "one walk, two reasons, three closes" — the same walk before the
   * `dependencies` label became the third reason. It now carries a fourth close,
   * the human-written bump, because that is the one live boards actually have;
   * the two older reasons assert exactly what they always did.)
   */
  it('one walk, three reasons, four closes: two bumps, then somebody else’s words, then the one it names', () => {
    const submission = close({
      number: 455,
      title: SUBMISSION_TITLE,
      atISO: '2026-07-30T00:00:00Z',
      labels: ['feedback'],
    });
    const walk = [mergedBump, LIVE_BUMP, submission, humanClose];
    expect(readableLastClosed(walk, STATIC_AGENT, SCOPE, NO_FOOTERS)).toMatchObject({
      number: 176,
      title: TEAM_TITLE,
    });
    // …and the human, who may read the submission, still steps over both bumps.
    expect(readableLastClosed(walk, HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({ number: 455 });
  });
});

/**
 * The walk's third reason, and the only one that fires on a live board (#488).
 *
 * Dependabot files no issues in this org — it files pull requests, which the
 * source's `isIssue` filter drops before they can ever become close candidates.
 * The card the issue was filed about is `compliance.example.com#149`, "Upgrade
 * @acme/ui from 0.19.1 to 0.26.1": a person opened it, a person closed it, and
 * the ONLY thing marking it housekeeping is its `dependencies` label. So the
 * author rule above, correct as it is, was never going to move that card — the
 * label is what does.
 *
 * The two rules are an OR, not a replacement. The author rule stays because it
 * is what makes a genuine bot item behave the day one lands.
 */
describe('readableLastClosed — a `dependencies` close is skipped by its label, whoever wrote it (#488)', () => {
  const DEP_TITLE = 'Upgrade @acme/ui from 0.19.1 to 0.26.1';
  const humanClose = close({ number: 176, title: TEAM_TITLE, atISO: '2026-07-01T00:00:00Z' });

  it('skips the live shape — a person wrote it, a person closed it, and it is labelled `dependencies`', () => {
    expect(readableLastClosed([LIVE_BUMP, humanClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({
      number: 176,
      title: TEAM_TITLE,
      // …named with its OWN date, not the bump's.
      atISO: '2026-07-01T00:00:00Z',
    });
  });

  it('a static agent token gets the same answer — this is presentation, not a words rule', () => {
    expect(readableLastClosed([LIVE_BUMP, humanClose], STATIC_AGENT, SCOPE, NO_FOOTERS)).toMatchObject({ number: 176 });
  });

  it('matches the label case-insensitively, the way every other label test here folds case', () => {
    for (const label of ['dependencies', 'Dependencies', 'DEPENDENCIES']) {
      expect(
        readableLastClosed([close({ number: 149, title: DEP_TITLE, labels: [label] }), humanClose], HUMAN, SCOPE, NO_FOOTERS),
      ).toMatchObject({ number: 176 });
    }
  });

  it('finds the label among the others a bump carries, not only on its own', () => {
    const many = close({ number: 149, title: DEP_TITLE, labels: ['chore', 'dependencies', 'javascript'] });
    expect(readableLastClosed([many, humanClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({ number: 176 });
  });

  it('leaves an ordinary close alone — other labels are not a reason to skip', () => {
    const ordinary = close({ number: 300, title: 'Ship the compliance rails', labels: ['bug', 'ui'] });
    expect(readableLastClosed([ordinary, humanClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({ number: 300 });
  });

  it('a board whose every close is a dependency bump names nothing at all', () => {
    const closes = [LIVE_BUMP, close({ number: 148, title: DEP_TITLE, labels: ['dependencies'] })];
    expect(readableLastClosed(closes, HUMAN, SCOPE, NO_FOOTERS)).toBeNull();
  });

  it('skips a bump that is BOTH bot-written and `dependencies`-labelled — the two reasons are an OR', () => {
    const both = close({ number: 487, title: DEP_TITLE, author: 'dependabot[bot]', by: 'octocat', labels: ['dependencies'] });
    expect(readableLastClosed([both, humanClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({ number: 176 });
  });

  /**
   * The direction that must never invert. #497's rule fails CLOSED — a label set
   * that cannot be proven complete withholds the words, because that rule guards
   * somebody else's privacy. This one is a presentation preference, so it fails
   * the other way: an unprovable set is "no reason to skip found", and the close
   * is NAMED. Backwards, a truncated label page would blank the recency line on
   * every real card at once.
   */
  it('a close whose label set cannot be proven complete is NAMED, not skipped', () => {
    const unknown = close({ number: 149, title: DEP_TITLE, labels: null, atISO: '2026-08-01T00:00:00Z' });
    expect(readableLastClosed([unknown, humanClose], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({ number: 149 });
  });

  /**
   * The same input, the same unprovable label set, the two rules answering
   * opposite ways on purpose — on a board in another repo, where no submission
   * could live, so #497 has already said yes and only this rule is left.
   */
  it('…and a static agent token gets it named too, on a repo where the words rule has nothing to say', () => {
    const unknown = close({
      repo: 'acme/compliance.example.com',
      url: 'https://github.com/acme/compliance.example.com/issues/149',
      number: 149,
      title: DEP_TITLE,
      labels: null,
      atISO: '2026-08-01T00:00:00Z',
    });
    expect(readableLastClosed([unknown, humanClose], STATIC_AGENT, SCOPE, NO_FOOTERS)).toMatchObject({ number: 149 });
  });

  it('a close carrying no labels at all is named — an empty set is not a bump', () => {
    expect(readableLastClosed([close({ number: 300, labels: [] })], HUMAN, SCOPE, NO_FOOTERS)).toMatchObject({ number: 300 });
  });

  it('the labels ride the candidate only — the skip never puts them on the wire', () => {
    expect(readableLastClosed([LIVE_BUMP, humanClose], HUMAN, SCOPE, NO_FOOTERS)).not.toHaveProperty('labels');
  });
});

/**
 * #516 — a submission after triage changed its labels, on a board.
 *
 * The two functions here get the marker from DIFFERENT places, and that is the
 * design rather than an inconsistency. A board ROW comes from `DETAIL_QUERY`,
 * which reads the issue's body, so `readableItems` is told outright — the
 * highest-title-count surface on the board never depends on a shared index at
 * all. A CLOSE comes from the rollup's list query, which reads no body across
 * twenty boards, so `readableLastClosed` asks the index.
 */
describe('readableItems — a relabelled submission on a board (#516)', () => {
  const RELABELLED_TITLE = '[Bug] the digest email arrives empty every second week';
  const relabelledItem = item({
    number: 902,
    title: RELABELLED_TITLE,
    url: 'https://github.com/acme/board/issues/902',
    labels: [{ name: 'bug', color: '' }, { name: 'in progress', color: '' }],
    labelsComplete: true,
    submission: true,
    type: 'bug',
  });

  it('hides its title from a static agent token, though its labels say `bug`', () => {
    expect(readableItems([relabelledItem], STATIC_AGENT, SCOPE)[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
  });

  it('a human session and a personal access token read it whole', () => {
    for (const viewer of [HUMAN, PAT]) {
      expect(readableItems([relabelledItem], viewer, SCOPE)[0].title).toBe(RELABELLED_TITLE);
    }
  });

  it('the same body-derived mark in another repo hides nothing — the repo is settled first', () => {
    const elsewhere = item({
      repo: 'acme/acme',
      number: 902,
      title: RELABELLED_TITLE,
      url: 'https://github.com/acme/acme/issues/902',
      submission: true,
    });
    expect(readableItems([elsewhere], STATIC_AGENT, SCOPE)[0].title).toBe(RELABELLED_TITLE);
  });

  /** The marker decides; it is not part of the payload. Same rule
   *  `ProjectClose.labels` and `.author` already follow. */
  it('the mark rides the row to decide with and never reaches the wire', () => {
    for (const viewer of [HUMAN, STATIC_AGENT]) {
      for (const row of readableItems([relabelledItem, teamItem], viewer, SCOPE)) {
        expect(row).not.toHaveProperty('submission');
      }
    }
  });
});

describe('readableLastClosed — the index answers for a close (#516)', () => {
  const RELABELLED_TITLE = '[Bug] the digest email arrives empty every second week';
  const relabelledClose = close({
    number: 902,
    title: RELABELLED_TITLE,
    atISO: '2026-07-30T00:00:00Z',
    labels: ['bug'],
  });
  const teamClose = close({ number: 176, title: TEAM_TITLE, atISO: '2026-07-01T00:00:00Z' });

  it('skips a close the index marks as a submission, and names the readable one behind it', () => {
    expect(
      readableLastClosed([relabelledClose, teamClose], STATIC_AGENT, SCOPE, indexOf({ 902: true, 176: false })),
    ).toMatchObject({ number: 176, title: TEAM_TITLE, atISO: '2026-07-01T00:00:00Z' });
  });

  it('a human still gets the newest close, whatever the index says', () => {
    expect(
      readableLastClosed([relabelledClose, teamClose], HUMAN, SCOPE, indexOf({ 902: true, 176: false })),
    ).toMatchObject({ number: 902 });
  });

  /** The row the first draft got wrong: an index with no answer for this issue
   *  must not read as an authoritative "not a submission". */
  it('skips a feedback-repo close the index has no row for', () => {
    expect(readableLastClosed([relabelledClose, teamClose], STATIC_AGENT, SCOPE, indexOf({ 176: false }))).toMatchObject(
      { number: 176 },
    );
  });

  it('an index that could not be built at all skips every feedback-repo close', () => {
    expect(readableLastClosed([relabelledClose, teamClose], STATIC_AGENT, SCOPE, null)).toBeNull();
  });

  it('…and a close in another repo is named even with no index at all', () => {
    const elsewhere = close({
      repo: 'acme/acme',
      url: 'https://github.com/acme/acme/issues/191',
      number: 191,
      title: 'Waitlist: confirm-email copy pass',
      atISO: '2026-07-02T00:00:00Z',
    });
    expect(readableLastClosed([elsewhere], STATIC_AGENT, SCOPE, null)).toMatchObject({ number: 191 });
  });

  it('places a close by its Github URL when the row carries no owner/name', () => {
    const orphan = close({
      repo: '',
      number: 902,
      title: RELABELLED_TITLE,
      url: 'https://github.com/acme/board/issues/902',
      atISO: '2026-07-30T00:00:00Z',
      labels: ['bug'],
    });
    expect(readableLastClosed([orphan, teamClose], STATIC_AGENT, SCOPE, indexOf({ 902: true, 176: false }))).toMatchObject(
      { number: 176 },
    );
  });
});

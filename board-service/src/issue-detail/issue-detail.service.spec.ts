import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HIDDEN_FEEDBACK_TITLE } from '../auth/feedback-visibility';
import { IssueDetailService } from './issue-detail.service';
import type { IssuesCacheService, SubmissionIndex } from '../issues-metrics/issues-cache.service';
import {
  ClosedIssue,
  CreatedProject,
  FieldValue,
  IIssueDetailSource,
  IssueDetail,
  IssueEditOptions,
  IssueLabel,
  IssueState,
  Person,
  PostedComment,
} from './issue-detail.types';

/**
 * The shared issues cache, stubbed down to the one thing this service reads from
 * it: the submission index its RELATIONS gate needs (#516). `NO_FOOTERS` is an
 * index that read every body and found no footer, which is what lets the #497
 * cases below go on testing the label half of the rule exactly as they did.
 */
const cacheOf = (index: SubmissionIndex | null): IssuesCacheService =>
  ({ submissionIndex: async () => index }) as unknown as IssuesCacheService;
const NO_FOOTERS = cacheOf({ lookup: () => false });
/** An index that knows these rows and answers `null` — no row — for the rest. */
const cacheKnowing = (rows: Record<number, boolean>): IssuesCacheService =>
  cacheOf({ lookup: (_o: string, _r: string, n: number) => (n in rows ? rows[n] : null) });

function config(ttl = 60_000): ConfigService {
  // `GITHUB_ORGS` and `FEEDBACK_REPO` are pinned at the org this file's
  // expectations name (#1166): they were the defaults too until the
  // organisation was renamed to `acme`.
  return {
    get: (k: string, d?: unknown) =>
      k === 'ISSUE_DETAIL_CACHE_TTL_MS'
        ? ttl
        : k === 'GITHUB_ORGS'
          ? 'acme'
          : k === 'FEEDBACK_REPO'
            ? 'acme/board'
            : d,
  } as unknown as ConfigService;
}

function detail(number: number): IssueDetail {
  return {
    owner: 'o', repo: 'r', number, title: `#${number}`, state: 'open',
    htmlUrl: `https://x/${number}`, author: null, createdAt: '', updatedAt: '',
    bodyMarkdown: '', labels: [], labelsComplete: true, assignees: [], milestone: null,
    issueType: null,
    relations: { parent: null, subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0, blockedBy: [], blocking: [] },
    linkedPrs: [], comments: [], totalComments: 0, commentsTruncated: false,
    projects: [],
  };
}

class StubSource implements IIssueDetailSource {
  async editText() { return { bodyMarkdown: "saved" }; }
  calls = 0;
  closes: Array<[string, string, number]> = [];
  mode: 'ok' | 'missing' | 'throw' = 'ok';
  /** Fields laid over the served issue — how a spec makes the stub answer with a
   *  feedback submission (a repo + labels) rather than a plain one (#497). */
  constructor(private readonly overrides: Partial<IssueDetail> = {}) {}
  fetch(owner: string, repo: string, number: number): Promise<IssueDetail | null> {
    this.calls += 1;
    if (this.mode === 'throw') return Promise.reject(new Error('boom'));
    if (this.mode === 'missing') return Promise.resolve(null);
    return Promise.resolve({ ...detail(number), ...this.overrides });
  }
  close(owner: string, repo: string, number: number): Promise<ClosedIssue> {
    this.closes.push([owner, repo, number]);
    return Promise.resolve({ state: 'closed', stateReason: 'completed', alreadyClosed: false });
  }

  // Widened-interface members unused by these cache tests — present so the fake
  // satisfies IIssueDetailSource (Task 3 Step 0). The mutation service methods
  // are covered by the controller spec against the real fixture.
  setState(_o: string, _r: string, _n: number, state: IssueState): Promise<IssueState> {
    return Promise.resolve(state);
  }
  setAssignees(_o: string, _r: string, _n: number, logins: string[]): Promise<Person[]> {
    return Promise.resolve(logins.map((login) => ({ login, name: null })));
  }
  addAssignees(_o: string, _r: string, _n: number, logins: string[]): Promise<Person[]> {
    return Promise.resolve(logins.map((login) => ({ login, name: null })));
  }
  removeAssignees(): Promise<Person[]> {
    return Promise.resolve([]);
  }
  currentAssignees(): Promise<Person[] | null> {
    return Promise.resolve([]);
  }
  setLabels(_o: string, _r: string, _n: number, names: string[]): Promise<IssueLabel[]> {
    return Promise.resolve(names.map((name) => ({ name, color: '' })));
  }
  setMilestone(_o: string, _r: string, _n: number, milestoneNumber: number | null): Promise<string | null> {
    return Promise.resolve(milestoneNumber == null ? null : `M${milestoneNumber}`);
  }
  /** Echoes the served issue's body, the way GitHub echoes the body it just
   *  wrote (B2) — so the words gate on this path has real words to place (#516). */
  toggleTask(_o: string, _r: string, _n: number, _line: number, _checked: boolean): Promise<string> {
    return Promise.resolve(this.overrides.bodyMarkdown ?? '');
  }
  /** Records the posted comment the way Github would store it (#693) — a
   *  distinct author and permalink, so a test can tell the stored comment from
   *  the request it was made of. */
  addComment(_o: string, _r: string, _n: number, bodyMarkdown: string): Promise<PostedComment> {
    return Promise.resolve({
      author: { login: 'board', name: null },
      bodyMarkdown,
      createdAt: '2026-08-30T00:00:00.000Z',
      htmlUrl: 'https://github.com/o/r/issues/1#issuecomment-1',
    });
  }
  editOptions(): Promise<IssueEditOptions> {
    return Promise.resolve({ labels: [], milestones: [], assignableLogins: [] });
  }
  projectOwnerLogin(): Promise<string | null> {
    return Promise.resolve(null);
  }
  addToProject(): Promise<{ itemId: string }> {
    return Promise.resolve({ itemId: 'stub' });
  }
  createProject(): Promise<CreatedProject> {
    return Promise.resolve({ id: 'stub', number: 1, title: 'stub', url: null, owner: 'stub' });
  }
  removeFromProject(): Promise<void> {
    return Promise.resolve();
  }
  setFieldValue(
    _projectId: string,
    _itemId: string,
    _fieldId: string,
    value: FieldValue,
    _owner?: string,
    _repo?: string,
  ): Promise<FieldValue> {
    return Promise.resolve(value);
  }
}

/** The viewer every pre-#497 assertion below was written against: a signed-in
 *  teammate. Passed explicitly now that the read is identity-dependent. */
const HUMAN = { agent: false, email: 'octocat@example.com' };
/** A static `BOARD_AGENT_TOKENS` actor — no person behind it, and carrying the
 *  `staticAgent` flag that says so (#525). */
const STATIC_AGENT = { agent: true, staticAgent: true, email: 'agent:ci-bot' };

describe('IssueDetailService', () => {
  it('fetches once and serves the cache within TTL', async () => {
    const src = new StubSource();
    const svc = new IssueDetailService(src, config(), NO_FOOTERS);
    expect((await svc.getIssue('o', 'r', 1, HUMAN))?.number).toBe(1);
    expect((await svc.getIssue('o', 'r', 1, HUMAN))?.number).toBe(1);
    expect(src.calls).toBe(1); // second call is a cache hit
  });

  it('a posted comment drops this issue’s cached detail, so the next read is a fresh one (#693)', async () => {
    // The invalidation, measured at the source rather than through the fixture:
    // `FixtureIssueDetailSource` hands out the SAME object it caches, so a
    // controller-level assertion on the thread's contents passes whether or not
    // anything was evicted. Counting fetches is what cannot.
    const src = new StubSource();
    const svc = new IssueDetailService(src, config(), NO_FOOTERS);
    await svc.getIssue('o', 'r', 1, HUMAN);
    await svc.getIssue('o', 'r', 1, HUMAN);
    expect(src.calls).toBe(1); // the floor: the second read really was cached

    await svc.addComment('o', 'r', 1, 'answered from the board');
    await svc.getIssue('o', 'r', 1, HUMAN);
    expect(src.calls).toBe(2); // …and the write made the third read cold again
  });

  it('caches a 404 so a mistyped URL does not re-hammer the source', async () => {
    const src = new StubSource();
    src.mode = 'missing';
    const svc = new IssueDetailService(src, config(), NO_FOOTERS);
    expect(await svc.getIssue('o', 'r', 9, HUMAN)).toBeNull();
    expect(await svc.getIssue('o', 'r', 9, HUMAN)).toBeNull();
    expect(src.calls).toBe(1);
  });

  it('propagates a cold-fetch error (nothing cached to fall back to)', async () => {
    const src = new StubSource();
    src.mode = 'throw';
    const svc = new IssueDetailService(src, config(), NO_FOOTERS);
    await expect(svc.getIssue('o', 'r', 1, HUMAN)).rejects.toThrow('boom');
  });

  it('serves the stale value on a refresh error instead of throwing', async () => {
    const src = new StubSource();
    const svc = new IssueDetailService(src, config(0), NO_FOOTERS); // TTL 0 → always stale after prime
    expect((await svc.getIssue('o', 'r', 1, HUMAN))?.number).toBe(1); // prime (cold)
    src.mode = 'throw';
    // Now stale: returns the primed value immediately; the background refresh throws
    // and is swallowed (never surfaces to the caller).
    expect((await svc.getIssue('o', 'r', 1, HUMAN))?.number).toBe(1);
  });

  it('closeIssue delegates to the source and drops the cache entry (#287/#291)', async () => {
    const src = new StubSource();
    const svc = new IssueDetailService(src, config(), NO_FOOTERS); // long TTL
    await svc.getIssue('o', 'r', 1, HUMAN); // prime the cache (1 fetch)
    await svc.closeIssue('o', 'r', 1);
    expect(src.closes).toEqual([['o', 'r', 1]]);
    await svc.getIssue('o', 'r', 1, HUMAN); // cache was invalidated → a fresh fetch
    expect(src.calls).toBe(2);
  });
});

/**
 * #497 — the body route. A feedback submission's body is the end user's message
 * plus its `Submitted by <address>` footer, and its comments are the thread on
 * top; there is no version of that worth serving redacted, so a static agent
 * token is refused. An ordinary issue in the same repo is not.
 */
describe('IssueDetailService — a static agent token and a feedback submission (#497)', () => {
  const submission: Partial<IssueDetail> = {
    owner: 'acme',
    repo: 'board',
    labels: [{ name: 'feedback', color: 'd4c5f9' }],
    title: '[Bug] my weekly report never arrives',
    bodyMarkdown: 'It just spins.\n\n---\nSubmitted by someone@example.com via the board feedback form.',
  };
  const teamIssue: Partial<IssueDetail> = {
    owner: 'acme',
    repo: 'board',
    labels: [{ name: 'access', color: 'd4c5f9' }],
    title: 'a static agent token still reads feedback content',
    bodyMarkdown: 'Found during the pre-merge security review of #482.',
  };

  it('refuses the submission — neither the words nor the address cross the wire', async () => {
    const svc = new IssueDetailService(new StubSource(submission), config(), NO_FOOTERS);
    await expect(svc.getIssue('acme', 'board', 460, STATIC_AGENT)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('still serves an ordinary issue in the same repo, body and all', async () => {
    const svc = new IssueDetailService(new StubSource(teamIssue), config(), NO_FOOTERS);
    const issue = await svc.getIssue('acme', 'board', 497, STATIC_AGENT);
    expect(issue?.bodyMarkdown).toBe(teamIssue.bodyMarkdown);
  });

  it('a human session reads the submission', async () => {
    const svc = new IssueDetailService(new StubSource(submission), config(), NO_FOOTERS);
    const issue = await svc.getIssue('acme', 'board', 460, HUMAN);
    expect(issue?.bodyMarkdown).toContain('Submitted by someone@example.com');
  });

  it('a personal access token reads it too — it carries its owner’s address', async () => {
    const pat = { agent: true, email: 'octocat@example.com' };
    const svc = new IssueDetailService(new StubSource(submission), config(), NO_FOOTERS);
    expect((await svc.getIssue('acme', 'board', 460, pat))?.title).toBe(submission.title);
  });

  it('the refusal holds on a cached copy too, not only on the cold fetch', async () => {
    const src = new StubSource(submission);
    const svc = new IssueDetailService(src, config(), NO_FOOTERS);
    // A teammate primes the cache…
    await svc.getIssue('acme', 'board', 460, HUMAN);
    // …and the static token is still refused off that same cached entry.
    await expect(svc.getIssue('acme', 'board', 460, STATIC_AGENT)).rejects.toThrow(
      ForbiddenException,
    );
    expect(src.calls).toBe(1);
  });
});

/**
 * #516 — the same route after ordinary triage. This is the one path that needs
 * nothing shared: it has already fetched the body, so it reads the footer off
 * the body in its hand. No index, no cache, no coupling.
 */
describe('IssueDetailService — a submission whose labels were changed (#516)', () => {
  const SUBMITTER = 'someone@example.com';
  const FOOTERED_BODY = `It just spins.\n\n---\nSubmitted by ${SUBMITTER} via the board feedback form.`;
  /** `feedback` swapped for `bug`, which is exactly what triage does. */
  const relabelled: Partial<IssueDetail> = {
    owner: 'acme',
    repo: 'board',
    labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'in progress', color: '0e8a16' }],
    labelsComplete: true,
    title: '[Bug] my weekly report never arrives',
    bodyMarkdown: FOOTERED_BODY,
  };

  it('refuses it — the labels stopped saying what it is, the footer did not', async () => {
    const svc = new IssueDetailService(new StubSource(relabelled), config(), NO_FOOTERS);
    await expect(svc.getIssue('acme', 'board', 902, STATIC_AGENT)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('a human session and a personal access token read it whole, address intact', async () => {
    for (const viewer of [HUMAN, { agent: true, email: 'octocat@example.com' }]) {
      const svc = new IssueDetailService(new StubSource(relabelled), config(), NO_FOOTERS);
      const issue = await svc.getIssue('acme', 'board', 902, viewer);
      expect(issue?.bodyMarkdown).toContain(SUBMITTER);
      expect(issue?.title).toBe(relabelled.title);
    }
  });

  it('recognises a footer a triager appended a routing note to', async () => {
    const edited = { ...relabelled, bodyMarkdown: `${FOOTERED_BODY} — routed to #520` };
    const svc = new IssueDetailService(new StubSource(edited), config(), NO_FOOTERS);
    await expect(svc.getIssue('acme', 'board', 902, STATIC_AGENT)).rejects.toThrow(
      ForbiddenException,
    );
  });

  /** The guard the other way: the marker must not widen the rule. An ordinary
   *  board-repo issue with no footer and no feedback label stays readable. */
  it('leaves an ordinary board-repo issue readable — no footer, no feedback label', async () => {
    const ordinary = { ...relabelled, bodyMarkdown: 'The apply step logs nothing when the quota rejects it.' };
    const svc = new IssueDetailService(new StubSource(ordinary), config(), NO_FOOTERS);
    const issue = await svc.getIssue('acme', 'board', 903, STATIC_AGENT);
    expect(issue?.bodyMarkdown).toBe(ordinary.bodyMarkdown);
  });

  /** …and the blast radius is one repo: the same footered body elsewhere is read
   *  end to end, because the repo is settled before either marker. */
  it('a footered body in another repo is served — the repo gate runs first', async () => {
    const elsewhere = { ...relabelled, owner: 'acme', repo: 'acme' };
    const svc = new IssueDetailService(new StubSource(elsewhere), config(), NO_FOOTERS);
    expect((await svc.getIssue('acme', 'acme', 218, STATIC_AGENT))?.bodyMarkdown).toBe(FOOTERED_BODY);
  });
});

/**
 * #497 — the relations panel, and the door the body gate left open. The issue
 * asked for is an ORDINARY team issue, so it passes the gate; what hangs off it
 * is a submission, and the page names neighbours by title. Filing a submission
 * under an umbrella is how this repo works, so this is the live path, not a
 * corner.
 */
describe('IssueDetailService — a submission among an ordinary issue’s relations (#497)', () => {
  const SUBMISSION_TITLE = '[Bug] my weekly report never arrives and the button just spins';

  /** The submission, as a relation of the host issue. */
  const child = {
    owner: 'acme',
    repo: 'board',
    number: 901,
    title: SUBMISSION_TITLE,
    state: 'open' as const,
    url: 'https://github.com/acme/board/issues/901',
    labels: ['feedback', 'bug'],
  };
  const sibling = { ...child, number: 902, title: 'Rewrap the README paragraph', labels: ['docs'] };

  /** An ordinary team issue in the feedback repo — readable end to end — whose
   *  sub-issues include a submission. */
  const umbrella: Partial<IssueDetail> = {
    owner: 'acme',
    repo: 'board',
    labels: [{ name: 'access', color: 'd4c5f9' }],
    labelsComplete: true,
    title: 'Close the feedback doors',
    bodyMarkdown: 'Found during the pre-merge security review of #482.',
    relations: {
      parent: null,
      subIssues: [child, sibling],
      subIssuesTotal: 2,
      subIssuesClosed: 0,
      blockedBy: [child],
      blocking: [],
    },
  };

  it('the host issue is served — the neighbour is not a reason to refuse the route', async () => {
    const svc = new IssueDetailService(new StubSource(umbrella), config(), NO_FOOTERS);
    const issue = await svc.getIssue('acme', 'board', 497, STATIC_AGENT);
    expect(issue?.bodyMarkdown).toBe(umbrella.bodyMarkdown);
  });

  it('a static agent token gets no submission title through subIssues or blockedBy', async () => {
    const svc = new IssueDetailService(new StubSource(umbrella), config(), NO_FOOTERS);
    const issue = await svc.getIssue('acme', 'board', 497, STATIC_AGENT);
    expect(issue?.relations.subIssues.map((r) => r.title)).toEqual([
      HIDDEN_FEEDBACK_TITLE,
      sibling.title,
    ]);
    expect(issue?.relations.blockedBy[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
    expect(JSON.stringify(issue)).not.toContain(SUBMISSION_TITLE);
  });

  it('a human session reads every relation title', async () => {
    const svc = new IssueDetailService(new StubSource(umbrella), config(), NO_FOOTERS);
    const issue = await svc.getIssue('acme', 'board', 497, HUMAN);
    expect(issue?.relations.subIssues.map((r) => r.title)).toEqual([SUBMISSION_TITLE, sibling.title]);
  });

  it('the gate holds on a cached copy a teammate primed', async () => {
    const src = new StubSource(umbrella);
    const svc = new IssueDetailService(src, config(), NO_FOOTERS);
    await svc.getIssue('acme', 'board', 497, HUMAN);
    const issue = await svc.getIssue('acme', 'board', 497, STATIC_AGENT);
    expect(issue?.relations.subIssues[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
    expect(src.calls).toBe(1);
  });

  it('and the reverse: a token’s read does not poison the copy a human then gets', async () => {
    const src = new StubSource(umbrella);
    const svc = new IssueDetailService(src, config(), NO_FOOTERS);
    await svc.getIssue('acme', 'board', 497, STATIC_AGENT);
    const issue = await svc.getIssue('acme', 'board', 497, HUMAN);
    expect(issue?.relations.subIssues[0].title).toBe(SUBMISSION_TITLE);
    expect(src.calls).toBe(1);
  });

  it('relation labels are fetched to decide with and never served', async () => {
    const svc = new IssueDetailService(new StubSource(umbrella), config(), NO_FOOTERS);
    const issue = await svc.getIssue('acme', 'board', 497, HUMAN);
    for (const r of issue!.relations.subIssues) expect(r).not.toHaveProperty('labels');
  });
});

/**
 * #497 — the host issue's own labels. The decision keys on a label being
 * present, so a truncated label page would read as "no `feedback` label" and
 * serve the body. An issue whose set we could not establish is treated as a
 * possible submission — but only in the repo where one could live.
 */
describe('IssueDetailService — a host issue whose labels were truncated (#497)', () => {
  const truncated: Partial<IssueDetail> = {
    owner: 'acme',
    repo: 'board',
    labels: [{ name: 'access', color: 'd4c5f9' }],
    labelsComplete: false,
    bodyMarkdown: 'It just spins.\n\n---\nSubmitted by someone@example.com via the board feedback form.',
  };

  it('refuses a static agent token rather than reading "no feedback label" off a partial page', async () => {
    const svc = new IssueDetailService(new StubSource(truncated), config(), NO_FOOTERS);
    await expect(svc.getIssue('acme', 'board', 460, STATIC_AGENT)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('costs the token nothing outside the feedback repo, where no submission can live', async () => {
    const svc = new IssueDetailService(
      new StubSource({ ...truncated, owner: 'acme', repo: 'acme' }),
      config(),
      NO_FOOTERS,
    );
    const issue = await svc.getIssue('acme', 'acme', 218, STATIC_AGENT);
    expect(issue?.bodyMarkdown).toBe(truncated.bodyMarkdown);
  });

  it('a human session reads it either way', async () => {
    const svc = new IssueDetailService(new StubSource(truncated), config(), NO_FOOTERS);
    expect((await svc.getIssue('acme', 'board', 460, HUMAN))?.bodyMarkdown).toContain(
      'Submitted by',
    );
  });
});

/**
 * #516 — the one route that served words without asking the rule.
 *
 * `toggleTask` returns Github's whole stored body, which on a submission is an
 * end user's message under their address, and no version of `mayReadWords` ran
 * on that path. A static agent token cannot reach the route today because it
 * carries `@UseGuards(HumanOnlyGuard)` — that is a real control, for a separate
 * reason, and it stays the primary one. This is depth behind it, so the rule the
 * plan calls the only answer to "may this caller read these words" actually
 * answers on every path that serves them.
 */
describe('IssueDetailService — the task-toggle route asks the words rule too (#516)', () => {
  const SUBMITTER = 'someone@example.com';
  const submissionBody = [
    'It just spins.',
    '',
    '- [ ] chase the digest job',
    '',
    '---',
    `Submitted by ${SUBMITTER} via the board feedback form.`,
  ].join('\n');
  const relabelled: Partial<IssueDetail> = {
    owner: 'acme',
    repo: 'board',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    labelsComplete: true,
    bodyMarkdown: submissionBody,
  };

  it('refuses a static-agent viewer, and no body crosses the wire', async () => {
    const svc = new IssueDetailService(new StubSource(relabelled), config(), NO_FOOTERS);
    await expect(
      svc.toggleTask('acme', 'board', 902, 3, true, STATIC_AGENT),
    ).rejects.toThrow(ForbiddenException);
  });

  it('a human toggle is untouched — the body comes back with the address intact', async () => {
    const svc = new IssueDetailService(new StubSource(relabelled), config(), NO_FOOTERS);
    const body = await svc.toggleTask('acme', 'board', 902, 3, true, HUMAN);
    expect(body).toContain(SUBMITTER);
  });

  it('an ordinary issue toggles for a human exactly as before', async () => {
    const ordinary = { ...relabelled, bodyMarkdown: 'It just spins.\n\n- [ ] chase the digest job' };
    const svc = new IssueDetailService(new StubSource(ordinary), config(), NO_FOOTERS);
    expect(await svc.toggleTask('acme', 'board', 903, 3, true, HUMAN)).toContain('chase');
  });

  /**
   * This path passes `labels: null` — a write echoes a body, not a label set —
   * so inside the feedback repo it fails closed for a static agent whatever the
   * body says. That is the intended answer and costs nothing: no human reaches
   * it (`mayReadWords` short-circuits on any caller with a real address) and no
   * static agent reaches the route at all, because `HumanOnlyGuard` refuses it
   * first.
   */
  it('refuses a static agent anywhere in the feedback repo — a write echoes no label set', async () => {
    const ordinary = { ...relabelled, bodyMarkdown: 'It just spins.\n\n- [ ] chase the digest job' };
    const svc = new IssueDetailService(new StubSource(ordinary), config(), NO_FOOTERS);
    await expect(
      svc.toggleTask('acme', 'board', 903, 3, true, STATIC_AGENT),
    ).rejects.toThrow(ForbiddenException);
  });

  it('…and outside it a static agent is unaffected, since no submission can live there', async () => {
    const ordinary = { ...relabelled, owner: 'acme', repo: 'acme', bodyMarkdown: '- [ ] chase the digest job' };
    const svc = new IssueDetailService(new StubSource(ordinary), config(), NO_FOOTERS);
    expect(await svc.toggleTask('acme', 'acme', 218, 1, true, STATIC_AGENT)).toContain('chase');
  });

  it('the cache entry is dropped even when the body is refused — no stale copy left behind', async () => {
    const src = new StubSource(relabelled);
    const svc = new IssueDetailService(src, config(), NO_FOOTERS);
    await svc.getIssue('acme', 'board', 902, HUMAN); // prime (1 fetch)
    await expect(
      svc.toggleTask('acme', 'board', 902, 3, true, STATIC_AGENT),
    ).rejects.toThrow(ForbiddenException);
    await svc.getIssue('acme', 'board', 902, HUMAN);
    expect(src.calls).toBe(2); // the refusal still invalidated the write's issue
  });

  it('a footered body in another repo is served — the repo gate runs first here too', async () => {
    const elsewhere = { ...relabelled, owner: 'acme', repo: 'acme' };
    const svc = new IssueDetailService(new StubSource(elsewhere), config(), NO_FOOTERS);
    expect(await svc.toggleTask('acme', 'acme', 218, 3, true, STATIC_AGENT)).toContain(SUBMITTER);
  });
});

/**
 * The index is resolved only for a viewer the words are actually withheld from.
 *
 * `mayReadWords` returns true before `submission` is ever consulted whenever
 * `withheldFrom(viewer)` is false, so for a human the index's value is provably
 * never read — and resolving it anyway put this route on the shared issues
 * cache for no benefit. That matters on a boot whose warm failed: `this.cache`
 * stays null, so the next read takes the cold path into an org-wide ~70-repo
 * scan, on a route that had no dependency on that cache at all before #516. The
 * in-flight dedupe covers concurrent callers but not sequential ones, so a burst
 * of issue-page loads under a Github outage becomes a burst of org-wide scans —
 * the shape that trips secondary rate limits and keeps the cache cold.
 *
 * The gate is the same predicate the decision uses, exported rather than copied,
 * so there is one definition of who is withheld.
 */
describe('IssueDetailService — the relations index is resolved only when it can matter (#516)', () => {
  const SUBMISSION_TITLE = '[Bug] my weekly report never arrives and the button just spins';
  const child = {
    owner: 'acme',
    repo: 'board',
    number: 901,
    title: SUBMISSION_TITLE,
    state: 'open' as const,
    url: 'https://github.com/acme/board/issues/901',
    labels: ['feedback', 'bug'],
  };
  const umbrella: Partial<IssueDetail> = {
    owner: 'acme',
    repo: 'board',
    labels: [{ name: 'access', color: 'd4c5f9' }],
    labelsComplete: true,
    title: 'Close the feedback doors',
    bodyMarkdown: 'Found during the pre-merge security review of #482.',
    relations: {
      parent: null,
      subIssues: [child],
      subIssuesTotal: 1,
      subIssuesClosed: 0,
      blockedBy: [],
      blocking: [],
    },
  };

  /** Counts the reads, so "did this route touch the issues cache at all" is an
   *  assertion rather than an inference. */
  function countingCache() {
    const calls = { n: 0 };
    const cache = {
      submissionIndex: async () => {
        calls.n += 1;
        return { lookup: () => false };
      },
    } as unknown as IssuesCacheService;
    return { cache, calls };
  }

  for (const [who, viewer] of [
    ['a human session', HUMAN],
    ['a personal access token', { agent: true, email: 'octocat@example.com' }],
  ] as const) {
    it(`${who} never reaches the issues cache — the index's value could not be read anyway`, async () => {
      const { cache, calls } = countingCache();
      const svc = new IssueDetailService(new StubSource(umbrella), config(), cache);
      const issue = await svc.getIssue('acme', 'board', 497, viewer);
      expect(calls.n).toBe(0);
      // …and the response is exactly what it was: every relation title whole.
      expect(issue?.relations.subIssues.map((r) => r.title)).toEqual([SUBMISSION_TITLE]);
    });
  }

  for (const [who, viewer] of [
    ['a static agent token', STATIC_AGENT],
    ['a caller with no address at all', undefined],
  ] as const) {
    it(`${who} still resolves it — this is the viewer the gate exists for`, async () => {
      const { cache, calls } = countingCache();
      const svc = new IssueDetailService(new StubSource(umbrella), config(), cache);
      const issue = await svc.getIssue('acme', 'board', 497, viewer);
      expect(calls.n).toBe(1);
      expect(issue?.relations.subIssues[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
    });
  }

  it('a cache that would fail is never even asked on a human read', async () => {
    const exploding = {
      submissionIndex: async () => {
        throw new Error('the org-wide scan should not have run');
      },
    } as unknown as IssuesCacheService;
    const svc = new IssueDetailService(new StubSource(umbrella), config(), exploding);
    const issue = await svc.getIssue('acme', 'board', 497, HUMAN);
    expect(issue?.relations.subIssues[0].title).toBe(SUBMISSION_TITLE);
  });
});

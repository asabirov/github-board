import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GithubIssueDetailSource, closedBefore } from './github-issue-detail.source';
import { TaskToggleError } from './body-tasks';
import type { CapabilityRegistry } from '../capability/capability.registry';
import { gh } from '../capability/capability-testing.contract';
import { IssueNotFoundError, ProjectTitleTakenError } from './issue-detail.types';

/**
 * What the live issue query ASKS FOR (#497).
 *
 * The words gate keys on a label being present, so a query that stops selecting
 * labels does not fail — it quietly answers "no `feedback` label here" for every
 * issue on the route, and serves an end user's sentence to a static token. The
 * board never renders a relation's labels, so deleting that selection is a
 * plausible tidy-up with no visible effect. This spec is what makes it visible.
 *
 * `totalCount` is part of the requirement, not decoration: without it there is
 * no way to tell a complete label page from a first one, and `knownLabels`
 * treats a page it cannot show complete as unknown.
 */

const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;

/**
 * The source with both lazily-built Octokit clients preset, and the query it sends.
 *
 * #625 split the source's one memoized client into a read client and a write
 * client. Every stub in this file presets BOTH fields to the SAME object, on
 * purpose: these tests are about refusal classification, not about credentials,
 * and one shared object keeps each call count and each rejection reaching
 * exactly what it reached before the split. Which credential each call actually
 * goes out under is measured on the wire in `write-credential.spec.ts`.
 */
async function queryFor(): Promise<string> {
  const graphql = vi.fn().mockResolvedValue({ repository: { issue: null } });
  const src = new GithubIssueDetailSource(config);
  // @ts-expect-error — preset BOTH lazily-built clients with one stub (#625)
  src.readClient = src.writeClient = { graphql };
  await src.fetch('acme', 'board', 497);
  return graphql.mock.calls[0][0] as string;
}

describe('GithubIssueDetailSource — the query the gate depends on (#497)', () => {
  it('asks for the host issue’s labels with a totalCount to check the page against', () => {
    return queryFor().then((query) => {
      expect(query).toMatch(/labels\(first:\s*\d+\)\s*\{[^}]*totalCount/);
    });
  });

  it('asks for every relation’s label names — the `rel` fragment every kind reads', async () => {
    const query = await queryFor();
    const fragment = /fragment rel on Issue \{([\s\S]*?)\n/.exec(query)?.[1] ?? '';
    expect(fragment).toMatch(/labels\(first:\s*\d+\)/);
    expect(fragment).toMatch(/totalCount/);
    expect(fragment).toMatch(/name/);
  });

  it('reads every relation kind through that one fragment, so none is left ungated', async () => {
    const query = await queryFor();
    for (const field of ['parent', 'subIssues', 'blockedBy', 'blocking']) {
      expect(query).toMatch(new RegExp(`${field}[^\\n]*\\.\\.\\.rel`));
    }
  });
});

describe('GithubIssueDetailSource — what counts as an absence (#584)', () => {
  /** The source with a stubbed Octokit whose `issues.update` refuses.
   *
   *  `issues.get` is part of the stub because task 5's `learn` RE-READS the
   *  issue to earn a 404, and it answers "not there" — which is what makes the
   *  absences below the absences they claim to be. The shape is
   *  `octokit.issues.…`, never `octokit.rest.issues.…`: every write in the
   *  source reaches Github that way, so a stub built with `rest` is reached by
   *  nothing. */
  const sourceRefusing = (err: unknown) => {
    const src = new GithubIssueDetailSource(config);
    const client = {
      issues: { update: vi.fn().mockRejectedValue(err), get: vi.fn().mockRejectedValue(gh(404)) },
    };
    // @ts-expect-error — preset BOTH lazily-built clients with one stub (#625)
    src.readClient = src.writeClient = client;
    return src;
  };

  it('a plain 404 is still an absence, and still answers as one', async () => {
    await expect(
      sourceRefusing(Object.assign(new Error('Not Found'), { status: 404 })).setState(
        'acme',
        'board',
        1,
        'closed',
      ),
    ).rejects.toBeInstanceOf(IssueNotFoundError);
  });

  it('a GraphQL NOT_FOUND with no status is still an absence', async () => {
    await expect(
      sourceRefusing(Object.assign(new Error('gql'), { errors: [{ type: 'NOT_FOUND' }] })).setState(
        'acme',
        'board',
        1,
        'closed',
      ),
    ).rejects.toBeInstanceOf(IssueNotFoundError);
  });

  it('a 403 carrying a NOT_FOUND error is a REFUSAL, not an absence', async () => {
    // The old predicate read `status === 404 || errors.some(NOT_FOUND)`, so this
    // shape answered "absent". Through the classifier the 403 rung runs first
    // and it answers "refused" — which is the correct reading, a refusal being
    // the opposite of an absence. Github does not produce this shape today, so
    // it is pinned here rather than discovered later.
    const err = Object.assign(new Error('Forbidden'), {
      status: 403,
      errors: [{ type: 'NOT_FOUND' }],
    });
    // Task 5 moved what a refusal LOOKS like on the way out: it used to escape
    // raw and reach Nest as a bare 500, and it now carries its own status.
    const thrown = await sourceRefusing(err)
      .setState('acme', 'board', 1, 'closed')
      .catch((e: unknown) => e);
    expect(thrown).not.toBeInstanceOf(IssueNotFoundError);
    expect((thrown as HttpException).getStatus()).toBe(403);
  });
});

/**
 * The nine issue routes stop swallowing, and every one of them teaches (#584
 * task 5).
 *
 * Two claims, and this task makes both: the registry is told what Github
 * refused, and the PERSON is told too — where a Github refusal on these routes
 * used to reach Nest as an unrecognised error and answer 500 with an empty
 * body, beside a Retry that could never work.
 */
describe('GithubIssueDetailSource — what a refused issue write answers with (#584)', () => {
  /** A registry that records nothing and answers nothing — these tests are about
   *  what the CALLER gets back, not about what was learned. */
  const deaf = { recordRefusal: () => {}, recordSuccess: () => {} } as unknown as CapabilityRegistry;

  /** The source with its lazily-built client preset, the way `queryFor` above
   *  already does it. */
  const withOctokit = (issues: Record<string, unknown>, registry: CapabilityRegistry = deaf) => {
    const src = new GithubIssueDetailSource(config, registry);
    // @ts-expect-error — preset BOTH lazily-built clients with one stub (#625)
    src.readClient = src.writeClient = { issues, graphql: vi.fn() };
    return src;
  };

  /** Records what the source taught, so a test asserts a call list. */
  const recorder = () => {
    const calls: { cap: string; target?: string; reason: string }[] = [];
    return {
      calls,
      registry: {
        recordRefusal: (cap: string, r: { reason: string }, target?: string) =>
          calls.push({ cap, target, reason: r.reason }),
        recordSuccess: () => {},
      } as unknown as CapabilityRegistry,
    };
  };

  it('a refused issue write answers 403 with a reason, where it answered 500', async () => {
    // The half a "classify in order to learn" implementation would skip: the
    // registry is told, the person is not, and the facet editor still renders
    // "Couldn’t save" beside a Retry that cannot work.
    const src = withOctokit({ update: vi.fn().mockRejectedValue(gh(403)) });

    const err = await src.setState('acme', 'board', 1, 'closed').catch((e: unknown) => e);

    expect((err as HttpException).getStatus()).toBe(403);
    expect((err as HttpException).getResponse()).toMatchObject({ reason: 'not-permitted' });
  });

  it('logs a refusal the person sees at warn, not at error (#1450)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const src = withOctokit({ update: vi.fn().mockRejectedValue(gh(403)) });

    await src.setState('acme', 'board', 1, 'closed').catch(() => undefined);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('issue acme/board#1 setState failed'));
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('…and a genuinely absent issue still throws IssueNotFoundError, unchanged', async () => {
    // The rung this task must not break. Same source, same shape, opposite
    // branch: the write 404s AND the re-read 404s, so nothing is earned and the
    // absence stands.
    const src = withOctokit({
      update: vi.fn().mockRejectedValue(gh(404)),
      get: vi.fn().mockRejectedValue(gh(404)),
    });

    await expect(src.setState('acme', 'board', 1, 'closed')).rejects.toBeInstanceOf(
      IssueNotFoundError,
    );
  });

  it('a 404 on an issue the board can still READ answers 403, not 404', async () => {
    // #577's shape, arriving by the issue door. The write 404s, the re-read
    // finds the issue, so the 404 was a missing permission wearing an absence.
    const src = withOctokit({
      update: vi.fn().mockRejectedValue(gh(404)),
      get: vi.fn().mockResolvedValue({ data: { number: 1 } }),
    });

    const err = await src.setState('acme', 'board', 1, 'closed').catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(IssueNotFoundError);
    expect((err as HttpException).getStatus()).toBe(403);
  });

  it('teaches on owner/repo, never on the issue number', async () => {
    // A per-issue key would be remembered and never read: task 9's envelope has
    // `owner` and `repo` and the issue number, and keys on the repo — so
    // `acme/board#1` would match nothing on nine of the eleven writes,
    // silently, a rung that matches nothing throwing nothing.
    const { calls, registry } = recorder();
    // `issues.setLabels`, which is the call `setLabels` actually makes — a stub
    // built around `update` would have this test record a TypeError as
    // `try-again` and pass for the wrong reason.
    const src = withOctokit({ setLabels: vi.fn().mockRejectedValue(gh(403)) }, registry);

    await src.setLabels('acme', 'board', 1, ['bug']).catch(() => undefined);

    expect(calls).toEqual([
      { cap: 'issue.labels', target: 'acme/board', reason: 'not-permitted' },
    ]);
  });

  it('a refused close teaches issue.close, not issue.state', async () => {
    // Without the capability travelling through `close`, one refused close
    // records `issue.state` — and once the guard enforces, closing one issue
    // disables the state toggle on every issue.
    const { calls, registry } = recorder();
    const src = withOctokit({ update: vi.fn().mockRejectedValue(gh(403)) }, registry);

    await src.close('acme', 'board', 1).catch(() => undefined);

    expect(calls.map((c) => c.cap)).toEqual(['issue.close']);
  });

  it('a close sends the reason as state_reason and answers with the one Github stored (#1006)', async () => {
    const update = vi.fn().mockResolvedValue({ data: { state: 'closed', state_reason: 'completed' } });
    const src = withOctokit({ update });

    const closed = await src.close('acme', 'board', 1, 'issue.close', 'not_planned');

    expect(update).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'board',
      issue_number: 1,
      state: 'closed',
      state_reason: 'not_planned',
    });
    // Github's answer, not the request: this is what an already-closed issue
    // gives back, and what the page has to report. No `closed_at` and no `Date`
    // came back, so nothing says the close was a no-op, and the row is kept.
    expect(closed).toEqual({ state: 'closed', stateReason: 'completed', alreadyClosed: false });
  });

  it('a close with no reason sends no state_reason, exactly as before #1006', async () => {
    const update = vi.fn().mockResolvedValue({ data: { state: 'closed', state_reason: 'completed' } });
    const src = withOctokit({ update });

    await src.close('acme', 'board', 1);
    await src.setState('acme', 'board', 1, 'open');

    expect(update.mock.calls.map(([args]) => 'state_reason' in args)).toEqual([false, false]);
  });

  describe('a close that found the issue already closed (#1006 review)', () => {
    const answered = 'Fri, 11 Sep 2026 10:00:00 GMT';
    /** `date: null` sends no `Date` header at all. */
    const closeAnswering = (closedAt: string | null, date: string | null = answered) =>
      withOctokit({
        update: vi.fn().mockResolvedValue({
          data: { state: 'closed', state_reason: 'completed', closed_at: closedAt },
          headers: date === null ? {} : { date },
        }),
      });

    it('says so when Github stamped the close well before it answered', async () => {
      const closed = await closeAnswering('2026-09-10T08:00:00Z').close('acme', 'board', 1);
      expect(closed.alreadyClosed).toBe(true);
    });

    it('calls a close stamped as Github answered this one', async () => {
      const closed = await closeAnswering('2026-09-11T09:59:59Z').close('acme', 'board', 1);
      expect(closed.alreadyClosed).toBe(false);
    });

    it('keeps the row wherever either time is missing or unreadable', async () => {
      expect((await closeAnswering(null).close('acme', 'board', 1)).alreadyClosed).toBe(false);
      expect((await closeAnswering('2026-09-10T08:00:00Z', null).close('acme', 'board', 1)).alreadyClosed).toBe(false);
      expect((await closeAnswering('not a time').close('acme', 'board', 1)).alreadyClosed).toBe(false);
    });

    it('never calls a reopen a no-op close', async () => {
      const src = closeAnswering('2026-09-10T08:00:00Z');
      await expect(src.setState('acme', 'board', 1, 'open')).resolves.toBe('open');
    });

    it('draws the line at thirty seconds of Github’s own clock', () => {
      expect(closedBefore('2026-09-11T09:59:31Z', answered)).toBe(false);
      expect(closedBefore('2026-09-11T09:59:29Z', answered)).toBe(true);
    });
  });

  describe('changing assignees by name, never by set (#1009 review)', () => {
    const issue = (logins: string[]) => ({ data: { assignees: logins.map((login) => ({ login, name: null })) } });

    it('adds through Github’s add endpoint with only the people named', async () => {
      const addAssignees = vi.fn().mockResolvedValue(issue(['carol', 'ann']));
      const update = vi.fn();
      const src = withOctokit({ addAssignees, update });

      const held = await src.addAssignees('acme', 'board', 1, ['ann']);

      expect(addAssignees).toHaveBeenCalledWith({ owner: 'acme', repo: 'board', issue_number: 1, assignees: ['ann'] });
      // The replace call is never made, so nothing tells Github the whole set.
      expect(update).not.toHaveBeenCalled();
      // Github's whole answer, carol included, though this request never named her.
      expect(held.map((p) => p.login)).toEqual(['carol', 'ann']);
    });

    it('removes through Github’s remove endpoint with only the people named', async () => {
      const removeAssignees = vi.fn().mockResolvedValue(issue(['carol']));
      const src = withOctokit({ removeAssignees });

      const held = await src.removeAssignees('acme', 'board', 1, ['ann']);

      expect(removeAssignees).toHaveBeenCalledWith({ owner: 'acme', repo: 'board', issue_number: 1, assignees: ['ann'] });
      expect(held.map((p) => p.login)).toEqual(['carol']);
    });

    it('a refused change teaches issue.assignees and answers 403', async () => {
      const { calls, registry } = recorder();
      const src = withOctokit({ addAssignees: vi.fn().mockRejectedValue(gh(403)) }, registry);

      await expect(src.addAssignees('acme', 'board', 1, ['ann'])).rejects.toMatchObject({ status: 403 });
      expect(calls.map((c) => c.cap)).toEqual(['issue.assignees']);
    });

    it('reads who holds the issue with one issues.get, and a missing issue as null', async () => {
      const get = vi.fn().mockResolvedValueOnce(issue(['ann'])).mockRejectedValueOnce(gh(404));
      const src = withOctokit({ get });

      expect(await src.currentAssignees('acme', 'board', 1)).toEqual([{ login: 'ann', name: null }]);
      expect(await src.currentAssignees('acme', 'board', 2)).toBeNull();
      expect(get).toHaveBeenCalledWith({ owner: 'acme', repo: 'board', issue_number: 1 });
    });
  });

  it('a refused comment teaches issue.comment and answers 403, rather than swallowing it (#693)', async () => {
    // This is what lets the page WITHHOLD the composer instead of offering it
    // and failing: a refusal Github gives on this capability has to reach the
    // registry, not only the caller who asked.
    const { calls, registry } = recorder();
    // `issues.createComment`, which is the call `addComment` actually makes — a
    // stub built around `update` would record a TypeError as `try-again` and
    // pass for the wrong reason.
    const src = withOctokit({ createComment: vi.fn().mockRejectedValue(gh(403)) }, registry);

    const err = await src.addComment('acme', 'board', 1, 'hi').catch((e: unknown) => e);

    expect(calls).toEqual([
      { cap: 'issue.comment', target: 'acme/board', reason: 'not-permitted' },
    ]);
    expect((err as HttpException).getStatus()).toBe(403);
  });

  it('a comment on an issue that is genuinely gone is still an IssueNotFoundError (#693)', async () => {
    // The write 404s AND the re-read 404s, so nothing is earned and the absence
    // stands — the route answers 404, exactly as the other writes do.
    const src = withOctokit({
      createComment: vi.fn().mockRejectedValue(gh(404)),
      get: vi.fn().mockRejectedValue(gh(404)),
    });

    await expect(src.addComment('acme', 'board', 1, 'hi')).rejects.toBeInstanceOf(
      IssueNotFoundError,
    );
  });

  it('hands back the comment GITHUB STORED, never the request echoed (#693)', async () => {
    // The page appends this to the thread it is already rendering, so every
    // field has to be Github's: an echo would draw a comment with no permalink
    // and a made-up time, and the first reload would replace it with a
    // different-looking one.
    const createComment = vi.fn().mockResolvedValue({
      data: {
        user: { login: 'board-bot', name: 'Board Bot' },
        body: 'what Github kept',
        created_at: '2026-08-30T04:00:00Z',
        html_url: 'https://github.com/acme/board/issues/1#issuecomment-42',
      },
    });
    const src = withOctokit({ createComment });

    const posted = await src.addComment('acme', 'board', 1, 'what the caller sent');

    // Verbatim on the way out: markdown is the body's format, and anything done
    // to it here would be done to somebody's words.
    expect(createComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'board',
      issue_number: 1,
      body: 'what the caller sent',
    });
    expect(posted).toEqual({
      author: { login: 'board-bot', name: 'Board Bot' },
      bodyMarkdown: 'what Github kept',
      createdAt: '2026-08-30T04:00:00Z',
      htmlUrl: 'https://github.com/acme/board/issues/1#issuecomment-42',
    });
  });

  it('a refused Projects v2 mutation teaches and answers, where it had no catch at all', async () => {
    // These three arrive HTTP 200 with an `errors` array, so they fell through
    // `run()` untouched and became a 500. Their target is `owner/repo` too —
    // the node id would be more precise and unenforceable.
    const { calls, registry } = recorder();
    const src = withOctokit({}, registry);
    // @ts-expect-error — the mutations go through the write client's `graphql`
    src.writeClient.graphql = vi.fn().mockRejectedValue(
      Object.assign(new Error('gql'), { errors: [{ type: 'FORBIDDEN' }] }),
    );

    const err = await src
      .removeFromProject('ITEM_1', 'PVT_1', 'acme', 'board')
      .catch((e: unknown) => e);

    expect(calls).toEqual([
      { cap: 'issue.project.remove', target: 'acme/board', reason: 'not-permitted' },
    ]);
    expect((err as HttpException).getStatus()).toBe(403);
  });

  it('a toggle whose line is no longer a task stays a client error, unclassified', async () => {
    // Not a Github answer at all. Classifying it would file a client error as
    // `try-again` and pay for a re-read to do it.
    const { calls, registry } = recorder();
    const src = withOctokit(
      {
        get: vi.fn().mockResolvedValue({ data: { body: 'not a task list' } }),
        update: vi.fn(),
      },
      registry,
    );

    await expect(src.toggleTask('acme', 'board', 1, 1, true)).rejects.toBeInstanceOf(
      TaskToggleError,
    );
    expect(calls).toEqual([]);
  });
});

/**
 * A read that failed is not a write that was refused (#584 task 5, narrowed).
 *
 * Two of the writes read something first — `toggleTask` fetches the current body
 * before rewriting it, `addToProject` resolves the issue's node id before adding
 * it — and task 5 put both reads inside the `try` that classifies. A 403 on the
 * READ then taught the registry a refusal that never happened, and told the
 * person the board is not permitted to do something when in truth the board
 * could not look something up. The classifying `try` holds the mutating call and
 * nothing else; a failed read answers exactly what it answered before task 5.
 *
 * The third case is not a read but has the same shape: `setFieldValue` shaped the
 * request's own value inside that block, so a malformed body classified as a
 * Github answer.
 */
describe('GithubIssueDetailSource — a failed read is not a refused write (#584)', () => {
  const recorder = () => {
    const calls: { cap: string; reason: string }[] = [];
    return {
      calls,
      registry: {
        recordRefusal: (cap: string, r: { reason: string }) => calls.push({ cap, reason: r.reason }),
        recordSuccess: () => {},
      } as unknown as CapabilityRegistry,
    };
  };

  it('a 403 reading the body teaches nothing and reaches the caller as it was thrown', async () => {
    const { calls, registry } = recorder();
    const denied = gh(403, {}, 'Forbidden');
    const update = vi.fn();
    const src = new GithubIssueDetailSource(config, registry);
    // @ts-expect-error — preset BOTH lazily-built clients with one stub (#625)
    src.readClient = src.writeClient = { issues: { get: vi.fn().mockRejectedValue(denied), update }, graphql: vi.fn() };

    const thrown = await src.toggleTask('acme', 'board', 1, 1, true).catch((e: unknown) => e);

    expect(thrown).toBe(denied);
    expect(calls).toEqual([]);
    // The write was never attempted, so there is nothing for a refusal to be about.
    expect(update).not.toHaveBeenCalled();
  });

  it('a 403 resolving the issue node id teaches nothing and never reaches the mutation', async () => {
    const { calls, registry } = recorder();
    const denied = gh(403, {}, 'Forbidden');
    const graphql = vi
      .fn()
      .mockRejectedValueOnce(denied)
      .mockResolvedValue({ addProjectV2ItemById: { item: { id: 'ITEM_1' } } });
    const src = new GithubIssueDetailSource(config, registry);
    // @ts-expect-error — preset BOTH lazily-built clients with one stub (#625)
    src.readClient = src.writeClient = { issues: {}, graphql };

    const thrown = await src
      .addToProject('acme', 'board', 1, 'PVT_1')
      .catch((e: unknown) => e);

    expect(thrown).toBe(denied);
    expect(calls).toEqual([]);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('a value this process cannot express is a client error, not a Github refusal', async () => {
    // `isFieldClear` and `toGqlFieldValue` read the request's own value and call
    // no one. Inside the classifying block, the TypeError they throw on a
    // malformed body has no status and no `errors` array, so the classifier read
    // it as an unrecognised Github failure: measured, `try-again` and HTTP 502
    // "Github could not be reached on acme/board", plus a `try-again`
    // handed to the registry — which drops it, so the cost is the answer and the
    // retry it invites, not a stored refusal. The recorder below records
    // everything the source SAYS, which is the claim being tested.
    const { calls, registry } = recorder();
    const graphql = vi.fn();
    const src = new GithubIssueDetailSource(config, registry);
    // @ts-expect-error — preset BOTH lazily-built clients with one stub (#625)
    src.readClient = src.writeClient = { issues: {}, graphql };

    const thrown = await src
      // @ts-expect-error — the shape a malformed request body arrives in
      .setFieldValue('PVT_1', 'ITEM_1', 'FIELD_1', null, 'acme', 'board')
      .catch((e: unknown) => e);

    // Raw. A classified one would arrive as an HttpException carrying 502, and
    // an HttpException is not a TypeError, so this asserts the absence too.
    expect(thrown).toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });
});

/**
 * A new project reads before it writes (#982): the issue, the owner's node id
 * and the owner's open projects by that name, in one query, and then only the
 * mutation. Every refusal below is answered with no mutation sent.
 */
describe('GithubIssueDetailSource.createProject reads before it writes (#982)', () => {
  const MADE = { id: 'PVT_2', number: 2, title: 'Launch week', url: 'https://github.com/orgs/acme/projects/2' };
  const setup = (read: unknown) => {
    const graphql = vi.fn().mockImplementation(async (doc: string) => {
      if (doc.includes('createProjectV2')) return { createProjectV2: { projectV2: MADE } };
      if (read instanceof Error) throw read;
      return read;
    });
    const src = new GithubIssueDetailSource(config);
    // @ts-expect-error — preset BOTH lazily-built clients with one stub (#625)
    src.readClient = src.writeClient = { graphql };
    return { src, graphql };
  };
  const found = (nodes: { id: string; number: number; title: string; closed: boolean }[]) => ({
    repository: { issue: { id: 'I_1' } },
    repositoryOwner: { id: 'O_1', login: 'acme', projectsV2: { nodes } },
  });
  const wrote = (graphql: ReturnType<typeof vi.fn>) =>
    graphql.mock.calls.some(([doc]) => String(doc).includes('createProjectV2'));

  it('searches open projects for the name, and makes the project when only a closed one has it', async () => {
    const { src, graphql } = setup(found([{ id: 'PVT_1', number: 1, title: 'Launch week', closed: true }]));
    await expect(src.createProject('acme', 'board', 1, 'Launch week')).resolves.toEqual({ ...MADE, owner: 'acme' });
    expect(graphql.mock.calls[0][1]).toEqual({ o: 'acme', r: 'board', n: 1, q: 'is:open Launch week' });
    expect(wrote(graphql)).toBe(true);
  });

  it('refuses a name an open project already carries, whatever its case and spacing, without writing', async () => {
    const { src, graphql } = setup(found([{ id: 'PVT_1', number: 1, title: ' launch WEEK ', closed: false }]));
    await expect(src.createProject('acme', 'board', 1, 'Launch week')).rejects.toBeInstanceOf(ProjectTitleTakenError);
    expect(wrote(graphql)).toBe(false);
  });

  it('an issue or repo Github cannot find is IssueNotFoundError, whether it errors or answers null', async () => {
    const errored = setup(Object.assign(new Error('Could not resolve to an Issue'), { errors: [{ type: 'NOT_FOUND' }] }));
    await expect(errored.src.createProject('acme', 'board', 99, 'x')).rejects.toBeInstanceOf(IssueNotFoundError);
    expect(wrote(errored.graphql)).toBe(false);
    const empty = setup({ ...found([]), repository: { issue: null } });
    await expect(empty.src.createProject('acme', 'board', 99, 'x')).rejects.toBeInstanceOf(IssueNotFoundError);
    expect(wrote(empty.graphql)).toBe(false);
  });

  it('an owner Github does not return is a 404, before anything is written', async () => {
    const { src, graphql } = setup({ repository: { issue: { id: 'I_1' } }, repositoryOwner: null });
    const thrown = await src.createProject('acme', 'board', 1, 'x').catch((e: unknown) => e);
    expect((thrown as HttpException).getStatus()).toBe(404);
    expect(wrote(graphql)).toBe(false);
  });
});

/**
 * That read is CLASSIFIED, and `addToProject`'s is not (#1057).
 *
 * The two reads differ by what they ask for. `addToProject` resolves an issue's
 * node id, which wants nothing the issue page has not already read, so a 403
 * there is not evidence about projects and is left raw — the case above this one
 * pins that and still holds. This read also asks `repositoryOwner` for its
 * `projectsV2`, which wants a Projects READ permission on top, so Github
 * refusing it IS the claim `issue.project.create` makes.
 *
 * Before this it was neither answered nor learned: only NOT_FOUND was mapped, so
 * a FORBIDDEN left the controller as a 500 with no body. The page read that as
 * "Couldn’t make the project. Try again." beside an armed button, over a refusal
 * that no second press could get past, and the registry heard nothing, so the
 * next `/api/auth/me` armed "New project" again.
 */
describe('GithubIssueDetailSource.createProject classifies the read it needs a permission for (#1057)', () => {
  /** `errors` on an HTTP 200, which is how GraphQL refuses. */
  const gql = (type: string) => Object.assign(new Error(type), { errors: [{ type }] });
  const setup = (read: unknown, visible = true) => {
    const calls: { cap: string; reason: string; scope: string }[] = [];
    const graphql = vi.fn().mockImplementation(async (doc: string) => {
      if (doc.includes('createProjectV2')) return { createProjectV2: { projectV2: { id: 'P', number: 1, title: 't' } } };
      throw read;
    });
    // `learn`'s re-read, which is what earns a 404 the right to be read as a
    // refusal (#577). `visible` is whether the issue is still readable.
    const get = vi.fn(async () => {
      if (!visible) throw gh(404);
      return {};
    });
    const registry = {
      recordRefusal: (cap: string, r: { reason: string; scope: string }) => calls.push({ cap, reason: r.reason, scope: r.scope }),
      recordSuccess: () => {},
    } as unknown as CapabilityRegistry;
    const src = new GithubIssueDetailSource(config, registry);
    // @ts-expect-error — preset BOTH lazily-built clients with one stub (#625)
    src.readClient = src.writeClient = { graphql, issues: { get } };
    const made = () => graphql.mock.calls.some(([doc]) => String(doc).includes('createProjectV2'));
    return { src, calls, made };
  };
  const run = (src: GithubIssueDetailSource) =>
    src.createProject('acme', 'board', 1, 'Launch week').catch((e: unknown) => e);

  it('a FORBIDDEN is a 403 the person is told about, learned on this owner and repo alone', async () => {
    const { src, calls, made } = setup(gql('FORBIDDEN'));
    const thrown = await run(src);
    expect((thrown as HttpException).getStatus()).toBe(403);
    expect((thrown as HttpException).getResponse()).toMatchObject({ reason: 'not-permitted' });
    // The add is a different write against a different project; this read
    // refuses nothing about it, so only the create is taught.
    expect(calls).toEqual([{ cap: 'issue.project.create', reason: 'not-permitted', scope: 'target' }]);
    expect(made()).toBe(false);
  });

  it('a credential missing the scope is believed of every target, because every create needs this read', async () => {
    const { src, calls } = setup(gql('INSUFFICIENT_SCOPES'));
    expect(((await run(src)) as HttpException).getStatus()).toBe(403);
    expect(calls).toEqual([{ cap: 'issue.project.create', reason: 'not-permitted', scope: 'credential' }]);
  });

  it('a throttle, an unclassified type and a dropped socket are each a 502 a retry is for', async () => {
    for (const thrownBy of [gql('RATE_LIMITED'), gql('SOMETHING_NEW'), new Error('socket hang up')]) {
      const { src, calls, made } = setup(thrownBy);
      const thrown = await run(src);
      expect((thrown as HttpException).getStatus()).toBe(502);
      expect((thrown as HttpException).getResponse()).toMatchObject({ reason: 'try-again' });
      // Handed over as classified; `recordRefusal` drops a scope-`none` refusal,
      // so nothing is believed. The claim tested here is what the source SAYS.
      expect(calls).toEqual([{ cap: 'issue.project.create', reason: 'try-again', scope: 'none' }]);
      expect(made()).toBe(false);
    }
  });

  it('a NOT_FOUND over an issue the board can still read is the refusal #577 hid, not an absence', async () => {
    const { src, calls } = setup(gql('NOT_FOUND'), true);
    expect(((await run(src)) as HttpException).getStatus()).toBe(403);
    expect(calls).toEqual([{ cap: 'issue.project.create', reason: 'not-permitted', scope: 'target' }]);
  });

  it('a NOT_FOUND over an issue that is gone stays IssueNotFoundError, and teaches nothing', async () => {
    const { src, calls } = setup(gql('NOT_FOUND'), false);
    expect(await run(src)).toBeInstanceOf(IssueNotFoundError);
    expect(calls).toEqual([]);
  });
});

describe('GithubIssueDetailSource activity alongside the existing thread (#882)', () => {
  const issue = {
    number: 882, title: 'Timeline', state: 'OPEN', url: 'https://github.com/acme/board/issues/882',
    body: 'Opening post', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z', author: null,
    comments: {totalCount: 1, nodes:[{url:'https://github.com/acme/board/issues/882#issuecomment-1',author:{login:'octocat'},body:'Existing comment',createdAt:'2026-09-02T00:00:00Z'}]},
  };
  const source = (listEventsForTimeline: ReturnType<typeof vi.fn>) => {
    const src = new GithubIssueDetailSource(config);
    const graphql = vi.fn().mockResolvedValue({repository:{issue}});
    // @ts-expect-error — read client double; the write client must never be used.
    src.readClient = {graphql,issues:{listEventsForTimeline}};
    return src;
  };
  it('fetches events through the read client while preserving comment author, body and permalink', async () => {
    const read=vi.fn().mockResolvedValue({data:[{id:5,event:'closed',actor:null,created_at:'2026-09-03T00:00:00Z'}],headers:{}});
    const result=await source(read).fetch('acme','board',882);
    expect(result?.activity).toMatchObject({state:'read',events:[{id:'5',kind:'closed'}]});
    expect(result?.comments).toEqual([{id:undefined,viewerCanUpdate:false,author:{login:'octocat',name:null},bodyMarkdown:'Existing comment',createdAt:'2026-09-02T00:00:00Z',htmlUrl:issue.comments.nodes[0].url}]);
    expect(read).toHaveBeenCalledWith({owner:'acme',repo:'board',issue_number:882,per_page:100,page:1});
  });
  it('keeps issue and comments readable when the additional timeline endpoint refuses', async () => {
    const result=await source(vi.fn().mockRejectedValue(gh(403))).fetch('acme','board',882);
    expect(result?.activity).toEqual({state:'unreadable',events:[]});
    expect(result?.bodyMarkdown).toBe('Opening post');expect(result?.comments).toHaveLength(1);
  });
});

describe('mention catalog (#1378)', () => {
  it('reads paginated assignable names with the read client and preserves the login catalog', async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({ repository: { assignableUsers: { nodes: [{ login: 'ann', name: 'Ann Baker' }], pageInfo: { hasNextPage: true, endCursor: 'next' } } } })
      .mockResolvedValueOnce({ repository: { assignableUsers: { nodes: [{ login: 'bob', name: null }], pageInfo: { hasNextPage: false, endCursor: 'end' } } } });
    const src = new GithubIssueDetailSource(config);
    // @ts-expect-error preset the read client independently of the write client
    src.readClient = { graphql, issues: { listLabelsForRepo: 'labels', listMilestones: 'milestones' }, paginate: vi.fn().mockResolvedValue([]) };
    const result = await src.editOptions('acme', 'board');
    expect(result.assignablePeople).toEqual([{ login: 'ann', name: 'Ann Baker' }, { login: 'bob', name: null }]);
    expect(result.assignableLogins).toEqual(['ann', 'bob']);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[0][0]).toContain('nodes { login name }');
    expect(graphql.mock.calls[1][1]).toEqual({ owner: 'acme', repo: 'board', after: 'next' });
  });
});

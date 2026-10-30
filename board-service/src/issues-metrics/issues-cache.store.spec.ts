import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { IssueStoreSignal } from '../github-store/issue-store';
import { IssuesCacheService } from './issues-cache.service';
import type { IIssuesSource, ListIssuesOptions, RawIssue } from './issues-metrics.types';

/**
 * The issues cache and the webhook store's signal (#1007, V5). A delivery that
 * changed the store makes a young snapshot out of date, and the next read
 * refills it rather than waiting out the TTL; "Sync now" always reads Github.
 */

/** `GITHUB_ORGS` and `FEEDBACK_REPO` are pinned at the org this file's sample
 *  rows are written against. Since #1175 neither key has a default to be left
 *  to: #1166 put both behind one constant, the organisation was renamed out from
 *  under it, and the constant came off. A case that means another value passes
 *  its own. */
const config = {
  get: (k: string, d?: unknown) =>
    k === 'GITHUB_ORGS'
      ? 'acme'
      : k === 'FEEDBACK_REPO'
        ? 'acme/board'
        : d,
} as unknown as ConfigService;

const raw = (title: string): RawIssue => ({
  owner: 'acme', repo: 'acme', number: 1, title, htmlUrl: 'https://github.com/acme/acme/issues/1',
  state: 'open', createdAt: '2026-09-01T00:00:00Z', closedAt: null, stateReason: null, author: null,
  assignees: [], labels: [], labelsComplete: true, submission: false, milestone: null,
});

const person = (): GithubPrincipal => ({
  key: 'person', email: 'a@example.test', login: 'a', token: 'synthetic', owners: [],
  repositories: [], cache: new WeakMap(), permissionCache: new WeakMap(),
});

function counting(): { source: IIssuesSource; listIssues: ReturnType<typeof vi.fn> } {
  let n = 0;
  const listIssues = vi.fn(async (_options?: ListIssuesOptions) => [raw(`v${++n}`)]);
  return { source: reporting({ listIssues }), listIssues };
}

/** A source whose every read waits to be settled by the test, in call order. */
function held(): { source: IIssuesSource; listIssues: ReturnType<typeof vi.fn>; reads: { resolve: (issues: RawIssue[]) => void; reject: (err: Error) => void }[] } {
  const reads: { resolve: (issues: RawIssue[]) => void; reject: (err: Error) => void }[] = [];
  const listIssues = vi.fn((_options?: ListIssuesOptions) => new Promise<RawIssue[]>((resolve, reject) => reads.push({ resolve, reject })));
  return { source: reporting({ listIssues }), listIssues, reads };
}

const repoOutcomes = () => [{ full: 'acme/acme', id: 101, ok: true }];
const reporting = (source: IIssuesSource) => Object.assign(source, { repoOutcomes });

const title = async (cache: IssuesCacheService) => (await cache.getIssues()).issues[0].title;

afterEach(() => {
  vi.useRealTimers();
});

describe('a young snapshot and the webhook store (#1007, V5)', () => {
  it('does not refill for a delivery outside its repository scope', async () => {
    const { source, listIssues } = counting();
    Object.assign(source, { repoOutcomes: () => [{ full: 'acme/acme', id: 101, ok: true }] });
    const signal = new IssueStoreSignal();
    const cache = new IssuesCacheService(source, config, signal);
    expect(await title(cache)).toBe('v1');
    signal.bump([999]);
    expect(await title(cache)).toBe('v1');
    expect(listIssues).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a delivery arriving during a read and its baseline writes', async () => {
    const { source, reads, listIssues } = held();
    Object.assign(source, { repoOutcomes: () => [{ full: 'acme/acme', id: 101, ok: true }] });
    const signal = new IssueStoreSignal();
    const cache = new IssuesCacheService(source, config, signal);
    const first = cache.getIssues();
    signal.bump([101]);
    reads[0].resolve([raw('before delivery')]);
    await first;
    const next = cache.getIssues();
    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(listIssues.mock.calls[1][0]?.reuse?.changedRepos).toEqual(['acme/acme']);
    reads[1].resolve([raw('after delivery')]);
    expect((await next).issues[0].title).toBe('after delivery');
  });

  it('is served as before while no delivery has changed the store', async () => {
    const { source, listIssues } = counting();
    const cache = new IssuesCacheService(source, config, new IssueStoreSignal());
    expect(await title(cache)).toBe('v1');
    expect(await title(cache)).toBe('v1');
    expect(listIssues).toHaveBeenCalledTimes(1);
  });

  it('is refilled on the first read after a delivery changed the store, once, keeping what the store cannot answer', async () => {
    const { source, listIssues } = counting();
    const signal = new IssueStoreSignal();
    const cache = new IssuesCacheService(source, config, signal);
    expect(await title(cache)).toBe('v1');
    signal.bump([101]);
    expect(await title(cache)).toBe('v2');
    expect(await title(cache)).toBe('v2');
    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(listIssues.mock.calls[1][0]).toEqual({ reuse: { issues: [raw('v1')], repos: repoOutcomes(), changedRepos: ['acme/acme'] } });
  });

  it('keeps the age of the snapshot it refilled, so the TTL still runs from the last full read', async () => {
    const { source } = counting();
    const signal = new IssueStoreSignal();
    const cache = new IssuesCacheService(source, config, signal);
    const first = await cache.getIssues(1_000);
    signal.bump([101]);
    const caught = await cache.getIssues(2_000);
    expect(caught.issues[0].title).toBe('v2');
    expect(caught.at).toBe(first.at);
  });

  it('gives a read the snapshot it had when the refill outlasts the wait, and the refill to the read after', async () => {
    vi.useFakeTimers();
    let release: (issues: RawIssue[]) => void = () => {};
    const listIssues = vi.fn()
      .mockResolvedValueOnce([raw('v1')])
      .mockImplementationOnce(() => new Promise<RawIssue[]>((resolve) => (release = resolve)));
    const signal = new IssueStoreSignal();
    const cache = new IssuesCacheService(reporting({ listIssues }), config, signal);
    expect(await title(cache)).toBe('v1');
    signal.bump([101]);
    const waiting = cache.getIssues();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await waiting).issues[0].title).toBe('v1');
    release([raw('v2')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await title(cache)).toBe('v2');
  });

  it('rebuilds the submission index from the refilled snapshot, whose `at` it kept', async () => {
    const feedback = (number: number, submission: boolean): RawIssue => ({
      ...raw('feedback'), repo: 'board', number, submission,
      htmlUrl: `https://github.com/acme/board/issues/${number}`,
    });
    const listIssues = vi.fn()
      .mockResolvedValueOnce([feedback(1, false)])
      .mockResolvedValueOnce([feedback(1, false), feedback(2, true)]);
    const signal = new IssueStoreSignal();
    const cache = new IssuesCacheService(reporting({ listIssues }), config, signal);
    expect((await cache.submissionIndex())?.lookup('acme', 'board', 2)).toBeNull();
    signal.bump([101]);
    expect((await cache.submissionIndex())?.lookup('acme', 'board', 2)).toBe(true);
  });

  it('gives a read the snapshot it holds at once while another read is in flight', async () => {
    vi.useFakeTimers();
    const { source, reads } = held();
    const signal = new IssueStoreSignal();
    const cache = new IssuesCacheService(source, config, signal);
    const first = cache.getIssues();
    reads[0].resolve([raw('v1')]);
    await first;
    signal.bump([101]);
    const sync = cache.resync();
    let answered: string | null = null;
    void cache.getIssues().then((s) => (answered = s.issues[0].title));
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe('v1');
    reads[1].resolve([raw('v2')]);
    await sync;
  });

  it('leaves a person their snapshot when the refill after a delivery fails', async () => {
    const listIssues = vi.fn().mockResolvedValueOnce([raw('v1')]).mockRejectedValue(new Error('rate limited'));
    const signal = new IssueStoreSignal();
    const cache = new IssuesCacheService(reporting({ listIssues }), config, signal);
    await githubContext.run({ principal: person() }, async () => {
      expect(await title(cache)).toBe('v1');
      signal.bump([101]);
      expect(await title(cache)).toBe('v1');
      expect(await title(cache)).toBe('v1');
    });
  });

  /**
   * What a failed refill costs (#1070, S3).
   *
   * A refill that fails leaves the snapshot's generation behind the signal's,
   * which is the same test the next request makes — so every request after it
   * started another full read of the whole scope, each one listing both orgs
   * from Github on the deployment path, until the TTL rolled the snapshot over
   * ten minutes later. The doc predicts the trigger itself: past about 150,000
   * stored issues every store read misses its limit, which makes a failing
   * refill the steady state rather than an edge.
   *
   * One try per delivery is the bound. The next delivery buys the next try, and
   * the TTL refreshes regardless.
   */
  it('spends one read on a delivery whose refill failed, not one per request', async () => {
    const listIssues = vi.fn().mockResolvedValueOnce([raw('v1')]).mockRejectedValue(new Error('the webhook store could not be read'));
    const signal = new IssueStoreSignal();
    const cache = new IssuesCacheService(reporting({ listIssues }), config, signal);
    await githubContext.run({ principal: person() }, async () => {
      expect(await title(cache)).toBe('v1');
      signal.bump([101]);
      for (let i = 0; i < 6; i += 1) expect(await title(cache)).toBe('v1');
      // The first read, and one refill for the delivery. Not seven.
      expect(listIssues).toHaveBeenCalledTimes(2);
      // The next delivery is a new thing to catch up on, and is tried.
      listIssues.mockResolvedValueOnce([raw('v2')]);
      signal.bump([101]);
      expect(await title(cache)).toBe('v2');
      expect(listIssues).toHaveBeenCalledTimes(3);
    });
  });
});

describe('"Sync now" reads Github, never the store (#1007, V5)', () => {
  it('asks the source to reconcile', async () => {
    const { source, listIssues } = counting();
    await new IssuesCacheService(source, config, new IssueStoreSignal()).resync();
    expect(listIssues).toHaveBeenCalledWith({ reconcile: true });
  });

  it('starts its own read when an ordinary one is in flight, and joins one that is already reconciling', async () => {
    const { source, listIssues, reads } = held();
    const cache = new IssuesCacheService(source, config, new IssueStoreSignal());
    const ordinary = cache.getIssues();
    const sync = cache.resync();
    const again = cache.resync();
    expect(listIssues.mock.calls).toEqual([[], [{ reconcile: true }]]);
    for (const read of reads) read.resolve([raw('x')]);
    await Promise.all([ordinary, sync, again]);
  });

  it('keeps what the sync read when the ordinary read it overtook lands after it', async () => {
    const { source, reads } = held();
    const cache = new IssuesCacheService(source, config, new IssueStoreSignal());
    const ordinary = cache.getIssues();
    const sync = cache.resync();
    reads[1].resolve([raw('after the sync')]);
    await sync;
    reads[0].resolve([raw('before the sync')]);
    expect((await ordinary).issues[0].title).toBe('before the sync');
    expect(await title(cache)).toBe('after the sync');
  });

  it('keeps a person what the sync read when the ordinary read it overtook fails after it', async () => {
    const { source, reads } = held();
    const cache = new IssuesCacheService(source, config, new IssueStoreSignal());
    await githubContext.run({ principal: person() }, async () => {
      const ordinary = cache.getIssues().catch(() => null);
      const sync = cache.resync();
      reads[1].resolve([raw('after the sync')]);
      await sync;
      reads[0].reject(new Error('rate limited'));
      await ordinary;
      expect(await title(cache)).toBe('after the sync');
    });
  });

  it('with the store off, joins the read in flight and reads as before V5', async () => {
    const { source, listIssues, reads } = held();
    const cache = new IssuesCacheService(source, config);
    const ordinary = cache.getIssues();
    const sync = cache.resync();
    expect(listIssues.mock.calls).toEqual([[]]);
    reads[0].resolve([raw('x')]);
    await Promise.all([ordinary, sync]);
  });
});

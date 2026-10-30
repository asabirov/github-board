import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { IssuesCacheService, type OrgReportingSource } from './issues-cache.service';
import type { IIssuesSource, RawIssue } from './issues-metrics.types';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { IssuesCacheModule } from './issues-cache.module';
import { ORG_READ_STATE, type OrgReadState } from './org-read-state';

/**
 * #516 — the submission marker shared to the two surfaces that fetch no body:
 * the Projects rollup's recency line and the issue page's relations.
 *
 * The contract IS the deliverable here. Three values all the way down, no
 * rejection ever reaching a caller, and emptiness that reports itself as
 * emptiness rather than as an authoritative "none of these are submissions".
 * The last one is the trap: `projects.service.ts`'s weekly-close join catches a
 * cache failure and returns `[]`, which is right for counting closes and
 * catastrophic here — an empty-but-non-null index answers `false` for every
 * issue in the feedback repo and hands over every title in it.
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

const FEEDBACK_REPO = 'acme/board';

const raw = (over: Partial<RawIssue>): RawIssue => ({
  owner: 'acme',
  repo: 'board',
  number: 1,
  title: 't',
  htmlUrl: `https://github.com/${FEEDBACK_REPO}/issues/1`,
  state: 'open',
  createdAt: '2026-07-01T00:00:00Z',
  closedAt: null,
  // A synthetic row is told no reason, which is the state that COUNTS —
  // so every assertion written before #1014 keeps meaning what it meant.
  stateReason: null,
  author: null,
  assignees: [],
  labels: [],
  labelsComplete: true,
  submission: false,
  milestone: null,
  ...over,
});

const sourceOf = (issues: RawIssue[]): IIssuesSource => ({ listIssues: async () => issues });
const failingSource: IIssuesSource = {
  listIssues: async () => {
    throw new Error('github is down');
  },
};

const cache = (source: IIssuesSource) => new IssuesCacheService(source, config);

describe('IssuesCacheService.submissionIndex — the shared marker (#516)', () => {
  it('resolves null rather than rejecting when the source fails', async () => {
    // A rejection here would turn a data-hiding control into a 500 for humans on
    // the Projects page, which is a worse outcome than a hidden title.
    await expect(cache(failingSource).submissionIndex()).resolves.toBeNull();
  });

  it('reports a cache holding no feedback-repo row as null, NOT as an empty index', async () => {
    const elsewhere = raw({
      repo: 'acme',
      number: 218,
      htmlUrl: 'https://github.com/acme/acme/issues/218',
    });
    await expect(cache(sourceOf([elsewhere])).submissionIndex()).resolves.toBeNull();
  });

  it('answers true for a footered row and false for one without', async () => {
    const index = await cache(
      sourceOf([
        raw({ number: 511, htmlUrl: `https://github.com/${FEEDBACK_REPO}/issues/511`, submission: true }),
        raw({ number: 497, htmlUrl: `https://github.com/${FEEDBACK_REPO}/issues/497`, submission: false }),
      ]),
    ).submissionIndex();
    expect(index?.lookup('acme', 'board', 511)).toBe(true);
    expect(index?.lookup('acme', 'board', 497)).toBe(false);
  });

  /**
   * The defect that made this a second draft. A per-issue miss returning `false`
   * is an authoritative "not a submission" for an issue nobody read, and it
   * falls straight through to the label test — which is #516 one level up.
   */
  it('answers null for an issue the cache has no row for', async () => {
    const index = await cache(
      sourceOf([raw({ number: 511, htmlUrl: `https://github.com/${FEEDBACK_REPO}/issues/511`, submission: true })]),
    ).submissionIndex();
    expect(index?.lookup('acme', 'board', 512)).toBeNull();
  });

  it('does not index a row whose Github URL cannot be parsed — it looks up as null', async () => {
    const index = await cache(
      sourceOf([
        raw({ number: 511, htmlUrl: `https://github.com/${FEEDBACK_REPO}/issues/511`, submission: true }),
        raw({ number: 512, htmlUrl: '', submission: true }),
      ]),
    ).submissionIndex();
    expect(index?.lookup('acme', 'board', 512)).toBeNull();
  });

  /**
   * Keys come from the URL, never from `RawIssue.repo`. That field is the SHORT
   * key from `shortRepoKey()`, it carries no owner, and #484's documented
   * collision folds `board` and `board.example.com` onto the same key — so a key
   * composed from it can place an issue in the wrong repo.
   */
  it('keys off the Github URL, so a short-key collision cannot place an issue in the wrong repo', async () => {
    const index = await cache(
      sourceOf([
        // Both carry the short key `board` (#484), and they are different repos.
        raw({ repo: 'board', number: 7, htmlUrl: `https://github.com/${FEEDBACK_REPO}/issues/7`, submission: true }),
        raw({ repo: 'board', number: 7, htmlUrl: 'https://github.com/acme/board.example.com/issues/7', submission: false }),
      ]),
    ).submissionIndex();
    expect(index?.lookup('acme', 'board', 7)).toBe(true);
    expect(index?.lookup('acme', 'board.example.com', 7)).toBe(false);
  });

  it('matches owner and repo case-insensitively, the way every other repo test here folds case', async () => {
    const index = await cache(
      sourceOf([raw({ number: 511, htmlUrl: `https://github.com/${FEEDBACK_REPO}/issues/511`, submission: true })]),
    ).submissionIndex();
    expect(index?.lookup('Acme', 'board', 511)).toBe(true);
  });

  it('a cold cache that fails does not leave the caller waiting on a rejection either', async () => {
    const svc = cache(failingSource);
    await expect(svc.submissionIndex()).resolves.toBeNull();
    await expect(svc.submissionIndex()).resolves.toBeNull();
  });
});

/**
 * #528 — the other half of the same guarantee, and the half a reader is most
 * likely to assume rather than check.
 *
 * The source now throws when it cannot resolve its repo scope instead of
 * resolving with nothing, but a throw only helps if it travels. `getIssues` is
 * the one door every board surface reads through, and the metrics service does
 * not catch it, so a cold failure becomes a 500 and the frontend draws its error
 * state — somebody looking at the board sees a fault rather than a plausible
 * empty board.
 *
 * Pinned here because it is exactly the kind of guarantee a later `catch → []`
 * would take away in one line while every other test stayed green. Note the
 * deliberate asymmetry with `submissionIndex` directly above: that one swallows
 * on purpose, because a hidden title beats a 500 on the Projects page. This one
 * must not, because the whole point is that an outage is heard.
 */
describe('IssuesCacheService.getIssues — a lost fetch is heard, not served as emptiness (#528)', () => {
  it('rejects on a cold cache rather than resolving with no issues', async () => {
    await expect(cache(failingSource).getIssues()).rejects.toThrow(/github is down/);
  });

  it('serves the stale cache when a later refresh fails — SWR, and knowingly so', async () => {
    // Documented behaviour, recorded so the trade is visible: once a good
    // snapshot exists, a failing refresh is logged and the old list is served on.
    // The outage is only loud while there is nothing to fall back on.
    let fail = false;
    const flaky: IIssuesSource = {
      listIssues: async () => {
        if (fail) throw new Error('github is down');
        return [raw({ number: 1 })];
      },
    };
    const svc = cache(flaky);
    const first = await svc.getIssues(0);
    expect(first.issues).toHaveLength(1);

    fail = true;
    // Past the 600s default TTL, so this read is stale and triggers a refresh.
    await expect(svc.getIssues(10_000_000)).resolves.toMatchObject({ at: 0 });
  });
});


/**
 * #647 — the cache slot stays ONE list and gains a per-org outcome beside it.
 *
 * The union is the right answer for every person-shaped surface, so it is not
 * split. What it cannot say is which org it covers: an org whose enumeration
 * failed contributes no rows and reads, inside the list, exactly like an org
 * that is genuinely quiet. The outcome record is what keeps those apart.
 */
describe('IssuesCacheService — which orgs answered (#647)', () => {
  const outcomes = [
    { org: 'acme', state: 'read' as const, reason: null, calls: 3 },
    { org: 'globex', state: 'unreadable' as const, reason: '403 Forbidden', calls: 1 },
  ];

  const reportingSource = (issues: RawIssue[]): IIssuesSource & OrgReportingSource => ({
    listIssues: async () => issues,
    orgOutcomes: () => outcomes,
  });

  it('carries the per-org outcome beside the union, not instead of it', async () => {
    const snapshot = await cache(reportingSource([raw({})])).getIssues();
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.orgs).toEqual(outcomes);
  });

  it('an unreadable org is not a counted zero — it is named as unreadable', async () => {
    const snapshot = await cache(reportingSource([raw({})])).getIssues();
    expect(snapshot.orgs.find((o) => o.org === 'globex')?.state).toBe('unreadable');
  });

  it('a source that cannot say which orgs it read claims none', async () => {
    // The fixture source has no orgs to report. An invented `read` would be
    // worse than silence, so the answer is an empty list.
    const snapshot = await cache(sourceOf([raw({})])).getIssues();
    expect(snapshot.orgs).toEqual([]);
  });

  it('serves the cached outcome with the cached list, so the two never disagree', async () => {
    const svc = cache(reportingSource([raw({})]));
    await svc.getIssues(0);
    const again = await svc.getIssues(1);
    expect(again.orgs).toEqual(outcomes);
  });
});

/**
 * #650 — the accessor the auth layer holds, resolved through the REAL module.
 *
 * A unit test over `composeOrgReadState` cannot see a DI mistake, and the
 * dependency is `@Optional()` at the controller — so a token this module failed
 * to provide or export would not crash a boot, it would silently drop the field
 * and leave the board back where #647 left it. This resolves it the way Nest
 * does.
 */
describe('ORG_READ_STATE resolves from IssuesCacheModule (#650)', () => {
  it('is provided and exported, and composes without the capability layer present', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ ISSUES_SOURCE: 'fixture', FEEDBACK_REPO })] }),
        IssuesCacheModule,
      ],
    }).compile();

    const state = mod.get<OrgReadState>(ORG_READ_STATE);

    // No CapabilityModule in this graph, so the optional boot probe is absent.
    // That costs the pre-first-ingest window and nothing else: the answer is
    // `[]` — "no claim" — never a fabricated `read` for a configured org.
    expect(state.orgsRead()).toEqual([]);
    await mod.close();
  });
});


describe('manual ingest outcome (#976)', () => {
  it('reports partial org/repo reads without adding another fetch', async () => {
    let reads = 0; let orgUnread = true; let repoUnread = false;
    const source = {
      listIssues: async () => { reads++; return []; },
      orgOutcomes: () => orgUnread ? [{ org: 'x', state: 'unreadable' as const }] : [],
      repoOutcomes: () => repoUnread ? [{ full: 'x/a', ok: false }] : [],
    };
    const service = cache(source);
    await expect(service.resyncWithOutcome()).resolves.toBe('degraded');
    expect(reads).toBe(1);
    orgUnread = false; repoUnread = true;
    await expect(service.resyncWithOutcome()).resolves.toBe('degraded');
    repoUnread = false;
    await expect(service.resyncWithOutcome()).resolves.toBe('succeeded');
    expect(reads).toBe(3);
  });
});

/**
 * What the Board sync panel's Issue metrics row reads (#1169).
 *
 * The ingest's own `at` — the number every surface joined against this snapshot
 * already reports as its freshness — so the row, the chip and the payload are
 * one fact rather than three.
 */
describe('IssuesCacheService.lastSyncedAt (#1169)', () => {
  it('has no record before anything has read the ingest', () => {
    expect(cache(sourceOf([])).lastSyncedAt()).toBeNull();
  });

  it('reports the snapshot it is serving, by the snapshot’s own moment', async () => {
    const svc = cache(sourceOf([raw({})]));
    const snapshot = await svc.getIssues(Date.now());
    expect(svc.lastSyncedAt()).toBe(new Date(snapshot.at).toISOString());
  });

  it('asks the source nothing — a panel must not pay for a ~70-repo scan', () => {
    let calls = 0;
    const svc = cache({ listIssues: async () => { calls += 1; return []; } });
    svc.lastSyncedAt();
    svc.lastSyncedAt();
    expect(calls).toBe(0);
  });

  it('forgets its record when a write drops the ingest', async () => {
    const svc = cache(sourceOf([raw({})]));
    await svc.getIssues(Date.now());
    svc.dropCaches();
    expect(svc.lastSyncedAt()).toBeNull();
  });
});

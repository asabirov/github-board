/**
 * The failure this covers, as it happened (#1003).
 *
 * On 2026-09-10 the signed-in person's Github GraphQL point budget ran out.
 * `github-quota.ts` then refused every GraphQL query for that identity until the
 * hourly reset, so each org's Projects read threw, `perOrg` had nothing left to
 * union, and two things went off the board at once: `/api/projects` answered 500
 * (the Projects card drew "Projects unavailable"), and the issue→board join in
 * `IssuesMetricsService` caught the same throw and degraded to "on no board", so
 * `availableGroupDims` stopped offering `project` and both queues silently fell
 * back to grouping by type.
 *
 * `ProjectsService.retired` could not help: it refuses outright while a person
 * is acting, and the caches it would read from are replaced at every permission
 * re-check anyway. So a person's Projects had no fallback at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { GithubQuotaCooldownError } from '../sources/github-quota';
import { FixtureIssuesSource } from '../issues-metrics/fixture-issues.source';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import { FixtureProjectsSource } from './fixture-projects.source';
import { ProjectsService } from './projects.service';

const req = { user: { agent: false, email: 'reader@example.test' } };
/** `key` is what an entry is filed under, and the whole isolation claim: it is
 *  the person, their credential generation and their repository fingerprint. */
const principal = (key = 'reader:1:1:fp-a'): GithubPrincipal => ({
  key, email: req.user.email, login: 'reader', token: 'fixture-only',
  owners: [{ login: 'acme', type: 'Organization' }],
  repositories: [], cache: new WeakMap(), permissionCache: new WeakMap(),
});

/** What the quota cooldown throws once a person's GraphQL budget is spent.
 *  BARE: `github-quota.ts` throws it out of the request hook and
 *  `GithubProjectsSource` re-throws it unwrapped, so this is the shape the
 *  service's `catch` actually receives. */
const cooling = () => new GithubQuotaCooldownError(Date.now() + 3_600_000);

/**
 * What a lost Projects grant actually looks like, and the reason it gets its own
 * fixture (#1003 review).
 *
 * Github answers an authorization failure on the GraphQL API with **HTTP 200**
 * and the verdict in the body, so `@octokit/graphql` raises a
 * `GraphqlResponseError` carrying `errors` and `data` and NO status. An
 * HTTP-shaped 403 does occur on this path — a dead token, an abuse block — but
 * it is not how a withdrawn grant arrives, so a gate tested only against one
 * passes while the case it exists for walks through.
 */
const graphqlError = (type: string) => Object.assign(new Error(`Request failed: ${type}`), {
  name: 'GraphqlResponseError',
  errors: [{ type, message: `Resource not accessible: ${type}` }],
  data: null,
  response: { data: null, errors: [{ type, message: `Resource not accessible: ${type}` }] },
});
/** The HTTP-shaped refusal, which also has to be refused. */
const forbidden = () => Object.assign(new Error('forbidden'), { status: 403 });

function setup() {
  // `FEEDBACK_REPO` has no default since #1175 and `ProjectsService` builds the
  // submission-visibility scope in its constructor.
  const config = new ConfigService({ GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board' });
  const issues = new IssuesCacheService(new FixtureIssuesSource(), config);
  issues.submissionIndex = async () => ({ lookup: () => false });
  const source = new FixtureProjectsSource();
  return { service: new ProjectsService(source, config, issues), source, config };
}

/** A permission re-check installs fresh caches on a fresh principal object, so
 *  every read below runs cold exactly as production does — which is the point:
 *  the fallback has to live somewhere those caches do not. */
const asPerson = <T>(p: GithubPrincipal, run: () => Promise<T>): Promise<T> =>
  githubContext.run({ principal: p }, run);

describe('a refused Projects read serves this person their last answer (#1003)', () => {
  it('keeps the boards and the issue→board join alive across a quota cooldown', async () => {
    const { service, source } = setup();
    const warm = await asPerson(principal(), () => service.listProjects(req.user));
    expect(warm.length).toBeGreaterThan(0);
    const memberships = await asPerson(principal(), () => service.projectMemberships());
    expect(memberships.length).toBeGreaterThan(0);
    // The names the preview strip draws while the rollup walks items.
    expect(await asPerson(principal(), () => service.listProjectPreview())).not.toHaveLength(0);

    vi.spyOn(source, 'listProjects').mockRejectedValue(cooling());
    vi.spyOn(source, 'projectMemberships').mockRejectedValue(cooling());
    vi.spyOn(source, 'listProjectCatalog').mockRejectedValue(cooling());

    // A LATER permission check: a new principal object with the same visibility,
    // so every in-request cache is cold and only the last-good store is left.
    const refused = principal();
    const boards = await asPerson(refused, () => service.listProjects(req.user));
    expect(boards.map((b) => b.number).sort()).toEqual(warm.map((b) => b.number).sort());
    // Marked as what it is, so `ProjectBlock` can say the counts are old.
    expect(boards.every((b) => b.lastGoodCopy)).toBe(true);
    // The join the queues group by. `[]` here is what silently removed the
    // Project grouping from both queues.
    expect(await asPerson(refused, () => service.projectMemberships())).toHaveLength(memberships.length);
    expect(await asPerson(refused, () => service.listProjectPreview())).not.toHaveLength(0);
  });

  it('never serves one visibility the copy another was given', async () => {
    const { service, source } = setup();
    await asPerson(principal('reader:1:1:fp-a'), () => service.listProjects(req.user));
    vi.spyOn(source, 'listProjects').mockRejectedValue(cooling());
    vi.spyOn(source, 'projectMemberships').mockRejectedValue(cooling());
    // Same person, access changed: a different fingerprint is a different key
    // and reaches nothing, exactly as a cold narrow read must.
    await expect(asPerson(principal('reader:1:1:fp-b'), () => service.listProjects(req.user))).rejects.toThrow('cooling down');
    // Another person entirely, likewise.
    await expect(asPerson(principal('other:2:1:fp-a'), () => service.listProjects(req.user))).rejects.toThrow('cooling down');
    // And the original visibility still has its own.
    await expect(asPerson(principal('reader:1:1:fp-a'), () => service.listProjects(req.user))).resolves.not.toHaveLength(0);
  });

  it('drops a copy past the configured ceiling rather than serving it forever', async () => {
    const config = new ConfigService({ GITHUB_ORGS: 'acme', PROJECTS_LAST_GOOD_MAX_MS: 1000, FEEDBACK_REPO: 'acme/board' });
    const issues = new IssuesCacheService(new FixtureIssuesSource(), config);
    issues.submissionIndex = async () => ({ lookup: () => false });
    const source = new FixtureProjectsSource();
    const service = new ProjectsService(source, config, issues);
    await asPerson(principal(), () => service.listProjects(req.user));
    vi.spyOn(source, 'listProjects').mockRejectedValue(cooling());
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 2000);
      await expect(asPerson(principal(), () => service.listProjects(req.user))).rejects.toThrow('cooling down');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers the live read, and serves what it answered rather than the held copy', async () => {
    const { service, source } = setup();
    await asPerson(principal(), () => service.listProjects(req.user));
    // A LIVE answer that differs from the held one. If the store were consulted
    // first — or at all on a success — the old name would come back.
    const renamed = vi.spyOn(source, 'listProjects').mockImplementation(async (org) =>
      (await new FixtureProjectsSource().listProjects(org)).map((row) => ({ ...row, name: `renamed ${row.name}` })));
    const boards = await asPerson(principal(), () => service.listProjects(req.user));
    expect(renamed).toHaveBeenCalled();
    expect(boards).not.toHaveLength(0);
    expect(boards.every((b) => b.name.startsWith('renamed '))).toBe(true);
    expect(boards.some((b) => b.lastGoodCopy)).toBe(false);
  });

  it('refuses to stand in for an authorization verdict, only for back-pressure', async () => {
    const { service, source } = setup();
    await asPerson(principal(), () => service.listProjects(req.user));
    await asPerson(principal(), () => service.projectMemberships());

    const reads = vi.spyOn(source, 'listProjects');
    const join = vi.spyOn(source, 'projectMemberships');
    const refused = async (thrown: Error, message: string) => {
      reads.mockRejectedValue(thrown);
      join.mockRejectedValue(thrown);
      await expect(asPerson(principal(), () => service.listProjects(req.user))).rejects.toThrow(message);
      await expect(asPerson(principal(), () => service.projectMemberships())).rejects.toThrow(message);
    };
    const served = async (thrown: Error) => {
      reads.mockRejectedValue(thrown);
      join.mockRejectedValue(thrown);
      await expect(asPerson(principal(), () => service.listProjects(req.user))).resolves.not.toHaveLength(0);
      await expect(asPerson(principal(), () => service.projectMemberships())).resolves.not.toHaveLength(0);
    };

    // NOT YOU, as it actually arrives on a GraphQL-only path: HTTP 200, verdict
    // in the body, no status anywhere on the error.
    await refused(graphqlError('FORBIDDEN'), 'FORBIDDEN');
    await refused(graphqlError('NOT_FOUND'), 'NOT_FOUND');
    // NOT YOU, HTTP-shaped — a dead token or an abuse block.
    await refused(forbidden(), 'forbidden');
    // NOT ANYTHING. A bug in the source says nothing about this reader, so it
    // may not open the gate either.
    await refused(new TypeError('Cannot read properties of null'), 'Cannot read properties of null');
    // NOT YOU wins INSIDE one errors array, not only across the cause chain.
    await refused(Object.assign(graphqlError('RATE_LIMITED'), {
      errors: [{ type: 'RATE_LIMITED' }, { type: 'FORBIDDEN' }],
    }), 'RATE_LIMITED');
    // An error that cannot be inspected at all is an error that cannot clear
    // the gate: every read of it is guarded, and a guarded read decides nothing.
    const opaque = new Error('opaque');
    for (const property of ['errors', 'response', 'status']) {
      Object.defineProperty(opaque, property, { get() { throw new Error(`boom-${property}`); }, configurable: true });
    }
    await refused(opaque, 'opaque');

    // NOT NOW. The same reader, the same held copy, refusals about the budget.
    await served(cooling());
    await served(graphqlError('RATE_LIMITED'));
    await served(Object.assign(new Error('bad gateway'), { status: 502 }));
  });

  it('reads the verdict through a wrapper, and survives a hostile cause chain', async () => {
    const { service, source } = setup();
    await asPerson(principal(), () => service.listProjects(req.user));
    const reads = vi.spyOn(source, 'listProjects');

    // `ProjectsService.perOrg` wraps with `{ cause }` above these callers, and a
    // future source may too — a verdict must not hide behind one.
    reads.mockRejectedValue(new Error('projectsV2 list failed', { cause: graphqlError('FORBIDDEN') }));
    await expect(asPerson(principal(), () => service.listProjects(req.user))).rejects.toThrow('projectsV2 list failed');
    reads.mockRejectedValue(new Error('projectsV2 list failed', { cause: cooling() }));
    await expect(asPerson(principal(), () => service.listProjects(req.user))).resolves.not.toHaveLength(0);

    // A `cause` that throws must not replace the refusal, and a cycle must not hang.
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'cause', { get() { throw new Error('boom'); } });
    reads.mockRejectedValue(hostile);
    await expect(asPerson(principal(), () => service.listProjects(req.user))).rejects.toThrow('hostile');
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;
    reads.mockRejectedValue(loop);
    await expect(asPerson(principal(), () => service.listProjects(req.user))).rejects.toThrow('loop');
  });

  it('lets a write drop the held copy, so no pre-write payload is left to serve', async () => {
    const { service, source } = setup();
    await asPerson(principal(), () => service.listProjects(req.user));
    await asPerson(principal(), () => service.projectMemberships());

    // The writer's own drop. #713 retires the caches; the held copies of the
    // same two payloads must go with them, or `recall` — which is asked before
    // `retired` — answers this writer with what they just changed.
    await asPerson(principal(), async () => service.dropCaches());

    vi.spyOn(source, 'listProjects').mockRejectedValue(cooling());
    vi.spyOn(source, 'projectMemberships').mockRejectedValue(cooling());
    await expect(asPerson(principal(), () => service.listProjects(req.user))).rejects.toThrow('cooling down');
    await expect(asPerson(principal(), () => service.projectMemberships())).rejects.toThrow('cooling down');
  });
});

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ApiError, WithdrawnReadError, withdrawnRead } from './api/core';
import { changeIssueAssignees, closeIssue, fetchIssueAssignees, fetchIssueMetrics, fetchMyIssues, fetchOrgIssues, setIssueState } from './api/issues';
import { fetchProjects } from './api/projects';
import { fetchRepos, setRepoDri } from './api/repos';
import { resetSessionExpiry } from './auth/session-expiry';

/** Answer the next fetch with a bare status, the way a refused write arrives. */
function mockStatus(status: number) {
  const fn = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => resetSessionExpiry());

// #584 — the eight facet writers and the close dialog used to reject with a
// plain Error naming the refusal in prose. `describeEditFailure` reads ApiError
// and nothing else, so every one of those refusals rendered as "Couldn't save"
// beside a Retry that could never work. These pin the status onto the rejection.
describe('the issue writers reject with the status they were refused with (#584)', () => {
  it('an issue write rejects with an ApiError carrying the status', async () => {
    mockStatus(403);
    await expect(setIssueState('acme', 'board', 1, 'closed')).rejects.toBeInstanceOf(ApiError);
  });

  it('a close rejects with an ApiError carrying the status', async () => {
    mockStatus(503);
    await expect(closeIssue('acme', 'board', 1)).rejects.toMatchObject({ status: 503 });
  });
});

// #1006 — the reason travels in the body, and what comes back is the reason
// Github KEPT, which the dialog compares with the one it sent.
describe('a close carries its reason (#1006)', () => {
  function mockJson(body: unknown) {
    const fn = vi.fn(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fn);
    return fn as unknown as ReturnType<typeof vi.fn>;
  }

  it('sends the reason as JSON and resolves the one Github kept', async () => {
    const fn = mockJson({ state: 'closed', stateReason: 'completed' });

    const res = await closeIssue('acme', 'board', 1, 'not_planned');

    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/issues\/acme\/board\/1\/close$/);
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'not_planned' });
    expect(res).toEqual({ stateReason: 'completed' });
  });

  it('sends no body when no reason is given', async () => {
    const fn = mockJson({ state: 'closed', stateReason: 'completed' });

    await closeIssue('acme', 'board', 1);

    expect((fn.mock.calls[0] as [string, RequestInit])[1].body).toBeUndefined();
  });

  it('resolves null from a service that names no reason, never a guessed one', async () => {
    mockJson({ state: 'closed' });
    await expect(closeIssue('acme', 'board', 1, 'duplicate')).resolves.toEqual({ stateReason: null });
  });
});

// #1009 review — the picker saves a change, never a set, and reads who holds the
// issue on a route of its own. These pin both routes and the body, so a rename on
// either side fails here rather than 404ing on Save.
describe('the picker’s assignee change and fresh read (#1009)', () => {
  function mockJson(body: unknown, status = 200) {
    const fn = vi.fn(
      async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fn);
    return fn as unknown as ReturnType<typeof vi.fn>;
  }

  it('posts only who to add and who to remove, and resolves Github’s whole answer', async () => {
    const fn = mockJson({ assignees: [{ login: 'carol' }, { login: 'bob' }] });

    const res = await changeIssueAssignees('acme', 'board', 1, { add: ['bob'], remove: ['ann'] });

    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/issues\/acme\/board\/1\/assignees\/change$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ add: ['bob'], remove: ['ann'] });
    expect(res.assignees.map((a) => a.login)).toEqual(['carol', 'bob']);
  });

  it('a refused change rejects with the status, like every issue write', async () => {
    mockStatus(503);
    await expect(changeIssueAssignees('acme', 'board', 1, { add: ['bob'], remove: [] })).rejects.toMatchObject({
      status: 503,
    });
  });

  it('reads who holds the issue from its own route, as logins', async () => {
    const fn = mockJson({ assignees: [{ login: 'ann', name: null }] });

    await expect(fetchIssueAssignees('acme', 'board', 1)).resolves.toEqual(['ann']);
    expect((fn.mock.calls[0] as [string])[0]).toMatch(/\/api\/issues\/acme\/board\/1\/assignees$/);
  });

  it('names a missing issue and a refused read the way fetchIssue does', async () => {
    mockStatus(404);
    await expect(fetchIssueAssignees('acme', 'board', 1)).rejects.toThrow('not-found');
    mockStatus(403);
    await expect(fetchIssueAssignees('acme', 'board', 1)).rejects.toThrow('forbidden');
  });
});

/** Answer the next fetch with a refusal body, the way the service answers one
 *  since #584: `{ message, reason, authorizeUrl? }` on the refused status. */
function mockRefusal(status: number, body: Record<string, unknown>) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return fn;
}

// #584 — the status alone is a lossy projection of what the service decided:
// three reasons answer 403. These pin the reason itself onto the rejection, on
// all three writers, so the surface can say which of the three it was.
describe('the writers carry the refusal reason, not just the status (#584)', () => {
  it('an issue write reads the reason and the authorize link out of the body', async () => {
    mockRefusal(403, {
      message: 'no',
      reason: 'not-permitted-yet',
      authorizeUrl: 'https://github.com/orgs/x/sso',
    });
    await expect(setIssueState('acme', 'board', 1, 'closed')).rejects.toMatchObject({
      status: 403,
      reason: 'not-permitted-yet',
      authorizeUrl: 'https://github.com/orgs/x/sso',
    });
  });

  it('a close reads it too', async () => {
    mockRefusal(403, { message: 'no', reason: 'not-permitted' });
    await expect(closeIssue('acme', 'board', 1)).rejects.toMatchObject({
      status: 403,
      reason: 'not-permitted',
    });
  });

  it('the repo tile reads it too — the surface #577 started from', async () => {
    // `setRepoDri` has thrown ApiError since #577, so it compiles and renders a
    // sentence whether or not this lands. Without it an SSO refusal on the dri
    // control says "The board isn’t allowed" and drops the link that fixes it.
    mockRefusal(403, {
      message: 'no',
      reason: 'not-permitted-yet',
      authorizeUrl: 'https://github.com/orgs/x/sso',
    });
    await expect(setRepoDri('acme', 'board', 'octocat')).rejects.toMatchObject({
      status: 403,
      reason: 'not-permitted-yet',
      authorizeUrl: 'https://github.com/orgs/x/sso',
    });
  });

  it('an authorize link that is not on github.com never reaches the rejection', async () => {
    mockRefusal(403, {
      message: 'no',
      reason: 'not-permitted-yet',
      authorizeUrl: 'https://evil.example/sso',
    });
    const err = await setRepoDri('acme', 'board', 'octocat').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).authorizeUrl).toBeUndefined();
  });

  it('a body that is not JSON leaves the status intact and the reason absent', async () => {
    // The failure path must not turn a 502 into a parse error.
    mockStatus(502);
    const err = await setIssueState('acme', 'board', 1, 'closed').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).reason).toBeUndefined();
  });

  it('a reason the frontend does not know is dropped rather than carried', async () => {
    // It is a string off the wire until `isRefusalReason` narrows it.
    mockRefusal(403, { message: 'no', reason: 'made-up' });
    const err = await closeIssue('acme', 'board', 1).catch((e: unknown) => e);
    expect((err as ApiError).reason).toBeUndefined();
  });
});

/**
 * A read a page holds a stale answer over has to name the number it was refused
 * with (#824 follow-up).
 *
 * `scopeStatus` reads `status` off an `ApiError` and, failing that, a number at
 * the end of the message. A bare `Error('forbidden')` has neither, so
 * `scopeRefusal` answers null, and a page whose refusal handler asks "was this
 * a refusal?" gets "no" and holds what is on screen. `fetchRepos` was given the
 * status in #824; `/api/projects` is a read that #824 newly put on disk, and it
 * was left on the bare form — so a reader on `/gtm/team` whose refresh 403s
 * went on being shown yesterday's boards and percentages.
 */
describe('a narrowed read refused with 403 names the number (#824 follow-up)', () => {
  it('fetchProjects rejects with an ApiError carrying 403', async () => {
    mockRefusal(403, { message: 'unknown org gtm' });
    const err = await fetchProjects('gtm').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    // The word every caller has always matched on is unchanged: `mapError` and
    // `App`'s gate both read this message, and a rename here is a sign-in
    // screen that stops appearing.
    expect((err as ApiError).message).toBe('forbidden');
  });

  it('fetchProjects carries the server’s own message, so the org gate can be told apart', async () => {
    mockRefusal(403, { message: 'unknown org gtm' });
    const err = await fetchProjects('gtm').catch((e: unknown) => e);
    expect((err as ApiError).serverMessage).toBe('unknown org gtm');
  });

  it('fetchProjects carries the server’s code, the one thing that tells one 503 from another (#1035)', async () => {
    mockRefusal(503, { message: 'GitHub GraphQL quota is cooling down', code: 'projects_not_now' });
    const err = await fetchProjects('gtm').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503, code: 'projects_not_now', serverMessage: 'GitHub GraphQL quota is cooling down' });
    mockRefusal(503, { statusCode: 503, message: 'GitHub access needs rechecking before this view can be shown; retry' });
    expect((await fetchProjects('gtm').catch((e: unknown) => e) as ApiError).code).toBeUndefined();
  });

  it('fetchOrgIssues and fetchIssueMetrics carry it too, for the Overview tiles’ saved copy (#1046)', async () => {
    const body = { message: 'issue metrics: GitHub quota is cooling down until 2026-09-11T13:00:00.000Z', code: 'issues_not_now' };
    mockRefusal(503, body);
    expect(await fetchOrgIssues('gtm').catch((e: unknown) => e)).toMatchObject({ status: 503, code: 'issues_not_now', serverMessage: body.message });
    mockRefusal(503, body);
    expect(await fetchIssueMetrics({ org: 'gtm' }).catch((e: unknown) => e)).toMatchObject({ status: 503, code: 'issues_not_now', serverMessage: body.message });
    mockRefusal(503, { statusCode: 503, message: 'GitHub access needs rechecking before this view can be shown; retry' });
    expect((await fetchOrgIssues('gtm').catch((e: unknown) => e) as ApiError).code).toBeUndefined();
  });

  it('fetchRepos already did, and this is what fetchProjects was measured against', async () => {
    mockRefusal(403, { message: 'unknown org gtm' });
    const err = await fetchRepos('gtm').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });
});


describe('selected-owner issue reads (#923, #924)', () => {
  for (const [name, read] of [
    ['mine', () => fetchMyIssues('globex')],
    ['all', () => fetchOrgIssues('globex')],
    ['metrics', () => fetchIssueMetrics({ org: 'globex' })],
  ] as const) {
    it(`${name} carries the owner and preserves the server scope verdict`, async () => {
      const fetch = mockRefusal(503, { message: 'issues for globex could not be read' });
      await expect(read()).rejects.toMatchObject({ status: 503, serverMessage: 'issues for globex could not be read' });
      expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(`/api/issues/${name}?org=globex`);
    });
  }
});

// #1061 — the mount gate drew "the board couldn't verify your session" over a
// page whose every request answered 200, because `apiFetch`'s own 409 is an
// ApiError like any other and the gate maps anything that is not a 401 or a 403
// to its error state. A withdrawal needs to be tellable from a 409 the SERVER
// answered, and `issue-detail.controller.ts` answers one for a taken project
// title that `new-project.tsx` reads by status.
describe('a withdrawal is told apart from a 409 the server answered (#1061)', () => {
  it('is a withdrawal only when the board raised it', () => {
    expect(withdrawnRead(new WithdrawnReadError('Your GitHub access changed; reload this view.'))).toBe(true);
    expect(withdrawnRead(new ApiError(409, 'acme already has a project called “Roadmap”.'))).toBe(false);
    expect(withdrawnRead(new ApiError(503, 'me 503'))).toBe(false);
    expect(withdrawnRead(new Error('unauthenticated'))).toBe(false);
    expect(withdrawnRead(undefined)).toBe(false);
  });

  it('still answers 409 to every handler that reads the status', () => {
    // `projects-last-good.ts` and `sync-operation.ts` both branch on the number,
    // so narrowing what can be told apart must move nothing that already was.
    const withdrawal = new WithdrawnReadError('Your GitHub access changed; reload this view.');
    expect(withdrawal.status).toBe(409);
    expect(withdrawal).toBeInstanceOf(ApiError);
    expect(withdrawal.message).toBe('Your GitHub access changed; reload this view.');
  });
});

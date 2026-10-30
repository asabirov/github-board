import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { ApiError } from '../api/core';
import { postIssueComment, type IssueComment } from '../api/issues';
import { resetSessionExpiry } from '../auth/session-expiry';
import { ISSUE_CAP } from './facet-editors';
import { mayWrite, type Me } from '../use-me';

// #693 — an issue could be READ on the board and only answered on Github. The
// write below is the board's half of the round trip; the route and both payload
// shapes are pinned with board-service, so a rename on either side has to fail
// here rather than 404 at a person who just wrote a paragraph.

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => resetSessionExpiry());

/** The posted comment, as the service answers it. `htmlUrl` is nullable because
 *  the contract says so: the permalink is what Github hands back, and a write
 *  that lands without one still produced a real comment. */
const POSTED: IssueComment = {
  author: { login: 'octocat', name: 'Octocat' },
  bodyMarkdown: 'Confirmed — see #123.',
  createdAt: '2026-08-30T09:00:00Z',
  htmlUrl: 'https://github.com/acme/board/issues/7#issuecomment-9',
};

function mockJson(status: number, body: unknown) {
  const fn = vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('posting a comment from the board (#693)', () => {
  it('POSTs bodyMarkdown to the pinned route, owner and repo encoded', async () => {
    const fetchMock = mockJson(201, POSTED);
    await postIssueComment('acme hub', 'board', 7, 'Confirmed — see #123.');
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/api/issues/acme%20hub/board/7/comment');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ bodyMarkdown: 'Confirmed — see #123.' });
  });

  it('resolves with the posted comment, so the thread can append it unreloaded', async () => {
    mockJson(201, POSTED);
    await expect(postIssueComment('acme', 'board', 7, 'x')).resolves.toEqual(POSTED);
  });

  it('carries a null permalink through rather than failing on it', async () => {
    const noLink = { ...POSTED, htmlUrl: null, author: null };
    mockJson(201, noLink);
    await expect(postIssueComment('acme', 'board', 7, 'x')).resolves.toEqual(noLink);
  });

  it('rejects with an ApiError carrying the status AND the refusal reason (#584)', async () => {
    mockJson(403, { message: 'no', reason: 'not-permitted-yet', authorizeUrl: 'https://gh/authorize' });
    const err = await postIssueComment('acme', 'board', 7, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, reason: 'not-permitted-yet' });
  });
});

describe('the capability the composer asks about before it offers itself (#693)', () => {
  // The name has to be the one board-service's `@Writes(...)` gives the route.
  // Spelled out rather than read off the map: a spec that derives the string it
  // is checking cannot see a typo, and `mayWrite` reads an unrecognised key as
  // NOT refused — so one misspelling would arm the composer permanently. That is
  // #635's defect returning invisibly, and `PropertiesPanel.spec.tsx` pins the
  // whole set the same way for the same reason.
  it('is `issue.comment`', () => {
    expect(ISSUE_CAP.comment).toBe('issue.comment');
  });

  const session = (capabilities: Record<string, string>, writesEnabled = true): Me => ({
    email: 'a@b.c', isAdmin: false, name: 'A', writesEnabled, canWrite: writesEnabled,
    githubLogin: 'octocat', capabilities, orgs: [],
  });

  it('withholds the composer when the board’s credential was refused it', () => {
    expect(mayWrite(session({ 'issue.comment': 'refused' }), ISSUE_CAP.comment)).toBe(false);
  });

  it('offers it on `unknown` — an unattempted capability is not a refusal', () => {
    expect(mayWrite(session({}), ISSUE_CAP.comment)).toBe(true);
    expect(mayWrite(session({ 'issue.comment': 'unknown' }), ISSUE_CAP.comment)).toBe(true);
  });

  it('a refused `issue.labels` leaves the composer armed (#635)', () => {
    const me = session({ 'issue.labels': 'refused', 'issue.comment': 'available' });
    expect(mayWrite(me, ISSUE_CAP.comment)).toBe(true);
  });
});

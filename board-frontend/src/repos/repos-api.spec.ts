import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRepoPage, fetchRepos, fetchReposHealth, openIssuesOf, setRepoDri } from '../api/repos';

function mockFetch(res: { ok?: boolean; status?: number; jsonValue?: unknown }) {
  const fn = vi.fn(async () => ({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    json: async () => res.jsonValue,
    text: async () => (res.jsonValue === undefined ? '' : JSON.stringify(res.jsonValue)),
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('setRepoDri (#558)', () => {
  it('PATCHes /api/repos/:owner/:repo/dri with { login } and resolves with the response owner', async () => {
    const owner = { login: 'octocat', name: 'Octocat' };
    const fn = mockFetch({ jsonValue: { owner } });

    const result = await setRepoDri('acme', 'board', 'octocat');

    expect(result).toEqual(owner);
    const [url, init] = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/api/repos/acme/board/dri');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ login: 'octocat' });
    expect(init.credentials).toBe('include');
  });

  it('resolves with a null owner when the write clears the dri', async () => {
    mockFetch({ jsonValue: { owner: null } });
    const result = await setRepoDri('acme', 'board', null);
    expect(result).toBeNull();
  });

  it('rejects on a non-ok response', async () => {
    mockFetch({ ok: false, status: 400 });
    await expect(setRepoDri('acme', 'board', 'octocat')).rejects.toThrow('set owner 400');
  });
});

describe('the health read (#571)', () => {
  it('GETs /api/repos/health and hands back every row the server sent', () => {
    // The second of the page's two reads. It is its own request because the
    // first one has to land without waiting for Github's three alert APIs.
    const fn = mockFetch({
      jsonValue: {
        repos: [
          { full: 'acme/board', security: { depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null }, ci: 'success' },
          { full: 'acme/acme-ui', security: { depHigh: 6, depModerate: 1, codeScanning: 0, secrets: 0, secretsUrl: null }, ci: 'failure' },
        ],
      },
    });

    return fetchReposHealth().then((view) => {
      expect(view.repos.map((r) => r.full)).toEqual(['acme/board', 'acme/acme-ui']);
      expect(view.repos[1].ci).toBe('failure');
      expect(view.repos[1].security.depHigh).toBe(6);
      const [url] = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('/api/repos/health');
    });
  });

  it('rejects on a non-ok response, which is what settles the tiles as unread', () => {
    // The page catches this and settles every tile at an unread security state
    // (#718), so the rejection has to BE a rejection: an empty view would be a
    // payload saying every repo is clean.
    mockFetch({ ok: false, status: 500 });
    return expect(fetchReposHealth()).rejects.toThrow('repos health 500');
  });
});

describe('setRepoDri — what a refused write hands back (#577)', () => {
  it('carries the response status on the rejection, so the caller can say why', async () => {
    mockFetch({ ok: false, status: 403 });

    // A bare Error is why every refusal — 400, 401, 403, 404, 503, 500 — reached
    // the tile as the same four words.
    await expect(setRepoDri('acme', 'board', 'octocat')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('the repo page read (#575)', () => {
  /** The smallest payload the page can be built from — one repo, and all three
   *  of its extra reads present. Shapes mirror `board-service`'s `RepoPageView`. */
  const PAGE = {
    updatedAt: '2026-08-14T09:00:00.000Z',
    repo: {
      full: 'acme/board',
      name: 'board',
      key: 'board',
      htmlUrl: 'https://github.com/acme/board',
      description: 'The board',
      weeks: [{ opened: 1, closed: 2 }],
      open: 7,
      owner: { login: 'octocat', name: 'Octocat' },
      language: 'TypeScript',
      pushedAt: '2026-08-14T08:00:00.000Z',
    },
    readme: { state: 'present', markdown: '# Board' },
    pullRequests: { state: 'read', open: 2, closedMerged: 40, weeks: [{ opened: 3, merged: 4 }] },
    ciSpend: { state: 'read', weeks: [{ minutes: 53, netUsd: 0 }] },
    openIssues: [{
      number: 575, title: 'A repo has its own page', htmlUrl: 'https://github.com/acme/board/issues/575',
      createdAt: '2026-08-01T00:00:00.000Z', author: 'octocat', labels: ['feature'],
    }],
  };

  it('GETs /api/repos/:owner/:name/page and hands the whole view back', async () => {
    const fn = mockFetch({ jsonValue: PAGE });

    const view = await fetchRepoPage('acme', 'board');

    const [url, init] = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/repos/acme/board/page');
    expect(init.credentials).toBe('include');
    expect(view.repo.key).toBe('board');
    // Each of the three extra reads is a state, never a nullable number — so the
    // page can tell "measured at zero" from "could not find out".
    expect(view.readme.state).toBe('present');
    expect(view.pullRequests.state).toBe('read');
    expect(view.ciSpend.state).toBe('read');
    expect(openIssuesOf(view)[0].number).toBe(575);
  });

  it('reads the list under either of its two names, so a deploy skew cannot blank the page', () => {
    // #826 renamed `recentIssues` to `openIssues`, and the two services deploy
    // from `main` independently, so for a window one side sends the name the
    // other stopped reading. Unresolved that is not a missing block: the page's
    // body reads `.length` off it, so the throw unwinds the whole page and the
    // boundary above it draws nothing. `openIssuesOf` is the only thing that
    // knows there are two names, and it goes when #838 drops the older one.
    const rows = PAGE.openIssues;
    expect(openIssuesOf({ ...PAGE, openIssues: rows } as never)).toBe(rows);
    expect(openIssuesOf({ ...PAGE, openIssues: undefined, recentIssues: rows } as never)).toBe(rows);
    // A server that sends neither leaves an empty block, never a broken page.
    expect(openIssuesOf({ ...PAGE, openIssues: undefined } as never)).toEqual([]);
  });

  it('encodes both path segments, so a repo name is never pasted raw into the URL', async () => {
    const fn = mockFetch({ jsonValue: PAGE });
    await fetchRepoPage('a b', 'c d');
    const [url] = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/repos/a%20b/c%20d/page');
  });

  it('rejects on a non-ok response, in the same shape the other repo reads use', async () => {
    mockFetch({ ok: false, status: 500 });
    await expect(fetchRepoPage('acme', 'board')).rejects.toThrow('repo page 500');
  });

  it('rejects a 404 as not-found, so a mistyped repo can say so rather than "error"', async () => {
    mockFetch({ ok: false, status: 404 });
    await expect(fetchRepoPage('acme', 'nope')).rejects.toThrow('not-found');
  });
});

it('preserves the auth cooldown code for the saved map fallback', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ message: 'Try again', code: 'access_not_now' }, { status: 503 }));
  await expect(fetchRepos()).rejects.toMatchObject({ status: 503, code: 'access_not_now' });
});

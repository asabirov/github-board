// A board's address carries its org (#697), and so does the whole shell (#714).
// Kept in its own file rather than folded into `route.spec.ts`, which another
// lane had open when #697 landed — the two changes then merge without touching
// each other.
//
// Three cases below were written for #697 and read the other way now, because
// #714 widened `org` from "the org half of a board number" to "the org the
// shell is narrowed to": `/globex` and `/globex/repos` are addresses now,
// and `routePath({ tab: 'repos', org })` writes the shell instead of dropping
// it. Each says so where it stands.
//
// #785 then moved `/globex/projects` on again: with the rollup deleted there
// is no page at a projects path that names no board, so it is that org's Your
// work rather than that org's Projects tab. The board — the only projects
// address left — is unmoved, which is what "a bare /projects, and the board
// beside it (#785)" below exists to hold still.
import { describe, expect, it } from 'vitest';
import { initialRoute, issuePath, issuePathFromUrl, isOrgLogin, parseRoute, routeOrg, routePath, routeTitle, takesOrgShell, type Route } from './route';
import { forgetOnRoute, readOrgPref, writeOrgPref } from './org-scope/org-pref';

const ISSUE_URL = 'https://github.com/acme/board/issues/9';

describe('a board addressed by its org (#697)', () => {
  it('reads /:org/projects/:number as that org’s board', () => {
    expect(parseRoute('/globex/projects/3')).toEqual({ tab: 'projects', org: 'globex', project: 3 });
  });

  it('round-trips the org through the path', () => {
    const board: Route = { tab: 'projects', org: 'globex', project: 3 };
    expect(routePath(board)).toBe('/globex/projects/3');
    expect(parseRoute(routePath(board))).toEqual(board);
  });

  it('gives two orgs’ board 3 two different addresses', () => {
    const a = routePath({ tab: 'projects', org: 'acme', project: 3 });
    const b = routePath({ tab: 'projects', org: 'globex', project: 3 });
    expect(a).toBe('/acme/projects/3');
    expect(b).toBe('/globex/projects/3');
    expect(a).not.toBe(b);
  });

  it('percent-encodes the org segment on the way out', () => {
    expect(routePath({ tab: 'projects', org: 'a/b', project: 3 })).toBe('/a%2Fb/projects/3');
    // And does NOT read it back as an org: since #714's review a segment has to
    // be shaped like a Github login before it is read as one, and `a/b` is not
    // — the encoding stays as a defence on the way out rather than as a promise
    // that anything round-trips.
    expect(parseRoute('/a%2Fb/projects/3')).toEqual({ tab: 'dashboard' });
  });

  it('titles an org-addressed board exactly as an unqualified one', () => {
    // The two titles are compared to EACH OTHER rather than to a literal: what
    // this pins is that naming the org changes nothing about the title, and a
    // literal pins the title's wording too — which #696 then changed
    // underneath it, failing this for a reason it was never about.
    expect(routeTitle({ tab: 'projects', org: 'globex', project: 3 })).toBe(
      routeTitle({ tab: 'projects', project: 3 }),
    );
  });
});

describe('the shared link that predates the org segment still opens (#697)', () => {
  it('keeps /projects/:number byte-identical, org unnamed', () => {
    expect(parseRoute('/projects/3')).toEqual({ tab: 'projects', project: 3 });
    expect(routePath({ tab: 'projects', project: 3 })).toBe('/projects/3');
    // `routePath({ tab: 'projects' })` was asserted here as `/projects`. #785
    // deleted the rollup, so nothing parses to that route any more — it formats
    // as the page that path opens instead, pinned once in `route.spec.ts`
    // ('formats a projects route with no board as the page that path opens')
    // rather than a second time here, where the subject is the org segment.
  });

  it('keeps the issue route’s ?srcProject= alone when no org qualifies it', () => {
    expect(issuePathFromUrl(ISSUE_URL, 3)).toBe('/issue/acme/board/9?srcProject=3');
    expect(issuePath('acme/board', 9, 3)).toBe(
      '/issue/acme/board/9?srcProject=3',
    );
  });
});

describe('an org segment and a tab name sit in the same position (#697)', () => {
  it('reads the first segment as a tab whenever it is one, never as an org', () => {
    // A repo literally named "projects", reached from a tile: `/repo/:owner/:name`.
    expect(parseRoute('/repo/projects/3')).toEqual({ tab: 'repo', repo: { owner: 'projects', name: '3' } });
    // And one of its tabs (#828) — the section segment is read where the
    // number would be on the projects tab, and neither reading crosses.
    expect(parseRoute('/repo/projects/3/prs'))
      .toEqual({ tab: 'repo', repo: { owner: 'projects', name: '3', section: 'prs' } });
    // An org literally named "repos" loses the shell; the tab wins and the
    // number is dropped, which is the documented cost of the rule.
    expect(parseRoute('/repos/projects/3')).toEqual({ tab: 'repos' });
  });

  it('reads an issue whose OWNER is spelled "projects" as an issue', () => {
    expect(parseRoute('/issue/projects/board/5')).toEqual({
      tab: 'issue',
      issue: { owner: 'projects', repo: 'board', number: 5 },
    });
  });

  // #697 read a shell with no board number as no address at all. #714 made the
  // org itself an address, so what was left when the number was unusable was
  // that org's Projects tab. #785 deleted the rollup that tab's bare path stood
  // at, so each expectation below moved from `{ tab: 'projects', … }` to
  // `{ tab: 'dashboard', … }`: a projects path naming no board now names no
  // page, and the org — where one was given — is all that is left of it.
  it('drops an unusable board number and keeps the org, as the union does', () => {
    expect(parseRoute('/globex/projects')).toEqual({ tab: 'dashboard', org: 'globex' });
    expect(parseRoute('/globex/projects/abc')).toEqual({ tab: 'dashboard', org: 'globex' });
    expect(parseRoute('/globex/projects/0')).toEqual({ tab: 'dashboard', org: 'globex' });
    expect(parseRoute('/projects/abc')).toEqual({ tab: 'dashboard' });
  });

  // Also #697's, also reversed by #714: these three were the dashboard because
  // an org alone addressed nothing. They are the org's own pages now, and the
  // remaining case — an org followed by something no tab answers to — is the
  // one that still collapses, to that org's dashboard.
  it('reads an org segment in front of any primary tab', () => {
    // `/globex/projects` is not in this list: since #785 it is the org's Your
    // work, which the case above already asserts. `/globex/projects/7` — the
    // one projects address left — is asserted below.
    expect(parseRoute('/globex')).toEqual({ tab: 'dashboard', org: 'globex' });
    expect(parseRoute('/globex/repos')).toEqual({ tab: 'repos', org: 'globex' });
    expect(parseRoute('/globex/team')).toEqual({ tab: 'team', org: 'globex' });
    // And two segments whose second is not a shellable tab are not a shell at
    // all — `/assets/x.js` has that shape, and Caddy serves index.html for it.
    expect(parseRoute('/globex/nope')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('/assets/x.js')).toEqual({ tab: 'dashboard' });
  });
});

// ---------------------------------------------------------------------------
// #785 — the rollup that stood at `/projects` is deleted.
// ---------------------------------------------------------------------------

/**
 * What a projects path does now, said outright in one place rather than left to
 * be inferred from the cases above.
 *
 * A projects path naming no usable board resolves to YOUR WORK — not to a 404,
 * and not to a page that says the rollup is gone. That is not a new rule: it is
 * the fallback `tabPath` has always given a path that parses but addresses no
 * page, the same answer a malformed `/issue/acme/acme` or a bare `/repo`
 * gets. With the rollup deleted, a board number is the whole of the projects
 * tab, so `/projects` joined that set rather than earning a treatment of its own.
 *
 * Behind an org shell the org survives the fallback, because `orgShellPath`
 * reads the remainder and spreads the org back onto whatever it leaves. Dropping
 * it would make `forgetOnRoute` true, and one visit to a stale
 * `/acme/projects` link would wipe the scope the device was in.
 *
 * The last two assertions are the constraint the whole of #785 is under: an
 * opened board is addressed exactly as it was before, scoped and unscoped, so
 * every `/projects/:number` link anyone has shared still opens what it opened.
 */
describe('a bare /projects, and the board beside it (#785)', () => {
  it('sends a projects path that names no board to Your work, keeping any org', () => {
    expect(parseRoute('/projects')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('/acme/projects')).toEqual({ tab: 'dashboard', org: 'acme' });
    expect(parseRoute('/projects/abc')).toEqual({ tab: 'dashboard' });
  });

  it('is the same fallback a path that parses but names no page has always had', () => {
    // The comparison is the point: `/projects` is not a special case, it is a
    // member of the set these two were already in.
    expect(parseRoute('/projects')).toEqual(parseRoute('/issue/acme/acme'));
    expect(parseRoute('/projects')).toEqual(parseRoute('/repo/acme'));
  });

  it('leaves the board itself exactly where it was, scoped and unscoped', () => {
    expect(parseRoute('/projects/7')).toEqual({ tab: 'projects', project: 7 });
    expect(parseRoute('/acme/projects/7')).toEqual({ tab: 'projects', org: 'acme', project: 7 });
    // …and formats back to the byte-identical address it was shared as.
    expect(routePath(parseRoute('/projects/7'))).toBe('/projects/7');
    expect(routePath(parseRoute('/acme/projects/7'))).toBe('/acme/projects/7');
  });
});

describe('an issue remembers WHICH board it was opened from (#697)', () => {
  it('carries the source board’s org beside its number', () => {
    expect(issuePathFromUrl(ISSUE_URL, 3, 'globex')).toBe(
      '/issue/acme/board/9?srcProject=3&srcProjectOrg=globex',
    );
    expect(issuePath('acme/board', 9, 3, 'globex')).toBe(
      '/issue/acme/board/9?srcProject=3&srcProjectOrg=globex',
    );
  });

  it('reads it back onto the route', () => {
    expect(parseRoute('/issue/acme/board/9', '?srcProject=3&srcProjectOrg=globex')).toEqual({
      tab: 'issue',
      issue: { owner: 'acme', repo: 'board', number: 9 },
      project: 3,
      org: 'globex',
    });
  });

  it('drops a source org with no source project — half an address addresses nothing', () => {
    expect(parseRoute('/issue/acme/board/9', '?srcProjectOrg=globex')).toEqual({
      tab: 'issue',
      issue: { owner: 'acme', repo: 'board', number: 9 },
    });
  });

  // The twin of route.spec.ts's "does not collide with the viewer's own
  // ?project= filter param": `srcProjectOrg` sits outside `viewer-url.ts`'s
  // KNOWN_PARAMS, so it must not read as viewer state either way round.
  it('does not collide with the viewer’s own filter params', () => {
    const r = parseRoute('/issue/acme/board/9', '?srcProject=3&srcProjectOrg=globex');
    expect(r.viewer).toBeUndefined();
    const filtered = parseRoute('/issue/acme/board/9', '?srcProjectOrg=globex&project=7');
    expect(filtered.org).toBeUndefined();
    expect(filtered.viewer?.filters?.projects).toEqual(['7']);
  });

  // #697 dropped `org` from every tab but Projects, because it meant only the
  // org half of a board number. #714 gave the primary tabs a shell, so what is
  // pinned here now is the half that did not move: on an ISSUE route the org
  // still qualifies the source board and still rides the query, never the path.
  it('keeps the source org in the query, never as a path shell', () => {
    const r: Route = {
      tab: 'issue',
      issue: { owner: 'acme', repo: 'board', number: 9 },
      project: 3,
      org: 'globex',
    };
    expect(routePath(r)).toBe('/issue/acme/board/9?srcProject=3&srcProjectOrg=globex');
    // And an issue route naming an org but no board keeps the plain path it has
    // always had — there is nothing for the org to qualify.
    expect(routePath({ ...r, project: undefined })).toBe('/issue/acme/board/9');
  });
});

// ---------------------------------------------------------------------------
// #714 — the whole shell narrowed to one org, in the path.
// ---------------------------------------------------------------------------

/** Every scoped address the board answers to, and its union twin. Written as
 *  pairs so each case below reads the same URL two ways rather than keeping two
 *  lists in step. */
const SCOPED: [scoped: string, union: string][] = [
  ['/acme', '/'],
  ['/acme/overview', '/overview'],
  ['/acme/repos', '/repos'],
  // `['/acme/projects', '/projects']` was a pair here until #785. Neither
  // half is its own address any more — each resolves to a Your work already in
  // this list and formats back as `/acme` and `/`, so keeping the pair
  // would assert a round trip that no longer exists rather than a scope.
  ['/acme/projects/7', '/projects/7'],
];

describe('the board narrowed to one org, in the path (#714)', () => {
  it('reads /{org}/ in front of a tab as that org’s page', () => {
    expect(parseRoute('/acme')).toEqual({ tab: 'dashboard', org: 'acme' });
    expect(parseRoute('/acme/team')).toEqual({ tab: 'team', org: 'acme' });
    expect(parseRoute('/acme/repos')).toEqual({ tab: 'repos', org: 'acme' });
    // Was `{ tab: 'projects', org: 'acme' }` until #785 deleted the
    // rollup: that path names no page now, and `orgShellPath` spreads the org
    // back onto the Your work it falls to, so the scope survives the fallback.
    expect(parseRoute('/acme/projects')).toEqual({ tab: 'dashboard', org: 'acme' });
    expect(parseRoute('/acme/projects/7')).toEqual({ tab: 'projects', org: 'acme', project: 7 });
  });

  it('answers the same way for any other configured org', () => {
    expect(parseRoute('/globex')).toEqual({ tab: 'dashboard', org: 'globex' });
    expect(parseRoute('/globex/team')).toEqual({ tab: 'team', org: 'globex' });
    expect(parseRoute('/globex/repos')).toEqual({ tab: 'repos', org: 'globex' });
    expect(parseRoute('/globex/projects/7')).toEqual({ tab: 'projects', org: 'globex', project: 7 });
  });

  it('round-trips every scoped address, parse → format → parse', () => {
    for (const [scoped] of SCOPED) {
      expect(routePath(parseRoute(scoped))).toBe(scoped);
      expect(parseRoute(routePath(parseRoute(scoped)))).toEqual(parseRoute(scoped));
    }
  });

  it('gives the union no segment at all — byte for byte what it had', () => {
    expect(parseRoute('/')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('/team')).toEqual({ tab: 'team' });
    expect(parseRoute('/repos')).toEqual({ tab: 'repos' });
    // Was `{ tab: 'projects' }` until #785 — see "a bare /projects, and the
    // board beside it" below, which is where that change is stated in full.
    expect(parseRoute('/projects')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('/projects/7')).toEqual({ tab: 'projects', project: 7 });
    for (const [, union] of SCOPED) {
      expect(routePath(parseRoute(union))).toBe(union);
      expect(parseRoute(routePath(parseRoute(union)))).toEqual(parseRoute(union));
    }
  });

  it('is the same route as the union’s, plus the org — nothing else moves', () => {
    for (const [scoped, union] of SCOPED) {
      expect(parseRoute(scoped)).toEqual({ ...parseRoute(union), org: 'acme' });
    }
  });

  it('keeps the scope when the tab changes', () => {
    // What App's nav does: same org, new tab. From /acme/repos, Overview
    // is /acme/overview.
    const from = parseRoute('/acme/repos');
    expect(routePath({ tab: 'team', org: from.org })).toBe('/acme/overview');
    // `routePath({ tab: 'projects', org: from.org })` was asserted here as
    // `/acme/projects`. #785 deleted the rollup and #750 had already taken
    // Projects off the sidebar, so there is no nav item that builds a projects
    // route without a board number and nothing left for that address to open.
    // And the union keeps its own: from /repos, Overview is /overview.
    expect(routePath({ tab: 'team', org: parseRoute('/repos').org })).toBe('/overview');
  });

  it('percent-encodes the shell on every tab it appears on', () => {
    expect(routePath({ tab: 'repos', org: 'a/b' })).toBe('/a%2Fb/repos');
    // Read back, it is not an org at all — see the charset rule below.
    expect(parseRoute('/a%2Fb/repos')).toEqual({ tab: 'dashboard' });
  });

  it('takes no org shell on the issue and repo pages, which name their own owner', () => {
    expect(parseRoute('/issue/acme/board/9')).toEqual({
      tab: 'issue', issue: { owner: 'acme', repo: 'board', number: 9 },
    });
    expect(parseRoute('/repo/acme/board')).toEqual({
      tab: 'repo', repo: { owner: 'acme', name: 'board' },
    });
    expect(routePath({ tab: 'repo', repo: { owner: 'acme', name: 'acme' }, org: 'globex' }))
      .toBe('/repo/acme/acme');
    // A shell in front of one is not an address at all: the second segment
    // names a tab that takes no shell, so the whole path is the plain dashboard
    // — the org goes with it, the same way `/assets/x.js` keeps nothing.
    expect(parseRoute('/globex/issue/acme/acme/9')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('/globex/repo/acme/acme')).toEqual({ tab: 'dashboard' });
    // A tab of that page behind a shell is the same non-address (#828). The
    // fourth segment does not rescue it: the second segment is what decides,
    // and it names a tab that takes no shell.
    expect(parseRoute('/globex/repo/acme/acme/issues')).toEqual({ tab: 'dashboard' });
    expect(routePath({ tab: 'repo', repo: { owner: 'acme', name: 'acme', section: 'members' }, org: 'globex' }))
      .toBe('/repo/acme/acme/members');
  });

  it('lands a stale org-scoped bookmark on THAT org’s Your work (#712 review)', () => {
    // `/acme/docs` was a page of acme's board. Dropping the org made
    // it the UNION's Your work, and `forgetOnRoute` is true there — so one visit
    // to an old link wiped the org this device was narrowed to.
    for (const path of ['/acme/docs', '/acme/admin', '/acme/account']) {
      expect(parseRoute(path), path).toEqual({ tab: 'dashboard', org: 'acme' });
      expect(forgetOnRoute(parseRoute(path)), path).toBe(false);
    }
  });

  it('takes no org shell on a page that names its own owner either', () => {
    // Neither narrows to an org: each names its owner in the path already. The
    // personal and admin surfaces used to be tested here too; #712 took their
    // addresses away, so there is no path left for an org to sit in front of.
    expect(routePath({ tab: 'repo', org: 'globex', repo: { owner: 'acme', name: 'acme' } }))
      .toBe('/repo/acme/acme');
    expect(routePath({ tab: 'issue', org: 'globex', issue: { owner: 'acme', repo: 'acme', number: 9 } }))
      .toBe('/issue/acme/acme/9');
  });

  // #697's rule, inherited whole: a first segment that IS a tab is a tab.
  it('still reads a first segment that is a tab name as the tab', () => {
    expect(parseRoute('/repos')).toEqual({ tab: 'repos' });
    expect(parseRoute('/team')).toEqual({ tab: 'team' });
    expect(parseRoute('/repos/team')).toEqual({ tab: 'repos' });
    expect(parseRoute('/team/repos')).toEqual({ tab: 'team' });
  });
});

describe('a board number addresses a BOARD, not a shell (#697, restated by #714’s review)', () => {
  // #714 widened `org` on a projects route to mean the whole shell, so opening
  // any board that carried its own org — every card in the UNION rollup did —
  // silently narrowed every tab and wrote that org into the device's memory.
  // The rollup went with #785 and the finding did not: the palette
  // (`search-index.ts`) and Your work's Contributions rings both still address a
  // board by `(org, number)`. What `org` means on `/acme/projects/7` is
  // what it meant in #697: THAT org's board 7.
  it('parses and formats exactly as it did — every #697 link still opens', () => {
    expect(parseRoute('/acme/projects/7')).toEqual({ tab: 'projects', org: 'acme', project: 7 });
    expect(routePath({ tab: 'projects', org: 'acme', project: 7 })).toBe('/acme/projects/7');
    expect(routePath(parseRoute('/acme/projects/7'))).toBe('/acme/projects/7');
  });

  it('narrows no shell, so opening a board from the union leaves the union', () => {
    expect(routeOrg({ tab: 'projects', org: 'acme', project: 7 })).toBeNull();
    expect(takesOrgShell({ tab: 'projects', org: 'acme', project: 7 })).toBe(false);
    // What App's nav does from that page: the union's tabs, not acme's.
    const from = parseRoute('/acme/projects/7');
    expect(routePath({ tab: 'repos', org: routeOrg(from) ?? undefined })).toBe('/repos');
  });

  // Named for the rollup until #785, because the rollup was what
  // `/acme/projects` reached. It reaches that org's Your work now, and the
  // property this holds is the one that matters either way: the fallback keeps
  // the scope. Dropping the org would make `forgetOnRoute` true and one visit to
  // a stale link would wipe the org the device was narrowed to.
  it('still narrows the shell for a projects path with no board to address', () => {
    expect(routeOrg(parseRoute('/acme/projects'))).toBe('acme');
    expect(takesOrgShell(parseRoute('/acme/projects'))).toBe(true);
    expect(forgetOnRoute(parseRoute('/acme/projects'))).toBe(false);
    for (const path of ['/acme', '/acme/team', '/acme/repos']) {
      expect(routeOrg(parseRoute(path)), path).toBe('acme');
    }
  });

  it('takes no shell on a tab that has none, whatever the route carries', () => {
    for (const tab of ['issue', 'repo'] as const) {
      expect(takesOrgShell({ tab, org: 'acme' }), tab).toBe(false);
    }
  });
});

describe('a path segment is read as an org only if it could be one (#714 review)', () => {
  // `org-pref.ts` validated the LESS hostile source — a value this board wrote
  // itself into localStorage — with a Github-login regex, while `route.ts` took
  // any segment at all off the address bar and rendered it into "This board does
  // not cover ${org}". React escapes it, so there was no injection; the
  // asymmetry was the finding, and one validator now answers for both.
  it('accepts what Github accepts and nothing else', () => {
    for (const ok of ['acme', 'globex', 'a', 'A1', 'x'.repeat(39)]) {
      expect(isOrgLogin(ok), ok).toBe(true);
    }
    for (const no of ['', ' ', 'a b', 'a/b', '../etc', 'x'.repeat(40), '{"org":"x"}', '-lead', 'a.b', '%E0']) {
      expect(isOrgLogin(no), no).toBe(false);
    }
  });

  it('does not read an unusable segment as an org', () => {
    expect(parseRoute('/a%20b')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('/a%2Fb/repos')).toEqual({ tab: 'dashboard' });
    expect(parseRoute(`/${'x'.repeat(40)}/team`)).toEqual({ tab: 'dashboard' });
  });

  it('leaves a segment that COULD be an org exactly as it was', () => {
    // `/gtm` is still an org named gtm, which the API answers 404 for — that is
    // the stated cost of `/{org}` being an address, and this check is a charset
    // guard rather than a list of the orgs a deployment serves.
    expect(parseRoute('/gtm')).toEqual({ tab: 'dashboard', org: 'gtm' });
    expect(parseRoute('/roadmap')).toEqual({ tab: 'dashboard', org: 'roadmap' });
  });
});

/** A localStorage stand-in — the suite runs with `environment: 'node'`, where
 *  there is none. Same shape `single-org.spec.tsx` uses. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
}

function withStorage<T>(seed: (s: MemoryStorage) => void, run: () => T): T {
  const g = globalThis as unknown as { localStorage?: unknown };
  const store = new MemoryStorage();
  seed(store);
  g.localStorage = store;
  try {
    return run();
  } finally {
    delete g.localStorage;
  }
}

describe('the org the board remembers (#714)', () => {
  it('is consulted when the address names nothing at all', () => {
    expect(initialRoute('/', '', 'acme')).toEqual({ tab: 'dashboard', org: 'acme' });
  });

  it('is ignored on every other address, so a shared link opens as it was sent', () => {
    // The whole point of the rule: /team sent to a colleague is the union for
    // them, not whichever org the sender was last in.
    expect(initialRoute('/team', '', 'acme')).toEqual({ tab: 'team' });
    expect(initialRoute('/repos', '', 'acme')).toEqual({ tab: 'repos' });
    // Was `{ tab: 'projects' }` until #785. A `/projects` link sent to a
    // colleague still opens the UNION and not the sender's org — the page it
    // opens is Your work now, and that is the only half that moved.
    expect(initialRoute('/projects', '', 'acme')).toEqual({ tab: 'dashboard' });
    expect(initialRoute('/projects/7', '', 'acme')).toEqual({ tab: 'projects', project: 7 });
    expect(initialRoute('/issue/acme/acme/9', '', 'acme')).toEqual({
      tab: 'issue', issue: { owner: 'acme', repo: 'acme', number: 9 },
    });
    // An address that names an org beats what was remembered.
    expect(initialRoute('/globex/team', '', 'acme')).toEqual({ tab: 'team', org: 'globex' });
  });

  it('falls to the union when nothing is remembered', () => {
    expect(initialRoute('/', '', null)).toEqual({ tab: 'dashboard' });
    expect(initialRoute('/', '?repo=board', null).tab).toBe('dashboard');
  });

  it('reads back the org it stored', () => {
    expect(withStorage(() => {}, () => {
      writeOrgPref('acme');
      return readOrgPref();
    })).toBe('acme');
  });

  it('carries a saved scope over from the old `lessly_org` key once (#1450)', () => {
    let store: MemoryStorage;
    const read = withStorage((s) => { store = s; s.setItem('lessly_org', 'acme'); }, () => readOrgPref());
    expect(read).toBe('acme');
    expect(store!.getItem('board_org')).toBe('acme');
    expect(store!.getItem('lessly_org')).toBeNull();
  });

  it('forgets the org when the board is back on the union', () => {
    expect(withStorage(() => {}, () => {
      writeOrgPref('acme');
      writeOrgPref(null);
      return readOrgPref();
    })).toBe(null);
  });

  it('ignores a stored value the board could not address', () => {
    // A tab name would resolve to the TAB and not to an org (the tab-wins rule),
    // so remembering one would silently open the wrong page. The rest cannot be
    // a Github org login at all.
    // The five #712 retired the addresses of belong here for the same reason the
    // tabs do — and one casing of each, because the predicate this reads is the
    // one `parseRoute` reads and neither may be fooled by a capital.
    for (const junk of [
      '', ' ', 'repos', 'team', 'projects', 'a/b', 'a b', '../etc', 'x'.repeat(40), '{"org":"x"}',
      'admin', 'account', 'feedback', 'docs', 'preferences', 'Admin', 'DOCS', 'Repos',
    ]) {
      expect(withStorage((s) => s.setItem('board_org', junk), () => readOrgPref())).toBe(null);
    }
  });

  // #714 review. Two halves of one rule, and the bug was that neither held.
  //
  // A junk segment used to be remembered on sight: one visit to a stale
  // `/roadmap` bookmark wrote `roadmap` into storage, and that device's `/` then
  // opened a board saying "This board does not cover roadmap" on every tab, for
  // good. Remembering is now a page's answer, not an address's — `useScopeState`
  // writes only after a narrowed read came back served.
  //
  // And FORGETTING ran on every route change, including tabs that take no
  // shell, so opening a repo page cleared the org the shell was in.
  it('forgets only when an org-scoped address names no org', () => {
    // The union, asked for by name: forget, which is what keeps `/` reachable.
    // A retired #712 address is Your work — the union's shell — so it forgets
    // for exactly that reason, and not as a surface of its own.
    for (const path of ['/', '/team', '/repos', '/projects', '/account', '/admin', '/docs']) {
      expect(forgetOnRoute(parseRoute(path)), path).toBe(true);
    }
  });

  it('leaves the remembered org alone on every address that is not the union’s shell', () => {
    for (const path of [
      // An org is named — the page decides, once its read is answered.
      '/acme', '/acme/team', '/acme/repos', '/acme/projects',
      // A board addresses a board and narrows nothing, so it says nothing here
      // — whether or not the address names the org.
      '/acme/projects/7', '/projects/7',
      // These take no shell at all: one repo, one issue.
      '/repo/acme/acme', '/issue/acme/acme/9',
    ]) {
      expect(forgetOnRoute(parseRoute(path)), path).toBe(false);
    }
  });

  it('reads nothing on a device with no storage, and writing there does not throw', () => {
    // No `localStorage` global at all — vitest's node environment, and a browser
    // with storage denied.
    expect(readOrgPref()).toBe(null);
    expect(() => writeOrgPref('acme')).not.toThrow();
  });
});

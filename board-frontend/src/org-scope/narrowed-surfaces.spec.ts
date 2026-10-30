/**
 * The rules every surface an address can narrow has to keep (#714), pinned as
 * source text.
 *
 * TEXT ONLY, and for the reason `ReposMap.spec.tsx` and `TeamView.spec.ts` give:
 * this suite has no DOM, so no effect fires and no refetch can
 * be observed by rendering. What each surface DRAWS at each state is pinned
 * beside that surface; what the sentences SAY is `scope-copy.spec.ts`; that a
 * narrowed read asks for a narrowed URL is `api-scoped-reads.spec.ts`. What is
 * left is the wiring between them, which is what these greps are for.
 *
 *   1. ONE VOICE. A sentence about the selected org is written in
 *      `scope-copy.ts` and nowhere else. Three surfaces each phrasing "this
 *      board does not cover globex" their own way is how the board ends up
 *      telling one reader two different things about one org.
 *   2. THE ORG IS ASKED FOR. Every call to a fetcher that can be narrowed
 *      passes an org — or the file is on the exemption list below WITH a written
 *      reason, which is one line and a review rather than an omission.
 *   3. THE ORG IS IN THE FETCH KEY. The value passed to that fetcher is in some
 *      effect's dependency list, so `/acme/repos` → `/globex/repos` is a
 *      different request. Keyed on the refresh signal alone, the navigation
 *      changed nothing on screen at all.
 *   4. THE READ CANCELS. Two org-keyed reads are in flight across a navigation
 *      and either can win. `ProjectsView` had no `alive` flag and no cleanup at
 *      all, and the previous org's answer could land on top of the new org's.
 *   5. THE ANSWER WRITES THE STATE. Nothing in that effect writes state BEFORE
 *      the request is made. `CommandPalette` set its "loaded for this org" latch
 *      on the line above its `fetchProjects`, so on `/gtm` — an org this board
 *      refuses — the palette marked itself loaded on a promise that then
 *      rejected into `() => {}`, went on offering the previous org's boards for
 *      the life of the page, and never asked for that org again. A surface that
 *      has to clear the previous org's data first does it in its OWN effect
 *      keyed on the org, which is what four of these five already do.
 *   6. WHAT CANNOT BE NARROWED SAYS SO. A page holding a scope draws as many
 *      scope sentences as it draws surfaces fed by a read that takes no `org`.
 *      Your work drew three of them from `/api/issues/mine` — the flow strip,
 *      the Contributions boards and the personal queue — under a heading
 *      reading `Your work · acme`, and only the strip said whose work it
 *      was counting.
 *
 * WHAT THIS FILE USED TO BE, and why it is not that any more. Its file list was
 * hand-written and missed `CommandPalette.tsx` and `PageCrumb.tsx` — the two
 * that were actually wrong. Its key check was `/\borg\b/` against a dependency
 * list, which any prop, field or word spelled `org` satisfies. And it asserted
 * nothing about cancellation, which is why the race above passed it. The file
 * list is read off the tree now, and each rule names the value it is about.
 */
import { describe, expect, it } from 'vitest';

/** Every source file in the app, read off the TREE rather than listed by hand:
 *  a page added tomorrow is swept by existing, not by being remembered. */
const MODULES: Record<string, string> = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Block and line comments out, string literals kept: what a file SAYS to a
 *  person is its literals, never its comments. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The app's own files, excluding specs and the facade and adapters that define
 *  the fetchers every rule below is about. */
const APP = Object.entries(MODULES)
  .filter(([path]) => !path.includes('.spec.') && !path.endsWith('/api/repos.ts') && !path.endsWith('/api/projects.ts'))
  .map(([path, source]) => [path.replace(/^\.\.\//, '').replace(/^\.\//, 'org-scope/'), code(source)] as const);

/** The reads an address can narrow — `api-scoped-reads.spec.ts` pins what each
 *  of them asks for. */
const NARROWABLE = /\bfetch(?:Projects|ReposHealth|Repos)\(([^)]*)\)/g;

/** The value handed to a narrowable read, as written: `scope.org` for a page
 *  holding a `ScopeState`, `org` for one reading the scope directly. Empty
 *  string for a call that named none. */
function scopedCalls(body: string): string[] {
  return [...body.matchAll(NARROWABLE)].map((m) => {
    const arg = m[1].trim();
    return /^[A-Za-z_$][\w$]*(\.[\w$]+)?/.exec(arg)?.[0] ?? '';
  });
}

const READERS = APP.filter(([, body]) => scopedCalls(body).length > 0);

/**
 * One `useEffect` at a time: its body and its dependency list.
 *
 * Per EFFECT and not per file, which is the difference between a rule and a
 * coincidence. Checked against the whole file, `ReposPage` passes rule 3 with
 * the org taken out of the read's own key, because a second effect beside it —
 * the one that clears the last org's map — still names `scope.org`. Verified by
 * making exactly that cut and watching this file stay green before it was
 * written this way.
 */
function effects(body: string): { block: string; deps: string }[] {
  return [...body.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, (\[[^\]]*\])\);/g)]
    .map((m) => ({ block: m[1], deps: m[2] }));
}

/**
 * A read that deliberately asks for the union, and why.
 *
 * One entry, and it has to stay a decision somebody wrote down: a second file
 * appearing here without a line saying why is the omission this list exists to
 * make visible.
 */
const UNSCOPED_ON_PURPOSE: Record<string, string> = {
  'PageCrumb.tsx':
    'resolves an issue page’s ?srcProject= to a board name. An issue takes no org '
    + 'shell (#697/#714), and the pair (number, srcProjectOrg) is the board’s whole '
    + 'address — so the union is exactly the list that can contain it.',
};

describe('every narrowable read is asked for a scope (#714)', () => {
  it('found the surfaces to sweep — an empty sweep would pass anything', () => {
    expect(APP.length).toBeGreaterThan(50);
    const names = READERS.map(([p]) => p);
    // The five the app has today, named so a deletion is a failure rather than
    // a quietly smaller sweep. It was six until #785: `projects/ProjectsView.tsx`
    // was swept for the rollup's `fetchProjects(org)`, and the board page left
    // behind reads `fetchProject(number, org)` — a different fetcher, not on
    // NARROWABLE above, and one whose org is part of a board's address rather
    // than a filter over a list. It is simply not one of the reads this rule is
    // about. (The `alive` cancellation this comment once credited it with was
    // the ROLLUP's, and went with the rollup; the board read got its own in the
    // same change that wrote this line down straight.)
    for (const f of [
      'repos/ReposPage.tsx', 'dashboard/Dashboard.tsx', 'dashboard/Pulse.tsx',
      'search/CommandPalette.tsx', 'PageCrumb.tsx',
    ]) {
      expect(names, `${f} reads a narrowable endpoint and must be swept`).toContain(f);
    }
  });

  for (const [name, body] of READERS) {
    it(`${name} passes an org to every read that can carry one`, () => {
      const unscoped = scopedCalls(body).filter((a) => a === '');
      if (name in UNSCOPED_ON_PURPOSE) {
        expect(UNSCOPED_ON_PURPOSE[name].length).toBeGreaterThan(40);
        return;
      }
      expect(unscoped, `${name} asks for the union with no reason on record`).toEqual([]);
    });
  }
});

describe('a narrowed page refetches, and cancels, when the org changes (#714)', () => {
  const SCOPED = READERS.filter(([name]) => !(name in UNSCOPED_ON_PURPOSE));

  for (const [name, body] of SCOPED) {
    /** The effects that actually make one of these reads. Every rule below is
     *  about THOSE, not about the file they happen to live in. */
    const reading = effects(body).filter((e) => scopedCalls(e.block).length > 0);

    it(`${name} makes its narrowable read inside an effect`, () => {
      expect(reading.length, `${name}: no useEffect contains a narrowable read`).toBeGreaterThan(0);
    });

    it(`${name} keys that effect on the very value it passes to the read`, () => {
      for (const { block, deps } of reading) {
        // The VALUE, not the word `org`: the check this replaces was `/\borg\b/`
        // against the dependency list, which any prop or field spelled `org`
        // satisfies — including one that has nothing to do with the address.
        for (const value of new Set(scopedCalls(block).filter(Boolean))) {
          expect(
            deps.includes(value),
            `${name} passes ${value} to a read keyed on ${deps}`,
          ).toBe(true);
        }
      }
    });

    /** The first request in the effect, whichever endpoint it is: everything
     *  before it runs on a promise nobody has an answer to yet. */
    const FIRST_READ = /\bfetch[A-Z]\w*\(/;
    /** A state write, as written. Narrower than `set` alone on purpose — a
     *  local `settings` or `setup` is not a setter. */
    const WRITES = /\bset[A-Z]\w*\(/g;

    it(`${name} lets the answer write the state, never the request`, () => {
      for (const { block } of reading) {
        const at = FIRST_READ.exec(block)?.index;
        expect(at, `${name}: an effect that reads has no read in it`).toBeDefined();
        const early = [...block.slice(0, at).matchAll(WRITES)].map((m) => m[0]);
        expect(
          early,
          `${name} writes ${early.join(', ')} before the read it is about to make — `
          + 'a latch set on a promise stays set when that promise rejects. Clear the '
          + 'previous org in its own effect keyed on the org.',
        ).toEqual([]);
      }
    });

    it(`${name} cancels the read it started`, () => {
      // Both halves, in the effect that made the read. A flag with no cleanup
      // never clears, and a cleanup with no flag cancels nothing — and the loser
      // of a race then overwrites the winner, which is what
      // `/acme/projects` → `/globex/projects` did.
      if (name === 'repos/ReposPage.tsx') {
        // The shared lifetime cancels at hard scope boundaries; soft renewal
        // must let an authorized in-flight answer finish (#957).
        expect(body).toContain('JSON.stringify([scope.org, accessEpoch])');
        expect(body).toContain('beginRows = useReadSequence(readKey)');
        expect(body).toContain('beginHealth = useReadSequence(readKey)');
        expect(body).toContain('if (!acceptRows()) return;');
        expect(body).toContain('if (acceptHealth())');
        return;
      }
      for (const { block } of reading) {
        if (block.includes('const accept = beginProjects();')) {
          expect(name).toMatch(/^dashboard\/(Dashboard|Pulse)\.tsx$/);
          const owner = name === 'dashboard/Dashboard.tsx' ? 'owner' : 'scope.org';
          expect(body).toContain(`useReadSequence(JSON.stringify([${owner}, accessEpoch]))`);
          expect(block.match(/if \(!accept\(\)\) return;/g)).toHaveLength(2);
          continue;
        }
        expect(block, `${name} starts an org-keyed read with no alive flag`).toMatch(/let alive = true;/);
        expect(block, `${name} never clears it`).toMatch(/alive = false;/);
      }
    });
  }
});

/**
 * The words `scope-copy.ts` owns. A surface holding one of these in a string
 * literal has written its own copy of a sentence that already exists — the
 * failure this rule is here to catch. Swept over the WHOLE app, not a list: a
 * new page phrasing its own refusal is exactly the case a list would miss.
 */
const OWNED = [
  /does not cover/,
  /could not read/,
  /count every org/,
  /no count here/,
];

/**
 * The two files allowed to write these words, and what each of them is.
 *
 * `scope-copy.ts` is the voice for the org an ADDRESS narrowed to.
 * `auth/org-scope-copy.ts` is the voice for the union's own missing members —
 * a different question, named as the other half in `scope-copy.ts`'s own
 * header, and it says "the board could not read" about a list of orgs rather
 * than about the selected one. Two files by design; a third is the drift.
 */
const VOICES: Record<string, string> = {
  'org-scope/scope-copy.ts': 'the org an address narrowed to (#714)',
  'auth/org-scope-copy.ts': 'the orgs a UNION read left out (#650) — the other half of one voice',
};

describe('issue pages narrow their reads to the selected owner (#923, #924)', () => {
  it('both pages send the selected owner and keep their payload caches separate', () => {
    const dashboard = APP.find(([name]) => name === 'dashboard/Dashboard.tsx')![1];
    const team = APP.find(([name]) => name === 'team/TeamView.tsx')![1];
    expect(dashboard).toContain('fetchMyIssues(owner ?? undefined, undefined, timeZone)');
    expect(dashboard).toContain('orgScopedKey(MINE_KEY, owner)');
    expect(dashboard).toContain('dayQuery(owner ?? undefined, timeZone)');
    expect(team).toContain('fetchOrgIssues(owner ?? undefined)');
    expect(team).toContain('fetchIssueMetrics({ org: owner ?? undefined, timeZone })');
    expect(team).toContain('orgScopedKey(ORG_QUEUE_KEY, owner)');
    expect(team).toContain('orgScopedKey(METRICS_KEY, owner)');
    expect(team).toContain('dayQuery(owner ?? undefined, timeZone)');
    for (const source of [dashboard, team]) expect(source).not.toContain('unnarrowedSentence(');
  });
});

describe('one voice about the selected org (#714)', () => {
  const OWNER = 'org-scope/scope-copy.ts';

  it('the owner still writes them, so the sweep below is not vacuous', () => {
    const owner = APP.find(([p]) => p === OWNER);
    expect(owner, 'scope-copy.ts must be in the sweep').toBeDefined();
    for (const phrase of OWNED) expect(owner![1]).toMatch(phrase);
    // And every file the sweep excuses is excused for a written reason.
    for (const [file, why] of Object.entries(VOICES)) {
      expect(APP.map(([p]) => p), file).toContain(file);
      expect(why.length).toBeGreaterThan(20);
    }
  });

  for (const [name, body] of APP) {
    if (name in VOICES) continue;
    it(`${name} writes no sentence scope-copy.ts already owns`, () => {
      for (const phrase of OWNED) {
        expect(body, `${name} ${phrase}`).not.toMatch(phrase);
      }
    });
  }
});

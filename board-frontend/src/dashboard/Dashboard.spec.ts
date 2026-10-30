/**
 * Your work's wiring, as text (#824 review).
 *
 * Nothing here renders `Dashboard`: it reads the URL through
 * `useLocationSearch`, which is a `useSyncExternalStore` and throws under
 * `react-dom/server`, and no effect fires in this suite anyway. What each of
 * these lines DOES is held where a real test
 * can reach it — `ProjectContributions.spec.tsx` draws the strip in both of the
 * rollup's absent states, `mine-fallback.spec.ts` holds the empty queue's
 * sentences, `project-filter.spec.ts` holds the ring press. What is left is
 * which value this page hands to which of them, and that is what these pin.
 */
import { describe, expect, it } from 'vitest';
import SOURCE from './Dashboard.tsx?raw';
import QUEUE from '../ui/IssueQueue.tsx?raw';

/**
 * A named span of the file, asserted non-empty by every test that uses one. A
 * slice that missed makes every `not.toContain` under it vacuously true.
 */
function slice(from: string, to: string): string {
  const start = SOURCE.indexOf(from);
  const end = SOURCE.indexOf(to, start);
  return start < 0 || end < 0 ? '' : SOURCE.slice(start, end);
}

/** The read effect alone: the one a two-minute tick and a Sync now both re-run,
 *  and the one every claim below is about. */
const readEffect = slice('const opening = takeOpeningMine', '}, [refresh, scope.org, timeZone, accessEpoch, renewal, takeOpeningMine]);');
/** The rollup's own effect, split off in #892's review so an expired access
 *  check can refill the boards without also re-reading the personal queue and
 *  the filter set. Every claim about the rollup's failure path reads THIS. */
const rollupEffect = slice('fetchProjects(owner ?? undefined)', '}, [refresh, owner, accessEpoch, renewal, beginProjects, setProjects]);');

describe('the queue and projects retain authorized cached responses (#974)', () => {
  it('seeds each response under its own scoped cache key', () => {
    expect(SOURCE).toContain('useReadState<PersonalIssues>(`/api/issues/mine${dayQuery(owner ?? undefined, timeZone)}`)');
    expect(SOURCE).toContain('useReadState<ProjectSummary[], { projects: ProjectSummary[] }>(`/api/projects${scopeQuery(owner ?? undefined)}`, value => value.projects)');
  });

  it('keeps failure separate from the held summaries', () => {
    expect(rollupEffect).not.toBe('');
    expect(rollupEffect).toContain('setRollupFailed(true);');
    expect(rollupEffect).not.toContain('setProjects([])');
    // A failed read may draw a copy (#1035), never an invented empty list.
    expect(SOURCE).toContain('const boards = projects ?? copy?.value ?? null;');
    expect(SOURCE).not.toMatch(/const boards = [^;]*\?\? \[\]/);
    expect(SOURCE).toContain('projects={boards}');
    expect(SOURCE).toContain('failed={rollupFailed}');
  });

  it('withdraws every copy on a refusal, on the saved copy’s rule (#1060)', () => {
    // The rule is `projectsAfterFailure`, which asks `servableFailure` — the
    // saved copy's own — so the boards this page holds, the stored copy behind
    // them and every saved copy go together. It asked `scopeWithdrawn` before,
    // a narrower question that a 500 does not answer, so a Github FORBIDDEN
    // left all three. Which statuses count is driven against a real store in
    // `projects-last-good.spec.ts`, and the mounted page in a real browser by
    // scripts/check-projects-preview.mjs, mode `held-refusal`.
    expect(rollupEffect).toContain('const after = projectsAfterFailure(owner, e);');
    expect(rollupEffect).toContain('setSaved(after.saved);');
    expect(rollupEffect).toContain('if (!after.keepHeld) setProjects(null);');
    expect(rollupEffect).not.toContain('scopeWithdrawn(');
    expect(rollupEffect).not.toContain('forgetPayload(');
  });
});

/**
 * The three background failures that must change nothing on screen, and the one
 * seed that keeps a control from opening empty (#824 follow-up).
 *
 * Every one of these is a line whose deletion left the whole suite green. The
 * queue guard is the sharpest: `if (holdsQueue.current) return;` is the whole of
 * what stops a failed refresh blanking Your work, which is the defect #824
 * exists for, and removing it kept 129 files and 2961 tests passing at exit 0.
 * `ReposMap.spec.tsx` pins the identical guard on `ReposPage`, so the shape was
 * already in the repo; Your work simply had none.
 */
describe('a failed refresh takes nothing off Your work (#824)', () => {
  it('keeps a queue that already has real issues on it', () => {
    expect(readEffect, 'the read effect must still be findable').not.toBe('');
    expect(readEffect).toContain('if (holdsQueue.current) return;');
    // Set on the way in from both sides — a live read and the copy on disk — or
    // the question above is always answered "no" and the guard never fires.
    expect(SOURCE).toContain('const holdsQueue = useRef(mine !== null);');
    expect(readEffect).toContain('holdsQueue.current = true;');
    // And the fallback is DERIVED, so it is never a value the cache was asked
    // to keep: stored, it would open the next visit on an empty queue under
    // "No Github login on your account".
    expect(SOURCE).toContain("const queue = mine ?? (mineError !== null ? MINE_UNAVAILABLE : null);");
    expect(readEffect).not.toContain('setMine(MINE_UNAVAILABLE)');
  });

  it('keeps the filter set the autocomplete already had', () => {
    // An empty set silently narrows what the control offers, which is worse
    // than a set whose response lease is still valid.
    const options = slice('fetchFilterOptions()', 'return () => { alive = false; };');
    expect(options, 'the filter-options read must still be findable').not.toBe('');
    expect(options).toContain('() => {},');
    expect(options).not.toContain('EMPTY_FILTER_OPTIONS');
  });

  it('asks for no delivery payload, because nothing on the page spends one', () => {
    // It fetched `/api/delivery` and cached it for the strip's Releases tile.
    // #816 replaced that tile with the oldest open issue, which is derived from
    // the queue this page already holds — so the read outlived its only reader
    // by a whole issue and cost every visit a request feeding nothing (#866).
    expect(SOURCE).not.toContain('fetchDelivery');
    expect(SOURCE).not.toContain('DELIVERY_KEY');
  });

  it('opens the autocomplete on the last set this person was served', () => {
    expect(SOURCE).toContain("useReadState<FilterOptions>('/api/issues/filter-options')");
    expect(SOURCE).toContain('const options = heldOptions ?? EMPTY_FILTER_OPTIONS');
    expect(readEffect).toContain('setOptions(o)');
  });

  it('tells the strip its figures never change subject', () => {
    // Nothing on this page re-scopes the tiles, so a constant is the honest
    // answer rather than an oversight, and a figure that lands different really
    // did move (#824). Passing nothing would have been silence, which the strip
    // reads as "this caller has said nothing" and marks no movement at all.
    expect(SOURCE).toContain('subject={MY_WORK}');
    expect(SOURCE).toMatch(/const MY_WORK = '[^']+';/);
  });
});

/**
 * What a fresh access check costs, and what it must not (#892 review, C2).
 *
 * The Projects rollup has to be re-read at every expiry: a private board is a
 * project grant, and a check that finds the same repositories observes no
 * project grant at all. The personal queue and the filter set do not — those a
 * fresh check releases — and re-reading them once a minute is two requests a
 * minute this page never has to make. The split between the two effects is that
 * decision, and this is what holds it.
 */
describe('the access epoch reaches every Projects-derived answer (#905)', () => {
  it('re-reads the rollup on a fresh check', () => {
    expect(rollupEffect, 'the rollup effect must be findable').not.toBe('');
    expect(SOURCE).toContain('}, [refresh, owner, accessEpoch, renewal, beginProjects, setProjects]);');
  });

  it('re-reads the queue and filter set for a fresh authorization', () => {
    expect(readEffect, 'the queue and filter effect must be findable').not.toBe('');
    expect(readEffect).toContain('fetchMyIssues(owner ?? undefined, undefined, timeZone)');
    expect(readEffect).toContain('fetchFilterOptions()');
    expect(SOURCE.slice(SOURCE.indexOf('fetchMyIssues('), SOURCE.indexOf('fetchMyIssues(') + readEffect.length + 70)).toContain('accessEpoch, renewal');
    expect(readEffect, 'and the rollup is no longer in here').not.toContain('fetchProjects(');
  });

  it('delegates expiry to the cache and fences pending reads at hard boundaries', () => {
    expect(SOURCE).toContain('useReadState<ProjectSummary[], { projects: ProjectSummary[] }>(`/api/projects${scopeQuery(owner ?? undefined)}`, value => value.projects)');
    expect(SOURCE).toContain('useReadSequence(JSON.stringify([owner, accessEpoch]))');
    expect(rollupEffect.match(/if \(!accept\(\)\) return;/g)).toHaveLength(2);
  });
});

describe('My work keeps queue triage (#1299)', () => {
  it('offers priority and size with sorting in the shared housed viewer', () => {
    expect(SOURCE).toMatch(/<IssueQueue\s+heading="Your queue"/);
    expect(QUEUE).toMatch(/<IssuesViewer[^>]+showTriage/);
    expect(QUEUE).toMatch(/<IssuesViewer[^>]+hideRowLabels/);
  });
});

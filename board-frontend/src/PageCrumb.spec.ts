import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageCrumb, atSourceAddress, crumbSlot, isDeepPage, sourceProject, sourceProjectName, trail } from './PageCrumb';
import { RouteProvider } from './route-ctx';
import { forgetSensitivePayloads } from './cache/payload-cache';
import { copyResponseDeadline, responseDeadline, responseExpired, setResponseIdentity, tagResponse } from './auth/response-deadline';
import type { ProjectSummary } from './api/projects';
import { TAB_LABEL, WALKED_HERE, walkedHere, type Route, type Tab } from './route';
// Vite's `?raw` rather than node:fs — the frontend package carries no node types,
// and `repos/ReposMap.spec.tsx` pins its own cross-file rule the same way.
import appSource from './App.tsx?raw';
import routeSource from './route.ts?raw';

const COLD: Route = { tab: 'issue', issue: { owner: 'acme', repo: 'board', number: 664 } };
const FROM_BOARD: Route = { ...COLD, project: 7 };
const REPO: Route = { tab: 'repo', repo: { owner: 'acme', name: 'board' } };
const BOARD: Route = { tab: 'projects', project: 7 };

// The first page to get this control. #823 generalised the rule to every page
// reached from a list, and these four cases are what it must not have moved.
describe('an issue reached without a source project (#664)', () => {
  it('offers back when there is an entry behind this one', () => {
    expect(crumbSlot(COLD, true)).toEqual({ kind: 'back' });
  });

  it('offers nothing at all when back would be a no-op', () => {
    expect(crumbSlot(COLD, false)).toEqual({ kind: 'none' });
  });

  it('claims no ancestry — the reader never passed through Projects', () => {
    expect(trail(COLD)).toEqual([]);
  });

  it('offers nothing for an issue tab with no issue (a route that cannot resolve)', () => {
    expect(crumbSlot({ tab: 'issue' }, true)).toEqual({ kind: 'none' });
  });
});

describe('an issue opened from a project board (#422)', () => {
  // The leading `{ label: 'Projects', route: { tab: 'projects' } }` crumb came
  // off with #785: the rollup it linked to is deleted and `/projects` resolves
  // to Your work, so that crumb named a page that does not exist. The BOARD
  // crumb stays — that half of the walk really happened and the page it points
  // at still renders — so the trail is one ancestor where it was two.
  const expected = (label: string) => ({
    kind: 'trail',
    crumbs: [
      { label, route: { tab: 'projects', project: 7 } },
    ],
  });

  it('retraces the walk that happened — and stops at the board, not the issue', () => {
    const slot = crumbSlot(FROM_BOARD, false, 'Board roadmap');
    expect(slot).toEqual(expected('Board roadmap'));
    // The issue's own #number is the H1's (#391), so the trail is exactly one
    // ancestor — a length assertion that would still pass at two proves nothing.
    expect(slot.kind === 'trail' && slot.crumbs).toHaveLength(1);
  });

  it('falls back to the bare project number while the name is unresolved', () => {
    expect(crumbSlot(FROM_BOARD, false)).toEqual(expected('Project 7'));
    expect(trail(FROM_BOARD)).toHaveLength(1);
  });

  it('is the same trail whether or not back is available', () => {
    // The back rule belongs to the cold case alone and must not leak into a
    // recorded path.
    expect(crumbSlot(FROM_BOARD, true, 'Board roadmap')).toEqual(crumbSlot(FROM_BOARD, false, 'Board roadmap'));
  });
});

// #823 — Octocat asked for a back button on the board page and on the repo page.
// The board page offered nothing at all; the repo page offered `Repos`, which is
// the whole map at its resting order and not the view the reader left. Measured
// in a real Chrome at 390x844 on 2026-09-03: from `/acme/repos?owner=
// octocat` (2 tiles) into a repo, the `Repos` crumb landed on `/repos` (8
// tiles), and `history.back()` landed on the 2.
describe('a page a reader drilled in to offers a way back (#823)', () => {
  const backed: Array<[string, Route]> = [
    ['a board page', BOARD],
    ['a board page in a named org', { ...BOARD, org: 'acme' }],
    ['a repo page', REPO],
    ['an issue reached without a source project', COLD],
  ];

  it.each(backed)('%s offers back when there is an entry behind it', (_name, route) => {
    expect(crumbSlot(route, true)).toEqual({ kind: 'back' });
  });

  it('offers the whole map to a repo page loaded cold, since back would be a no-op', () => {
    // A pasted link has no entry behind it, so `Repos` is the only way out this
    // page can offer — and the reader arrived from no narrowing to lose. Drawn
    // in the back control's shape since #1047, and still named for where it goes.
    expect(crumbSlot(REPO, false)).toEqual({ kind: 'up', label: 'Repos', route: { tab: 'repos' } });
  });

  it('offers a board page loaded cold nothing, having no ancestor to name', () => {
    expect(crumbSlot(BOARD, false)).toEqual({ kind: 'none' });
  });

  it('counts exactly the pages reached from a list, and no top-level page', () => {
    // Swept off TAB_LABEL and SORTED, so this says which tabs are deep without
    // also pinning the order somebody wrote TAB_LABEL's keys in. What stops a
    // tab added later from defaulting to "not deep" is not this assertion —
    // it would still pass — but `DEEP_PAGE`'s `Record<Tab, …>`, which does not
    // compile without the new key.
    const deep = (Object.keys(TAB_LABEL) as Tab[]).filter((tab) => isDeepPage({
      tab,
      project: 7,
      issue: { owner: 'acme', repo: 'board', number: 664 },
      repo: { owner: 'acme', name: 'board' },
    })).sort();
    expect(deep).toEqual(['issue', 'projects', 'repo']);
  });

  it('is no page at all where the tab carries nothing to resolve', () => {
    // These routes draw nothing, so there is nothing to leave.
    expect(isDeepPage({ tab: 'repo' })).toBe(false);
    expect(isDeepPage({ tab: 'issue' })).toBe(false);
    expect(isDeepPage({ tab: 'projects' })).toBe(false);
  });
});

// #1047 — "add Back button instead of 'Repos'". `← Back` was already there
// wherever it goes back; what the reporter met was the cold load, which drew the
// one-crumb trail. "Back" cannot be said there, with nothing behind a pasted
// link, so the page gets the back control's shape and keeps the destination's name.
describe('a drilled-in page with nothing behind it names where its way out goes (#1047)', () => {
  const PERSON: Route = { tab: 'people', person: 'octocat' };

  it('says Back on a repo page wherever it can go back, and Repos wherever it cannot', () => {
    expect(crumbSlot(REPO, true)).toEqual({ kind: 'back' });
    expect(crumbSlot(REPO, false)).toEqual({ kind: 'up', label: 'Repos', route: { tab: 'repos' } });
  });

  it('does the same on a person page, naming Overview', () => {
    expect(crumbSlot(PERSON, true)).toEqual({ kind: 'back' });
    expect(crumbSlot(PERSON, false)).toEqual({ kind: 'up', label: 'Overview', route: { tab: 'team' } });
  });

  it('leaves a recorded walk its trail, and a page with no ancestor nothing', () => {
    expect(crumbSlot(FROM_BOARD, false, 'Board roadmap').kind).toBe('trail');
    expect(crumbSlot(BOARD, false)).toEqual({ kind: 'none' });
    expect(crumbSlot(COLD, false)).toEqual({ kind: 'none' });
  });

  it('draws a cold repo page one link to Repos in the back control\'s shape, and no breadcrumb', () => {
    // Markup only. The suite has no DOM, so what a press does is not proven here;
    // with no `window` there is no walked entry, which is
    // exactly the cold load.
    const html = renderToStaticMarkup(createElement(RouteProvider, { route: REPO, children: createElement(PageCrumb) }));
    expect(html).toMatch(/^<a href="\/repos" class="[^"]*\bw-fit\b[^"]*"><span aria-hidden="true">←<\/span>Repos<\/a>$/);
    expect(html).not.toContain('Breadcrumb');
    expect(html).not.toContain('Back');
  });
});

// The measurement `crumbSlot` turns on, and the half of #823 that shipped wrong
// the first time. It read `history.length` against a baseline taken at module
// load, which counts entries rather than depth — so opening and closing the
// account panel raised it with no navigation at all, putting a `← Back` on a
// cold-loaded repo page in place of a `Repos` link that worked. A reload read the
// baseline back equal to the length and deleted the control instead. `route.ts`
// carries the argument; this is the rule.
describe('whether a history entry has a board page behind it (#823)', () => {
  // The two files that write history, read as text. The rule spans both and
  // cannot be asked of either at runtime: a push is a side effect in a `node`
  // test env with no history. `repos/ReposMap.spec.tsx` and
  // `org-scope/narrowed-surfaces.spec.ts` pin their own cross-file rules the
  // same way.
  const src = `${appSource}\n${routeSource}`;

  it('says yes to an entry this app pushed', () => {
    expect(walkedHere(WALKED_HERE)).toBe(true);
  });

  it('says no to the entry a tab booted on, and to the panel\'s own push', () => {
    // Both are `pushState(null, …)` or no push at all — indistinguishable from
    // each other and, correctly, from anything else that is not a navigation.
    expect(walkedHere(null)).toBe(false);
    expect(walkedHere(undefined)).toBe(false);
  });

  it('says no to a state that is not ours, however it is shaped', () => {
    // `history.state` is shared with anything else that writes it, so a truthy
    // object is not an answer and neither is a truthy field under our name.
    expect(walkedHere({})).toBe(false);
    expect(walkedHere({ boardWalked: false })).toBe(false);
    expect(walkedHere({ boardWalked: 'yes' })).toBe(false);
    expect(walkedHere({ somethingElse: true })).toBe(false);
    expect(walkedHere('boardWalked')).toBe(false);
    expect(walkedHere(1)).toBe(false);
  });

  it('never clears the marker on a replace', () => {
    // The half the first guard could not see. Three `replaceState` calls carry
    // `window.history.state` through — the mount canonicalisation, the sign-in
    // returnTo replay and `gotoPath`'s replace — and one writes `WALKED_HERE`,
    // App.navigate spending the panel's entry on a real destination. A fourth
    // spelling, `replaceState(null`, silently deletes a walked page's way out
    // and puts back the reload bug this branch was sent back over. The guard
    // said nothing about any of them until it was asked to.
    const replaces = src.match(/history\.replaceState\([^,]+/g) ?? [];
    expect(replaces.length).toBeGreaterThan(2);
    expect([...new Set(replaces)].sort()).toEqual([
      'history.replaceState(WALKED_HERE',
      'history.replaceState(window.history.state',
    ]);
  });

  it('is marked on every push this app makes but the panel\'s', () => {
    // An unmarked push added anywhere fails here and has to say why it is not a
    // navigation. That is the whole guard: the first cut of #823 measured
    // `history.length`, the panel's push raised it, and a page that had not
    // moved grew a `← Back` that went nowhere.
    const pushes = src.match(/history\.pushState\([^,]+/g) ?? [];
    const unmarked = pushes.filter((p) => !p.includes('WALKED_HERE'));
    expect(pushes.length).toBeGreaterThan(1);
    expect(unmarked).toEqual(['history.pushState(null']);
    // And the one that is unmarked is the panel's, named by the line under it.
    expect(src).toContain('window.history.pushState(null, \'\', window.location.href);');
  });
});

describe('every other page keeps the trail it had', () => {
  const pages: Array<[string, Route, ReturnType<typeof crumbSlot>]> = [
    ['a repo tab with no repo', { tab: 'repo' }, { kind: 'none' }],
    ['Overview', { tab: 'team' }, { kind: 'none' }],
    ['Your work', { tab: 'dashboard' }, { kind: 'none' }],
  ];

  it.each(pages)('%s is unmoved by whether back is available', (_name, route, expected) => {
    expect(crumbSlot(route, true)).toEqual(expected);
    expect(crumbSlot(route, false)).toEqual(expected);
  });

  it('draws a trail on exactly the pages that have an ancestor to name (#712)', () => {
    // Admin Hub, the Account pages and the API reference each had a case here
    // until #712. Inside the panel the rail names the area and the H1 names the
    // section, so there is no ancestry left to draw — and the admin case named
    // an ancestor that WAS the area you were already in. Swept off TAB_LABEL so
    // a tab added later lands in this list without anyone editing it.
    const rich = (tab: Tab): Route => ({
      tab,
      project: 7,
      issue: { owner: 'acme', repo: 'board', number: 664 },
      repo: { owner: 'acme', name: 'board' },
    });
    // `projects` left this list with #785: a board page had exactly one
    // ancestor, the rollup, and there is nowhere above one board to send a
    // reader now.
    const drawn = (Object.keys(TAB_LABEL) as Tab[]).filter((t) => trail(rich(t)).length > 0);
    expect(drawn).toEqual(['people', 'repo', 'issue']);
  });

  it('ignores a resolved project name outside the project-sourced issue case', () => {
    // Guards against the resolved name leaking into an unrelated route shape.
    expect(crumbSlot({ tab: 'dashboard' }, false, 'Board roadmap')).toEqual({ kind: 'none' });
    expect(trail({ tab: 'team' }, 'Board roadmap')).toEqual([]);
  });
});

// #697 — `?srcProject=3` resolved to the first board numbered 3 in the union
// across orgs, so a crumb could name a board the reader had never been on and
// link them to it.
describe('an issue opened from a board in a named org (#697)', () => {
  const FROM_APLITENI: Route = { ...COLD, project: 3, org: 'globex' };

  // Both lost their leading "Projects" crumb to #785, for the reason given at
  // the top of the #422 describe. What #697 put here is untouched: the board
  // crumb still carries the org the walk really passed through.
  it('walks back to THAT board, not to whichever org holds 3 first', () => {
    expect(trail(FROM_APLITENI, 'Delivery')).toEqual([
      { label: 'Delivery', route: { tab: 'projects', org: 'globex', project: 3 } },
    ]);
  });

  it('leaves an unqualified source board on the crumb it has always had', () => {
    expect(trail({ ...COLD, project: 3 }, 'Delivery')).toEqual([
      { label: 'Delivery', route: { tab: 'projects', project: 3 } },
    ]);
  });
});

// Named "out of the rollup" until #785. The rollup PAGE is gone; the list this
// resolves against is `/api/projects`, which the crumb still fetches and which
// #785 did not touch.
describe('naming the source board out of the projects list (#697)', () => {
  const projects = [
    { org: 'acme', number: 3, name: 'Platform' },
    { org: 'globex', number: 3, name: 'Delivery' },
  ] as ProjectSummary[];

  it('names the board in the org the URL asked for', () => {
    expect(sourceProjectName(projects, 3, 'globex')).toBe('Delivery');
    expect(sourceProjectName(projects, 3, 'acme')).toBe('Platform');
  });

  it('resolves an unqualified number the way the API does — the first org holding it', () => {
    expect(sourceProjectName(projects, 3)).toBe('Platform');
  });

  it('names nothing when the org holds no such board, rather than the wrong board', () => {
    expect(sourceProjectName(projects, 3, 'nobody')).toBeUndefined();
    expect(sourceProjectName(projects, 9, 'globex')).toBeUndefined();
  });
});

/**
 * The crumb's board name outlived the response that authorized it (#905 review,
 * R3): `useSourceProjectName` held `sourceProjectName(...)`, and a string cannot
 * carry the `WeakMap` metadata `copyResponseDeadline` moves, so no part of the
 * response-lifetime mechanism could reach it even in principle.
 *
 * What is provable HERE is the projection: that the value the hook now holds is
 * an object out of the marked response and so carries that response's deadline
 * and sensitive generation. That the hook is WIRED to it — `useResponseState`,
 * and a renewal that actually issues a second read — is behaviour, and this
 * suite runs `environment: 'node'` and fires no effect, so it
 * is gated by `scripts/check-held-responses.mjs`'s `crumb` surface in CI rather
 * than pinned as source text here.
 */
describe('the source board a crumb holds expires with the response it came from (#905)', () => {
  const answer = () => ({
    projects: [
      { org: 'acme', number: 7, name: 'PRIVATE CRUMB PROJECT' },
      { org: 'globex', number: 7, name: 'Delivery' },
    ] as ProjectSummary[],
  });

  afterEach(() => { setResponseIdentity(null, false); vi.useRealTimers(); });

  it('carries the source lease, survives the source clock, and accepts a refill', () => {
    vi.useFakeTimers();
    const lease = { visibilityKey: 'reader', expiresAt: Date.now() + 60_000 };
    setResponseIdentity('reader', true, lease.expiresAt);
    const pick = (l: { visibilityKey: string; expiresAt: number }) => {
      const body = tagResponse(answer(), l);
      return copyResponseDeadline(body.projects, sourceProject(body.projects, 7, 'acme') ?? null);
    };

    const old = pick(lease);
    expect(old?.name).toBe('PRIVATE CRUMB PROJECT');
    expect(responseDeadline(old)).toEqual(lease);
    // THE NEGATIVE CONTROL, and the whole of R3 in one line: what this hook held
    // before the repair was `old.name`, and a string carries no lease and can
    // never expire. Holding the row is not a stylistic preference — it is the
    // only shape the mechanism can reach.
    expect(responseDeadline(old?.name)).toBeUndefined();
    expect(responseExpired(old?.name)).toBe(false);

    // A shell renewal at 30s does not move the old row's own deadline, and the
    // replacement carries its own.
    vi.advanceTimersByTime(30_000);
    const nextLease = { ...lease, expiresAt: Date.now() + 60_000 };
    setResponseIdentity('reader', true, nextLease.expiresAt);
    const fresh = pick(nextLease);
    expect(responseDeadline(old)).toEqual(lease);
    expect(responseDeadline(fresh)).toEqual(nextLease);

    // Both rows survive the old deadline until a real refusal.
    vi.advanceTimersByTime(30_000);
    expect(responseExpired(old)).toBe(false);
    expect(responseExpired(fresh)).toBe(false);

    // A hard invalidation expires the survivor; a genuinely new answer refills.
    forgetSensitivePayloads();
    setResponseIdentity('reader', true, nextLease.expiresAt);
    expect(responseExpired(fresh)).toBe(true);
    expect(responseExpired(pick({ ...nextLease }))).toBe(false);
  });

  it('fences a held row against the address on screen, which is a render-time question', () => {
    // The hook keeps the row across a renewal on purpose, so the row it holds
    // can outlive the address that asked for it: walking from one board's issue
    // to another's leaves board 7's row held while the crumb is drawing board 9.
    // The effect that clears it runs AFTER the browser has painted, so the fence
    // has to be this comparison, made during render.
    const [seven, nine] = [
      { org: 'acme', number: 7, name: 'PRIVATE CRUMB PROJECT' },
      { org: 'acme', number: 9, name: 'Another board' },
    ] as ProjectSummary[];
    expect(atSourceAddress(seven, 7, 'acme')).toBe(true);
    expect(atSourceAddress(seven, 9, 'acme'), 'board 7 must not answer for board 9').toBe(false);
    expect(atSourceAddress(seven, 7, 'globex'), 'nor for the same number in another org').toBe(false);
    expect(atSourceAddress(seven, 7), 'an unqualified address takes the number alone').toBe(true);
    expect(atSourceAddress(nine, 9, 'acme')).toBe(true);
  });

  it('is the same comparison the search makes, so the two cannot drift', () => {
    const projects = [
      { org: 'acme', number: 7, name: 'Platform' },
      { org: 'globex', number: 7, name: 'Delivery' },
    ] as ProjectSummary[];
    for (const org of ['acme', 'globex', undefined]) {
      const found = sourceProject(projects, 7, org);
      expect(found && atSourceAddress(found, 7, org)).toBe(true);
    }
  });

  it('names nothing for a board the answer does not hold, and holds no row for it', () => {
    const lease = { visibilityKey: 'reader', expiresAt: Date.now() + 60_000 };
    setResponseIdentity('reader', true, lease.expiresAt);
    const body = tagResponse(answer(), lease);
    // `?? null` is what the hook stores, and `copyResponseDeadline` must take it
    // without stamping anything — a missing board is an absent row, not an
    // expired one.
    expect(copyResponseDeadline(body.projects, sourceProject(body.projects, 9, 'globex') ?? null)).toBeNull();
  });
});

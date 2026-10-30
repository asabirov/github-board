/**
 * The Repos map's URL wiring (#587, widened #583).
 *
 * `ReposPage.spec.tsx` renders `ReposBody`, which is the pure half — it takes
 * the order and the owner as props and never touches the URL. So the half that
 * DERIVES the two from the query string and WRITES them back on every press had
 * no test at all, and the defect it is most likely to have is invisible from
 * there: the two controls each write BOTH values, and nothing in the types
 * forces them to keep doing it. A `chooseOrder` that wrote only the order would
 * still render correctly, still pass every assertion about tiles and counts, and
 * quietly drop the chosen face out of any link somebody sent.
 *
 * It lives in its own file because it mocks the two controls (there is no DOM
 * here to press them in) and `ReposPage.spec.tsx` imports one of them for real.
 *
 * `gotoPath` is NOT mocked. The claim under test includes "with `replace`", and
 * a mock recording its own arguments would only prove the call site passes a
 * flag — not that the flag reaches `history.replaceState` rather than
 * `pushState`. So the window is stubbed instead, close enough to a browser's
 * that `route.ts`'s same-URL guard behaves as it does live.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup as renderBare } from 'react-dom/server';
import { TooltipProvider } from '../ui/kit';
import source from './ReposPage.tsx?raw';
// The fetcher, for the one claim that is about what it THROWS rather than about
// what this page does with it (#824 review).
import apiSource from '../api/repos.ts?raw';
import type { RepoOwner, RepoRow, ReposView } from '../api/repos';
import { NO_HEALTH, type OwnerSlot, type RepoOrderKey, type ReposHealth } from './repos-vm';

/** What the two controls were handed, and how to press them. There is no DOM
 *  here, so the controls stand in for themselves: each records its props and
 *  draws nothing. Everything else on the page — the grid, the counts, the
 *  narrowing — is the real thing.
 *
 *  One press per mount. State does not advance under the static renderer: a
 *  setter called after the component returned is a no-op there, by design. So
 *  every press below reads the query string the MOUNT was handed, and a test
 *  wanting a second press mounts again from the URL the first one wrote. That is
 *  the honest shape for this harness, and it happens to assert the stronger
 *  thing — that each URL the page writes is one the page can be handed straight
 *  back. */
const control: {
  owner?: { slots: OwnerSlot[]; chosen: string | null | undefined; onOwner: (o: string | null | undefined) => void };
  order?: { orderKey: RepoOrderKey; onOrder: (k: RepoOrderKey) => void };
} = {};

vi.mock('./OwnerRow', () => ({
  OwnerRow: (props: NonNullable<typeof control.owner>) => {
    control.owner = props;
    return null;
  },
}));
vi.mock('./OrderPicker', () => ({
  OrderPicker: (props: NonNullable<typeof control.order>) => {
    control.order = props;
    return null;
  },
}));

const { ReposMap } = await import('./ReposPage');

/** Every history call the page made, in order. */
const history: { kind: 'replace' | 'push'; path: string }[] = [];

/** A window close enough to a browser's for `route.ts`: `gotoPath` reads the
 *  current path to guard against a duplicate entry, and a stub that never moved
 *  would make every write after the first look like a no-op. So a write moves
 *  it, exactly as the browser does. */
function stubWindow(search: string): void {
  const location = { pathname: '/repos', search };
  const record = (kind: 'replace' | 'push') => (_s: unknown, _t: unknown, path: string) => {
    history.push({ kind, path });
    location.search = path.slice(location.pathname.length);
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history: { replaceState: record('replace'), pushState: record('push') },
      dispatchEvent: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  // `route.ts` announces a navigation with one of these; node has `Event` and
  // not this subclass.
  (globalThis as Record<string, unknown>).PopStateEvent = class extends Event {};
}

function repo(over: Partial<RepoRow> & { name: string }): RepoRow {
  return {
    full: `acme/${over.name}`,
    key: over.name,
    htmlUrl: `https://github.com/acme/${over.name}`,
    description: null,
    weeks: Array.from({ length: 10 }, () => ({ opened: 0, closed: 0 })),
    open: 0,
    owner: null,
    language: null,
    pushedAt: null,
    ...over,
  };
}

const ADA: RepoOwner = { login: 'octocat', name: 'Octocat' };
const IVAN: RepoOwner = { login: 'IvanRoslov', name: 'Ivan Roslov' };

/** Three repos that disagree under every order, so a wrong order is visible in
 *  the grid rather than only in a prop. */
const VIEW: ReposView = {
  updatedAt: '2026-08-13T09:00:00.000Z',
  repos: [
    repo({ name: 'alpha', owner: ADA, open: 1, pushedAt: '2026-08-12T00:00:00.000Z' }),
    repo({ name: 'beta', owner: ADA, open: 9, pushedAt: '2026-01-01T00:00:00.000Z' }),
    repo({ name: 'gamma', owner: IVAN, open: 4, pushedAt: '2026-08-13T00:00:00.000Z' }),
  ],
  driOptions: ['octocat', 'IvanRoslov'],
  ownerWritability: 'writable',
};

/** Mount the map with a query string already in the URL, as a link would. The
 *  string goes to BOTH: the stub window is what `gotoPath` guards against, and
 *  the prop is what the page reads — which is exactly the pairing `ReposPage`
 *  makes live through `useLocationSearch`.
 *
 *  The health defaults to settled and empty, which is the state everything
 *  below is about: these tests ask what a LINK puts on the page, and a map
 *  still waiting on its second read would answer half of them with a held grid.
 *  The one test that is about the wait passes `null` itself.
 *
 *  The string arrives as a prop because `ReposMap` used to read
 *  `window.location.search` itself, once, in a `useState` initialiser — which is
 *  the bug `location-search.ts` was written to end and which this page repeated.
 *  The read now happens one level up in `ReposPage`, through `useLocationSearch`.
 *  That is also the only arrangement this harness can hold:
 *  `useSyncExternalStore` throws under `react-dom/server` without a
 *  `getServerSnapshot` ("Missing getServerSnapshot" — measured, not assumed), so
 *  a `ReposMap` calling the hook itself could not be rendered here at all. What
 *  cannot be shown from here — that a re-render with no popstate refreshes the
 *  value — is pinned as source text at the foot of this file and was driven in a
 *  real browser besides. */
function mount(search: string, view: ReposView = VIEW, health: ReposHealth = NO_HEALTH): string {
  stubWindow(search);
  return renderBare(
    <TooltipProvider>
      <ReposMap view={view} health={health} canWrite search={search} />
    </TooltipProvider>,
  );
}

const tileKeys = (html: string) => [...html.matchAll(/data-repo="([^"]+)"/g)].map((m) => m[1]);

/** The last path the page wrote. */
const lastWrite = () => history[history.length - 1];

beforeEach(() => {
  history.length = 0;
  delete control.owner;
  delete control.order;
});

describe('what a link puts on the page', () => {
  it('reproduces the order AND the narrowing from one query string', () => {
    // Both, from one parse. Octocat's two repos, most recently pushed first —
    // which is the order `open` would not have put them in.
    const html = mount('?order=recent&owner=octocat');
    expect(tileKeys(html)).toEqual(['alpha', 'beta']);
    expect(control.order?.orderKey).toBe('recent');
    expect(control.owner?.chosen).toBe('octocat');
  });

  it('reproduces the repos nobody owns', () => {
    // `chosen` is `null` — the slot for the repos nobody owns — and that is what
    // makes this bite. Asserting it `toBeUndefined()` against the all-owned view
    // was the older shape and held nothing: no repo there is unowned, so there is
    // no `null` slot to resolve to and `undefined` comes back whether the flag
    // was read or dropped on the floor.
    const loose = { ...VIEW, repos: [...VIEW.repos, repo({ name: 'loose' })] };
    const html = mount('?unowned=1', loose);
    expect(control.owner?.chosen).toBeNull();
    expect(tileKeys(html)).toEqual(['loose']);
  });

  it('shows the whole map for a narrowing there is nothing to narrow to', () => {
    // Every repo in this view has an owner, so the flag names a slot that does
    // not exist. Resolved against the slots, that leaves the map standing rather
    // than emptying the grid — the same rule an order that never shipped gets.
    const html = mount('?unowned=1');
    expect(tileKeys(html)).toEqual(['beta', 'gamma', 'alpha']);
    expect(control.owner?.chosen).toBeUndefined();
  });

  it('draws a link’s tiles from the first read alone (#571)', () => {
    // The map a moment after the rows land: the link's order and its face are
    // both honoured, and the tiles are on screen with the health still in
    // flight. The page held all of this behind one word before #571.
    const html = mount('?order=recent&owner=octocat', VIEW, null);
    expect(tileKeys(html)).toEqual(['alpha', 'beta']);
    expect(control.order?.orderKey).toBe('recent');
    expect(control.owner?.chosen).toBe('octocat');
  });

  it('holds a health-filtered link until the health lands', () => {
    // The one order that sorts on the second read. The controls the link set
    // are still there and still say what the link asked for — it is the grid
    // that waits, so nothing re-sorts under a reader.
    const html = mount('?order=recent&health=security', VIEW, null);
    expect(tileKeys(html)).toEqual([]);
    expect(control.order?.orderKey).toBe('recent');
    // …and it draws once the read has landed, failed read included.
    expect(tileKeys(mount('?order=recent', VIEW, NO_HEALTH))).toHaveLength(3);
  });

  it('opens on the map at rest when the link says nothing', () => {
    const html = mount('');
    expect(tileKeys(html)).toEqual(['beta', 'gamma', 'alpha']);
    expect(control.order?.orderKey).toBe('open');
    expect(control.owner?.chosen).toBeUndefined();
    // A first visit writes nothing at all.
    expect(history).toEqual([]);
  });
});

describe('a press writes BOTH pieces, never one', () => {
  it('choosing a face keeps the order that was already chosen', () => {
    mount('?order=recent&owner=octocat');
    control.owner!.onOwner('IvanRoslov');
    expect(lastWrite().path).toBe('/repos?order=recent&owner=IvanRoslov');
  });

  it('choosing an order keeps the face that was already pressed', () => {
    mount('?order=name&owner=octocat');
    control.order!.onOrder('recent');
    expect(lastWrite().path).toBe('/repos?order=recent&owner=octocat');
  });

  it('choosing an order keeps the repos-nobody-owns narrowing too', () => {
    // The narrowing that is not a login, and the one a codec is likeliest to
    // drop, because "no owner" and "no narrowing" are one keystroke apart.
    mount('?unowned=1');
    control.order!.onOrder('name');
    expect(lastWrite().path).toBe('/repos?order=name&unowned=1');
  });

  it('clearing the narrowing leaves the order standing', () => {
    mount('?order=recent&owner=octocat');
    control.owner!.onOwner(undefined);
    expect(lastWrite().path).toBe('/repos?order=recent');
  });

  it('clearing the order leaves the face standing', () => {
    mount('?order=recent&owner=octocat');
    control.order!.onOrder('open');
    // The map's own order is omitted by design, so what is left is the face
    // alone — which is the whole state, not half of it.
    expect(lastWrite().path).toBe('/repos?owner=octocat');
  });

  it('writes the owner alone at the map’s own order, which is not a dropped param', () => {
    mount('');
    control.owner!.onOwner('octocat');
    expect(lastWrite().path).toBe('/repos?owner=octocat');
  });

  it('carries both across a run of presses, so nothing decays', () => {
    // The failure this guards is cumulative: one control dropping the other's
    // value shows up as state that erodes over a session rather than all at
    // once.
    //
    // Each press re-mounts from the URL the press before it wrote, which is a
    // constraint of the static renderer and not a weakening: `useState` cannot
    // advance without a DOM, so a second press in the same mount would read the
    // FIRST mount's values and prove nothing about the second. Re-mounting is
    // also the stronger claim — every URL written has to be one the page can be
    // handed back, or a reload mid-session loses what a press just set.
    const press = (search: string, act: () => void): string => {
      mount(search);
      act();
      return lastWrite().path.slice('/repos'.length);
    };
    const one = press('', () => control.owner!.onOwner('octocat'));
    const two = press(one, () => control.order!.onOrder('recent'));
    const three = press(two, () => control.owner!.onOwner(null));
    const four = press(three, () => control.order!.onOrder('name'));
    expect([one, two, three, four]).toEqual([
      '?owner=octocat',
      '?order=recent&owner=octocat',
      '?order=recent&unowned=1',
      '?order=name&unowned=1',
    ]);
  });
});

describe('the URL is read on every render, never copied (#572 follow-up)', () => {
  it('follows the query string it is HANDED, not the one in the window', () => {
    // The bug, stated as a disagreement. `ReposMap` read `window.location.search`
    // itself, in a `useState` initialiser that runs once — so once the page was
    // mounted, the window could say anything and the grid went on drawing what
    // the first render had captured. Live that happened on every press of the
    // sidebar's own "Repos" item: `App.navigate` pushes `/repos` and re-renders
    // without dispatching a popstate, so from `?order=recent&owner=octocat` the
    // URL went bare and 47 tiles stayed narrowed under it.
    //
    // Here the two are made to disagree deliberately. A page that reads the
    // window draws Octocat's two repos in push order; a page that reads what it
    // was handed draws the map at rest, which is what it must do.
    stubWindow('?order=recent&owner=octocat');
    const html = renderBare(
      <TooltipProvider>
        <ReposMap view={VIEW} health={NO_HEALTH} canWrite search="" />
      </TooltipProvider>,
    );
    expect(tileKeys(html)).toEqual(['beta', 'gamma', 'alpha']);
    expect(control.order?.orderKey).toBe('open');
    expect(control.owner?.chosen).toBeUndefined();
  });

  it('holds neither the order nor the owner in state — TEXT ONLY: this greps the '
    + 'file, it does not observe a re-render', () => {
    // The half no renderer here can reach. `useLocationSearch` is
    // `useSyncExternalStore`, which throws under `react-dom/server`, so the call
    // itself can only be pinned as text — the same limit `TeamView.spec.ts`
    // works under, and for the same reason.
    //
    // `setOrderKey`/`setOwner` are named as well as the initialiser, because a
    // page that derived the two AND kept setters for them would have two sources
    // of truth again, which is the arrangement that went stale in the first
    // place.
    expect(source).not.toMatch(/useState\([^;]*window\.location\.search/);
    expect(source).not.toMatch(/setOrderKey|setOwner\b/);
    expect(source).toMatch(/const search = useLocationSearch\(\);/);
    expect(source).toMatch(/import \{ useLocationSearch \} from '\.\.\/location-search';/);
    expect(source).not.toMatch(/addEventListener\('popstate'/);
  });
});

/**
 * The page's two reads (#571) — TEXT ONLY.
 *
 * `ReposPage` is the component that fetches, and nothing here can render it:
 * it calls `useLocationSearch` (a `useSyncExternalStore`, which throws under
 * `react-dom/server`) and its effects never run in a static render anyway, with
 * no DOM in this test environment to run them in. What the reads DO is pinned
 * where it belongs instead — `repos-vm.spec.ts` holds the join, the placeholder
 * and the settled defaults as pure functions, and `ReposPage.spec.tsx` holds
 * what each of those states draws. What is left is the wiring between them, and
 * that is what these greps are for.
 *
 * Each slice is asserted non-empty first. A slice that missed would otherwise
 * make every claim under it vacuously true — a `not.toContain` against an empty
 * string passes whatever the file says.
 */
function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  return start < 0 || end < 0 ? '' : source.slice(start, end);
}

describe('the rows and the health are read side by side (#571)', () => {
  // The org rides in as an argument since #714's review — `fetchRepos(scope.org
  // ?? undefined)` — so the anchors name the call rather than a bare `()`.
  const rowsRead = slice('fetchRepos(', 'fetchReposHealth(');
  const healthRead = slice('fetchReposHealth(scope.org', '}, [refresh, scope.org, accessEpoch, renewal, beginRows, beginHealth]);');
  /** The read effect ALONE — the one keyed on the refresh signal. The org-reset
   *  effect above it is a different effect making a different claim, and the
   *  assertions below are about what a Sync now may and may not do. */
  const readEffect = slice('fetchRepos(', '}, [refresh, scope.org, accessEpoch, renewal, beginRows, beginHealth]);');

  it('makes both reads, neither waiting on the other', () => {
    expect(rowsRead).not.toBe('');
    expect(healthRead).not.toBe('');
    // No `await` and no `Promise.all` between them: either would put the grid
    // back behind the slower of the two, which is the whole defect.
    expect(source).not.toContain('Promise.all');
    expect(source).not.toMatch(/await fetchRepos/);
  });

  it('fails the view for a lost row read, and only for that one', () => {
    expect(rowsRead).toContain("setLoad({ kind: 'failed' })");
    expect(rowsRead).not.toContain('setHealth');
    expect(healthRead).not.toContain('setLoad');
  });

  it('keeps a map somebody is reading when the row read fails under it (#824)', () => {
    // The claim above is about WHICH read is load-bearing, and it still is. This
    // is the case that did not exist when it was written: a first read and a
    // refresh were the same thing then, and a lost read blanked the page either
    // way. Now the failure asks whether there are rows on screen — from a live
    // read or from the copy on disk — and fails the view only when there are
    // not. Pinned as text because no effect fires in this suite.
    expect(rowsRead).toContain('holdsMap.current');
    expect(rowsRead).toMatch(/if \(withdrawn \|\| !holdsMap\.current\) setLoad\(\{ kind: 'failed' \}\);/);
    // Set on the way in from both sides, or the answer above is always "no".
    expect(source).toContain('const holdsMap = useRef(load.kind === \'ready\');');
    expect(source).toContain('holdsMap.current = true;');
    // And put back down when the address names another org, whose map is not
    // on screen however long this one was.
    const reset = slice('const clearedFor = useRef<string | null | undefined>', '}, [scope.org]);');
    expect(reset).toContain('holdsMap.current = false;');
  });

  it('reads a 503 as a hiccup and not as a withdrawal (#824 follow-up, #860)', () => {
    // `refusedScopeCopy` answers a sentence for a 503 as well as a 404 — its
    // own spec pins both, and this file's failed-state branch says what the 503
    // means: the board SERVES the org and its listing failed on this build. So
    // `refusedScopeCopy(...) !== null` on its own read every transient 503 as
    // the board disowning the org, blanked a map somebody was reading and
    // deleted `board_payload:repos:<org>` under it, which made the reload
    // after it cold too. That is the blanking and the cold start #824 exists to
    // remove, reached through #824's own new code.
    //
    // The expression this page spelled out inline is `scopeWithdrawn` since
    // #860, shared with `Pulse.tsx` so the two cannot answer one refusal two
    // ways — they had, on the 503, which is the symptom that issue is named for.
    // WHAT it answers is `scope-copy.spec.ts`'s, driven over every (org, status)
    // pair either page can hand it; a `toContain` over this file's source can
    // only say that the page asks it, and that is all these lines claim.
    expect(rowsRead).toContain('scopeWithdrawn(scope.org, refused)');
    // And the form that read both statuses as one is gone, not merely widened
    // past. Asserted as the whole line: a `not.toContain('503')` would match
    // the comment above it, which is prose about the 503 and not a branch on
    // one.
    expect(rowsRead).not.toContain('const disowned = refusedScopeCopy(scope.org, refused) !== null;');
  });

  it('takes the rows off the ref when it takes them off the page (#824 follow-up)', () => {
    // `holdsMap` means "rows on screen", and the withdrawal branch takes them
    // off. Left `true` through it, the NEXT failed read on the same page reads
    // "there are rows" over a page showing the refused state, and the page it
    // is protecting is not there to protect.
    expect(rowsRead).toContain('if (withdrawn) holdsMap.current = false;');
  });

  it('takes the map off a board that has DISOWNED the org (#714)', () => {
    // The one failure that still empties the page whatever is on it. A 404 or a
    // 503 naming the org is the board withdrawing it, and rows held under that
    // sentence would be `/gtm/repos` asserting gtm's repos after the board
    // stopped serving gtm — silently, for as long as the tab stays open.
    //
    // `scopeWithdrawn` and not a second reading of the status: its 404 arm is
    // `refusedScopeCopy`, the same predicate that decides whether the refused
    // state is drawn at all, so the page cannot come off for a verdict it would
    // then not state, or state a verdict over a map it kept.
    expect(rowsRead).toContain('scopeWithdrawn(scope.org, refused)');
    expect(source).toContain("import { scopeRefusal, scopeWithdrawn,");
  });

  it('takes the map off a reader the board refuses (#824 review)', () => {
    // A 403 is the board declining to serve this reader, not a hiccup, and a
    // map held under one goes on asserting rows nobody may be shown. It read
    // as a hiccup because `fetchRepos` threw a bare `Error('forbidden')`:
    // `scopeStatus`'s `/(?:^|\s)([1-5]\d\d)$/` finds no number in that word,
    // `scopeRefusal` answers null, and with rows on screen this handler ran to
    // the end doing nothing. Both halves are pinned, here and on the fetcher.
    //
    // The 403 arm moved into `scopeWithdrawn` with #860 and this page reads it
    // from there, so what is pinned here is that the status still ARRIVES with
    // a number in it — the half that lives in `api/repos.ts` — while the arm itself
    // is behavioural in `scope-copy.spec.ts`, union and narrowed both.
    expect(rowsRead).toContain('scopeWithdrawn(scope.org, refused)');
    // `fetchRepos`'s own body, not the whole module: `api/repos.ts` throws that
    // ApiError in another fetcher too, and a whole-file `toContain` would pass
    // on somebody else's line.
    const fetcher = apiSource.slice(apiSource.indexOf('export async function fetchRepos('));
    const body = fetcher.slice(0, fetcher.indexOf('\n}\n'));
    expect(body, 'fetchRepos must still be findable in api/repos.ts').not.toBe('');
    expect(body).toContain("throw new ApiError(403, 'forbidden'");
  });

  it('removes the stored copy when the map is withdrawn, not just the one on screen (#824 review)', () => {
    // The tab was cleaned and the disk was not. `board_payload:repos:gtm`
    // survived the disowning, so the next reload seeded gtm's whole map back
    // onto the page and did it again every visit until the entry aged out a day
    // later. One key, not the whole cache: a disowned org is not a session
    // ending.
    expect(rowsRead).toContain('forgetPayload(reposKey(scope.org))');
    expect(source).toContain("import { forgetPayload,");
  });

  it('settles the map at the defaults when the health read is refused', () => {
    // Never a placeholder left standing for a row that is not coming. What
    // those defaults SAY changed with #718 — every tile reports its alerts
    // unread rather than drawing four zeros — and `repos-vm.spec.ts` holds
    // that; what this pins is that the refusal settles the map at all.
    expect(healthRead).toContain('setHealth(NO_HEALTH)');
  });

  it('drops the last read’s unreadable orgs when the health read is refused (#718)', () => {
    // The page names an org whose ALERT lists refused off the health payload.
    // A Sync now whose health read then fails leaves that sentence on screen —
    // naming one org's alerts while every tile below it now says its own went
    // unread — because nothing cleared what the last payload said.
    //
    // Pinned as text for this file's own reason: no effect fires in this suite.
    const refused = healthRead.slice(healthRead.indexOf('setHealth(NO_HEALTH)'));
    expect(refused, 'the refusal arm must still settle the map').not.toBe('');
    expect(refused).toContain('setUnreadHealthOrgs(null)');
  });

  it('never puts the placeholders back under a reader', () => {
    // A refresh that reset the health would blank every word slot on a map
    // somebody is reading, and take the grid away under the recent order. So
    // the READ effect — the one a Sync now re-runs — must not write `null`.
    expect(readEffect).not.toBe('');
    expect(readEffect).not.toContain('setHealth(null)');
    expect(source).toContain('useState<ReposHealth>(null)');
    // It IS written in one other place, and that place is a different map:
    // #714's review keyed a reset on the address's org alone, so the previous
    // org's health does not sit under the next org's rows. Pinned as the org's
    // own effect, so it cannot quietly acquire the refresh signal.
    //
    // The anchor names the effect's first-run guard rather than its first
    // statement, because #824 put one in front of `setLoad(PENDING)`.
    //
    // Moving it DID lose a claim, and the first draft of this comment said it
    // had not (#824 review). The old anchor was the string
    // `useEffect(() => {\n    setLoad(PENDING);`, and an anchor that has to
    // match IS an assertion: it pinned that this effect is what puts the map
    // back to pending on an org change. Under the new anchor nothing said so,
    // and `grep -rn "setLoad(PENDING)" src` found the code and a comment and no
    // test. It is asserted below, in a test of its own, where an anchor moving
    // cannot take it away again.
    const reset = slice('const clearedFor = useRef<string | null | undefined>', '}, [scope.org]);');
    expect(reset, 'the org-change reset must still be its own effect').not.toBe('');
    expect(reset).toContain('setHealth(null)');
    // And in one more place since #892's review: the ACCESS EPOCH, which is a
    // different question again. A refresh must not blank the health; an expired
    // access check must, because `ReposService` holds the map on the same
    // permission-sensitive state as the alert counts and the billing, and a
    // re-check that finds the same repositories reauthorizes none of it.
    const reauthorize = slice('const seenEpoch = useRef(accessEpoch);', '  useEffect(() => {');
    expect(reauthorize, 'the access-epoch reset must be its own block').not.toBe('');
    expect(reauthorize).toContain('setHealth(null)');
    expect(reauthorize).toContain('setLoad(PENDING)');
    expect(reauthorize, 'a failed re-read must not be able to keep the map').toContain('holdsMap.current = false');
    expect(reauthorize).not.toContain('refresh');
    expect(reset).toContain('setRefusal(null)');
    expect(reset).not.toContain('refresh');
  });

  it('keeps retained rows visible while the normal response lease is renewed (#957)', () => {
    expect(source).toContain('useResponseDeadline(load.kind === \'ready\' ? load.view : null)');
    expect(source).toContain('useResponseDeadline(health)');
    expect(source).toContain('seenEpoch.current !== accessEpoch || rowsExpired || healthExpired');
    expect(readEffect).toContain('setLoad({ kind: \'ready\', view });');
    expect(readEffect).not.toContain('setLoad(PENDING)');
  });

  it('does not throw away the map it opened on (#824)', () => {
    // The page seeds its rows from this org's own stored copy, and the effect
    // above runs on mount as well as on an org change. Without the skip it puts
    // the page straight back to `Loading…` over a map it had already drawn —
    // the arrival half of the same defect the assertions above cover for a
    // refresh. On mount there is also no previous org whose leftovers need
    // clearing, so nothing else is lost by skipping.
    const reset = slice('const clearedFor = useRef<string | null | undefined>', '}, [scope.org]);');
    // Keyed on the ORG it has already cleared for, not on a spent boolean:
    // `StrictMode` runs this effect twice on mount, and a boolean guard is used
    // up by the first run while the second clears the map for real. That was
    // seen in a browser, where `/repos` drew "Loading…" over a stored map.
    expect(reset).toContain('clearedFor.current === scope.org');
    expect(reset).not.toContain('useRef(true)');
    expect(source).toContain('useReadState<Load, ReposView>(`/api/repos${scopeQuery(addressOrg ?? undefined)}`');
    // Transport persistence and every painted frame of a saved return are
    // exercised by check-session-hint.mjs, including the repos route.
  });

  it('puts the map back to pending when the address names another org', () => {
    // The claim the moved anchor above used to carry, standing on its own now.
    // Delete the line it names and every other test in this file stays green
    // while `/acme/repos` → `/gtm/repos` keeps acme's rows on the
    // page under gtm's heading, for as long as the new read takes.
    const reset = slice('const clearedFor = useRef<string | null | undefined>', '}, [scope.org]);');
    expect(reset, 'the org-change reset must still be its own effect').not.toBe('');
    expect(reset).toContain('setLoad(PENDING);');
    // And it is that effect and no other: the read effect must never blank the
    // page, which is the whole of #824.
    expect(readEffect).not.toContain('setLoad(PENDING)');
  });

  it('gates the page on rows and each answer’s own authorization lease', () => {
    // Ordinary health waits stay inside the rendered map; only a response
    // whose own lease expired joins the full-page withdrawal gate.
    expect(source).toContain('if (seenEpoch.current !== accessEpoch || rowsExpired || healthExpired)');
    expect(source.match(/LoadingStructure surface="repos"/g)).toHaveLength(2);
  });
});

describe('an in-page arrangement is not a place you navigated to', () => {
  it('replaces the entry rather than pushing one, so Back still leaves the page', () => {
    mount('?order=recent');
    control.owner!.onOwner('octocat');
    control.order!.onOrder('name');
    expect(history.map((h) => h.kind)).toEqual(['replace', 'replace']);
    expect(history.some((h) => h.kind === 'push')).toBe(false);
  });
});

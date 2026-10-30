import { describe, expect, it } from 'vitest';
import source from './TeamView.tsx?raw';

/**
 * READ THIS BEFORE TRUSTING ANY TEST IN THIS FILE.
 *
 * Every assertion here is a regex against `TeamView.tsx`'s SOURCE TEXT. Not one
 * of them mounts the component, and so not one of them observes behaviour. They
 * pin that a line is written a particular way; they cannot tell you the value on
 * that line is used, nor that the page does anything with it.
 *
 * That is a deliberate limit, not an oversight. The board's vitest env is `node`
 * and the repo carries no DOM implementation. `renderToStaticMarkup(<TeamView />)`
 * is not an alternative, and this was measured rather than assumed:
 *
 *   - it THROWS — "Missing getServerSnapshot, which is required for
 *     server-rendered content" — because the page reads the URL through
 *     `useSyncExternalStore`;
 *   - and with a `getServerSnapshot` supplied it renders exactly
 *     `<div class="state">Loading…</div>`, 33 characters. `people` starts
 *     `pending` and only `useEffect` resolves it, and a static render runs no
 *     effects. There is no prop or context by which a test could hand it people,
 *     and adding one to suit a test would be its own defect.
 *
 * So what is genuinely decidable has been moved OUT of this component into pure
 * functions that real tests hold — `crew-filter.ts` (`selectedLogins`,
 * `canonicalisation`, `pressCrewCard`), `pulse-filter.ts` (`selectedIssues`),
 * `use-viewer-state.ts` (`syncViewer`). What is left in the
 * component is the wiring between them, and the wiring is what these greps pin.
 *
 * Two mutations they DO catch, both of which switch #461 off entirely:
 *   - `<Pulse assignees={[]} …/>` — the page stops following the card
 *   - `toggleMember` computing `next` and never calling `gotoPath` — a press does
 *     nothing at all
 * A mutation they CANNOT catch is one that keeps the line and breaks the value,
 * e.g. `selectedLogins(search, known).slice(0, 0)`. Closing that needs a DOM.
 */

// The one thing in this file that is NOT a grep, imported below the warning
// above so the acceptance recorded against its line does not move:
// `rosterForDisk` is an ordinary function and the tests over it are real.
import { rosterForDisk } from '../cache/read-cache';
import cacheSource from '../cache/read-cache.ts?raw';
import type { Person } from '../api/people';

describe('TeamView’s source pins the URL as a render-time read (#461, C1)', () => {
  it('holds no copy of `window.location.search` in component state — TEXT ONLY: this '
    + 'greps the file, it does not observe a re-render', () => {
    // Held in state, the page went stale on any navigation that fires no
    // popstate. The sidebar's "Unit" item goes through App's own `navigate`,
    // which pushes history and re-renders without dispatching one: from
    // `/team?assignee=IvanRoslov` the URL cleared to `/team` while the tiles went
    // on reading Ivan's counts and his card stayed pressed — and the next Crew
    // press then wrote a SECOND login onto an already-bare URL.
    expect(source).not.toMatch(/useState\([^;]*window\.location\.search/);
    expect(source).not.toMatch(/setSearch/);
  });

  it('names the SAME hook the queue below it uses — TEXT ONLY. The page and its queue '
    + 'each mirroring the URL their own way is how one of them came to refresh on a '
    + 'navigation the other slept through', () => {
    expect(source).toMatch(/const search = useLocationSearch\(\);/);
    expect(source).toMatch(/import \{ useLocationSearch \} from '\.\.\/location-search';/);
    expect(source).not.toMatch(/addEventListener\('popstate'/);
  });
});

describe('TeamView’s source pins what it corrects a URL against (#461, C2)', () => {
  it('names `dataLogins` and passes its result to both readers — TEXT ONLY: it cannot '
    + 'see that the result is non-empty or that either reader uses it', () => {
    // `Person.githubLogin` is board-assigned and admin-typed, so the roster's
    // spelling is not necessarily Github's. Correcting against it rewrites a
    // working `?assignee=IvanRoslov` into a broken `?assignee=ivanroslov`
    // whenever an admin typed the latter — on every load, and with the URL no
    // longer holding what it would take to recover.
    expect(source).toMatch(/const known = useMemo\(\s*\(\) => dataLogins\(/);
    expect(source).toMatch(/selectedLogins\(search, known\)/);
    expect(source).toMatch(/canonicalisation\(window\.location\.search, known\)/);
    expect(source).not.toMatch(/rosterLogins|rosterKey/);
  });
});

describe('TeamView’s source pins that it never splits its memo key (#461, C3)', () => {
  it('hands the selection on whole — TEXT ONLY', () => {
    // The selection was joined into a key and split back out of it. A single
    // crafted token carrying that separator — `?assignee=IvanRoslov%00octocat` —
    // therefore became TWO logins: the tiles read the OR of two people out of one
    // token while the queue below matched neither.
    expect(source).toMatch(/const assignees = useMemo\(\(\) => selection, \[selectionKey\]\);/);
    expect(source).not.toMatch(/selectionKey\s*\.\s*split|selectionKey \? selectionKey\.split/);
    expect(source).not.toMatch(/rosterKey\s*\.\s*split/);
  });
});

describe('TeamView’s source pins the org queue as one derivation (#461, C4)', () => {
  it('maps it inside a memo keyed on plain identifiers — TEXT ONLY', () => {
    // Unmemoized at the `IssuesViewer` call site, this re-ran over the whole org
    // array on every keystroke in the queue's own search box — each of which
    // commits, navigates, fires a popstate and re-renders this page — and the
    // fresh array identity also invalidated `availableGroupDims`'s memo inside
    // the viewer, which had been a hit.
    const memos = [...source.matchAll(/useMemo\(\s*\(\) =>([\s\S]*?),\s*(\[[\s\S]*?\]),\s*\);/g)];
    const mapping = memos.find((m) => m[1].includes('fromPersonalIssue'));
    expect(mapping, 'fromPersonalIssue must be reached from inside a useMemo').toBeDefined();
    expect(mapping![2]).toMatch(/^\[[\w\s,]*\]$/);
    expect(source).toMatch(/issues=\{viewerIssues\}/);
    expect(source).not.toMatch(/issues=\{[^}]*\.map\(/);
  });
});

describe('TeamView’s source pins the two wires that carry #461 (#461)', () => {
  // These two lines ARE the feature at the component level: one hands the
  // selection to every block above the queue, the other turns a card press into a
  // navigation. Delete either and the page stops filtering while every pure test
  // in the repo stays green — which is exactly what happened when this file had
  // no assertion on them. TEXT ONLY, so they catch a deleted or emptied wire and
  // not a wire carrying a wrong value.

  it('hands Pulse the selection it derived, not a literal', () => {
    // Issue metrics are read by the host; Projects keeps its own coverage.
    expect(source).toMatch(
      /<Pulse assignees=\{assignees\} metrics=\{metrics\} metricsFailed=\{metricsFailed && metrics === null\} \/>/,
    );
  });

  it('turns a Crew press into a navigation, and asks `pressCrewCard` what it should '
    + 'be — the decision itself, inert cards included, is tested in crew-filter.spec', () => {
    const press = /const toggleMember = \(p: RosterPerson\) => \{([\s\S]*?)\n  \};/.exec(source);
    expect(press, 'toggleMember must still be here').not.toBeNull();
    expect(press![1]).toMatch(/pressCrewCard\(window\.location\.search, assignees, p\.githubLogin\)/);
    expect(press![1]).toMatch(/gotoPath\(window\.location\.pathname \+ next, \{ replace: true \}\)/);
  });
});

/**
 * Overview's top row, after the Oldest-open block came off it (#815).
 *
 * #752 took the feedback flow chart off the page and #815 took the aging block
 * off entirely, so the Crew leads with no companion column beside it.
 *
 * THE HOLE IS WHAT THIS PINS. Removing a block from a two-column row and leaving
 * the row is how a page ends up with a 566px empty column.
 *
 * TEXT ONLY, with the limits the header of this file sets out.
 */
describe('Overview draws no Oldest-open block, and no hole where it was (#815)', () => {
  it('draws the block nowhere and imports it from nowhere', () => {
    expect(source).not.toMatch(/\bOldestOpen\b/);
    expect(source).not.toMatch(/oldestOpenBeside/);
  });

  it('drops the aging derivation with the block it fed', () => {
    // It walked the whole org queue on every keystroke in the search box below.
    // Nothing on this page reads it now: the oldest issue is the flow strip's
    // third tile (#816) and `stripModel` walks that queue for it, so keeping
    // this would be a second pass over the same array feeding nothing.
    expect(source).not.toMatch(/\bagingState\b/);
    expect(source).not.toMatch(/const aging = useMemo/);
  });

  it('drops the hand-off to the queue, which was the block\'s own footer control', () => {
    // "See all N in the unit queue" set the viewer's `tf` param and scrolled to
    // the queue. It had no other caller and no button left to sit on.
    expect(source).not.toMatch(/function showAgingQueue\(\)/);
    expect(source).not.toMatch(/p\.set\('tf', 'aging'\)/);
  });

  // The queue's own Aging filter is untouched: it is the viewer's control and
  // was never this block's. The anchor the removed scroll targeted is still the
  // region's id, so a reader who picks Aging in the queue lands where they did.
  it('leaves the queue region and its id alone', () => {
    expect(source).toMatch(/id=\{UNIT_QUEUE_ID\}/);
  });
});

/**
 * What the roster leaves behind on the disk (#824 review).
 *
 * `rosterForDisk` is an ordinary function, so this half is a real test and not
 * a grep. The other half — that the write goes through it — is a grep, because
 * the effect that writes never fires here.
 */
describe('the stored roster carries no personal address', () => {
  const person = (over: Partial<Person> = {}): Person => ({
    id: 'octocat@example.com',
    displayName: 'Octocat',
    emails: ['octocat@example.com', 'octocat@personal.example'],
    clickupNames: ['Octocat'],
    githubLogin: 'octocat',
    ...over,
  });

  it('empties `emails`, which is the field the alias table fills', () => {
    // `people.controller.ts:47`: "The alias table holds people's personal,
    // non-corporate addresses." The service already empties this field for a
    // caller it will not vouch for, and a `localStorage` entry that outlives
    // the tab is that kind of caller.
    expect(rosterForDisk([person()])[0].emails).toEqual([]);
  });

  it('keeps everything the seed is for', () => {
    // Names, logins, ClickUp names and `id` — the group address the team group
    // publishes anyway, and the row's own key. Exactly what the same controller
    // keeps for an agent token.
    expect(rosterForDisk([person()])[0]).toEqual({
      id: 'octocat@example.com',
      displayName: 'Octocat',
      emails: [],
      clickupNames: ['Octocat'],
      githubLogin: 'octocat',
    });
  });

  it('does not touch the roster the page is drawing', () => {
    // The stripping is for the disk alone. The live list keeps its addresses,
    // so `resolvePerson` and the palette are unchanged the moment the read
    // lands; what degrades is the half second the seed is on screen for.
    const live = [person()];
    rosterForDisk(live);
    expect(live[0].emails).toHaveLength(2);
  });

  it('is what the write goes through, and the whole list is not written raw', () => {
    expect(cacheSource).toContain('people: rosterForDisk(value.people)');
    expect(source).not.toContain('writePayload(PEOPLE_KEY, list)');
  });

  it('tells the strip what its figures are counting, off the same key the memo uses', () => {
    // A Crew press re-scopes Issues and Throughput to that member. Both figures
    // land different and neither of them moved, so the mark needs the subject
    // and not just the value (#824). `selectionKey` and not a fresh join: the
    // memo above already keys on it, and a second derivation of the same string
    // is a second thing to keep in step.
    expect(source).toContain('subject={selectionKey}');
    expect(source).not.toMatch(/subject=\{selection\.join/);
  });
});

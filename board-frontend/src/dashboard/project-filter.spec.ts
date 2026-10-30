/**
 * #750 — the Contributions rings and the queue's Project chip write one param.
 *
 * The round-trip is what these pin: what a ring press writes is read back by
 * `decodeViewer`, the codec the queue itself filters from. Written against the
 * codec rather than against a literal query string, so the two cannot drift the
 * way #461 made sure the assignee dimension could not.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, filterIssues } from '../issues-viewer/filter-group';
import type { ViewerIssue } from '../issues-viewer/viewer-issue';
import {
  DEFAULT_VIEWER, decodeViewer, encodeViewer, hasExplicitGroup, hasExplicitView,
} from '../issues-viewer/viewer-url';
import { isPressed, pressBoardRing, selectedBoards, selectedProjects, withProjects } from './project-filter';

/** The two unqualified boards the pre-#782 spec named as bare strings. A board
 *  that names no org still has no address to write, so every URL asserted below
 *  is the one that was asserted before. */
const PLATFORM = { number: 1, name: 'Platform' };
const DELIVERY = { number: 2, name: 'Delivery' };
const HARDENING = { number: 3, name: 'Board hardening' };

describe('selectedProjects', () => {
  it('reads nothing out of a query that names no viewer state', () => {
    expect(selectedProjects('')).toEqual([]);
    expect(selectedProjects('?utm_source=slack')).toEqual([]);
  });

  it('reads the boards the URL named, in the order it named them', () => {
    expect(selectedProjects('?project=Platform&project=Delivery')).toEqual(['Platform', 'Delivery']);
  });

  it('drops an empty token and a repeat', () => {
    expect(selectedProjects('?project=Platform&project=&project=Platform')).toEqual(['Platform']);
  });

  it('keeps a name exactly as written — a board name is free text, not a login', () => {
    // `filterIssues` compares these strings verbatim against `issue.projects`,
    // so there is no casing to correct toward. `?project=platform` legitimately
    // matches nothing, the same way the queue's own chip would.
    expect(selectedProjects('?project=platform')).toEqual(['platform']);
  });

  it('reads a name carrying a comma whole', () => {
    // Repeated params, not a comma-joined value: a joined codec would split
    // "Growth, later" into two boards that match nothing.
    const search = withProjects('', ['Growth, later']);
    expect(selectedProjects(search)).toEqual(['Growth, later']);
  });
});

describe('pressBoardRing', () => {
  it('narrows to a board nothing was narrowed to', () => {
    expect(pressBoardRing('', [], PLATFORM)).toBe('?project=Platform');
  });

  it('clears the board it is already narrowed to — the press that set it also clears it', () => {
    expect(pressBoardRing('?project=Platform', [{ name: 'Platform' }], PLATFORM)).toBe('');
  });

  it('adds a second board beside the first', () => {
    expect(selectedProjects(pressBoardRing('?project=Platform', [{ name: 'Platform' }], DELIVERY)!)).toEqual([
      'Platform',
      'Delivery',
    ]);
  });

  it('navigates nowhere for a row carrying no name', () => {
    expect(pressBoardRing('?project=Platform', [{ name: 'Platform' }], undefined)).toBeNull();
    expect(pressBoardRing('?project=Platform', [{ name: 'Platform' }], { number: 1, name: '' })).toBeNull();
  });

  it('releases a board the URL spelled twice, rather than halving it', () => {
    // The toggle runs against the derived selection, not the raw text.
    const selection = selectedBoards('?project=Platform&project=Platform');
    expect(pressBoardRing('?project=Platform&project=Platform', selection, PLATFORM)).toBe('');
  });

  it('leaves every other param exactly as it was', () => {
    const next = pressBoardRing('?view=board&q=flaky&assignee=octocat', [], PLATFORM)!;
    const p = new URLSearchParams(next.slice(1));
    expect(p.get('view')).toBe('board');
    expect(p.get('q')).toBe('flaky');
    expect(p.get('assignee')).toBe('octocat');
    expect(p.getAll('project')).toEqual(['Platform']);
  });

  it('does not drop an explicit view the codec would have omitted', () => {
    // Your work's queue leads with `view=board`, so a round-trip through
    // `encodeViewer` would delete an explicit `?view=board`. Editing one key in
    // place cannot.
    expect(pressBoardRing('?view=board', [], PLATFORM)).toContain('view=board');
  });
});

/**
 * #750 review — the press writes the URL BESIDE the viewer, not through it, so
 * the URL it leaves has to say what the viewer's storage was saying. See
 * `withArrangement`.
 *
 * These are the recorded failure: with the fourth argument dropped from
 * `pressBoardRing`, every one of the first three fails, and the first is the one
 * a person meets — Status grouping chosen on Your work, then a ring pressed.
 */
describe('a ring press keeps the arrangement the queue remembered', () => {
  it('carries a remembered grouping the codec omits as its own default', () => {
    // `status` IS `DEFAULT_GROUP`, so `encodeViewer` never writes it, and
    // `initViewer` then falls to Your work's `['project', 'type']` lead. It has
    // to be in the URL or the queue snaps to Board under every press.
    const next = pressBoardRing('', [], PLATFORM, { group: 'status', view: 'board' })!;
    expect(new URLSearchParams(next.slice(1)).get('group')).toBe('status');
  });

  it('carries a remembered view too — the same silencing takes both halves', () => {
    const next = pressBoardRing('', [], PLATFORM, { group: 'status', view: 'list' })!;
    expect(new URLSearchParams(next.slice(1)).get('view')).toBe('list');
  });

  it('the URL it writes reads back as the arrangement that was remembered', () => {
    // The round trip, through the codec the viewer itself is re-derived by:
    // `hasExplicitGroup`/`hasExplicitView` are what `initViewer` asks, and both
    // have to answer yes now that storage is silenced.
    const next = pressBoardRing('', [], PLATFORM, { group: 'status', view: 'list' })!;
    expect(hasExplicitGroup(next)).toBe(true);
    expect(hasExplicitView(next)).toBe(true);
    expect(decodeViewer(next).group).toBe('status');
    expect(decodeViewer(next).view).toBe('list');
    expect(decodeViewer(next).filters?.projects).toEqual(['Platform']);
  });

  it('writes nothing extra when the page remembers nothing', () => {
    expect(pressBoardRing('', [], PLATFORM, null)).toBe('?project=Platform');
  });

  it('writes nothing extra over a URL that already speaks for the viewer', () => {
    // Storage is already silent there, so there is nothing being lost and the
    // press has no business restating it.
    const next = pressBoardRing('?group=type', [{ name: 'x' }], PLATFORM, { group: 'status', view: 'list' })!;
    expect(new URLSearchParams(next.slice(1)).get('group')).toBe('type');
    expect(new URLSearchParams(next.slice(1)).has('view')).toBe(false);
  });

  it('hands a cleared page back to a bare URL, where storage speaks again', () => {
    expect(pressBoardRing('?project=Platform', [{ name: 'Platform' }], PLATFORM, { group: 'status' })).toBe('');
  });
});

describe('the ring and the queue write one param (#750, the #461 move)', () => {
  it('what a ring press writes is what the viewer reads back as its project filter', () => {
    const search = pressBoardRing('', [], HARDENING)!;
    expect(decodeViewer(search).filters?.projects).toEqual(['Board hardening']);
  });

  it('what the queue writes is what a ring reads back as pressed', () => {
    const fromQueue = encodeViewer({
      ...DEFAULT_VIEWER,
      filters: { ...DEFAULT_VIEWER.filters, projects: ['Board hardening'] },
    });
    expect(selectedProjects(fromQueue)).toEqual(['Board hardening']);
  });

  it('a press over a queue-written URL clears what the queue set', () => {
    const fromQueue = encodeViewer({
      ...DEFAULT_VIEWER,
      filters: { ...DEFAULT_VIEWER.filters, projects: ['Board hardening'] },
    });
    const selection = selectedBoards(fromQueue);
    expect(selectedProjects(pressBoardRing(fromQueue, selection, HARDENING)!)).toEqual([]);
  });
});

/**
 * #782 — the rings were keyed per-org and the SELECTION was not, so two orgs
 * each holding a board called "Roadmap" behaved as one board: press either ring
 * and both lit, and the queue narrowed to the union.
 *
 * The selection is the board's whole address now. `?project=` still carries the
 * name — it is the dimension the queue matches on and the chip writes — and
 * `?board=` carries the address that says which of the boards wearing that name
 * was pressed.
 */
describe('two boards with one name in two orgs are two boards (#782)', () => {
  const hub = { org: 'acme', number: 3, name: 'Roadmap' };
  const globex = { org: 'globex', number: 5, name: 'Roadmap' };

  it('presses the board that was pressed, and leaves its namesake alone', () => {
    const selection = selectedBoards(pressBoardRing('', [], hub)!);
    expect(isPressed(selection, hub)).toBe(true);
    expect(isPressed(selection, globex)).toBe(false);
  });

  it('reads the whole address back out of the URL it wrote', () => {
    expect(selectedBoards(pressBoardRing('', [], hub)!)).toEqual([hub]);
  });

  it('opens on the same board for whoever the link is sent to', () => {
    // The one thing a shared narrowed URL has to do. Read back through the same
    // functions the receiving page reads it with, so this cannot pass on a
    // string the page never parses.
    const shared = pressBoardRing('', [], globex)!;
    expect(isPressed(selectedBoards(shared), globex)).toBe(true);
    expect(isPressed(selectedBoards(shared), hub)).toBe(false);
  });

  it('still narrows the queue to the name, which is what the queue matches on', () => {
    expect(decodeViewer(pressBoardRing('', [], hub)!).filters?.projects).toEqual(['Roadmap']);
  });

  it('holds both boards when both rings are pressed, under one name', () => {
    const first = pressBoardRing('', [], hub)!;
    const both = pressBoardRing(first, selectedBoards(first), globex)!;
    expect(selectedBoards(both)).toEqual([hub, globex]);
    // One name, because the queue's dimension is the name and the two boards
    // share it. Doubling the token would draw two identical FilterBar chips.
    expect(decodeViewer(both).filters?.projects).toEqual(['Roadmap']);
  });

  it('releases one of the two and keeps the other pressed', () => {
    const first = pressBoardRing('', [], hub)!;
    const both = pressBoardRing(first, selectedBoards(first), globex)!;
    const left = pressBoardRing(both, selectedBoards(both), hub)!;
    expect(selectedBoards(left)).toEqual([globex]);
    expect(isPressed(selectedBoards(left), hub)).toBe(false);
    // The name survives, because the board still pressed is wearing it.
    expect(decodeViewer(left).filters?.projects).toEqual(['Roadmap']);
  });

  it('clears the name when the last board wearing it is released', () => {
    const first = pressBoardRing('', [], hub)!;
    expect(pressBoardRing(first, selectedBoards(first), hub)).toBe('');
  });

  it('presses every board wearing a name the URL gave no address for', () => {
    // What the queue's own chip writes. A bare name says nothing about which
    // board, and the queue really is narrowed to both — so both rings are lit,
    // and pressing one clears the name for both. That is the honest reading of
    // a name-only URL, not the #782 defect.
    const selection = selectedBoards('?project=Roadmap');
    expect(isPressed(selection, hub)).toBe(true);
    expect(isPressed(selection, globex)).toBe(true);
    expect(pressBoardRing('?project=Roadmap', selection, hub)).toBe('');
  });

  it('writes no address for a board that named no org, and presses it by name', () => {
    // A board-api predating `org` (#697) leaves the row with no address to
    // write. It degrades to exactly the pre-#782 behaviour rather than writing
    // half an address that would match nobody.
    const next = pressBoardRing('', [], { number: 3, name: 'Roadmap' })!;
    expect(next).toBe('?project=Roadmap');
    expect(isPressed(selectedBoards(next), hub)).toBe(true);
  });

  it('leaves a stale address behind rather than pressing a board the name dropped', () => {
    // A `?board=` whose name is no longer in `?project=` qualifies nothing —
    // the FilterBar chip can remove the name without knowing the address exists.
    expect(selectedBoards('?board=acme/3/Roadmap')).toEqual([]);
    expect(isPressed(selectedBoards('?board=acme/3/Roadmap'), hub)).toBe(false);
  });
});

/**
 * The whole path, end to end, because #782 is a defect that lived in the seam
 * between three files: what a ring press writes, what the codec reads back, and
 * what the queue then keeps. Each half was right about its own half.
 *
 * Driven through the real functions in the real order — press, decode, filter —
 * so nothing here can pass on a string the page never parses.
 */
describe('a ring press narrows the queue to the board that was pressed (#782)', () => {
  const hub = { org: 'acme', number: 3, name: 'Roadmap' };
  const globex = { org: 'globex', number: 5, name: 'Roadmap' };
  const row = (number: number, owner: string): ViewerIssue => ({
    repo: 'board', owner, number, title: `#${number}`, htmlUrl: 'u', state: 'open',
    assignees: [], labels: [], projects: ['Roadmap'], type: 'chore', createdAt: '2026-08-01T00:00:00.000Z',
  });
  const queue = [row(1, 'acme'), row(2, 'globex')];
  const narrowed = (search: string) =>
    filterIssues(queue, { ...DEFAULT_FILTERS, ...decodeViewer(search).filters }, Date.parse('2026-09-02T00:00:00Z'))
      .map((i) => i.number);

  it('keeps the pressed board’s issues and drops its namesake’s', () => {
    expect(narrowed(pressBoardRing('', [], hub)!)).toEqual([1]);
    expect(narrowed(pressBoardRing('', [], globex)!)).toEqual([2]);
  });

  it('opens on the same issues for whoever the link is sent to', () => {
    // Same string, read cold — no selection carried over from the sender.
    const shared = pressBoardRing('', [], globex)!;
    expect(narrowed(shared)).toEqual([2]);
    expect(isPressed(selectedBoards(shared), globex)).toBe(true);
  });

  it('goes back to the whole queue when the press is undone', () => {
    const on = pressBoardRing('', [], hub)!;
    expect(narrowed(pressBoardRing(on, selectedBoards(on), hub)!)).toEqual([1, 2]);
  });

  it('holds both boards’ issues when both rings are pressed', () => {
    const on = pressBoardRing('', [], hub)!;
    expect(narrowed(pressBoardRing(on, selectedBoards(on), globex)!)).toEqual([1, 2]);
  });

  it('narrows to the name, and to both boards, when the chip wrote the URL', () => {
    // The queue's own Project chip knows a name and no address, so it selects
    // every board wearing it. That is the filter the reader asked for.
    expect(narrowed('?project=Roadmap')).toEqual([1, 2]);
  });
});

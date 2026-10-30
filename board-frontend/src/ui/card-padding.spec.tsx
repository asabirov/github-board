/**
 * One padding for every card on the board, loaded or loading (#944, #1008).
 *
 * Markup only. This suite has no DOM, so what is held here is the
 * class a card, its skeleton and the queue block around them carry, never where
 * any of them lands on screen. The edges were read in a browser, and the shots
 * were delivered on #944 and #1008.
 *
 * Classes are compared as whole tokens: `toContain('p-4')` would pass on `gap-4`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from './kit';
import { describe, expect, it } from 'vitest';
import type { IssueMetrics } from '../api/issues';
import { OrgLagCard, ThroughputCard } from '../dashboard/Pulse';
import { FlowStrip } from '../flow-strip/FlowStrip';
import { OldestTile } from '../flow-strip/OldestTile';
import type { OldestIssue, StripModel } from '../flow-strip/flow-strip.vm';
import { BoardView } from '../issues-viewer/BoardView';
import { ListView } from '../issues-viewer/ListView';
import type { ViewerIssue } from '../issues-viewer/viewer-issue';
import { ProjectsPreviewCard } from '../projects/ProjectsPreview';
import { CrewGrid } from '../team/CrewGrid';
import DASHBOARD from '../dashboard/Dashboard.tsx?raw';
import VIEWER from '../issues-viewer/IssuesViewer.tsx?raw';
import { CARD_PADDING } from './block';
import { LoadingStructure } from './LoadingStructure';
import { QUEUE_REGION } from './queue-region';

const classLists = (html: string): string[][] =>
  [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1].split(/\s+/).filter(Boolean));

/** A card on a column, loaded or not: the only surface with this corner that
 *  also stacks its contents. The skeleton's search field shares the corner but
 *  is not a column. */
const cardsIn = (html: string) => classLists(html).filter((c) => c.includes('rounded-[10px]') && c.includes('flex-col'));

/** The padding tokens in a class list, `p-4` and `px-[18px]` alike. Variant
 *  prefixes (`[@media(pointer:coarse)]:pr-[52px]`) are not padding on a card. */
const paddingOf = (classes: string[]) => classes.filter((c) => /^p[xytrblse]?-/.test(c));

const issue: ViewerIssue = {
  repo: 'board', number: 944, title: 'Card padding', htmlUrl: 'https://github.com/acme/board.example.com/issues/944',
  state: 'open', assignees: ['octocat'], projects: [], type: 'bug', createdAt: '2026-09-10T00:00:00Z', labels: [],
};
const loaded = renderToStaticMarkup(
  <TooltipProvider>
    <BoardView groups={[{ key: 'open', label: 'Open', tone: 'neutral', rows: [{ item: issue, depth: 0 }] }]} dim="openclosed" mayClose={false} mayAssign={false} />
  </TooltipProvider>,
);
const housed = renderToStaticMarkup(<LoadingStructure surface="queue" housed label="your queue" className={QUEUE_REGION} />);
const unhoused = renderToStaticMarkup(<LoadingStructure surface="queue" label="your queue" />);

describe('one card padding, loaded and loading (#944)', () => {
  it('pads a board card by the one card padding', () => {
    const cards = cardsIn(loaded);
    expect(cards).toHaveLength(1);
    expect(paddingOf(cards[0])).toEqual([CARD_PADDING]);
  });

  it.each([['on Your work', housed], ['on Queue', unhoused]])('pads a loading card %s exactly as a loaded one', (_, html) => {
    const cards = cardsIn(html);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(paddingOf(card)).toEqual(paddingOf(cardsIn(loaded)[0]));
  });

  it.each(['work', 'throughput', 'overview'] as const)('pads the %s skeleton as the blocks it stands in for', (surface) => {
    const html = renderToStaticMarkup(<LoadingStructure surface={surface} label={surface} />);
    // The section is the block; the div inside it carries the inset.
    expect(paddingOf(classLists(html)[1])).toEqual([CARD_PADDING]);
  });
});

/** The block surface (`BLOCK`) in a render, which is what a reader sees as a card. */
const surfacesIn = (html: string) => classLists(html).filter((c) => c.includes('rounded-xl') && c.includes('bg-surface'));

const oldest: OldestIssue = {
  repo: 'board', number: 1, title: 'The oldest open issue', ageDays: 400,
  htmlUrl: 'https://github.com/acme/board.example.com/issues/1', assignees: [],
};
const DAY = 86_400_000;
const tile = (series: number[]) => ({ n: 3, series, endsOn: Date.UTC(2026, 8, 5) });
const stripModel: StripModel = {
  issues: tile([6, 7, 9]),
  throughput: tile([4, 0, 7]),
  releases: { n: 0, series: [0, 0, 0], endsOn: Date.UTC(2026, 8, 5) - DAY, scope: 'acme', partial: false },
  grid: null,
  oldest: { kind: 'issue', issue: oldest },
  window: null,
  years: [],
};
const crewCard = { key: 'a@example.com', slug: 'octocat', githubLogin: 'octocat', name: 'Octocat', email: 'a@example.com' };

describe('every other card on My work and Overview (#944)', () => {
  // Each is the block it was reported against, rendered, rather than its class
  // constant: a constant can be right while the component stops using it.
  it.each([
    // `unknown` draws the card and nothing that reads the metrics.
    ['Throughput', <ThroughputCard m={{} as IssueMetrics} member={{ kind: 'unknown' }} />],
    ['Org lag', <OrgLagCard metrics={null} />],
    ['Projects, while its items load', <ProjectsPreviewCard projects={[]} />],
  ])('pads %s by the one card padding', (_, element) => {
    const [block] = surfacesIn(renderToStaticMarkup(<TooltipProvider>{element}</TooltipProvider>));
    expect(block).toBeDefined();
    expect(paddingOf(block)).toEqual([CARD_PADDING]);
  });

  it('pads every flow strip tile alike, the oldest-issue tile included', () => {
    // The oldest-issue tile was `py-[13px]` beside two tiles at 16px, so its
    // caption sat 3px above theirs on one row. Rendered inside the strip, so the
    // tile the strip draws is the one checked.
    const tiles = surfacesIn(renderToStaticMarkup(<TooltipProvider><FlowStrip model={stripModel} /></TooltipProvider>));
    expect(tiles.length).toBeGreaterThanOrEqual(3);
    for (const t of tiles) expect(paddingOf(t)).toEqual([CARD_PADDING]);
  });

  it.each([['holding an issue', { kind: 'issue' as const, issue: oldest }], ['holding none', { kind: 'none' as const }]])(
    'pads the oldest-issue tile %s by the one card padding', (_, view) => {
      const [shell] = surfacesIn(renderToStaticMarkup(<TooltipProvider><OldestTile view={view} /></TooltipProvider>));
      expect(paddingOf(shell)).toEqual([CARD_PADDING]);
    });

  it('pads a Crew card by the one card padding, so its avatar starts where the blocks below start', () => {
    const html = renderToStaticMarkup(<CrewGrid people={[]} roster={[crewCard]} isActive={() => false} onToggle={() => {}} />);
    const cards = classLists(html).filter((c) => c.includes('rounded-xl') && c.includes('w-full'));
    expect(cards).toHaveLength(1);
    expect(paddingOf(cards[0])).toEqual([CARD_PADDING]);
  });
});

describe("the queue's list view keeps #447's one text origin (#1008)", () => {
  const list = (housed: boolean) => classLists(renderToStaticMarkup(
    <TooltipProvider>
      <ListView groups={[{ key: 'open', label: 'Open', tone: 'neutral', rows: [{ item: issue, depth: 0 }] }]} mayClose={false} mayAssign={false} housed={housed} />
    </TooltipProvider>,
  ));
  const insetOf = (classes: string[]) => classes.filter((c) => /^px-/.test(c));
  const partsOf = (lists: string[][]) => ({
    wrapper: lists.find((c) => c.includes('max-w-5xl'))!,
    head: lists.find((c) => c.includes('grid') && c.includes('pb-2'))!,
    chip: lists.find((c) => c.includes('mb-1.5') && c.includes('items-center'))!,
    row: lists.find((c) => c.includes('hover:bg-[var(--queue-row-hover)]'))!,
  });

  it('bleeds a housed list by exactly its rows’ inset, so row text sits on the region’s edge with the label', () => {
    const { wrapper, head, chip, row } = partsOf(list(true));
    const bleed = wrapper.filter((c) => /^-mx-/.test(c));
    expect(bleed).toHaveLength(1);
    // `-mx-2.5` against `px-2.5`: out by the inset and back in by it, which puts
    // the text on the content edge and only the hover fill past it.
    expect(insetOf(row)).toEqual([bleed[0].replace(/^-mx-/, 'px-')]);
    expect(insetOf(head)).toEqual(insetOf(row));
    expect(insetOf(chip)).toEqual(insetOf(row));
    // And the viewer is what tells it it is housed.
    expect(VIEWER).toContain('housed={housed}');
  });

  it('leaves the Project page’s list, which has no region, at its own inset and unbled', () => {
    const { wrapper, row } = partsOf(list(false));
    expect(wrapper.filter((c) => /^-m[xl]-/.test(c))).toEqual([]);
    expect(insetOf(row)).toEqual(['px-3.5']);
  });
});

describe('the queue block around the board (#1008)', () => {
  it('pads by the card padding on every side, and by nothing else', () => {
    expect(paddingOf(QUEUE_REGION.split(' '))).toEqual([CARD_PADDING]);
  });

  it('keeps that padding while it loads, adding no inset of its own inside it', () => {
    const [section, inner] = classLists(housed);
    expect(paddingOf(section)).toEqual([CARD_PADDING]);
    expect(paddingOf(inner)).toEqual([]);
  });

  it('draws no block on Queue while it loads, because Queue draws none once loaded (#1000)', () => {
    const [section] = classLists(unhoused);
    expect(section).not.toContain('bg-surface');
    expect(paddingOf(section)).toEqual([]);
  });

  it('is the skeleton each page asks for', () => {
    // Dashboard cannot be rendered here (see Dashboard.spec.ts), so which
    // skeleton it asks for on which page is read off its source.
    expect(DASHBOARD).toContain('<LoadingStructure surface="queue" housed label="your queue" className={`${QUEUE_REGION} min-h-[220px]`} />');
    expect(DASHBOARD).not.toContain('label="your queue" inset={false}');
  });
});

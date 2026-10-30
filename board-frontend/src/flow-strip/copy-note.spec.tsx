/**
 * The quiet line a tile carries when its figure is a copy drawn after a failed
 * read (#1046). Markup only: the suite has no DOM and runs no effect, so which
 * copy TeamView hands the strip, and when, is
 * checked in a browser. What is pinned here is that the line appears on the
 * three tiles and only where there is a figure to qualify, so a failed read with
 * no copy, a genuine zero and an empty queue each still read as themselves.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../ui/kit';
import { COPY_NOTE, FlowStrip } from './FlowStrip';
import { DAY_MS, type StripModel } from './flow-strip.vm';
import { notComparableScopes, type MetricScope } from '../metric-scope/metric-scope';

const SAT = Date.UTC(2026, 8, 5);

const model = (over: Partial<StripModel> = {}): StripModel => ({
  issues: { n: 16, series: [6, 7, 9], endsOn: SAT },
  throughput: { n: 2, series: [4, 0, 7], endsOn: SAT - DAY_MS },
  releases: { n: 0, series: null, endsOn: null, scope: null, partial: false },
  grid: null,
  oldest: {
    kind: 'issue',
    issue: { repo: 'board', number: 901, title: 'Weekly report never arrives', ageDays: 90, htmlUrl: 'https://github.com/acme/board/issues/901', assignees: [] },
  },
  window: null,
  years: [],
  ...over,
});

const strip = (over: Partial<StripModel>, fromCopy?: { queue: boolean; metrics: boolean }) =>
  renderToStaticMarkup(<TooltipProvider><FlowStrip model={model(over)} fromCopy={fromCopy} /></TooltipProvider>);

const notes = (html: string) => (html.match(new RegExp(`>${COPY_NOTE}<`, 'g')) ?? []).length;

describe('a tile drawn from a copy says so (#1046)', () => {
  it('on all three tiles when both reads failed with a copy on screen', () => {
    expect(notes(strip({}, { queue: true, metrics: true }))).toBe(3);
  });

  it('on the tiles each read feeds: Issues and The oldest the queue, Closed the metrics', () => {
    const queueOnly = strip({}, { queue: true, metrics: false });
    expect(notes(queueOnly)).toBe(2);
    expect(queueOnly).toMatch(/>Issues<\/span><span[^>]*>Saved copy</);
    expect(queueOnly).toMatch(/>The oldest<\/span><span[^>]*>Saved copy</);
    const metricsOnly = strip({}, { queue: false, metrics: true });
    expect(notes(metricsOnly)).toBe(1);
    expect(metricsOnly).toMatch(/>Closed<\/span><span[^>]*>Saved copy</);
  });

  it('nowhere when the reads landed', () => {
    expect(notes(strip({}))).toBe(0);
    expect(notes(strip({}, { queue: false, metrics: false }))).toBe(0);
  });

  it('never over a tile with no figure, which still names the read that failed', () => {
    const html = strip(
      { issues: { n: null, series: null, endsOn: null }, throughput: { n: null, series: null, endsOn: null }, oldest: { kind: 'unread' } },
      { queue: true, metrics: true },
    );
    expect(notes(html)).toBe(0);
    expect(html).toContain('The issue queue couldn’t be read just now.');
    expect(html).toContain('Closed issues couldn’t be read just now.');
    expect(html).toContain('The oldest open issue couldn’t be read just now.');
  });

  it('marks a zero and an empty queue drawn from a copy, which are copies too', () => {
    const html = strip({ issues: { n: 0, series: null, endsOn: null }, oldest: { kind: 'none' } }, { queue: true, metrics: false });
    expect(notes(html)).toBe(2);
    expect(html).toMatch(/>The oldest<\/span><span[^>]*>Saved copy</);
    expect(html).toContain('Nothing open.');
  });

  it('keeps a genuine zero and an empty queue apart from a copy', () => {
    const html = strip({ issues: { n: 0, series: null, endsOn: null }, oldest: { kind: 'none' } });
    expect(notes(html)).toBe(0);
    expect(html).toMatch(/>0</);
    expect(html).toContain('Nothing open.');
  });
});

describe('comparison indicator for combined figures', () => {
  const render = (notComparable?: { queue: boolean; metrics: boolean }, over: Partial<StripModel> = {}) =>
    renderToStaticMarkup(<TooltipProvider><FlowStrip model={model(over)} notComparable={notComparable} /></TooltipProvider>);

  it('is absent when no comparison fails', () => {
    expect(render()).not.toContain('Not comparable');
    expect(render({ queue: false, metrics: false })).not.toContain('Not comparable');
  });

  it.each([
    { queue: true, metrics: false },
    { queue: false, metrics: true },
    { queue: true, metrics: true },
  ])('shows only one icon when a populated figure fails: %j', flags => {
    const html = render(flags);
    expect(html.match(/aria-label="Not comparable"/g)).toHaveLength(1);
    expect(html).not.toContain('>Not comparable<');
  });

  it('marks zero but never a missing figure', () => {
    const figures = { issues: { n: 0, series: null, endsOn: null }, throughput: { n: null, series: null, endsOn: null } };
    expect(render({ queue: true, metrics: true }, figures)).toContain('aria-label="Not comparable"');
    expect(render({ queue: false, metrics: true }, figures)).not.toContain('Not comparable');
  });
});

describe('comparison indicator requires current metadata', () => {
  const now = Date.parse('2026-09-28T00:01:00Z');
  const scope: MetricScope = {
    repositories: [], repositoryIds: null, ownerIds: null, digest: null,
    definition: 'issue-flow-v1', filters: { repo: null, label: null, cycle: null, longLivedLabels: [] }, timeZone: 'UTC',
    window: { start: '2026-09-21T00:00:00Z', end: '2026-09-28T00:00:00Z' },
    sourceUpdatedAt: '2026-09-28T00:00:00Z', freshUntil: '2026-09-28T00:10:00Z', completeness: 'partial',
  };
  const render = (a?: MetricScope, b = a, saved = false) => renderToStaticMarkup(
    <TooltipProvider><FlowStrip model={model()} fromCopy={{ queue: saved, metrics: saved }}
      notComparable={{ queue: notComparableScopes(a, b, now), metrics: notComparableScopes(a, b, now) }} /></TooltipProvider>,
  );

  it('shows no icon for legacy responses or when one person has no metadata', () => {
    expect(render()).not.toContain('Not comparable');
    expect(render(undefined, scope)).not.toContain('Not comparable');
    expect(notComparableScopes(scope, undefined, now)).toBe(false);
  });

  it('shows no icon on a stale saved copy until current metadata arrives', () => {
    const stale = { ...scope, freshUntil: '2026-09-28T00:00:00Z' };
    const html = render(stale, stale, true);
    expect(html).toContain('Saved copy');
    expect(html).not.toContain('Not comparable');
    expect(render(scope, stale)).not.toContain('Not comparable');
    expect(render(scope)).toContain('aria-label="Not comparable"');
  });
});

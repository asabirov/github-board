import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type { ReactElement } from 'react';
import { TooltipProvider } from '../ui/kit';
import { ProjectsCard, ThroughputCard, TrendPlot } from './Pulse';
import { weekTipText } from './trend-chart';
import { contrast, rgb, themeTokens, THEMES, type RGB } from '../../test/kit-contrast';
// The read-short sub-line from the function that produces it, never re-typed —
// a copy in a `not.toContain` goes green the moment the wording changes and
// stops protecting anything. `pulse.spec.ts` holds the literal that pins it.
import { truncatedCountNote } from '../projects/pulse';
import pulseSource from './Pulse.tsx?raw';
import apiSource from '../api/projects.ts?raw';
import type { IssueMetrics } from '../api/issues';
import type { ProjectSummary } from '../api/projects';

// The board's test env is `node` (no DOM), so — same rationale as
// ViewerControls.spec.tsx — render to a static HTML string and assert against the
// markup. `window` is stubbed the way route.spec.ts stubs it, because the
// Oldest-open hand-off below reads the current pathname and search.

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    location: { pathname: '/team', search: '' },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('Projects stands still under a Crew selection (#461)', () => {
  // Everything else on this page moves when a Crew card is pressed — the four
  // tiles, Oldest open, Throughput, the queue below. Projects deliberately does
  // not: `ProjectSummary` carries per-member `closed` but no per-member `open`,
  // so there is no denominator a member's completion percentage could come from,
  // and the block goes on stating the unit's. It says so by saying nothing — no
  // meta, no dimmed rings, no altered subline — which is exactly the shape a
  // later author would read as unfinished and "fix". These two tests are what
  // stops that, and neither alone is enough: the first proves the block reads
  // nothing off the URL, the second proves `Pulse` hands it nothing to read.
  const board = (o: Partial<ProjectSummary> & { number: number }): ProjectSummary => ({
    name: `Board ${o.number}`,
    url: `https://github.com/orgs/acme/projects/${o.number}`,
    status: 'active',
    open: 6,
    closed: 4,
    pct: 40,
    lastClosed: null,
    closedThisWeek: 2,
    contributors: [
      { login: 'IvanRoslov', closed: 3, kind: 'person' },
      { login: 'octocat', closed: 1, kind: 'person' },
    ],
    ...o,
  });
  const PROJECTS = [board({ number: 7 }), board({ number: 8, open: 2, closed: 8, pct: 80 })];
  const card = (search: string) => {
    (globalThis as unknown as { window: { location: { search: string } } }).window.location.search = search;
    return renderToStaticMarkup(
      <TooltipProvider>
        <ProjectsCard projects={PROJECTS} />
      </TooltipProvider>,
    );
  };

  it('renders byte for byte with a member selected and with none', () => {
    expect(card('?assignee=IvanRoslov')).toBe(card(''));
  });

  it('is handed the boards and nothing else — no selection reaches the call site', () => {
    const call = pulseSource.match(/<ProjectsCard[^/]*\/>/)?.[0];
    expect(call).toBe('<ProjectsCard projects={boards} />');
    expect(call).not.toMatch(/assignees|logins|who|selection/);
  });
});

const week = (opened: number, closed: number) => ({ opened, closed });
const metrics = (weeks: { opened: number; closed: number }[]): IssueMetrics => ({
  updatedAt: '2026-08-11T00:00:00Z',
  repos: [], labels: [], cycles: [], filter: {},
  totals: { open: 0, openFlow: 0, steadyState: 0, closed90: 0, unassigned: 0 },
  weeks,
  recent4: { opened: 0, closed: 0 },
  byMember: [],
  load: [],
  ttc: { medianDays: 0, p90Days: 0, n: 0 },
  stale: [],
  steadyByType: [],
});
/** The card mounts the chart, and the chart hints — so it needs the provider the
 *  app root gives it (App.tsx), the same way the Projects card's tests do. */
const throughput = (m: IssueMetrics, member?: Parameters<typeof ThroughputCard>[0]['member']) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <ThroughputCard m={m} member={member} />
    </TooltipProvider>,
  );

describe('Throughput opened figure contrast (#888 R1)', () => {
  it.each(THEMES)('keeps the opened figure readable and matched to its trace in %s', (theme) => {
    const html = throughput(metrics([week(7, 4)]), {
      kind: 'known', opened: 7, closed: 4, weeks: [week(7, 4)],
    });
    const colour = html.match(/<span[^>]*style="color:([^"]+)"[^>]*>7<\/span>/)?.[1];
    expect(colour, 'the opened figure must expose its series colour').toBeDefined();
    const trace = html.match(/<path[^>]*stroke="([^"]+)"/)?.[1];
    expect(trace).toBe(colour);

    const tokens = themeTokens(theme);
    const token = colour!.match(/var\((--[\w-]+)\)/)?.[1];
    expect(token).toBeDefined();
    expect(tokens[token!]).toBeDefined();
    const foreground = rgb(tokens[token!]);
    const background = rgb(tokens['--surface']);
    // Resolve both the opaque token and the translucent mix that caused R1.
    // Unsupported colour syntax fails instead of silently treating it as opaque.
    const mixed = colour!.match(/^color-mix\(in srgb, var\(--[\w-]+\) ([\d.]+)%, transparent\)$/);
    if (!mixed && !/^var\(--[\w-]+\)$/.test(colour!)) throw new Error(`Unsupported colour: ${colour}`);
    const alpha = mixed ? Number(mixed[1]) / 100 : 1;
    const painted = foreground.map((v, i) => v * alpha + background[i] * (1 - alpha)) as RGB;
    expect(contrast(painted, background)).toBeGreaterThanOrEqual(3);
  });
});

describe('Throughput under a Crew selection (#461)', () => {
  // The unit closes fifteen in its busiest week and two in its quietest; the
  // member closes two in both of theirs.
  const UNIT = metrics([week(0, 15), week(0, 2)]);
  const chart = (html: string) => html.slice(html.indexOf('<svg'));
  // Where each week's marker sits, off the markers themselves. Since #1171 they
  // are round-capped zero-length lines rather than `<circle>`s, so the y is
  // `y1` — and the match is anchored on `data-dot` so it cannot pick up a
  // gridline, whose own `y1` is 6, 65 or 124 and would make the assertions
  // below true of a chart with no series in it at all.
  //
  // The sign matters: a point drawn ABOVE the plot renders `y1="-112"`, and an
  // extractor that dropped the minus would read it back as 112 and call it inside.
  const cys = (html: string) => [...chart(html).matchAll(/data-dot="[^"]*"[^>]*?\sy1="(-?[\d.]+)"/g)]
    .map((m) => Number(m[1]));
  // `TrendChart`'s own bounds — PAD and H - PAD.
  const PLOT_TOP = 6;
  const PLOT_BOTTOM = 124;

  it('draws a member’s weeks on the UNIT’s scale, so a quiet member reads as quiet — '
    + 'rescaling per selection drew one closed issue a week edge to edge and made a '
    + 'member with two look exactly as busy as a unit with fifteen', () => {
    const unit = cys(throughput(UNIT));
    const member = cys(throughput(UNIT, { kind: 'known', closed: 4, opened: 0, weeks: [week(0, 2), week(0, 2)] }));
    // The unit's own chart plots both a 15 and a 2, so the height of a 2 is a
    // fact this render already fixes. The member's every point is a 2 or a 0 and
    // must sit at exactly those heights.
    expect(new Set(member).size).toBeGreaterThan(0);
    for (const cy of member) expect(unit).toContain(cy);
    // Rescaled to the member's own max, a 2 would be drawn at the top of the plot
    // — where the unit draws its 15, and nowhere near where it draws a 2.
    expect(Math.min(...member)).toBeGreaterThan(Math.min(...unit));
  });

  it('leaves the unfiltered chart exactly where it was — the unit’s series is its own '
    + 'scale, so nothing about this render moves', () => {
    const plain = throughput(UNIT);
    expect(cys(plain)).toContain(6); // the 15 still touches the top of the plot
  });

  it('keeps every plotted point inside the plot when a selection outruns the unit \u2014 '
    + '`throughputFor` SUMS two members\u2019 weeks and an issue assigned to two people '
    + 'counts for both, so a summed series can exceed the unit maximum the scale is '
    + 'locked to. Unclamped the line is drawn above the plot, and the svg is '
    + 'overflow-visible, so it runs across the legend', () => {
    // The unit's busiest week closes fifteen; this selection closes twenty, then thirty.
    const html = throughput(UNIT, { kind: 'known', closed: 50, opened: 0, weeks: [week(0, 20), week(0, 30)] });
    const ys = cys(html);
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(PLOT_TOP);
      expect(y).toBeLessThanOrEqual(PLOT_BOTTOM);
    }
  });

  it('draws no series at all for a login the board holds nothing for — the unit’s own '
    + 'trend under one person’s name is the exact falsehood the `weeks: null` path '
    + 'exists to prevent, and it reached the card a second way through this branch', () => {
    const unfiltered = throughput(UNIT);
    const html = throughput(UNIT, { kind: 'unknown' });
    // Not just "some other chart" — the unit's own plotted path, byte for byte.
    const unitPath = /<path d="([^"]+)"/.exec(unfiltered.slice(unfiltered.indexOf('aria-label="Weekly throughput')))![1];
    expect(html).not.toContain(unitPath);
    expect(html).not.toContain('Weekly throughput, last');
  });

  it('says the board holds nothing for that login, in a line — not as two em dashes '
    + 'where the numbers were: at 34px semibold a dash renders as a rule, so the card '
    + 'would read as its own legend drawn twice at two sizes', () => {
    const html = throughput(UNIT, { kind: 'unknown' });
    expect(html).toContain('The board holds no throughput for this login.');
    expect(html).not.toContain('>—<');
    // The numbers row goes with them — there is nothing true to put in it.
    expect(html).not.toContain('>0<');
    expect(html).not.toContain('closed</span>');
  });

  it('ends the card after that line rather than stretching to its neighbour’s height '
    + 'around an empty chart well', () => {
    expect(throughput(UNIT, { kind: 'unknown' })).toContain('self-start');
    expect(throughput(UNIT)).not.toContain('self-start');
  });

  it('also ends early for a member whose payload omits the series — the deploy window '
    + 'where board-web reads a board-api that ships `byMember` without `weeks`', () => {
    const html = throughput(UNIT, { kind: 'known', closed: 3, opened: 1, weeks: null });
    expect(html).not.toContain('Weekly throughput, last');
    expect(html).toContain('self-start');
    // Their counts ARE known, so unlike the unknown case they are still stated.
    expect(html).toContain('>3<');
  });
});

/**
 * The headline against the two things drawn beside it (#895).
 *
 * The report was two closed counts on one page: the day grid above this card
 * reading a day, and this card reading something a reader could not place. The
 * card summed `byMember`, and `issues-metrics.vm.ts` builds those rows by
 * ASSIGNEE — an issue with two assignees counted twice, an issue with none
 * counted nowhere — so the figure belonged to no window and no population the
 * page draws. The fixture below is that shape, minimal: an org that closed 8 in
 * its trailing week, one of them double-assigned and three of them unassigned,
 * which sums the roster to 6.
 */
describe('what the Throughput figures count (#895)', () => {
  // A trailing week the org closed 8 and opened 12 in, under a quieter one so a
  // reading off the wrong end of `weeks` fails rather than coincides.
  const WEEKS = [week(3, 2), week(12, 8)];
  const ROSTER = [
    { login: 'IvanRoslov', name: 'Ivan', opened: 6, closed: 3 },
    { login: 'octocat', name: 'Octocat', opened: 4, closed: 3 },
  ];
  const ORG: IssueMetrics = { ...metrics(WEEKS), byMember: ROSTER };

  it('states the unit’s own trailing week, not the sum of the per-assignee rows — the '
    + 'sum double-counts an issue with two assignees and drops one with none, so it was '
    + 'neither the org’s throughput nor anything the grid above could be reconciled '
    + 'against', () => {
    const html = throughput(ORG);
    const bignums = [...html.matchAll(/tabular-nums[^"]*"[^>]*>(\d+)</g)].map((m) => m[1]);
    expect(bignums).toEqual(['8', '12']);
    // The roster sums to 6 and 10 — the figures this card used to print.
    expect(bignums).not.toContain('6');
    expect(bignums).not.toContain('10');
  });

  it('prints the same numbers the chart under it ends on, which is the whole reason the '
    + 'figures are allowed to name and colour those two lines', () => {
    const html = throughput(ORG);
    // Read BOTH off one render and require them to agree, rather than pinning
    // each to 8 and 12 separately: the chart is drawn from `weeks` whatever the
    // headline does, so a pinned chart assertion stays green over a headline
    // that has wandered off to another population.
    const figures = [...html.matchAll(/tabular-nums[^"]*"[^>]*>(\d+)</g)].map((m) => m[1]);
    // `weekTipText` says the trailing week as "this week"; the chart's last
    // column carries that sentence as its accessible name.
    const trailing = /"this week, (\d+) closed and (\d+) opened"/.exec(html);
    expect(trailing, 'the chart must name its trailing week').not.toBeNull();
    expect(figures).toEqual([trailing![1], trailing![2]]);
  });

  it.each([
    undefined,
    { kind: 'known' as const, closed: 3, opened: 6, weeks: [week(6, 3)] },
    { kind: 'known' as const, closed: 3, opened: 6, weeks: null },
  ])('omits the figure period label while keeping the Throughput heading', (member) => {
    const html = throughput(ORG, member);
    expect(html).toContain('>Throughput</span>');
    expect(html).not.toContain('Throughput (7 days)');
    const { document } = parseHTML(html);
    document.querySelectorAll('.sr-only').forEach((node) => node.remove());
    expect(document.documentElement.textContent).not.toMatch(/7\s*days/);
    expect(html).not.toContain('Throughput details');
  });

  it.each([1, 2, 12])('keeps %i weekly buckets without a period label', (count) => {
    const html = throughput(metrics(Array.from({ length: count }, () => week(6, 3))));
    const { document } = parseHTML(html);
    const text = document.documentElement.textContent;
    expect(text).not.toMatch(new RegExp(`${count}\\s*weeks?`));
    expect(html.match(/data-point="/g)).toHaveLength(count);
  });

  it('shows each figure’s change against the seven days before, coloured by whether '
    + 'it is better: more closed is, and opened has no better direction (#1029)', () => {
    // ORG's weeks read 2 closed and 3 opened, then 8 and 12.
    const html = throughput(ORG);
    expect(html).toMatch(/text-success"><span aria-hidden="true">\+6<\/span>/);
    expect(html).toMatch(/text-dim"><span aria-hidden="true">\+9<\/span>/);
    const fewer = throughput(metrics([week(1, 9), week(1, 4)]));
    expect(fewer).toMatch(/text-danger"><span aria-hidden="true">−5<\/span>/);
    expect(fewer).toMatch(/text-dim"><span aria-hidden="true">±0<\/span>/);
  });

  it('names what each delta is measured against, for a reader who cannot see the figures '
    + '(#1170 review)', () => {
    const html = throughput(ORG);
    expect(html).toContain('<span class="sr-only">+6 compared with the previous 7 days.</span>');
    expect(html).toContain('<span class="sr-only">+9 compared with the previous 7 days.</span>');
    // Heard once each, not twice: the drawn number is `aria-hidden`.
    expect(html).toContain('<span aria-hidden="true">+6</span>');
    expect(html.match(/\+6/g)).toHaveLength(2);
    // And nothing of it is drawn — the sentence a reader called filler is gone
    // from the screen, which is what the card looks like either way.
    expect(html).not.toContain('Last 7 days, compared with');
    expect(html.match(/compared with/g)).toHaveLength(2);
  });

  it('takes a Crew member’s change from their own weeks, not the unit’s', () => {
    const html = throughput(ORG, { kind: 'known', closed: 3, opened: 6, weeks: [week(2, 5), week(6, 3)] });
    expect(html).toMatch(/text-danger"><span aria-hidden="true">−2<\/span>/);
    expect(html).toMatch(/text-dim"><span aria-hidden="true">\+4<\/span>/);
  });
});

/**
 * The trend chart on the board's one chart-pointer (#708).
 *
 * It had grown its own hover in #421 — a `useState`, twelve `<rect>` hit
 * targets, a halo, swelling dots and a hand-positioned chip — beside the repo
 * sparkline's separate implementation of the same idea. What the chart SAYS is
 * still its own (`weekTipText`); how it is pointed at is `ui/chart-pointer`'s.
 *
 * No DOM here, so the marked states are driven through `TrendPlot`, which takes
 * the pointer as props — the same split `repo-spark.tsx` uses, and for the same
 * reason.
 */
describe('the throughput trend answers through the board’s one chart-pointer (#708)', () => {
  // Four weeks, no two of them alike in either series, so no assertion below can
  // pass by landing on the wrong week.
  const WEEKS = [week(1, 3), week(2, 4), week(6, 15), week(5, 9)];
  const FOUR = metrics(WEEKS);
  const say = (i: number) => weekTipText(WEEKS.length - 1 - i, WEEKS[i].closed, WEEKS[i].opened);
  const plot = (over: Partial<Parameters<typeof TrendPlot>[0]> = {}) =>
    TrendPlot({ weeks: WEEKS, max: 15, mark: null, read: null, onPoint: () => {}, ...over });
  const plotted = (over: Partial<Parameters<typeof TrendPlot>[0]> = {}) =>
    renderToStaticMarkup(<TooltipProvider>{plot(over)}</TooltipProvider>);
  /** The sentence the box is opened with. A closed Radix tooltip renders no
   *  content into the markup, so — as `chart-pointer.spec.tsx` does for the
   *  side — it is read off the element `TrendPlot` returns. */
  const boxSays = (el: ReactElement) => (el as ReactElement<{ label: string }>).props.label;
  /** The week markers this chart draws at rest. They are round-capped
   *  zero-length lines rather than `<circle>`s since #1171, so they are counted
   *  by the name they carry. */
  const dots = (html: string) => (html.match(/data-dot=/g) ?? []).length;

  it('gives every week a real control named with that week’s own sentence, and keeps '
    + 'none of the twelve hit rects it used to draw', () => {
    const html = throughput(FOUR);
    expect((html.match(/<button[^>]*data-point=/g) ?? []).length).toBe(WEEKS.length);
    for (let i = 0; i < WEEKS.length; i += 1) expect(html).toContain(`aria-label="${say(i)}"`);
    expect(html.slice(html.indexOf('<svg'))).not.toContain('<rect');
    // The hand-positioned chip is gone with them.
    expect(html).not.toContain('role="tooltip"');
  });

  it('is ONE tab stop, parked on the latest week — this card is on a page of charts '
    + 'and a stop per week would be twelve', () => {
    const html = throughput(FOUR);
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/data-point="3"[^>]*tabindex="0"/);
  });

  it('anchors the tooltip to the marked closed point in plot coordinates (#1190)', () => {
    for (const i of [0, 1, 3]) {
      const props = (plot({ mark: i, read: i }) as ReactElement<{ x: number; y: number; open: boolean }>).props;
      expect(props.x).toBeCloseTo((6 + i * 328 / 3) / 340 * 100);
      expect(props.y).toBeCloseTo((124 - WEEKS[i].closed / 15 * 118) / 130 * 100);
      expect(props.open).toBe(true);
    }
    expect((plot() as ReactElement<{ open: boolean }>).props.open).toBe(false);
  });

  it('says in the box the same sentence the pointed week carries as its name', () => {
    expect(boxSays(plot({ read: 1 }))).toBe(say(1));
    // Before the pointer has landed anywhere the box reads the week the chart
    // ends on — never an empty box.
    expect(boxSays(plot())).toBe(say(WEEKS.length - 1));
  });

  it('draws ONE dot for a marked week — the week’s own steps aside for the mark '
    + 'rather than sitting under it (#576, inherited)', () => {
    const rest = plotted();
    const marked = plotted({ mark: 1, read: 1 });
    expect((marked.match(/data-mark="dot"/g) ?? []).length).toBe(1);
    // The mark replaces a dot, it does not add one — so the count is one dot
    // short and one mark long, which is the same one dot. Both are now the same
    // shape: `ChartMark`'s round-capped zero-length line, a circle in SCREEN
    // pixels (#708), which the week's own markers became in #1171.
    expect(dots(marked)).toBe(dots(rest) - 1);
    expect(dots(rest)).toBeGreaterThan(0);
    // And it is drawn in the colour of the line it sits on. Both closed series
    // are `--chart-series`, which is NOT the module's default brand token.
    expect(marked).toMatch(/data-mark="dot"[^>]*stroke="var\(--chart-series\)"/);
  });

  it('marks a week with the #951 dashed brand guide and a haloed dot, not the black '
    + 'primary-ink rule it drew until #1030', () => {
    const marked = plotted({ mark: 1, read: 1 });
    expect(marked).toMatch(/data-mark="guide"[^>]*stroke="var\(--accent\)"[^>]*stroke-dasharray="2 3"/);
    expect(marked).not.toContain('data-mark="rule"');
    expect(marked).toContain('data-mark="halo"');
    expect(plotted()).not.toContain('data-mark="guide"');
  });

  it('drops the trailing week’s emphasis while another week is marked, so the biggest '
    + 'dot on the chart is never one nobody pointed at', () => {
    expect(plotted()).toContain('stroke-width="6.8"');
    expect(plotted({ mark: 1, read: 1 })).not.toContain('stroke-width="6.8"');
  });

  /**
   * #1171. A `<circle>` in this svg is not a circle: the chart is
   * `preserveAspectRatio="none"` over a 340x130 viewBox, so a radius is
   * stretched by each axis separately and the trailing closed marker measured
   * 10.60 x 6.20, 12.35 x 6.20, 14.50 x 6.20 and 17.80 x 6.20 px at 900, 1280,
   * 1440 and 1920 on the built page. `scripts/measure-chart-dots.mjs --check` is what measures the
   * drawn shape; this is the half a suite with no DOM can hold, which is that
   * nothing here asks a browser to scale a marker at all.
   */
  it('draws every week marker as a round-capped zero-length line in screen pixels, '
    + 'never as a `<circle>` this stretched viewBox would turn into a lozenge', () => {
    const html = plotted();
    const svg = html.slice(html.indexOf('<svg'));
    expect(svg).not.toContain('<circle');
    expect(dots(html)).toBe(WEEKS.length * 2);
    for (const m of svg.matchAll(/<line [^>]*data-dot="[^"]*"[^>]*>/g)) {
      expect(m[0]).toContain('stroke-linecap="round"');
      expect(m[0]).toContain('vector-effect="non-scaling-stroke"');
      // A zero-length line, or the round cap paints a capsule rather than a dot.
      const at = (name: string) => /"([-\d.]+)"/.exec(m[0].slice(m[0].indexOf(`${name}=`)))?.[1];
      expect(at('x1')).toBe(at('x2'));
      expect(at('y1')).toBe(at('y2'));
    }
  });

  it('reports a week past the ceiling at its TRUE numbers while plotting it clamped — '
    + 'the scale stays the unit’s envelope and the readout stays honest', () => {
    const over = [week(0, 20), week(0, 30)];
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <TrendPlot weeks={over} max={15} mark={1} read={1} onPoint={() => {}} />
      </TooltipProvider>,
    );
    expect(html).toContain('aria-label="this week, 30 closed and 0 opened"');
    expect(boxSays(TrendPlot({ weeks: over, max: 15, mark: 1, read: 1, onPoint: () => {} })))
      .toBe('this week, 30 closed and 0 opened');
    for (const cy of [...html.matchAll(/cy="(-?[\d.]+)"/g)].map((m) => Number(m[1]))) {
      expect(cy).toBeGreaterThanOrEqual(6);
    }
  });

  it('draws its empty box and answers nothing when the payload carries no weeks at all', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <TrendPlot weeks={[]} max={15} mark={null} read={null} onPoint={() => {}} />
      </TooltipProvider>,
    );
    expect(html).toContain('<svg');
    expect(html).not.toContain('<button');
  });
});

describe('Pulse’s cost of a Crew press (#461)', () => {
  const source = pulseSource;

  it('keeps the SELECTION out of the fetch effect’s key — putting it there would '
    + 'turn every card press into three network round-trips against a 60s-TTL '
    + 'cache', () => {
    const deps = [...source.matchAll(/useEffect\([\s\S]*?\}, (\[[^\]]*\])\);/g)].map((m) => m[1]);
    // The org the ADDRESS narrows to joined the key in #714, and it is not a
    // selection: `/api/projects` carries `?org=` off the URL, so two orgs are two
    // different requests. A Crew press writes `?assignee=` and leaves `scope.org`
    // the same string, so it still costs nothing — which is what the next
    // assertion pins, rather than leaving it to the equality above.
    // Three effects now, and the claim is about all of them. The org-change
    // effect exists only to clear the last org's boards and the last org's
    // refusal before the new read lands, and it is keyed on the org ALONE — put
    // the refresh signal in there and a Sync now blanks a block somebody is
    // reading. The clock read is keyed on the refresh signal and the org. The
    // ROLLUP carries the access epoch as well (#892 review, C2): its summaries
    // are cleared at every expiry by `useCachedState`, and without a refill the
    // boards this person can still see stayed gone until an unrelated refresh.
    // No selection is in any of the three.
    expect(deps).toEqual(['[scope.org, report]', '[refresh, scope.org]', '[refresh, scope.org, accessEpoch, renewal, beginProjects, setProjects, report]']);
    for (const dep of deps) {
      expect(dep).not.toMatch(/assignees|logins|who|selection/);
    }
    // One dep list per effect: an effect written with no dep array at all runs on
    // every render, and the match above would simply skip it.
    expect(source.split('useEffect(').length - 1).toBe(deps.length);
  });

  it('memoizes the derivations on plain identifiers — a keystroke in the queue’s '
    + 'search box commits, navigates and re-renders this page, and these walk the '
    + 'whole org array. A dep list holding a fresh array literal defeats the memo '
    + 'on every render while still reading as memoized', () => {
    const memos = [...source.matchAll(/useMemo\(\(\) => (\w+)\([\s\S]*?\), (\[[\s\S]*?\])\);/g)]
      .map((m) => [m[1], m[2]] as const);
    // `agingState` was the other one until the #752 follow-up moved the
    // Oldest-open block to the top of Overview. The same assertion, on the same
    // derivation, now lives in `team/TeamView.spec.ts`.
    expect(memos.map((m) => m[0])).toEqual(['memberThroughput']);
    for (const [name, deps] of memos) {
      expect(`${name} ${deps}`).toMatch(/^\w+ \[[\w\s,]*\]$/);
    }
  });
});

describe('Pulse’s source pins the two wires that carry the selection (#461)', () => {
  // TEXT ONLY — these are regexes against `Pulse.tsx`'s source, in the same
  // technique and with the same limits as `TeamView.spec.ts`: they pin that a
  // line is written a particular way, and they cannot observe that the page does
  // anything with it. `TeamView.spec` pins that `assignees` is PASSED to `Pulse`;
  // nothing pinned that Pulse then USES it, and `Pulse.spec` renders
  // `ThroughputCard` directly, so it never sees the wiring either. Changing
  // both calls to `[]` switched #461 off inside this component and left the
  // whole suite green.
  //
  // The DOM constraint documented in `TeamView.spec.ts` is why these are greps
  // rather than a mounted render, and it is unchanged: the board's vitest env is
  // `node`, `Pulse` fetches in `useEffect`, and a static render runs no effects.
  const source = pulseSource;
  const calls = [...source.matchAll(/useMemo\(\(\) => (\w+)\(([^)]*)\)/g)]
    .map((m) => [m[1], m[2].split(',').map((a) => a.trim())] as const);

  it('hands the selection to every derivation that should follow a Crew card, as the '
    + 'LAST argument each of them takes', () => {
    expect(calls.map((c) => c[0])).toEqual(['memberThroughput']);
    for (const [name, args] of calls) {
      expect(`${name}(…, ${args[args.length - 1]})`).toBe(`${name}(…, assignees)`);
    }
  });

  it('names each derivation’s own source alongside it, so a wire cannot be right about '
    + 'the member and wrong about what it reads them out of', () => {
    expect(calls).toEqual([
      ['memberThroughput', ['metrics', 'assignees']],
    ]);
  });

  it('takes no org queue at all any more, the one block that read it having moved '
    + 'to the top of the page (#752 follow-up)', () => {
    // The queue was `Pulse`'s only because the aging list was. A prop left
    // behind, still passed and read by nothing, is a wire the next author has to
    // trace before they can believe it is dead — and `agingState` reachable from
    // two components is two places for one block to come back in.
    // Comments stripped first, the way the #666 block below does it and for the
    // same reason: this file's header says where the block WENT, and a grep over
    // the raw text would read that sentence as the mount it forbids.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bOldestOpen\b/);
    expect(code).not.toMatch(/\bagingState\b/);
    expect(code).not.toMatch(/\bOrgSource\b/);
    expect(source).toMatch(/export function Pulse\(\{ assignees = \[\], metrics, metricsFailed = false, onScope \}/);
  });
});

describe('Pulse reads metrics from above, never for itself (#666)', () => {
  // TEXT ONLY, and the same limits as the greps above. `TeamView` renders the
  // only `<Pulse>` on the board and fetches the metrics the flow strip reads;
  // when this component fetched its own too, Overview issued
  // `/api/issues/metrics` twice concurrently on every load and every refresh.
  // Nothing coalesces those: `apiFetch` keeps no in-flight map, and the HTTP
  // cache cannot dedupe two requests that are already out. The bytes are the
  // small half — the endpoint is stale-while-revalidate, so two reads either
  // side of a refresh can state different numbers for one member on one screen.
  // Comments stripped first: the prop's own doc names `fetchIssueMetrics` to say
  // why it is not called here, and a grep over the raw file would read that
  // sentence as the call it forbids.
  const code = pulseSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('calls `fetchIssueMetrics` nowhere and does not import it', () => {
    expect(code).toContain('useEffect');
    expect(code).not.toMatch(/fetchIssueMetrics/);
  });

  it('declares metrics as a prop, keeping `null` for both "not yet" and "failed" — '
    + 'the single state its own fetch collapsed them into, and the one the skeleton '
    + 'below draws', () => {
    expect(code).toMatch(/^\s*metrics: IssueMetrics \| null;$/m);
    expect(code).toMatch(/export function Pulse\(\{[^}]*\bmetrics\b[^}]*\}/);
    expect(code).not.toMatch(/setMetrics/);
  });
});

// #715 — the Projects card's rows read `closedThisWeek`, which the service now
// withholds from a board whose item read came up short. Coalesced to 0 the row
// said "No closes this week": a claim about the board where the truth is that
// nobody can say. The card already says the long form of this state on the
// Projects page; the row says the short form.
describe('a board read short says so instead of counting (#715)', () => {
  const board = (o: Partial<ProjectSummary> & { number: number }): ProjectSummary => ({
    name: `Board ${o.number}`,
    url: `https://github.com/orgs/acme/projects/${o.number}`,
    status: 'active',
    open: 6,
    closed: 4,
    pct: 40,
    lastClosed: null,
    closedThisWeek: 2,
    itemsComplete: true,
    ...o,
  });
  const card = (projects: ProjectSummary[]) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <ProjectsCard projects={projects} />
      </TooltipProvider>,
    );

  it('says the sentence on the short board and counts on the whole one, in one card', () => {
    const html = card([
      board({ number: 7, name: 'Read short', itemsComplete: false, closedThisWeek: undefined }),
      board({ number: 8, name: 'Read whole', itemsComplete: true, closedThisWeek: 3 }),
    ]);
    expect(html).toContain(truncatedCountNote(false));
    expect(html).toContain('This week: 3 closed, 0 opened');
    // ...and the short board is not also drawn as a board that closed nothing.
    // Counted rather than searched: this card holds TWO boards and the whole one
    // legitimately carries the week line, so a bare `not.toContain('This week:')`
    // here would assert against the row that is meant to have it.
    expect(html).not.toContain('Nothing opened or closed this week');
    expect(html.split('This week:')).toHaveLength(2);
  });

  it('shows what it always showed to a board-api that predates the flag', () => {
    const html = card([board({ number: 7, itemsComplete: undefined, closedThisWeek: undefined })]);
    expect(html).toContain('Nothing opened or closed this week');
    expect(html).not.toContain(truncatedCountNote(false));
  });
});

describe('Overview uses the compact project strip (#946)', () => {
  const board = (o: Partial<ProjectSummary> & { number: number }): ProjectSummary => ({
    name: `Board ${o.number}`, url: `https://github.com/orgs/acme/projects/${o.number}`,
    status: 'active', open: 5, closed: 5, pct: 50, lastClosed: null,
    closedThisWeek: 2, itemsComplete: true, ...o,
  });
  const card = (projects: ProjectSummary[]) => renderToStaticMarkup(
    <TooltipProvider><ProjectsCard projects={projects} /></TooltipProvider>,
  );

  it('retains individual progress and withholds the short board’s share', () => {
    const html = card([board({ number: 7 }), board({ number: 8, itemsComplete: false })]);
    expect(html.match(/>50%<\//g)).toHaveLength(1);
    expect(html).toContain(truncatedCountNote(false));
    expect(html).not.toContain('issues closed on');
  });

  it('keeps a whole board’s ring when its weekly join failed', () => {
    const html = card([board({ number: 7, pulseJoined: false, joinedFiguresWithheld: true })]);
    expect(html).toContain('50%');
    expect(html).not.toContain('This week: 2 closed');
  });

  it('states an empty successful list without inventing a zero share', () => {
    const html = card([]);
    expect(html).toContain('No projects.');
    expect(html).not.toContain('0%');
  });
});

/**
 * #785 — the Projects card's completion summary was a button that opened the
 * Projects rollup (#228), wrapped in a `Tip` reading "Open Projects". The rollup
 * is deleted, so the press led nowhere: a control that looks pressable and is
 * not is worse than a figure, because the reader spends a click finding out.
 *
 * What a reader loses and what they keep is the whole of this: the HEADLINE
 * stops being a target, and every ROW below it goes on opening its own board.
 * `ProjectBlock` draws its rows as anchors, so the summary was the card's only
 * `<button>` — which is what makes the absence assertion below say something
 * rather than nothing. Run against the card as it was before #785 it fails on
 * that line, naming the button.
 */
describe('compact Projects keeps project-detail navigation (#785, #946)', () => {
  const board = (o: Partial<ProjectSummary> & { number: number }): ProjectSummary => ({
    org: 'acme',
    name: `Board ${o.number}`,
    url: `https://github.com/orgs/acme/projects/${o.number}`,
    status: 'active',
    open: 5,
    closed: 5,
    pct: 50,
    lastClosed: null,
    closedThisWeek: 2,
    itemsComplete: true,
    ...o,
  });
  const html = () =>
    renderToStaticMarkup(
      <TooltipProvider>
        <ProjectsCard projects={[board({ number: 7 }), board({ number: 8 })]} />
      </TooltipProvider>,
    );

  it('draws individual shares without the removed aggregate control', () => {
    const markup = html();
    // The figure itself is unchanged — this is not a card that stopped saying.
    expect(markup).toContain('50%');
    expect(markup).not.toContain('issues closed on');
    // The summary was the only button in this card, so any button here is it.
    expect(markup).not.toContain('<button');
  });

  // The drill-in that survives: the summary stopped being a target and each row
  // did not. No `not.toContain` for the rollup address here — the old summary
  // navigated on click and carried no href at all, so asserting one is absent
  // would have passed against the very card this describe is about. The button
  // above is where that half is caught.
  it('still gives every board it lists its own address', () => {
    const markup = html();
    expect(markup).toContain('href="/acme/projects/7"');
    expect(markup).toContain('href="/acme/projects/8"');
  });
});

/**
 * A failed read must not become the next visit's seed (#824 review).
 *
 * `setProjects([])` on the failure path wrote that empty array through to the
 * disk — `use-cached-state.ts` stores anything non-null — so the next visit
 * seeded it, `projects` was truthy on the first render, and this block drew
 * `0%` and "0 / 0 issues closed on 0 of 0 boards": a definite claim about the
 * org, from the disk, produced by a read that failed. `Dashboard.tsx` avoids
 * the same thing for `mine` by deriving its fallback rather than setting it.
 *
 * These wiring checks do not run effects. The mounted failure and late-read
 * behavior is exercised by scripts/check-projects-preview.mjs.
 */
/**
 * The read this page makes for somebody else (#1169 review, B2).
 *
 * `/api/issues/buckets` feeds no number here — #461 took the block that read it
 * — and since #1169 it feeds no clock either: the top-bar stamp reads
 * `GET /api/sync/sources` and this file reports nothing up. What is left looks
 * exactly like dead code, and is not. It is the board's only call of that route,
 * `IssueBucketsService` has no boot warm, and the cache it fills is what the
 * Board sync panel's "Issue buckets" row reports on. Deleting it takes one of
 * that panel's six rows to "Not recorded" for ever, on a board where nothing is
 * wrong — a failure no test would have shown and no reader would have connected
 * to this line. So it is pinned here, and the reason is in the file.
 */
describe('the buckets read is kept for the cache it fills, not for its answer (#1169)', () => {
  it('still calls the route', () => {
    expect(pulseSource).toContain('fetchIssueBuckets()');
  });

  it('says in the file what the read is for, so it does not read as dead code', () => {
    const argument = pulseSource.slice(
      pulseSource.indexOf('read for the READ and not for the answer'),
      pulseSource.indexOf('fetchIssueBuckets().catch'),
    );
    expect(argument, 'the argument must sit at the fetch, where a deleter is standing').not.toBe('');
    expect(argument).toContain('only caller of that route');
    expect(argument).toContain('row says "Not recorded" for ever');
  });

  it('keeps no payload nobody reads, which is what made it look dead', () => {
    // The answer went into cached state and was then read by nothing — on the
    // disk, under a key, for no reader. The read is the point; the payload is
    // not.
    expect(pulseSource).not.toContain('setBuckets');
    expect(pulseSource).not.toContain('BUCKETS_KEY');
  });
});

describe('the rollup’s failure is derived, never stored (#824 review)', () => {
  const readEffect = pulseSource.slice(
    pulseSource.indexOf('fetchIssueBuckets('),
    pulseSource.indexOf('}, [refresh, scope.org, accessEpoch, renewal, beginProjects, setProjects, report]);'),
  );

  it('sets no boards on the failure path', () => {
    expect(readEffect, 'the read effect must still be findable').not.toBe('');
    expect(readEffect).toContain('setRollupFailed(true);');
    expect(readEffect).not.toContain('setProjects([])');
  });

  it('keeps a missing rollup unavailable instead of inventing zero progress', () => {
    // A copy after a failure (#1035), never an invented empty list.
    expect(pulseSource).toContain('const boards = projects ?? copy?.value ?? null;');
    expect(pulseSource).not.toMatch(/const boards = [^;]*\?\? \[\]/);
    // Disabled and still on the page, never replaced by a sentence (#1003).
    expect(pulseSource).toContain('<DisabledProjectStrip label="Projects"');
    expect(pulseSource).not.toContain('Projects unavailable.</p>');
  });

  it('hands a refused org’s boards to projectsAfterFailure, page and disk together', () => {
    // `TeamView` stands the whole page down for a withdrawal, which cleans the
    // tab. Nothing was cleaning the disk, so the entry sat under
    // `board_payload:projects:gtm` and seeded gtm's boards back every visit
    // for a day. Both halves are `projectsAfterFailure`'s since #1060 — the
    // disk inside it, the page through `keepHeld` — so this page names it once
    // and the storage assertion lives where the store is real,
    // `projects-last-good.spec.ts`.
    expect(readEffect).toContain('const after = projectsAfterFailure(scope.org, e);');
    expect(readEffect).toContain('setSaved(after.saved);');
  });

  it('does the same for a reader the board refuses (#824 follow-up)', () => {
    // A 403 is the board declining to serve this READER, and it draws no
    // sentence: `refusedScopeCopy` answers null for it, so `TeamView` does not
    // stand the page down and this card went on stating yesterday's boards and
    // percentages to somebody the board had just refused. It needed
    // `fetchProjects` to carry the status first — a bare `Error('forbidden')`
    // names no number and `scopeRefusal` reads null out of it — which is why
    // this arrives with the fetcher's own pin beside it.
    expect(readEffect).toContain('if (!after.keepHeld) setProjects(null);');
  });

  it('keeps no second opinion about what a refusal means (#860, #862 review, #1060)', () => {
    // Deliberately the ONLY thing this file says about which failures count,
    // and it is a claim about wiring rather than about behaviour: that question
    // is `projectsAfterFailure`'s, which asks `servableFailure` — the saved
    // copy's own rule — and `projects-last-good.spec.ts` drives every status
    // this handler can hand it against a real store.
    //
    // So it pins the delegation and nothing else. A `toContain` over source
    // text is what this file can do — no effect fires in this suite, per the
    // block comment above — and pretending it says more than that is how a
    // reintroduced defect passed a test written for it. The mounted refusal is
    // driven in a real browser by scripts/check-projects-preview.mjs, mode
    // `held-refusal`.
    expect(readEffect).toContain('projectsAfterFailure(scope.org, e)');
    expect(readEffect).not.toContain('if (refusedScopeCopy(');
    // The three shapes this rule has been re-derived in, none of which may come
    // back beside it: the narrower withdrawal question (#1060), a second
    // reading of the status (#860), and a second forget of the stored copy.
    expect(readEffect).not.toContain('scopeWithdrawn(');
    expect(readEffect).not.toContain('r?.status ===');
    expect(readEffect).not.toContain('forgetPayload(');
  });

  it('the fetcher behind it names the number, or the branch above is dead', () => {
    // `fetchProjects`'s own body, not the whole module: `api/projects.ts` throws that
    // `ApiError` in another fetcher too, and a whole-file `toContain` would
    // pass on somebody else's line.
    const start = apiSource.indexOf('async function readProjects(');
    expect(start).toBeGreaterThan(-1);
    const fetcher = apiSource.slice(start);
    const body = fetcher.slice(0, fetcher.indexOf('\n}\n'));
    expect(body, 'fetchProjects must still be findable in api/projects.ts').not.toBe('');
    expect(body).toContain("throw new ApiError(403, 'forbidden'");
  });
});

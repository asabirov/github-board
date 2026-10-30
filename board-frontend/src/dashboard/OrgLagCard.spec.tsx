import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../ui/kit';
import { OrgLagCard, orgLagHelp } from './Pulse';
import type { IssueMetrics } from '../api/issues';
import { lagInterval, OrgLagTrend } from './OrgLagTrend';

const metrics = (ttc: Partial<IssueMetrics['ttc']> = {}): IssueMetrics => ({
  ttc: { medianDays: 2, p90Days: 120, n: 3, meanDays: 41, readable: true, windowDays: 90, ...ttc },
} as IssueMetrics);
const render = (m: IssueMetrics | null, failed = false) => renderToStaticMarkup(<TooltipProvider><OrgLagCard metrics={m} failed={failed} /></TooltipProvider>);

describe('Org lag (#843)', () => {
  it('renders the mean, and keeps its explanation behind the figure', () => {
    const html = render(metrics());
    expect(html).toContain('>41</span>');
    expect(html).toContain('aria-label="41 days. Org lag details"');
    // A closed tooltip renders nothing, so the words are read off `orgLagHelp`.
    expect(html).not.toContain('Mean time from open to close');
  });

  it('distinguishes no closures, exact zero, and a small positive duration', () => {
    const nothing = render(metrics({ meanDays: null, n: 0 }));
    expect(nothing).toContain('No issues closed in this organization in the last 90 days.');
    // The population this card counts is not every close (#1103 review, B2):
    // `deliveredCloseAt` drops not-planned and duplicate, so the empty line has
    // to say so or an org whose only closes were not planned reads it as a lie.
    expect(nothing).toContain('Ones closed as not planned or duplicate are left out.');
    // And it is one owner's figure, not every owner this board serves.
    expect(nothing).not.toMatch(/anywhere/i);
    expect(render(metrics({ meanDays: 0, n: 1 }))).toContain('>0</span>');
    expect(render(metrics({ meanDays: 1 / 86400, n: 1 }))).toContain('&lt;0.1');
  });

  it.each([
    { readable: false, meanDays: null },
    { meanDays: undefined },
    { readable: undefined },
    { windowDays: undefined },
    { meanDays: NaN },
    { meanDays: -1 },
  ])('says the read did not land, for a missing or unreadable value: %j', (ttc) => {
    const html = render(metrics(ttc));
    expect(html).toContain('Org lag couldn’t be read just now.');
    expect(html).not.toContain('>0</span>');
    expect(html).not.toContain('No issues closed in this organization');
  });

  it('ends the loading state when the request fails, including a failed refresh with saved data', () => {
    expect(render(null)).toContain('Loading org lag');
    expect(render(null, true)).toContain('Org lag couldn’t be read just now.');
    expect(render(metrics(), true)).toContain('Org lag couldn’t be read just now.');
  });
});

describe('the Org lag tooltip is one sentence (#1031)', () => {
  it('says what the mean is of and how many issues, and nothing the card already says', () => {
    expect(orgLagHelp(255)).toBe('Mean time from open to close, over 255 issues closed organization-wide.');
    expect(orgLagHelp(1)).toBe('Mean time from open to close, over 1 issue closed organization-wide.');
    expect(orgLagHelp(1200)).toContain('1,200 issues');
    expect(orgLagHelp(255)).not.toContain('90 days');
    expect(orgLagHelp(255)).not.toContain('·');
  });
});

describe('matching Org lag readings (#1384)', () => {
  it.each([[3.7, 4.4, 'danger', '+0.7'], [5.1, 4.4, 'success', '−0.7'], [4.4, 4.4, 'dim', '±0']])('uses rolling endpoints for %s to %s', (prior, current, tone, delta) => {
    const point = (meanDays: number, endAt: string) => ({ startAt: '2026-01-01', endAt, n: 1, meanDays });
    const comparison = {
      startAt: '2026-04-01', endAt: '2026-07-01', previousStartAt: '2026-01-01',
      previousN: 1, previousMeanDays: Number(prior), deltaDays: 999,
      weekly: [point(9, '2026-06-24'), point(1, '2026-07-01')],
      rolling: [point(Number(prior), '2026-04-01'), point(Number(current), '2026-07-01')],
    };
    const html = render(metrics({ meanDays: Number(current), n: 1, comparison }));
    expect(html).toContain('>4.4</span>');
    expect(html).toContain(`text-${tone}"><span aria-hidden="true">${delta}</span>`);
    const path = /data-lag-series="rolling" d="([^"]*)"/.exec(html)?.[1];
    expect(path).toBeDefined();
    const ys = [...path!.matchAll(/[ML][\d.]+,([\d.]+)/g)].map(match => Number(match[1]));
    expect(Math.sign(ys[0] - ys.at(-1)!)).toBe(Math.sign(Number(current) - Number(prior)));
  });
});


describe('rolling lag availability and interaction', () => {
  const point = (meanDays: number | null, n = 1) => ({ startAt: '2026-01-01T00:00:00Z', endAt: '2026-04-01T00:00:00Z', meanDays, n });
  const comparison = { startAt: '2026-04-01', endAt: '2026-07-01', previousStartAt: '2026-01-01', previousN: 1, previousMeanDays: 2, deltaDays: -1, weekly: [], rolling: [point(2), point(1)] };

  it.each([0.01, -0.04])('rounds an unprintable delta to neutral zero: %s', delta => {
    const html = render(metrics({ comparison: { ...comparison, rolling: [point(1), point(1 + delta)] } }));
    expect(html).toContain('text-dim"><span aria-hidden="true">±0</span>');
    expect(html).not.toMatch(/[+−]&lt;0\.1/);
    expect(html).not.toMatch(/text-(success|danger)"/);
  });

  it('omits misleading legacy weekly charts and deltas until rolling data arrives', () => {
    const html = render(metrics({ comparison: { ...comparison, rolling: undefined } }));
    expect(html).toContain('>41</span>');
    expect(html).not.toContain('data-lag-series');
    expect(html).not.toContain('data-figure-change');
  });

  it('suppresses measurements after source failure', () => {
    for (const html of [render(metrics({ comparison, readable: false })), render(metrics({ comparison }), true)]) {
      expect(html).toContain('Org lag couldn’t be read just now.');
      expect(html).not.toContain('data-lag-series');
      expect(html).not.toContain('data-figure-change');
    }
  });

  it('does not compare an empty prior cohort to zero', () => {
    const html = render(metrics({ comparison: { ...comparison, rolling: [point(null, 0), point(1)] } }));
    expect(html).not.toContain('data-figure-change');
    expect(html).toContain('nothing closed');
  });

  it('breaks the line at empty windows and keeps real zero and round markers', () => {
    const weekly = [point(0), point(null, 0), point(1)];
    const plot = (mark: number | null) => renderToStaticMarkup(<TooltipProvider><OrgLagTrend rolling={weekly} mark={mark} read={mark} onPoint={() => {}} /></TooltipProvider>);
    const html = plot(null);
    const path = /data-lag-series="rolling" d="([^"]*)"/.exec(html)![1];
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path).not.toContain('L');
    expect(html).toContain('0 days over 1 issue');
    expect(html).not.toContain('<circle');
    expect(html.match(/stroke-width="5.4"/g)).toHaveLength(2);
    expect(plot(0)).toContain('data-mark="dot"');
    expect(plot(0)).toContain('data-mark="halo"');
    expect(plot(0)).not.toContain('data-mark="rule"');
    expect(html).toContain('aria-label="1 week ago, nothing closed"');
    expect(html).toContain('aria-label="2 weeks ago, 0 days over 1 issue"');
    expect(plot(1)).not.toContain('data-mark="dot"');
    expect(lagInterval(weekly, 2)).toBe('this week, 1 day over 1 issue');
  });

  it('keeps period wording out of the visible heading', () => {
    const html = render(metrics({ comparison }));
    expect(html).toContain('>Org lag</span>');
    expect(html).not.toContain('Org lag (90 days)');
    expect(html).toContain('compared with the previous 90 days.');
  });
});

describe('Org lag accessibility and copy guards (#977)', () => {
  const comparison = {
    startAt: '2026-06-10T23:59:59.999Z', endAt: '2026-09-08T23:59:59.999Z', previousStartAt: '2026-03-12T23:59:59.999Z',
    previousN: 2, previousMeanDays: 42, deltaDays: -1, weekly: [],
    rolling: [
      { startAt: '2026-03-12T23:59:59.999Z', endAt: '2026-06-10T23:59:59.999Z', n: 2, meanDays: 42 },
      { startAt: '2026-06-03T23:59:59.999Z', endAt: '2026-09-01T23:59:59.999Z', n: 0, meanDays: null },
      { startAt: '2026-06-10T23:59:59.999Z', endAt: '2026-09-08T23:59:59.999Z', n: 2, meanDays: 41 },
    ],
  };

  it('omits the heading period, and leaves the comparison to the delta '
    + '(#1189)', () => {
    const html = render(metrics({ comparison }));
    expect(html).toContain('>Org lag</span>');
    expect(html).not.toContain('Org lag (90 days)');
    expect(html).not.toContain('Last 90 days');
    expect(html).not.toContain('Last 90 days, compared with');
    // And the comparison is DRAWN nowhere: the one "compared with" on the card
    // is the delta's own sr-only sentence, which no sighted reader meets.
    expect(html.match(/compared with/g)).toHaveLength(1);
    expect(html).toContain('<span class="sr-only">−1 compared with the previous 90 days.</span>');
  });

  it('names what the delta is measured against, for a reader who cannot see the line '
    + 'under the card (#1170 review)', () => {
    const html = render(metrics({ comparison }));
    // The cut caption was the only thing on the card naming the reference
    // period. A screen reader hears the delta and the period as one sentence,
    // while the drawn `−1` is `aria-hidden`, so the number is heard once.
    expect(html).toContain('<span class="sr-only">−1 compared with the previous 90 days.</span>');
    expect(html).toContain('<span aria-hidden="true">−1</span>');
    expect(html.match(/−1/g)).toHaveLength(2);
  });

  it('names the comparison period only in the delta sentence', () => {
    const html = render(metrics({ comparison }));
    expect(html).toContain('aria-label="Weekly mean time to close. Empty intervals are gaps."');
    expect(html).not.toContain('in the current 90 days');
    // Only the comparison sentence names its reference period.
    expect(html.match(/90 days/g)).toHaveLength(1);
    expect(html).not.toContain('Last 90 days');
  });

  it('keeps the figure, the change and the pointable chart, and drops the rest (#1002)', () => {
    const html = render(metrics({ comparison }));
    // What stays: the number, how it moved, and a chart that answers on hover.
    expect(html).toContain('>41</span>');
    expect(html).toContain('>−1</span>');
    expect(html).toContain('data-lag-series="rolling"');
    // What went: the two window sentences, the interval picker, the scale
    // caption and the weekly listing under it.
    for (const gone of [
      'Current:', 'Previous:', '11 Jun 2026 – 8 Sept 2026',
      'Inspect closure interval', 'Previous closure interval', 'Next closure interval',
      'Weekly intervals and sample counts', 'Mean days · weekly', '0–62 days',
    ]) expect(html).not.toContain(gone);
  });

  /**
   * #1171. This svg is `preserveAspectRatio="none"` over a 300x82 viewBox drawn
   * into the narrow third of the pulse row, so a `<circle>` in it is a lozenge:
   * `r 2.7` measured 1.80 x 5.40, 2.60 x 5.40, 3.60 x 5.40 and 5.10 x 5.40 px
   * at 900, 1280, 1440 and 1920 on the built page. `scripts/measure-chart-dots.mjs --check`
   * measures the drawn shape; this is the half a suite with no DOM can hold.
   */
  it('draws every week marker as a round-capped zero-length line in screen pixels, '
    + 'never as a `<circle>` this stretched viewBox would turn into a lozenge', () => {
    const html = render(metrics({ comparison }));
    const svg = html.slice(html.indexOf('<svg'));
    expect(svg).not.toContain('<circle');
    const dots = [...svg.matchAll(/<line [^>]*data-dot="rolling"[^>]*>/g)];
    // One per week that closed anything; the empty interval draws no marker.
    expect(dots).toHaveLength(comparison.rolling.filter((w) => w.meanDays !== null).length);
    for (const m of dots) {
      expect(m[0]).toContain('stroke-linecap="round"');
      expect(m[0]).toContain('vector-effect="non-scaling-stroke"');
      expect(m[0]).toContain('stroke-width="5.4"');
      const at = (name: string) => /"([-\d.]+)"/.exec(m[0].slice(m[0].indexOf(`${name}=`)))?.[1];
      expect(at('x1')).toBe(at('x2'));
      expect(at('y1')).toBe(at('y2'));
    }
  });

  it('names a week the way the Throughput chart does, and never prints a timestamp (#1031)', () => {
    const html = render(metrics({ comparison }));
    expect(html).toContain('aria-label="this week, 41 days over 2 issues"');
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(html).not.toContain('mean lag');
    for (let i = 0; i < comparison.rolling.length; i += 1) {
      expect(lagInterval(comparison.rolling, i)).not.toMatch(/After|through|\d{4}-\d{2}-\d{2}/);
    }
  });

});

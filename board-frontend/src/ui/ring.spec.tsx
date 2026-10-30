import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Ring } from './ring';

// Node env, no DOM — render to markup and read the SVG attributes, same
// rationale as ProjectBlock.spec.tsx.

/** Every painted arc's `stroke-dasharray` head (the run's arc length). */
function runLengths(html: string): number[] {
  return [...html.matchAll(/stroke-dasharray="([\d.]+) /g)].map((m) => Number(m[1]));
}

const CIRC = (size: number, stroke: number) => 2 * Math.PI * ((size - stroke) / 2);

describe('Ring (#174/#454)', () => {
  it('never sets a stroke cap, so the arc keeps SVG default butt caps (#457)', () => {
    const plain = renderToStaticMarkup(<Ring pct={60} />);
    const segmented = renderToStaticMarkup(
      <Ring pct={60} segments={[{ key: 'a', value: 3, color: 'red' }, { key: 'b', value: 1, color: 'blue' }]} />,
    );
    expect(plain).not.toContain('stroke-linecap');
    expect(segmented).not.toContain('stroke-linecap');
  });

  it('labels the clamped value, not the raw prop', () => {
    expect(renderToStaticMarkup(<Ring pct={120} />)).toContain('100%');
    expect(renderToStaticMarkup(<Ring pct={-5} />)).toContain('0%');
  });

  it('paints one brand arc when there is nothing to segment by', () => {
    const html = renderToStaticMarkup(<Ring pct={50} />);
    expect(html).toContain('var(--accent)');
    // Track + one arc.
    expect(runLengths(html)).toHaveLength(1);
  });

  it('falls back to the single arc for an empty or all-zero segment list', () => {
    expect(renderToStaticMarkup(<Ring pct={50} segments={[]} />)).toContain('var(--accent)');
    expect(
      renderToStaticMarkup(<Ring pct={50} segments={[{ key: 'a', value: 0, color: 'red' }]} />),
    ).toContain('var(--accent)');
  });

  it('cuts the closed arc into one run per segment, in the order given', () => {
    const html = renderToStaticMarkup(
      <Ring
        pct={100}
        size={66}
        segments={[
          { key: 'a', value: 3, color: 'red' },
          { key: 'b', value: 1, color: 'blue' },
        ]}
      />,
    );
    const runs = runLengths(html);
    expect(runs).toHaveLength(2);
    // 3:1 split of the full circle, each run short by the 2.5px gap.
    const circ = CIRC(66, 7);
    expect(runs[0]).toBeCloseTo(circ * 0.75 - 2.5, 1);
    expect(runs[1]).toBeCloseTo(circ * 0.25 - 2.5, 1);
    expect(html.indexOf('red')).toBeLessThan(html.indexOf('blue'));
  });

  it('keeps a tiny share visible instead of letting the gap swallow it', () => {
    const html = renderToStaticMarkup(
      <Ring
        pct={100}
        size={34}
        segments={[
          { key: 'a', value: 200, color: 'red' },
          { key: 'b', value: 1, color: 'blue' },
        ]}
      />,
    );
    expect(runLengths(html)[1]).toBe(2);
  });

  it('paints nothing beyond the track when a board has no closes', () => {
    const html = renderToStaticMarkup(<Ring pct={0} segments={[{ key: 'a', value: 4, color: 'red' }]} />);
    expect(runLengths(html)).toEqual([0]);
  });
});

// ─── The withheld ring (#763) ────────────────────────────────────────────────

const svgOf = (html: string): string => /<svg[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
const outsideSvg = (html: string): string => html.replace(/<svg[\s\S]*?<\/svg>/, '');

/** The svg as it PAINTS. A run of zero arc length puts no pixel on the card, so
 *  the 0% ring's zero-length arc comes out before the comparison — otherwise
 *  this compares markup, where the two already differ, rather than the crop the
 *  design review took off the shipped screenshots, where they did not. */
function paintedSvg(html: string): string {
  return svgOf(html).replace(/<circle[^>]*stroke-dasharray="0\.00 [^"]*"[^>]*><\/circle>/g, '');
}

describe('a withheld ring is told apart in words and not on screen (#763, #771)', () => {
  for (const size of [66, 34]) {
    // These two states are one picture on purpose, and this is what holds them
    // there. Three treatments — a dashed track, a rule struck across the ring,
    // and a "?" where the percentage stood — were rendered at both sizes, in
    // both themes, on real cards and rows, and shown to Artur on 2026-08-31.
    // None was taken. Artur accepted that on 2026-09-01: accepted, not fixed,
    // and the ring paints today exactly what it painted at edee2ef. #771 closes
    // with the PR that added this comment, so what stands behind this test is
    // the decision and its date, not the issue's state.
    //
    // So this guards a decision rather than watching a defect. Red here means a
    // withheld ring has started painting differently from a board at 0%, which
    // is a call somebody already made the other way with all three drawings in
    // front of him. It is allowed to change — but changing it without knowing it
    // was decided is the thing this is here to stop. The docblock at the top of
    // `ring.tsx` has the treatments, the dates and the contrast numbers.
    it(`paints exactly what a board genuinely at 0% paints, at ${size}px`, () => {
      const zero = paintedSvg(renderToStaticMarkup(<Ring pct={0} size={size} />));
      const withheld = paintedSvg(renderToStaticMarkup(<Ring pct={40} size={size} withheld />));
      expect(zero).not.toBe('');
      expect(withheld).toBe(zero);
    });
  }

  it('says outside the aria-hidden svg that no share is being stated', () => {
    const html = renderToStaticMarkup(<Ring pct={40} size={34} withheld />);
    // The svg stays out of the accessibility tree, so the words cannot live in it.
    expect(svgOf(html)).toContain('aria-hidden="true"');
    expect(svgOf(html)).not.toContain('sr-only');
    expect(outsideSvg(html)).toContain('<span class="sr-only">Share done not stated</span>');
    expect(outsideSvg(html)).not.toContain('%');
  });

  it('leaves a stated share where a screen reader already got it', () => {
    const html = renderToStaticMarkup(<Ring pct={40} />);
    expect(outsideSvg(html)).toContain('40%');
    expect(html).not.toContain('sr-only');
  });
});

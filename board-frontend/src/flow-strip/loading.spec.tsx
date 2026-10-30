import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../ui/kit';
import { FlowStrip } from './FlowStrip';
import type { StripModel } from './flow-strip.vm';

const missing = { n: null, series: null, endsOn: null };
const model: StripModel = {
  issues: missing, throughput: missing,
  releases: { ...missing, scope: null, partial: false },
  oldest: { kind: 'unread' }, grid: null, window: null, years: [],
};
const render = (pending = { queue: false, metrics: false }, overrides: Partial<StripModel> = {}) =>
  renderToStaticMarkup(<TooltipProvider><FlowStrip model={{ ...model, ...overrides }} pending={pending} /></TooltipProvider>);
const cards = (html: string) => html.slice(html.indexOf('data-spark-card'), html.indexOf('<div class="flex min-w-0 flex-col'));

describe('spark card read states (#1201)', () => {
  it('reserves figure and spark shapes while explicitly pending', () => {
    const html = cards(render({ queue: true, metrics: true }));
    expect(html.match(/aria-busy="true"/g)).toHaveLength(2);
    expect(html).toContain('Loading closed');
    expect(html.match(/motion-reduce:animate-none/g)).toHaveLength(4);
    expect(html.match(/h-\[27px\]/g)).toHaveLength(2);
    expect(html.match(/h-\[34px\]/g)).toHaveLength(2);
    expect(html).not.toContain('Unavailable');
  });

  it('stops pulsing on failure and identifies the failed read in the header', () => {
    const html = cards(render());
    expect(html.match(/>Unavailable</g)).toHaveLength(2);
    expect(html.match(/!animate-none/g)).toHaveLength(4);
    expect(html).toContain('aria-label="Closed issues couldn’t be read just now."');
    expect(html).not.toContain('>Closed issues couldn’t be read just now.<');
    expect(html).not.toContain('aria-busy="true"');
    expect(html).not.toContain('role="img"');
  });

  it('keeps independent read states and genuine zero data', () => {
    const html = cards(render({ queue: false, metrics: true }, {
      issues: { n: 0, series: [0, 0], endsOn: Date.UTC(2026, 8, 20) },
    }));
    expect(html.match(/aria-busy="true"/g)).toHaveLength(1);
    expect(html).toContain('>0<');
    expect(html).toContain('role="img"');
    expect(html).not.toContain('Loading issues');
  });
});

const oldest = (html: string) => html.slice(html.indexOf('The oldest'), html.indexOf('data-flow-grid'));

describe('oldest card read states (#1201)', () => {
  it('uses the queue pending state for age, title and owner placeholders', () => {
    const html = oldest(render({ queue: true, metrics: false }));
    expect(html).toContain('aria-label="Loading the oldest open issue"');
    expect(html).toContain('>Loading<');
    expect(html.match(/motion-reduce:animate-none/g)).toHaveLength(4);
    expect(html).not.toContain('Unavailable');
    expect(html).not.toContain('couldn’t be read');
  });

  it('identifies failure in the caption and stops every placeholder', () => {
    const html = oldest(render({ queue: false, metrics: true }));
    expect(html).toContain('role="status" aria-label="The oldest open issue couldn’t be read just now."');
    expect(html).toContain('>Unavailable<');
    expect(html.match(/!animate-none/g)).toHaveLength(4);
    expect(html).not.toContain('>The oldest open issue couldn’t be read just now.<');
    expect(html).not.toContain('>Loading<');
  });

  it('preserves a genuine empty queue while a refresh is pending', () => {
    const html = oldest(render({ queue: true, metrics: true }, { oldest: { kind: 'none' } }));
    expect(html).toContain('Nothing open.');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('animate-pulse');
  });
});

describe('the row above the grid (#1450)', () => {
  it('stretches the three cards to one height and leaves one 24px slot under them', () => {
    const html = render();
    const row = html.slice(0, html.indexOf('data-flow-grid'));
    expect(row).not.toContain('self-start');
    expect(row).toContain('<div class="grid grid-cols-3 gap-4 max-[720px]:grid-cols-1">');
    expect(row).toMatch(/<div class="min-h-6"><\/div><div class="[^"]*" $/);
  });
});

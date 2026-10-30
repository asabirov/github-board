import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../ui/kit';
import { ListView } from './ListView';
import type { ViewerIssue } from './viewer-issue';
import type { RenderGroup } from './viewer-groups';

// The board's test env is `node` (no DOM), so — same rationale as
// ViewerControls.spec.tsx — render to a static HTML string and assert against
// the markup. That is enough here because the age is computed during render, off
// the `now` the list is handed rather than off the clock: pinning it is what
// stops this file from meaning something different tomorrow.
//
// The rows below are synthetic on purpose. `scripts/fixtures/team-api.json` is
// what the browser reading opens, and the ages it happens to hold move with the
// calendar — so the 60-89 day band, the one step between quiet and red, is
// exercised here and nowhere a fixture can take away.

const NOW = Date.parse('2026-09-02T12:00:00Z');
const DAY = 86_400_000;

function issue(number: number, days: number, extra: Partial<ViewerIssue> = {}): ViewerIssue {
  return {
    repo: 'board',
    number,
    title: `Issue ${number}`,
    htmlUrl: `https://github.com/acme/board/issues/${number}`,
    state: 'open',
    assignees: [],
    labels: [],
    projects: [],
    type: 'chore',
    createdAt: new Date(NOW - days * DAY).toISOString(),
    ...extra,
  };
}

function listMarkup(items: ViewerIssue[], showTriage = false): string {
  const groups: RenderGroup[] = [
    { key: 'open', label: 'Open', tone: 'neutral', rows: items.map((item) => ({ item, depth: 0 })) },
  ];
  // The unassigned placeholder wears a `Tip`, and the kit's tooltip refuses to
  // render outside a provider — App.tsx has the only one in the app.
  return renderToStaticMarkup(
    <TooltipProvider>
      <ListView groups={groups} showTriage={showTriage} now={NOW} mayClose={false} mayAssign={false} />
    </TooltipProvider>,
  );
}

/** The age cell is the row's one outward link (`target="_blank"`), and it is the
 *  only place a class and a number are read together — which is the whole claim. */
function ageCells(html: string): { cls: string; text: string }[] {
  const cells = [...html.matchAll(/<a href="https:\/\/github[^"]*" target="_blank"[^>]*class="([^"]*)"[^>]*>.*?<span>([^<]*)<\/span><\/a>/g)];
  return cells.map((m) => ({ cls: m[1], text: m[2] }));
}

describe('the issues list ranks by age (#822)', () => {
  const CELLS = ageCells(listMarkup([issue(1, 95), issue(2, 70), issue(3, 5)]));

  it('reads three rows, so an empty match cannot pass the assertions below', () => {
    expect(CELLS.map((c) => c.text)).toEqual(['95d', '70d', '5d']);
  });

  it('paints an old, a middling and a young row three different colours', () => {
    const tones = CELLS.map((c) => c.cls.match(/\btext-(danger|warn|muted)\b/)?.[0]);
    expect(new Set(tones).size).toBe(3);
    expect(tones).toEqual(['text-danger', 'text-warn', 'text-muted']);
  });

  // The band between the thresholds is the one the fixture cannot be relied on to
  // hold, so nothing but this says amber is reachable at all.
  it('paints the 60-89 day band amber', () => {
    expect(ageCells(listMarkup([issue(4, 60)]))[0].cls).toContain('text-warn');
    expect(ageCells(listMarkup([issue(5, 89)]))[0].cls).toContain('text-warn');
    expect(ageCells(listMarkup([issue(6, 59)]))[0].cls).not.toContain('text-warn');
    expect(ageCells(listMarkup([issue(7, 90)]))[0].cls).toContain('text-danger');
  });

  // Anchored at both ends, so this is the whole assertion: a phrase, a month
  // name or a second unit all fail it. Two `not.toMatch` lines used to sit under
  // it saying so again, where they could not have gone red if they tried.
  it('says every age the same way, so the column compares down the page', () => {
    for (const { text } of CELLS) {
      expect(text).toMatch(/^\d+d$/);
    }
  });

  // A closed issue is finished work, so it rests whatever its age: an issue
  // opened 200 days ago and closed yesterday drew the row's only colour, in
  // danger red, which put the most urgent-looking thing on the page in the
  // Closed group. The open row beside it is what keeps this honest — the tone
  // still fires, it just no longer fires on a row nobody has to act on.
  it('rests a closed row at the resting colour whatever its age', () => {
    const closed = ageCells(listMarkup([issue(12, 200, { state: 'closed' })]))[0];
    const open = ageCells(listMarkup([issue(13, 200)]))[0];
    expect([closed.text, open.text]).toEqual(['200d', '200d']);
    expect(closed.cls).toContain('text-muted');
    expect(closed.cls).not.toMatch(/text-text-(danger|warning)/);
    expect(open.cls).toContain('text-danger');
  });

  it('names the column Age, not the moment the cell links to', () => {
    const html = listMarkup([issue(8, 5)]);
    expect(html).toContain('>Age<');
    expect(html).not.toContain('Last activity');
  });

  // Blocked is a word; aging draws nothing at all. The second assertion is a
  // whole-markup equality rather than a search for the glyph the preview drew:
  // that string has never been emitted here, on either side of this change, so
  // asking for its absence could not have failed. Comparing an aging row against
  // the same row without the flag can, whatever shape a marker came back as.
  it('gives blocked a word and aging none', () => {
    expect(listMarkup([issue(9, 5, { blocked: true, aging: true })])).toContain('>blocked<');
    expect(listMarkup([issue(10, 5, { aging: true })])).toBe(listMarkup([issue(10, 5)]));
    expect(listMarkup([issue(11, 5, { blocked: false, aging: true })])).not.toContain('>blocked<');
  });
});

describe('list label chips with triage (#1330)', () => {
  const items = [issue(20, 5, { labels: ['triage:P1', 'triage:S', 'blocker', 'bug', 'frontend', 'fourth']
    .map(name => ({ name, color: '' })) })];

  it('reserves all three chip slots for ordinary labels when badges show triage', () => {
    const html = listMarkup(items, true);
    expect(html).toContain('data-triage="priority"');
    expect(html).toContain('data-triage="size"');
    expect(html).not.toContain('>triage:P1<');
    expect(html).not.toContain('>triage:S<');
    for (const label of ['blocker', 'bug', 'frontend']) expect(html).toContain(`>${label}<`);
    expect(html).not.toContain('>fourth<');
  });

  it('retains triage labels as chips when badges are not shown', () => {
    const html = listMarkup(items);
    for (const label of ['triage:P1', 'triage:S', 'blocker']) expect(html).toContain(`>${label}<`);
    expect(html).not.toContain('>bug<');
  });
});

/**
 * The objective half of #948, #964, #973 and #1024, read off the handle's class
 * table, the glyph's markup and the markup `ActionMenu` and a board card emit.
 * Nothing here renders a hover, opens a menu, presses a key or measures a pixel,
 * because the suite has no DOM. The shots delivered on #948, #964, #973 and
 * #1024 are the evidence for those.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from './kit';
import { describe, expect, it } from 'vitest';
import { DotsGlyph } from '../icons';
import { BoardView } from '../issues-viewer/BoardView';
import type { ViewerIssue } from '../issues-viewer/viewer-issue';
import { HANDLE, HANDLE_MENU, type HandleAppearance } from './action-handle';
import { ActionMenu } from './ActionMenu';
import actionMenuSource from './ActionMenu.tsx?raw';
import { CARD_PADDING } from './block';

const APPEARANCES: HandleAppearance[] = ['quiet', 'solid', 'standalone'];
const classes = (s: string) => s.split(/\s+/);

// Tailwind's spacing unit is 4px: `size-8` is 32.
const px = (cls: string) => {
  const m = cls.match(/(?:^|\s)size-(\d+)(?:\s|$)/);
  return m ? Number(m[1]) * 4 : null;
};

/** The class list of the handle labelled `label`, and of every element around
 *  it, innermost first. React escapes `>` inside an attribute and closes an
 *  empty element in its own tag (`<circle/>`), so a tag walk is enough. */
const handleIn = (html: string, label: string) => {
  const around: string[][] = [];
  for (const [, close, tag, attrs, empty] of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*?)(\/?)>/g)) {
    const own = classes(attrs.match(/class="([^"]*)"/)?.[1] ?? '');
    if (tag === 'button' && attrs.includes(`aria-label="${label}"`)) return { button: own, around: [...around].reverse() };
    if (empty) continue;
    if (close) around.pop();
    else around.push(own);
  }
  throw new Error(`no handle labelled "${label}"`);
};

const COARSE = '[@media(pointer:coarse)]:';
const coarsePx = (list: string[], utility: 'size' | 'pr') => {
  const token = list.find((t) => t.startsWith(`${COARSE}${utility}-`));
  const m = token?.slice(COARSE.length + utility.length + 1).match(/^(\d+)$|^\[(\d+)px\]$/);
  return m ? (m[1] ? Number(m[1]) * 4 : Number(m[2])) : null;
};

describe('DotsGlyph', () => {
  it.each([[2, 5], [3, 6]])('puts every edge of a %ipx dot on a whole pixel', (dot, pitch) => {
    const html = renderToStaticMarkup(<DotsGlyph dot={dot} pitch={pitch} />);
    expect(html).toContain('viewBox="0 0 16 16"');
    const circles = [...html.matchAll(/cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
    expect(circles).toHaveLength(3);
    for (const [cx, cy, r] of circles) {
      expect(2 * r).toBe(dot);
      for (const edge of [cx - r, cx + r, cy - r, cy + r]) expect(Number.isInteger(edge)).toBe(true);
      expect(cx - r).toBeGreaterThanOrEqual(0);
      expect(cx + r).toBeLessThanOrEqual(16);
    }
  });
});

describe('the handle', () => {
  it.each(APPEARANCES)('keeps the %s footprint the callers reserve', (appearance) => {
    expect(px(HANDLE[appearance].button)).toBe(appearance === 'quiet' ? 24 : 44);
  });

  it.each(APPEARANCES)('centres the %s glyph on whole pixels', (appearance) => {
    const chip = px(HANDLE[appearance].chip)!;
    const footprint = px(HANDLE[appearance].button)!;
    // Even chip in an even footprint, 16px glyph in the chip: every offset flex
    // centring produces is a whole number.
    for (const n of [chip, footprint]) expect(n % 2).toBe(0);
    expect(chip).toBeGreaterThanOrEqual(16);
    expect(chip).toBeLessThanOrEqual(footprint);
  });

  it.each(APPEARANCES)('gives the %s chip an edge, not only a fill', (appearance) => {
    const chip = classes(HANDLE[appearance].chip);
    expect(chip).toContain('border-line-strong');
    expect(chip).not.toContain('bg-elevated');
  });
});

describe('where the handle shows (#1024, #964)', () => {
  it.each(['quiet', 'solid'] as const)('hides the %s handle at rest, and shows it for the row, the keyboard, an open menu and touch', (appearance) => {
    const button = classes(HANDLE[appearance].button);
    expect(button).toContain('opacity-0');
    for (const on of [
      'group-hover:opacity-100',
      'focus-visible:opacity-100',
      'group-has-[:focus-visible]:opacity-100',
      'data-[state=open]:opacity-100',
      '[@media(hover:none)]:opacity-100',
      '[@media(pointer:coarse)]:opacity-100',
    ]) expect(button).toContain(on);
  });

  it('sits inside a `group`, the row its `group-hover` and `group-has` read', () => {
    // Without one, those two variants match nothing and a mouse over the row
    // never shows the handle. Its own `group/handle` is a named group and does
    // not count.
    const html = renderToStaticMarkup(
      <ActionMenu items={[{ key: 'open', label: 'Open', run: () => {} }]}><span>row</span></ActionMenu>,
    );
    expect(handleIn(html, 'Actions').around.some((c) => c.includes('group'))).toBe(true);
  });

  it('keeps the standalone handle at rest, with no row to reveal it', () => {
    expect(HANDLE.standalone.button).not.toMatch(/opacity/);
  });

  it('draws the Feedback chip smaller than the 44px square it replaces', () => {
    expect(px(HANDLE.solid.chip)).toBeLessThan(44);
  });
});

describe('the board card on a coarse pointer', () => {
  const issue: ViewerIssue = {
    repo: 'board', number: 948, title: 'Blurry handle', htmlUrl: 'https://github.com/acme/board.example.com/issues/948',
    state: 'open', assignees: [], projects: [], type: 'bug', createdAt: '2026-09-11T00:00:00Z', labels: [],
  };
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <BoardView groups={[{ key: 'open', label: 'Open', tone: 'neutral', rows: [{ item: issue, depth: 0 }] }]} dim="openclosed" mayClose={false} mayAssign={false} />
    </TooltipProvider>,
  );
  const { button } = handleIn(html, 'Issue actions');

  it('grows the 24px target to 44px, and leaves the chip at 24', () => {
    expect(px(button.join(' '))).toBe(24);
    expect(coarsePx(button, 'size')).toBe(44);
    expect(px(HANDLE.quiet.chip)).toBe(24);
  });

  it('keeps the title out from under the grown target', () => {
    // The target's inner edge is `right-*` plus its size in from the card's
    // edge; the title's text stops at the card's padding plus its reserve,
    // which on a coarse pointer is the coarse one if it has one.
    const right = Number(button.find((t) => /^right-\d+$/.test(t))!.slice('right-'.length)) * 4;
    const title = classes(html.match(new RegExp(`class="([^"]*)">${issue.title}<`))![1]);
    const reserve = coarsePx(title, 'pr') ?? Number(title.find((t) => /^pr-\d+$/.test(t))!.slice('pr-'.length)) * 4;
    const padding = Number(CARD_PADDING.slice('p-'.length)) * 4;
    expect(padding + reserve).toBeGreaterThanOrEqual(right + coarsePx(button, 'size')!);
  });
});

describe('the menu', () => {
  it('takes the kit zoom off', () => {
    // Important, or the kit's `animate-in zoom-in-95` wins the cascade.
    expect(classes(HANDLE_MENU)).toEqual(expect.arrayContaining([
      'data-[state=open]:[--tw-enter-scale:1]!',
      'data-[state=closed]:[--tw-exit-scale:1]!',
    ]));
  });

  it('is the same class list on the dropdown and the right-click menu', () => {
    expect(actionMenuSource.match(/MenuContent[^>]*className=\{HANDLE_MENU\}/g)).toHaveLength(2);
    expect(actionMenuSource).not.toMatch(/MenuContent[^>]*className=\{(?!HANDLE_MENU\})/);
  });
});

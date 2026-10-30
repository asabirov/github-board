import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardHeader, HeaderSkeleton, shouldRefetch, type RefreshMark } from './ProjectsView';
// The page's own text, for the two claims that are about wiring no static
// render reaches — the same reason `TeamView.spec.ts` and `ReposMap.spec.tsx`
// read their subjects as text.
import source from './ProjectsView.tsx?raw';

// The board's test env is `node` (no DOM), so — same rationale as
// ProjectBlock.spec.tsx — render to a static HTML string and assert against the
// markup rather than pull in jsdom + RTL.
//
// #785 deleted the rollup and every test that stood over it: the card's three
// cells, the fortnight spark, the movement notes, the delta, the card's grid at
// three widths, and a card's address. This file is the BOARD PAGE's header now,
// which is what survived, and every block below was already about it before the
// rollup went. `pulse.spec.ts` still holds the sentences, and Your work's own
// specs still hold the rings that replaced the cards.

const HEADER = {
  name: 'Board hardening',
  number: 7,
  url: 'https://github.com/orgs/acme/projects/7',
  pct: 72,
};

/** The `<h1>…</h1>` slice of a rendered header, so "in the title" is testable. */
function h1Of(html: string): string {
  return /<h1\b[^>]*>[\s\S]*?<\/h1>/.exec(html)?.[0] ?? '';
}

/** The words a reader actually sees — attributes and class names stripped out,
 *  so asserting that a header says no "open" isn't defeated by `noopener`. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    // The renderer escapes what it puts in a text node, so an apostrophe arrives
    // as `&#x27;` — a reader sees the character, not the entity.
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every `<circle>` in the markup. The `Ring` paints one for its track and one
 *  per arc run, so a ring that declines to state a share draws exactly one. */
function circles(html: string): number {
  return (html.match(/<circle\b/g) ?? []).length;
}


describe('board header (#510)', () => {
  it("names the board's id beside the title, as the link out to Github", () => {
    const h1 = h1Of(renderToStaticMarkup(<BoardHeader {...HEADER} />));
    expect(h1).toContain('Board hardening');
    expect(h1).toContain('#7');
    expect(h1).toContain(`href="${HEADER.url}"`);
    // Same treatment the issue page's H1 number carries: muted at rest, and no
    // ↗ glyph anywhere on the board.
    expect(h1).toContain('text-muted');
    expect(h1).not.toContain('↗');
  });

  it('opens Github in a new tab, safely', () => {
    const h1 = h1Of(renderToStaticMarkup(<BoardHeader {...HEADER} />));
    expect(h1).toContain('target="_blank"');
    expect(h1).toContain('rel="noopener noreferrer"');
  });

  it('drops the status chip, the open/closed counts and the trailing "Open board" link', () => {
    const text = textOf(renderToStaticMarkup(<BoardHeader {...HEADER} />));
    expect(text).not.toContain('Open board');
    expect(text).not.toContain('Active'); // every board's status chip read this
    expect(text).not.toMatch(/\bopen\b/i);
    expect(text).not.toMatch(/\bclosed\b/i);
    // What is left: the completion, the name, and the id — and nothing else.
    // Ring-first or ring-last is the variant's call, so take the dial out and
    // assert on the remainder rather than on one order.
    expect(text.replace('72%', '').trim()).toBe('Board hardening #7');
  });

  it('keeps the completion ring, reading the board\u2019s own pct', () => {
    const html = renderToStaticMarkup(<BoardHeader {...HEADER} />);
    expect(html).toContain('72%');
  });

  it('carries exactly one link — the id — so the header has one way out', () => {
    const html = renderToStaticMarkup(<BoardHeader {...HEADER} />);
    expect(html.match(/<a\b/g) ?? []).toHaveLength(1);
  });
});

describe('board header skeleton (#510)', () => {
  it('mirrors the header it stands in for: the ring and the title, nothing trailing', () => {
    const html = renderToStaticMarkup(<HeaderSkeleton />);
    // Two shimmering placeholders — the ring and the heading. The chip and meta
    // placeholders went with the meta row they stood in for. Each keeps the
    // kit's pulse and holds it still under reduced motion (#1033).
    expect(html.match(/animate-pulse/g) ?? []).toHaveLength(2);
    expect(html.match(/motion-reduce:animate-none/g) ?? []).toHaveLength(2);
    expect(html).not.toContain('!animate-none');
  });
});

describe('a board detail header withholds on the same gate as its card (#722)', () => {
  // `BoardHeader`'s `pct` is documented as the same field every other ring on
  // the board reads, "so one board can't report two numbers". The rollup card
  // was the second reader until #785; Your work's Contributions rings are the
  // second reader now, and the rule is unchanged — a surface that declines while
  // this header goes on asserting is that comment stopped being true.
  const header = { ...HEADER, pct: 44 };

  it('draws the empty track when the board this page is for was read short', () => {
    const html = renderToStaticMarkup(<BoardHeader {...header} itemsComplete={false} />);
    expect(circles(html)).toBe(1);
    expect(textOf(html)).not.toMatch(/\d+%/);
    // The name and the id are the header's other job and are untouched.
    expect(textOf(html)).toContain('Board hardening');
    expect(textOf(html)).toContain('#7');
  });

  it('states it on a board read whole, and on one that makes no claim', () => {
    for (const flag of [true, undefined]) {
      const html = renderToStaticMarkup(<BoardHeader {...header} itemsComplete={flag} />);
      expect(circles(html)).toBe(2);
      expect(textOf(html)).toContain('44%');
    }
  });
});

/**
 * The refresh effect's guard (#824 review).
 *
 * `shouldRefetch` is pure so it can be driven here at all: no effect fires in
 * this suite and nothing re-renders, so the decision has to
 * live somewhere a test can reach. Each case below is a run the effect really
 * makes, in the order React makes them.
 */
describe('when a board page refetches, and when it must not', () => {
  const mark = (board: string, refresh: number): RefreshMark => ({ board, refresh });

  it('does not fetch on the first run, because the identity effect just did', () => {
    expect(shouldRefetch(null, mark('acme/7', 0))).toBe(false);
  });

  it('does not fetch on StrictMode’s second mount pass', () => {
    // The one a `useRef(true)` boolean got wrong: the first pass spent the flag
    // and the second fetched. `main.tsx` wraps the app in `StrictMode`, so this
    // is every mount in development, and `ReposPage` rejected the same shape in
    // this branch after it was seen in a browser.
    expect(shouldRefetch(mark('acme/7', 0), mark('acme/7', 0))).toBe(false);
  });

  it('does not fetch when the BOARD changed — that is the identity effect’s read', () => {
    expect(shouldRefetch(mark('acme/7', 3), mark('acme/8', 3))).toBe(false);
  });

  it('fetches when the nonce moves under the same board, which is a Sync now', () => {
    expect(shouldRefetch(mark('acme/7', 3), mark('acme/7', 4))).toBe(true);
  });

  it('tells two orgs’ board 7 apart, the way the cache key does (#697)', () => {
    expect(shouldRefetch(mark('acme/7', 3), mark('globex/7', 3))).toBe(false);
  });

  it('keys the refresh effect on the board as well as the nonce', () => {
    // Keyed on `[refresh]` alone the effect ran no cleanup when the board
    // changed, so a slow answer for board 7 landed on board 8 through
    // `setDetail` and `setErr(null)`. The identity effect's own `alive` flag
    // cannot cover that: it is a different effect with a different closure.
    // TEXT ONLY, for this file's own reason — no effect fires here.
    expect(source).toContain('}, [refresh, number, org]);');
    // And the guard in front of it is the mark, asked through the pure function
    // above. Pinned positively: the file's prose says `useRef(true)` while
    // explaining why it is gone, so a `not.toContain` on those words fails on
    // the comment rather than on the code.
    expect(source).toContain('const ran = useRef<RefreshMark | null>(null);');
    expect(source).toContain('const fetching = shouldRefetch(ran.current, mark);');
  });

  it('uses the shared refusal rule to clear a refused board and its copy', () => {
    // The rollup surfaces made `servableFailure` the one rule in #1060. The
    // board page must ask the same question on every read, rather than
    // narrowing it back to particular status codes: the 404 this used to ask on
    // the first read, and the 403-or-404 on the second, both let a Github
    // FORBIDDEN through, and that arrives as a 500.
    //
    // All three reads use the same failure handler. The access epoch is
    // driven in check-access-epoch.mjs, including refusal followed by cooldown.
    //
    // TEXT ONLY, for this file's own reason — no effect fires here, so neither
    // read can be driven. `check-board-refusal.mjs` and `check-board-copy.mjs`
    // are what drive them, in a browser, against every answer board-api can
    // give this route.
    expect(source).toContain("servableBoardFailure,");
    expect(source.match(/if \(servableBoardFailure\(e\)\)/g) ?? []).toHaveLength(1);
    expect(source.match(/forgetPayload\(projectKey\(number, org\)\)/g) ?? []).toHaveLength(1);
    expect(source.match(/failed\(e\);/g) ?? []).toHaveLength(3);
    // And the narrow rule is gone rather than merely bypassed: `scopeStatus` was
    // the whole of the old question and this file no longer asks it.
    expect(source).not.toContain('scopeStatus');
  });

  it('clears the marks with every read that leaves no board to wear them (#1107, #1249)', () => {
    // The mark is about a board on THIS screen. A new board, a landed answer, a
    // refusal and an expired access check each end the board it was about, so a
    // mark left behind would be worn by something else.
    //
    // It is ONE helper now rather than four `setStaleNote(null)` calls, which
    // is the same rule with one place to read it: `starting` clears the lot,
    // `landed` calls `starting` and then saves, and the refusal arm of `failed`
    // clears them on its way to `setErr`. TEXT ONLY again.
    expect(source.match(/starting\(\);/g) ?? []).toHaveLength(3);
    const starting = source.slice(source.indexOf('const starting = ()'), source.indexOf('/** A read LANDED'));
    for (const cleared of ['setErr(null)', 'setNotNow(false)', 'setSavedCopy(null)', 'setSavedRollup(null)']) {
      expect(starting, `starting() must clear ${cleared}`).toContain(cleared);
    }
    const landed = source.slice(source.indexOf('const landed = (d: ProjectDetail)'));
    expect(landed.slice(0, landed.indexOf('};'))).toContain('starting();');
  });

  it('saves every board a read lands, and only what a read landed (#1249)', () => {
    // The saved copy is written from the answer, on all three reads, and from
    // nowhere else — a copy written anywhere but a landed read is a copy of
    // something nobody was served.
    expect(source.match(/saveBoard\(/g) ?? []).toHaveLength(1);
    const landed = source.slice(source.indexOf('const landed = (d: ProjectDetail)'));
    expect(landed.slice(0, landed.indexOf('};'))).toContain('saveBoard(number, org ?? null, d)');
    expect(source.match(/landed\(d\);/g) ?? []).toHaveLength(3);
  });
});

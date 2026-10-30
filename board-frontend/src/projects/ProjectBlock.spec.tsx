import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectSummary } from '../api/projects';
import { ProjectStrip } from '../dashboard/ProjectContributions';
import { BLOCK, CARD_PADDING } from '../ui/block';
import {
  blockRowOf,
  formatWeeklyClosed,
  weeklyClosedLine,
  type ProjectBlockRow,
} from './ProjectBlock';
// The read-short sub-line taken from the function that produces it, never
// re-typed — the same rule `ProjectsView.spec.tsx` states for the card's
// sentence. A re-typed copy in a `not.toContain` passes vacuously the moment the
// wording changes, which is how these four literals survived #763's first
// rewrite. `pulse.spec.ts` holds the one literal that pins the words.
import { staleCopyCountNote, truncatedCountNote, withheldCountNote } from './pulse';

// The board's test env is `node` (no DOM), so — same rationale as
// PropertiesPanel.spec.tsx — render to a static HTML string and assert against
// the markup rather than pull in jsdom + RTL.

function row(o: Partial<ProjectBlockRow>): ProjectBlockRow {
  return { number: 7, name: 'Board hardening', pct: 72, closedThisWeek: 2, open: 3, ...o };
}

describe('formatWeeklyClosed (#419, #851)', () => {
  it('states both directions over the week', () => {
    expect(formatWeeklyClosed(21, 3)).toBe('This week: 21 closed, 3 opened');
    expect(formatWeeklyClosed(1, 0)).toBe('This week: 1 closed, 0 opened');
  });

  /**
   * The reading the old copy could not produce (#851). "21 closed this week" is
   * the same line whether the board took three new issues or thirty, so a
   * reader could not tell a board that is converging from one that is not.
   */
  it('distinguishes a board that is converging from one that is not', () => {
    expect(formatWeeklyClosed(21, 3)).not.toBe(formatWeeklyClosed(21, 30));
  });

  it('phrases nothing-at-all as a sentence, not a pair of zeros', () => {
    // #419's rule, kept where it still applies. Inside the labelled frame a 0 is
    // a fact — "This week: 0 closed, 3 opened" is a sentence about a week — but
    // both at zero has no frame to sit in and would read as an alarm.
    expect(formatWeeklyClosed(0, 0)).toBe('Nothing opened or closed this week');
  });

  it('floors a negative count rather than printing one', () => {
    // Defensive: no count reaching here can be negative, and "-1 closed" on a
    // card would be the row inventing a fact.
    expect(formatWeeklyClosed(-1, -1)).toBe('Nothing opened or closed this week');
    expect(formatWeeklyClosed(-1, 3)).toBe('This week: 0 closed, 3 opened');
  });
});

describe('ProjectStrip (#419, #946)', () => {
  it('renders each project row: name, completion ring (%), and the weekly-closed subline', () => {
    const rows = [
      row({ number: 7, name: 'Board hardening', pct: 72, closedThisWeek: 2 }),
      row({ number: 8, name: 'Compliance rails', pct: 40, closedThisWeek: 0 }),
    ];
    const html = renderToStaticMarkup(<ProjectStrip rows={rows} />);
    expect(html).toContain('Board hardening');
    expect(html).toContain('Compliance rails');
    // The Ring paints the % as its inner label.
    expect(html).toContain('72%');
    expect(html).toContain('40%');
    // The quiet weekly-closed subline, one phrasing per row.
    expect(html).toContain('This week: 2 closed, 0 opened');
    expect(html).toContain('Nothing opened or closed this week');
  });

  it('uses the compact surface without an empty refresh-notice line', () => {
    const html = renderToStaticMarkup(<ProjectStrip rows={[row({})]} />);
    // The block and its padding as one string, so `p-4` cannot be found inside
    // some other class (`gap-4`) and pass over a strip that lost it (#944).
    expect(html).toContain(`class="${BLOCK} ${CARD_PADDING} `);
    expect(html).not.toContain('role="status"');
  });

  it('pulls the ring row left by exactly an item’s own inset, so a ring starts on the card’s 16px line (#944)', () => {
    const lists = [...renderToStaticMarkup(<ProjectStrip rows={[row({})]} />).matchAll(/class="([^"]*)"/g)]
      .map((m) => m[1].split(/\s+/));
    const ringRow = lists.find((c) => c.includes('flex-wrap'))!;
    const item = lists.find((c) => c.includes('cursor-pointer'))!;
    const bleed = ringRow.filter((c) => /^-m[lx]-/.test(c));
    expect(bleed).toHaveLength(1);
    expect(item.filter((c) => /^px-/.test(c))).toEqual([bleed[0].replace(/^-m[lx]-/, 'px-')]);
  });

  it('each row deep-links to its board', () => {
    const html = renderToStaticMarkup(<ProjectStrip rows={[row({ number: 42 })]} />);
    expect(html).toContain('href="/projects/42"');
  });


});

describe('two orgs’ board 3 are two rows (#697)', () => {
  it('deep-links each row to its own org’s board', () => {
    const html = renderToStaticMarkup(
      <ProjectStrip

        rows={[
          row({ org: 'acme', number: 3, name: 'Platform' }),
          row({ org: 'globex', number: 3, name: 'Delivery' }),
        ]}
      />,
    );
    expect(html).toContain('href="/acme/projects/3"');
    expect(html).toContain('href="/globex/projects/3"');
  });

  it('leaves a row whose board named no org on the address it has always had', () => {
    const html = renderToStaticMarkup(<ProjectStrip rows={[row({ number: 42 })]} />);
    expect(html).toContain('href="/projects/42"');
  });
});

// #715 — a board whose item read came up short has no week figure to show, and
// the service withholds it rather than serving a partial one. Coalesced to 0 the
// row states a week it never read — "No closes this week" then, "Nothing opened
// or closed this week" since #851 — which is a claim about the board rather than
// about the read. Three states, because only the middle one is the bug: the
// short read, the whole read, and the board-api that predates the flag.
describe('a board read short says so instead of counting (#715)', () => {
  const sub = (p: Partial<ProjectBlockRow>) =>
    renderToStaticMarkup(<ProjectStrip rows={[row(p)]} />);

  it('shows the sentence and no count when the read came up short', () => {
    const html = sub({ itemsComplete: false, closedThisWeek: undefined });
    expect(html).toContain(truncatedCountNote(false));
    expect(html).not.toContain('This week:');
    expect(html).not.toContain('Nothing opened or closed this week');
  });

  it('shows its count as before on a board read whole', () => {
    const html = sub({ itemsComplete: true, closedThisWeek: 2 });
    expect(html).toContain('This week: 2 closed, 0 opened');
    expect(html).not.toContain(truncatedCountNote(false));
  });

  it('shows what it always showed to a board-api that predates the flag', () => {
    // `itemsComplete` and `closedThisWeek` are both optional on the wire, and an
    // API that sends neither makes no claim about its read — the row goes on
    // saying the quiet phrase it has said since #419.
    const old = sub({ itemsComplete: undefined, closedThisWeek: undefined });
    expect(old).toContain('Nothing opened or closed this week');
    expect(old).not.toContain(truncatedCountNote(false));
    expect(sub({ itemsComplete: undefined, closedThisWeek: 5 })).toContain('This week: 5 closed, 0 opened');
  });
});

// #715 — three surfaces mapped a rollup board to a row by hand, and the third
// copy (`single-org.spec.tsx`) still coalesced the week count to 0 after the two
// app ones stopped. One mapper, so the field list and the carry-don't-coalesce
// rule cannot be half-applied again.
describe('blockRowOf (#715)', () => {
  const summary = (o: Partial<ProjectSummary> = {}): ProjectSummary => ({
    org: 'acme',
    number: 7,
    name: 'Board hardening',
    url: 'https://github.com/orgs/acme/projects/7',
    status: 'active',
    open: 3,
    closed: 5,
    pct: 62,
    lastClosed: null,
    closedThisWeek: 2,
    itemsComplete: true,
    ...o,
  });

  it('carries the week figure and the flag rather than coalescing either', () => {
    const short = blockRowOf(summary(), summary({ itemsComplete: false, closedThisWeek: undefined }));
    expect(short.closedThisWeek).toBeUndefined();
    expect(short.itemsComplete).toBe(false);
    expect(weeklyClosedLine(short)).toBe(truncatedCountNote(false));
  });

  it('takes the address from the first argument and the numbers from the rollup', () => {
    // Your work's strip maps from a CONTRIBUTION: the name it shows is the one
    // the contribution carries, and everything else joins in from the rollup.
    const row = blockRowOf({ org: 'other-org', number: 9, name: 'Onboarding' }, summary({ pct: 62, open: 3 }));
    expect(row).toMatchObject({ org: 'other-org', number: 9, name: 'Onboarding', pct: 62, open: 3 });
  });

  it('degrades a board the rollup never matched to a quiet ring, with no claim about the read', () => {
    const row = blockRowOf({ number: 9, name: 'Onboarding' }, undefined);
    expect(row.pct).toBe(0);
    expect(row.open).toBe(0);
    expect(row.itemsComplete).toBeUndefined();
    expect(row.closedThisWeek).toBeUndefined();
    expect(weeklyClosedLine(row)).toBe('Nothing opened or closed this week');
  });

  it('carries the ring’s two attributions through', () => {
    const contributors = [{ login: 'ann', closed: 4, kind: 'person' as const }];
    const row = blockRowOf(summary(), summary({ contributors, contributorsByAssignee: [] }));
    expect(row.contributors).toBe(contributors);
    expect(row.contributorsByAssignee).toEqual([]);
  });
});

/**
 * #722 — the shared row, at the two sizes it is drawn. The card on the Projects
 * page says the long form of this; a row has one tertiary sub-line, so it says
 * the short one. The ring is the part that changes on BOTH: the row's 30px dial
 * reads the same `pct` the card's 66px dial does, and a row still asserting
 * while the card declines is one board reporting two numbers.
 */
function circles(html: string): number {
  return (html.match(/<circle\b/g) ?? []).length;
}

describe('a row for a board read short stops asserting a share (#722)', () => {
  const block = (p: Partial<ProjectBlockRow>) =>
    renderToStaticMarkup(<ProjectStrip rows={[row(p)]} />);

  it('draws the empty track — no arc, and no percentage in the middle', () => {
    const html = block({ itemsComplete: false, closedThisWeek: undefined });
    expect(circles(html)).toBe(1);
    expect(html).not.toContain('72%');
  });

  it('says the card’s sentence under the name, minus its full stop', () => {
    const html = block({ itemsComplete: false, closedThisWeek: undefined });
    expect(html).toContain(truncatedCountNote(false));
  });

  it('states the ring on a board read whole, and on one making no claim', () => {
    for (const flag of [true, undefined]) {
      const html = block({ itemsComplete: flag });
      expect(circles(html)).toBe(2);
      expect(html).toContain('72%');
    }
  });
});

/**
 * The third state (#722), and it is not the one above. `pulseJoined === false`
 * says the ORG-WIDE issues-to-memberships join did not run — the week figure
 * behind this sub-line is the only thing it costs. The board's own item read was
 * whole, so its ring and its percentage are sound and neither moves.
 */
describe('a row whose org-wide join did not run says so, and keeps its ring (#722)', () => {
  const block = (p: Partial<ProjectBlockRow>) =>
    renderToStaticMarkup(<ProjectStrip rows={[row(p)]} />);

  it('says the week was not read, not that the week was quiet', () => {
    const html = block({ pulseJoined: false, closedThisWeek: undefined });
    expect(html).toContain("This week’s closes were not read");
    expect(html).not.toContain('Nothing opened or closed this week');
    expect(html).not.toContain('This week:');
    expect(html).not.toContain(truncatedCountNote(false));
  });

  it('leaves the ring alone — the join says nothing about completion', () => {
    const html = block({ pulseJoined: false, closedThisWeek: undefined });
    expect(circles(html)).toBe(2);
    expect(html).toContain('72%');
  });

  it('says the read-short sentence and not this one when a row is both', () => {
    // The item list is the larger claim, and two sentences do not fit one line.
    const html = block({ itemsComplete: false, pulseJoined: false, closedThisWeek: undefined });
    expect(html).toContain(truncatedCountNote(false));
    expect(html).not.toContain('closes were not read');
  });

  it('counts as it always did when the join ran, or when nothing was said', () => {
    for (const flag of [true, undefined]) {
      expect(block({ pulseJoined: flag, closedThisWeek: 2 })).toContain('This week: 2 closed, 0 opened');
    }
  });
});

/** The control (#722): a row read whole and joined is the row it always was. */
describe('a row read whole and joined draws exactly what it drew (#722)', () => {
  const block = (p: Partial<ProjectBlockRow>) =>
    renderToStaticMarkup(<ProjectStrip rows={[row(p)]} />);

  it('is the same markup under a true flag, a true join and no claim at all', () => {
    const base = block({});
    expect(block({ itemsComplete: true })).toBe(base);
    expect(block({ pulseJoined: true })).toBe(base);
    expect(block({ itemsComplete: true, pulseJoined: true })).toBe(base);
  });

  it('asserts its ring and counts its week', () => {
    const html = block({ itemsComplete: true, pulseJoined: true, closedThisWeek: 2 });
    expect(circles(html)).toBe(2);
    expect(html).toContain('72%');
    expect(html).toContain('This week: 2 closed, 0 opened');
  });
});

/** #722 — `blockRowOf` is the one mapper both surfaces use, so the new flag has
 *  to travel on it or the row cannot tell the third state from a quiet week. */
describe('blockRowOf carries the join flag too (#722)', () => {
  const summary = (o: Partial<ProjectSummary> = {}): ProjectSummary => ({
    org: 'acme',
    number: 7,
    name: 'Board hardening',
    url: 'https://github.com/orgs/acme/projects/7',
    status: 'active',
    open: 3,
    closed: 5,
    pct: 62,
    lastClosed: null,
    closedThisWeek: 2,
    itemsComplete: true,
    ...o,
  });

  it('carries a false join rather than coalescing it away', () => {
    const unjoined = blockRowOf(summary(), summary({ pulseJoined: false, closedThisWeek: undefined }));
    expect(unjoined.pulseJoined).toBe(false);
    expect(weeklyClosedLine(unjoined)).toBe("This week’s closes were not read");
  });

  it('makes no claim for a board the rollup never matched', () => {
    expect(blockRowOf({ number: 9, name: 'Onboarding' }, undefined).pulseJoined).toBeUndefined();
  });

  it('keeps the two gates apart — neither is derived from the other', () => {
    const short = blockRowOf(summary(), summary({ itemsComplete: false, closedThisWeek: undefined }));
    expect(short.pulseJoined).toBeUndefined();
    const unjoined = blockRowOf(summary(), summary({ pulseJoined: false, closedThisWeek: undefined }));
    expect(unjoined.itemsComplete).toBe(true);
  });
});

/**
 * The FOURTH state (#770), and it is the one `pulseJoined` was wrongly saying.
 *
 * A write drops the rollup cache, the read that should replace it fails, and
 * #713's retiree serves the copy that drop retired. That copy is served with
 * `pulseJoined: false` — so before #770 this row said "This week's closes were
 * not read", which is FALSE on a retiree: the closes were read, by the copy
 * being served. What is actually out of date is the board's own counts, ring and
 * contributor list, and none of those carried a marker at all.
 *
 * `lastGoodCopy` is the bit that separates the two causes, and it takes the
 * sub-line from the join's sentence — it is the only one that explains why the
 * change the reader just made is missing from the numbers in front of them. It
 * does NOT take it from the read-short sentence, which is a wider claim and is
 * still true on a retiree read short; `weeklyClosedLine`'s docblock argues the
 * order and this file pins it.
 */
describe('a row served from the last-good copy says its numbers are old (#770)', () => {
  const block = (p: Partial<ProjectBlockRow>) =>
    renderToStaticMarkup(<ProjectStrip rows={[row(p)]} />);

  /** The retiree exactly as `unjoined` serves it, and this fixture tracks the
   *  wire rather than the state it stands for: since #792 the copy carries
   *  `pulseJoined: true` — the join ran for it — and says the withholding with
   *  `joinedFiguresWithheld` instead of borrowing the join's false. The shape a
   *  board-api predating #792 still sends across a deploy window is pinned in
   *  the #792 block below, not here. Same sentence either way, which is why this
   *  fixture had to be corrected rather than left: it passes both ways round and
   *  `blockRowOf`'s docblock records what that costs. */
  const retiree = {
    lastGoodCopy: true,
    pulseJoined: true,
    joinedFiguresWithheld: true,
    closedThisWeek: undefined,
  };

  it('says the counts are old, not that the closes were not read', () => {
    const html = block(retiree);
    expect(html).toContain(staleCopyCountNote(true));
    expect(html).not.toContain('closes were not read');
    expect(html).not.toContain('Nothing opened or closed this week');
    expect(html).not.toContain('This week:');
  });

  it('yields to the read-short sentence when the retired copy was itself short', () => {
    // Both are true of a retiree read short, and one line fits one sentence, so
    // the wider claim takes it. It is also the one the ring needs: this row
    // draws an empty track and no percentage, and "these counts predate the last
    // change" would be an old count beside a share the row refuses to state.
    const html = block({ ...retiree, itemsComplete: false });
    expect(html).toContain(truncatedCountNote(false));
    expect(html).not.toContain(staleCopyCountNote(true));
    expect(circles(html)).toBe(1);
    expect(html).not.toContain('72%');
  });

  it('leaves that reader with no sentence about the copy — the cost of the order', () => {
    // Recorded rather than asserted-away: nothing else on this row says the
    // numbers are old, so on a retiree read short the reader learns it only by
    // reloading past the failure. `RETIREE_MAX_TTLS` in board-service bounds how
    // long that can last. A single sentence covering both states is the open
    // alternative and is Octocat's call, not this spec's.
    const html = block({ ...retiree, itemsComplete: false });
    expect(html).not.toContain('predate');
    expect(html).not.toContain('closes were not read');
  });

  it('leaves a board that is not a retiree exactly as it was', () => {
    for (const flag of [false, undefined]) {
      expect(block({ lastGoodCopy: flag })).toBe(block({}));
      expect(block({ lastGoodCopy: flag, pulseJoined: false, closedThisWeek: undefined })).toContain(
        'closes were not read',
      );
    }
  });

  it('puts the copy ahead of the join on the one payload where the order decides', () => {
    // The ordering this block exists to guarantee, on the only shape that still
    // tests it. The `retiree` fixture above cannot: since #792 it carries
    // `pulseJoined: true`, so `joinFailedCountNote` is empty on it and every case
    // above passes whichever way round the two sit in `weeklyClosedLine`. Swap
    // those two lines and this is the case that goes red.
    //
    // Both flags at once is what a board-api predating #792 still sends across a
    // deploy window — and a bundle can outlive a deploy by the life of its tab
    // (`weeklyClosedLine`'s docblock has the cache headers). The #792 block asserts
    // the same payload for the other half of the argument, that the cause reads
    // survive the new flag; this one is about which of the two causes wins the
    // line, which is #770's question and belongs here.
    //
    // `not.toContain` on a substring with no apostrophe in it, because
    // `renderToStaticMarkup` escapes the one in "week's" and a literal copy of
    // the whole sentence would pass without asserting anything.
    const html = block({ lastGoodCopy: true, pulseJoined: false, closedThisWeek: undefined });
    expect(html).toContain(staleCopyCountNote(true));
    expect(html).not.toContain('closes were not read');
    expect(html).not.toContain('Nothing opened or closed this week');
    expect(html).not.toContain('This week:');
  });
});

/**
 * The FIFTH state (#792). `joinedFiguresWithheld` says the four joined figures
 * are off the payload and says nothing about what took them off — board-api
 * sets it inside the one function that removes them, so it is true on the three
 * causes above and on any cause it grows later. This row is what a reader sees
 * when the cause is one of those later ones: the sentence it can honestly say,
 * instead of the zero the absence used to be counted as.
 *
 * The order is the whole of it. The flag goes LAST among the notes, because a
 * named cause says more, and it goes IN ADDITION to the three cause reads
 * rather than in place of them: board-web ships either side of board-api, and a
 * payload predating this field carries the causes and not the flag. Gated on
 * the flag alone, a board read short by such a board-api would say "No closes
 * this week" — #715's bug, from the other direction. Both halves are pinned
 * here.
 */
describe('a row whose figures were withheld for a cause it cannot name says so (#792)', () => {
  const block = (p: Partial<ProjectBlockRow>) =>
    renderToStaticMarkup(<ProjectStrip rows={[row(p)]} />);
  /** The sentence as the markup carries it — React escapes the apostrophe in
   *  "week's". Taken from the function rather than re-typed, the rule this file
   *  states at the top, and the escaping is why it needs a step. */
  const esc = (sentence: string) => sentence.replace(/'/g, '&#x27;');

  it('says the figures were withheld, not that the week was quiet', () => {
    const html = block({ joinedFiguresWithheld: true, closedThisWeek: undefined });
    expect(html).toContain(esc(withheldCountNote(true)));
    expect(html).not.toContain('Nothing opened or closed this week');
    expect(html).not.toContain('This week:');
  });

  it('yields to all three sentences that can name the cause', () => {
    // The fallback is last because "withheld" is the least a row can say. Each
    // of these payloads carries the flag as well, which is what the service
    // sends: the flag is set wherever the figures come off.
    const withheld = { joinedFiguresWithheld: true, closedThisWeek: undefined };
    expect(block({ ...withheld, itemsComplete: false })).toContain(truncatedCountNote(false));
    expect(block({ ...withheld, lastGoodCopy: true })).toContain(staleCopyCountNote(true));
    expect(block({ ...withheld, pulseJoined: false })).toContain('closes were not read');
    for (const cause of [{ itemsComplete: false }, { lastGoodCopy: true }, { pulseJoined: false }]) {
      expect(block({ ...withheld, ...cause })).not.toContain('were withheld');
    }
  });

  it('still reads the causes on a board-api that predates the flag', () => {
    // The half that would be a regression rather than a missing feature. These
    // two payloads are what a board-api predating #792 sends, and if this flag
    // had replaced the cause reads instead of joining them both would fall
    // through to the count and claim a quiet week.
    const short = block({ itemsComplete: false, closedThisWeek: undefined });
    expect(short).toContain(truncatedCountNote(false));
    expect(short).not.toContain('Nothing opened or closed this week');
    expect(short).not.toContain('This week:');
    const oldRetiree = block({ lastGoodCopy: true, pulseJoined: false, closedThisWeek: undefined });
    expect(oldRetiree).toContain(staleCopyCountNote(true));
    expect(oldRetiree).not.toContain('Nothing opened or closed this week');
    expect(oldRetiree).not.toContain('This week:');
  });

  it('counts as it always did when the figures are on the payload', () => {
    for (const flag of [false, undefined]) {
      expect(block({ joinedFiguresWithheld: flag, closedThisWeek: 2 })).toContain('This week: 2 closed, 0 opened');
    }
    expect(block({ joinedFiguresWithheld: undefined })).toBe(block({}));
  });
});

/** #792 — the flag has to travel on the one mapper, or a row cannot tell a
 *  withholding it has no name for from a board that closed nothing. */
describe('blockRowOf carries the withheld flag too (#792)', () => {
  const summary = (o: Partial<ProjectSummary> = {}): ProjectSummary => ({
    org: 'acme',
    number: 7,
    name: 'Board hardening',
    url: 'https://github.com/orgs/acme/projects/7',
    status: 'active',
    open: 3,
    closed: 5,
    pct: 62,
    lastClosed: null,
    closedThisWeek: 2,
    itemsComplete: true,
    ...o,
  });

  it('carries a true flag rather than dropping it', () => {
    const withheld = blockRowOf(
      summary(),
      summary({ joinedFiguresWithheld: true, closedThisWeek: undefined }),
    );
    expect(withheld.joinedFiguresWithheld).toBe(true);
    expect(weeklyClosedLine(withheld)).toBe(withheldCountNote(true));
  });

  it('invents no false — that would be the row saying the figures are present', () => {
    expect(blockRowOf(summary(), summary()).joinedFiguresWithheld).toBeUndefined();
    expect(blockRowOf({ number: 9, name: 'Onboarding' }, undefined).joinedFiguresWithheld).toBeUndefined();
  });

  it('carries the retiree in the shape #792 gives it, sentence and all', () => {
    const retiree = blockRowOf(
      summary(),
      summary({
        lastGoodCopy: true,
        pulseJoined: true,
        joinedFiguresWithheld: true,
        closedThisWeek: undefined,
      }),
    );
    expect(retiree).toMatchObject({ lastGoodCopy: true, pulseJoined: true, joinedFiguresWithheld: true });
    expect(weeklyClosedLine(retiree)).toBe(staleCopyCountNote(true));
  });
});

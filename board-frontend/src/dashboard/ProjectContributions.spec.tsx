import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { contributionRows, ProjectContributions, ProjectStrip } from './ProjectContributions';
// The read-short sub-line from the function that produces it, never re-typed —
// a copy in a `not.toContain` goes green the moment the wording changes and
// stops protecting anything. `pulse.spec.ts` holds the literal that pins it.
import { staleCopyCountNote, truncatedCountNote, withheldCountNote } from '../projects/pulse';
// Same rule for the quiet-week phrase: `formatWeeklyClosed` is what draws it,
// and a re-typed copy in a `not.toContain` goes green the moment the wording
// moves. It already had — the assertion below named "No closes this week",
// which #785 replaced and which nothing has rendered since, so it could not
// fail whatever the strip did.
import { formatWeeklyClosed } from '../projects/ProjectBlock';
import type { ProjectContribution, ProjectSummary } from '../api/projects';
import type { BoardSelection } from './project-filter';
import { FOCUS_RING } from '../repos/controls';

// Pure-mapper + render-markup coverage, node env (no DOM) — same rationale as
// ProjectBlock.spec.tsx.

function contribution(o: Partial<ProjectContribution>): ProjectContribution {
  return {
    number: 7,
    name: 'Board hardening',
    closed7d: 1,
    openAssigned: 2,
    lastClosedAtISO: '2026-08-01T09:00:00.000Z',
    slipping: false,
    ...o,
  };
}

function summary(o: Partial<ProjectSummary>): ProjectSummary {
  return {
    number: 7,
    name: 'Board hardening',
    url: 'https://github.com/orgs/acme/projects/7',
    status: 'active',
    open: 3,
    closed: 5,
    pct: 62,
    lastClosed: null,
    weeklyClosed: [],
    closedThisWeek: 3,
    ...o,
  };
}

describe('contributionRows (#419)', () => {
  it('joins each contribution to its project rollup for pct + closedThisWeek', () => {
    const rows = contributionRows(
      [contribution({ number: 7, name: 'Board hardening' })],
      [summary({ number: 7, pct: 72, closedThisWeek: 4, open: 6 })],
    );
    expect(rows).toEqual([
      {
        number: 7,
        name: 'Board hardening',
        pct: 72,
        closedThisWeek: 4,
        open: 6,
        contributors: undefined,
        contributorsByAssignee: undefined,
      },
    ]);
  });

  it('carries the ring contributions through the join (#454)', () => {
    const rows = contributionRows(
      [contribution({ number: 7 })],
      [
        summary({
          number: 7,
          contributors: [{ login: 'octocat', closed: 4, kind: 'person' }],
          contributorsByAssignee: [{ login: 'antonk', closed: 4, kind: 'person' }],
        }),
      ],
    );
    expect(rows[0].contributors).toEqual([{ login: 'octocat', closed: 4, kind: 'person' }]);
    expect(rows[0].contributorsByAssignee).toEqual([{ login: 'antonk', closed: 4, kind: 'person' }]);
  });

  it('degrades to a 0%/quiet row when the project rollup has no matching entry', () => {
    const rows = contributionRows([contribution({ number: 9, name: 'Onboarding' })], []);
    expect(rows).toEqual([
      {
        number: 9,
        name: 'Onboarding',
        pct: 0,
        closedThisWeek: undefined,
        open: 0,
        contributors: undefined,
        contributorsByAssignee: undefined,
      },
    ]);
    // The count stopped being coalesced HERE in #715 — a withheld figure and a
    // quiet week had to stay distinguishable this far down, and the row's
    // sub-line is now where the two are told apart. `toEqual` treats an absent
    // key and an undefined one alike, so the value is pinned on its own line;
    // the quiet ring this test is about is pinned in the rendered strip below.
    expect(rows[0].closedThisWeek).toBeUndefined();
  });

  it('orders most-recently-you-closed first', () => {
    const older = contribution({ number: 1, name: 'Older', lastClosedAtISO: '2026-07-01T00:00:00.000Z' });
    const newer = contribution({ number: 2, name: 'Newer', lastClosedAtISO: '2026-08-01T00:00:00.000Z' });
    const rows = contributionRows([older, newer], []);
    expect(rows.map((r) => r.number)).toEqual([2, 1]);
  });

  it('a board with no close yet (null lastClosedAtISO) sinks behind ones with a close', () => {
    const slipping = contribution({ number: 1, name: 'Slipping', lastClosedAtISO: null, closed7d: 0 });
    const active = contribution({ number: 2, name: 'Active', lastClosedAtISO: '2026-08-01T00:00:00.000Z' });
    const rows = contributionRows([slipping, active], []);
    expect(rows.map((r) => r.number)).toEqual([2, 1]);
  });
});

describe('ProjectContributions (#419/#413)', () => {
  it('renders nothing with no contributions (quiet by default)', () => {
    const html = renderToStaticMarkup(<ProjectContributions contributions={[]} projects={[]} selected={[]} onToggle={() => {}} />);
    expect(html).toBe('');
  });

  it('renders the compact strip with each project ring joined to its rollup (no block label — Artur)', () => {
    const html = renderToStaticMarkup(
      <ProjectContributions
        contributions={[contribution({ number: 7, name: 'Board hardening' })]}
        projects={[summary({ number: 7, pct: 55, closedThisWeek: 2 })]}
        selected={[]}
        onToggle={() => {}}
      />,
    );
    expect(html).not.toContain('Contributions'); // the block label was dropped
    expect(html).toContain('Board hardening');
    expect(html).toContain('55%');
    expect(html).toContain('This week: 2 closed, 0 opened');
  });
});

// #697 — `/api/issues/mine` rows and the `/api/projects` rollup are both unions
// across every configured org, and a Projects v2 number is unique only within
// one. Joined on the number alone, the last board with that number won: a row
// showed one org's name over another org's completion ring and another org's
// teammates.
describe('two orgs’ board 3 join to their own rollups (#697)', () => {
  const rows = () =>
    contributionRows(
      [
        contribution({ org: 'acme', number: 3, name: 'Platform', lastClosedAtISO: '2026-08-02T00:00:00.000Z' }),
        contribution({ org: 'globex', number: 3, name: 'Delivery', lastClosedAtISO: '2026-08-01T00:00:00.000Z' }),
      ],
      [
        summary({ org: 'acme', number: 3, name: 'Platform', pct: 10, closedThisWeek: 1, open: 11 }),
        summary({ org: 'globex', number: 3, name: 'Delivery', pct: 90, closedThisWeek: 9, open: 99 }),
      ],
    );

  it('gives each row its own org’s completion, not the last board’s', () => {
    expect(rows()).toEqual([
      { org: 'acme', number: 3, name: 'Platform', pct: 10, closedThisWeek: 1, open: 11, contributors: undefined, contributorsByAssignee: undefined },
      { org: 'globex', number: 3, name: 'Delivery', pct: 90, closedThisWeek: 9, open: 99, contributors: undefined, contributorsByAssignee: undefined },
    ]);
  });

  // Until #750 this asserted one href per row, which is where the address showed
  // in the markup. A ring is a filter now and carries the board's NAME, so the
  // address is no longer drawn at all — it survives as the row's identity (the
  // React key) and as the join above. What the render can still prove is that
  // both boards are there, each under its own name, rather than one of them
  // overwriting the other.
  it('draws both boards, each under its own name', () => {
    const html = renderToStaticMarkup(
      <ProjectContributions
        contributions={[
          contribution({ org: 'acme', number: 3, name: 'Platform' }),
          contribution({ org: 'globex', number: 3, name: 'Delivery', lastClosedAtISO: '2026-07-01T00:00:00.000Z' }),
        ]}
        projects={[]}
        selected={[]}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain('Platform');
    expect(html).toContain('Delivery');
    expect(html.match(/aria-pressed=/g) ?? []).toHaveLength(2);
  });

  // WHAT STILL GUARDS THE PER-ORG DISTINCTION IN THE MARKUP, now that the
  // address is not drawn (#750 review). The `href` this used to read was the
  // only place the org appeared on screen; a ring carries the board's NAME.
  // What the render can still prove is that the two rows were filled from their
  // OWN org's rollup rather than one of them overwriting the other — so give
  // the two boards different completions and require both on the page. That is
  // the same fact the `contributionRows` cases above settle, asserted where a
  // React key collision or a shared row would actually show.
  it('draws each board’s own org’s completion, not one of them twice', () => {
    const html = renderToStaticMarkup(
      <ProjectContributions
        contributions={[
          contribution({ org: 'acme', number: 3, name: 'Platform' }),
          contribution({ org: 'globex', number: 3, name: 'Delivery', lastClosedAtISO: '2026-07-01T00:00:00.000Z' }),
        ]}
        projects={[
          summary({ org: 'acme', number: 3, name: 'Platform', pct: 10, closedThisWeek: 1 }),
          summary({ org: 'globex', number: 3, name: 'Delivery', pct: 90, closedThisWeek: 9 }),
        ]}
        selected={[]}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain('10%');
    expect(html).toContain('90%');
  });

  it('joins on the number alone when a board-api predating the field says no org', () => {
    expect(contributionRows([contribution({ number: 7 })], [summary({ number: 7, pct: 72 })])[0].pct).toBe(72);
  });

  it('still joins when only one side of the pair names its org', () => {
    // Nothing serves this mix today; it is what a half-deployed pair would look
    // like, and the number is still the honest answer there.
    expect(contributionRows([contribution({ org: 'globex', number: 7 })], [summary({ number: 7, pct: 72 })])[0].pct).toBe(72);
  });

  it('draws an unqualified row as an ordinary, unpressed filter', () => {
    const html = renderToStaticMarkup(
      <ProjectContributions
        contributions={[contribution({ number: 7 })]}
        projects={[]}
        selected={[]}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain('aria-pressed="false"');
  });
});

// #714 — the narrowing reopened #697's last-number-wins bug through the number
// fallback. `/api/issues/mine` takes no `org`, so the contributions are every
// org's; `/api/projects?org=acme` is one org's. A contribution in
// `globex/#7` then misses the address map, fell through to the number map,
// and was drawn with acme's board 7 — its ring, its percentage, its
// contributors — under the globex board's name.
describe('a narrowed rollup fills no row belonging to another org (#714)', () => {
  const narrowed = () =>
    contributionRows(
      [contribution({ org: 'globex', number: 7, name: 'Delivery' })],
      [summary({ org: 'acme', number: 7, name: 'Platform', pct: 90, closedThisWeek: 9, open: 99 })],
    );

  it('does not lend the other org’s completion to the row', () => {
    expect(narrowed()[0].pct).toBe(0);
    expect(narrowed()[0].closedThisWeek).toBeUndefined();
    expect(narrowed()[0].open).toBe(0);
  });

  it('does not lend the other org’s contributors to the row', () => {
    const rows = contributionRows(
      [contribution({ org: 'globex', number: 7, name: 'Delivery' })],
      [summary({
        org: 'acme',
        number: 7,
        contributors: [{ login: 'octocat', closed: 4, kind: 'person' }],
        contributorsByAssignee: [{ login: 'antonk', closed: 4, kind: 'person' }],
      })],
    );
    expect(rows[0].contributors).toBeUndefined();
    expect(rows[0].contributorsByAssignee).toBeUndefined();
  });

  it('keeps the row on its own name', () => {
    const html = renderToStaticMarkup(
      <ProjectContributions
        contributions={[contribution({ org: 'globex', number: 7, name: 'Delivery' })]}
        projects={[summary({ org: 'acme', number: 7, name: 'Platform', pct: 90 })]}
        selected={[]}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain('Delivery');
    expect(html).not.toContain('Platform');
    expect(html).not.toContain('90%');
  });
});

// #714 — the one join the narrowing changed that nothing pinned either way: a
// board that names an org, against a contribution that does not. It no longer
// joins, and that is the STATED CONSEQUENCE of "a board with an address is
// reached by its address, and by nothing else" — not an oversight. The number
// map holds only address-less boards, so an address-less contribution has
// nothing to fall back to once the board has an address. It is pinned here so
// the next person to touch this join reads it off a check rather than off a
// board drawn at zero: a row degraded to the quiet 0% ring is the failure that
// looks like data.
//
// The mirror — an address-less BOARD against a contribution that names an org —
// still joins on the number, and is pinned above as "still joins when only one
// side of the pair names its org" (#697). The two directions are deliberately
// not symmetric: the fallback belongs to the board with no address to miss on.
describe('a board with an address is not reached by a contribution without one (#714)', () => {
  const halfAddressed = () =>
    contributionRows(
      [contribution({ number: 7, name: 'Board hardening' })],
      [summary({ org: 'acme', number: 7, name: 'Platform', pct: 90, closedThisWeek: 9, open: 99 })],
    );

  it('degrades to the quiet 0% ring rather than borrowing the addressed board', () => {
    expect(halfAddressed()[0].pct).toBe(0);
    expect(halfAddressed()[0].closedThisWeek).toBeUndefined();
    expect(halfAddressed()[0].open).toBe(0);
    expect(halfAddressed()[0].contributors).toBeUndefined();
  });

  it('keeps the row, on its own name', () => {
    expect(halfAddressed()[0].name).toBe('Board hardening');
    const html = renderToStaticMarkup(
      <ProjectContributions
        contributions={[contribution({ number: 7, name: 'Board hardening' })]}
        projects={[summary({ org: 'acme', number: 7, name: 'Platform', pct: 90 })]}
        selected={[]}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain('Board hardening');
    expect(html).not.toContain('Platform');
    expect(html).not.toContain('90%');
  });

  it('the other direction still joins — the fallback is the address-less board’s', () => {
    // Restated beside its mirror on purpose: the asymmetry is the rule, and it
    // is only visible when the two are read together.
    expect(
      contributionRows([contribution({ org: 'globex', number: 7 })], [summary({ number: 7, pct: 72 })])[0].pct,
    ).toBe(72);
  });
});

// #715 — the same three states ProjectBlock.spec.tsx pins, through this strip's
// own row: the service withholds `closedThisWeek` from a board whose item read
// came up short, and coalescing that to 0 said "No closes this week" — a claim
// about the board rather than about the read.
describe('a board read short says so instead of counting (#715)', () => {
  const strip = (o: Partial<ProjectSummary>) =>
    renderToStaticMarkup(
      <ProjectContributions
        contributions={[contribution({ number: 7, name: 'Board hardening' })]}
        projects={[summary({ number: 7, ...o })]}
        selected={[]}
        onToggle={() => {}}
      />,
    );

  it('carries the rollup’s truncation flag through the join', () => {
    const rows = contributionRows(
      [contribution({ number: 7 })],
      [summary({ number: 7, itemsComplete: false, closedThisWeek: undefined })],
    );
    expect(rows[0].itemsComplete).toBe(false);
    expect(rows[0].closedThisWeek).toBeUndefined();
  });

  it('shows the sentence and no count when the read came up short', () => {
    const html = strip({ itemsComplete: false, closedThisWeek: undefined });
    expect(html).toContain(truncatedCountNote(false));
    expect(html).not.toContain('This week:');
    expect(html).not.toContain('Nothing opened or closed this week');
  });

  it('shows its count as before on a board read whole', () => {
    const html = strip({ itemsComplete: true, closedThisWeek: 2 });
    expect(html).toContain('This week: 2 closed, 0 opened');
    expect(html).not.toContain(truncatedCountNote(false));
  });

  it('shows what it always showed to a board-api that predates the flag', () => {
    const html = strip({ itemsComplete: undefined, closedThisWeek: undefined });
    expect(html).toContain('Nothing opened or closed this week');
    expect(html).not.toContain(truncatedCountNote(false));
  });

  it('withholds progress for a membership absent from the rollup', () => {
    // A missing summary establishes neither a zero nor a short read.
    const html = renderToStaticMarkup(
      <ProjectContributions
        contributions={[contribution({ number: 9, name: 'Onboarding' })]}
        projects={[]}
        selected={[]}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain('Progress was not read.');
    expect(html).not.toContain('Nothing opened or closed this week');
    expect(html).not.toContain('0%');
    expect(html).not.toContain(truncatedCountNote(false));
  });
});

// #750 — the ring is a filter over the queue below it, not a link away from the
// page. What this file can check is the half that reaches the markup: a ring is
// a button that says whether it is pressed, and it is pressed for exactly the
// boards the URL named. The press itself — which URL it writes — is
// `project-filter.spec.ts`; the two meet at the board NAME, which is what the
// queue's `?project=` dimension matches on.
describe('a ring is a pressed-or-not filter over the queue (#750)', () => {
  const strip = (selected: BoardSelection[]) =>
    renderToStaticMarkup(
      <ProjectContributions
        contributions={[
          contribution({ number: 7, name: 'Board hardening' }),
          contribution({ number: 9, name: 'Onboarding', lastClosedAtISO: '2026-07-01T00:00:00.000Z' }),
        ]}
        projects={[]}
        selected={selected}
        onToggle={() => {}}
      />,
    );

  it('draws a button, never a link away from the page', () => {
    const html = strip([]);
    expect(html).toContain('<button');
    expect(html).not.toContain('href=');
  });

  it('presses nothing when the URL named no board', () => {
    expect(strip([]).match(/aria-pressed="true"/g)).toBeNull();
    expect(strip([]).match(/aria-pressed="false"/g) ?? []).toHaveLength(2);
  });

  it('presses exactly the board the URL named, and only that one', () => {
    const html = strip([{ name: 'Onboarding' }]);
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g) ?? []).toHaveLength(1);
    // The pressed one is Onboarding's: its button opens before its name and the
    // next button opens after it.
    const pressed = html.indexOf('aria-pressed="true"');
    expect(html.indexOf('Onboarding')).toBeGreaterThan(pressed);
    expect(html.indexOf('Board hardening')).toBeLessThan(pressed);
  });

  it('presses a board the URL named twice exactly once', () => {
    // The host dedupes through `selectedProjects`, but the strip must not double
    // a press if a hand-edited URL reaches it whole.
    const html = strip([{ name: 'Onboarding' }, { name: 'Onboarding' }]);
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
  });

  it('presses nothing for a board name the strip does not draw', () => {
    expect(strip([{ name: 'Some other board' }]).match(/aria-pressed="true"/g)).toBeNull();
  });
});

/**
 * #750 review — the ring stopped looking and behaving like a control.
 *
 * It was an `<a href>` before the rings became filters, so the pointer and a
 * focus ring came with the element. Measured on the built page in headless
 * Chrome after the change, the button computed `cursor: default` and drew
 * Chrome's own `outline: 1px auto` on focus, beside a `.side-item` computing
 * `cursor: pointer` with the board's 2px brand ring.
 *
 * Asserted against `FOCUS_RING` itself rather than against the utilities it
 * spells, so a change to the board's one focus treatment carries here instead
 * of leaving this strip behind on the old one.
 */
describe('a ring is a control (#750 review)', () => {
  const markup = () =>
    renderToStaticMarkup(
      <ProjectContributions
        contributions={[contribution({})]}
        projects={[]}
        selected={[]}
        onToggle={() => {}}
      />,
    );

  it('offers the pointer — Tailwind v4 gives a button none', () => {
    expect(markup()).toContain('cursor-pointer');
  });

  it('wears the board’s own focus ring, not the user agent’s hairline', () => {
    for (const cls of FOCUS_RING.split(' ')) expect(markup()).toContain(cls);
  });
});

/**
 * The second live surface of #770, and the reason it is asserted twice: this
 * strip and the Projects block draw the same row through the same mapper, and
 * the bug was that one flag made both of them say a sentence that was false.
 *
 * The fixture tracks the wire, not the state it stands for. Since #792 a retiree
 * carries `pulseJoined: true` — the join ran for the copy being served — and
 * says the withholding with `joinedFiguresWithheld`. The sentence is the same
 * either way, so this fixture went on passing over a shape the service had
 * stopped sending, which is the drift `blockRowOf`'s docblock records the last
 * case of.
 */
describe('a ring served from the last-good copy says its numbers are old (#770)', () => {
  const strip = (o: Partial<ProjectSummary>) =>
    renderToStaticMarkup(
      <ProjectContributions
        contributions={[contribution({})]}
        projects={[
          summary({
            lastGoodCopy: true,
            pulseJoined: true,
            joinedFiguresWithheld: true,
            closedThisWeek: undefined,
            ...o,
          }),
        ]}
        selected={[]}
        onToggle={() => {}}
      />,
    );

  it('says the counts are old instead of blaming the join that ran', () => {
    const html = strip({});
    expect(html).toContain(staleCopyCountNote(true));
    expect(html).not.toContain('closes were not read');
  });

  it('carries the flag through the mapper rather than coalescing it away', () => {
    // `blockRowOf` invents no flags: a row the join never matched must not claim
    // to be a copy of anything, the way it must not claim a failure.
    const [matched] = contributionRows([contribution({})], [summary({ lastGoodCopy: true })]);
    const [unmatched] = contributionRows([contribution({ number: 99 })], []);
    expect(matched.lastGoodCopy).toBe(true);
    expect(unmatched.lastGoodCopy).toBeUndefined();
  });
});

/**
 * The second live surface of #792, and it is here for the reason #770 is
 * asserted twice: this strip and the Projects block draw the same row through
 * the same mapper, so a field that reaches one and not the other is a board
 * answering differently depending on which page the reader is on. The ordering
 * against the three cause sentences is pinned once, in ProjectBlock.spec.tsx;
 * what has to hold HERE is that the flag survives the join and that the strip
 * says the sentence rather than counting the absence as a quiet week.
 */
describe('a ring whose figures were withheld for a cause it cannot name says so (#792)', () => {
  /** The sentence as the markup carries it — React escapes the apostrophe in
   *  "week's", so the raw string never appears and a `toContain` on it would go
   *  red for the escaping rather than for the wording. */
  const esc = (sentence: string) => sentence.replace(/'/g, '&#x27;');

  it('says the figures were withheld instead of counting their absence as zero', () => {
    const html = renderToStaticMarkup(
      <ProjectContributions
        contributions={[contribution({})]}
        projects={[summary({ joinedFiguresWithheld: true, closedThisWeek: undefined })]}
        selected={[]}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain(esc(withheldCountNote(true)));
    expect(html).not.toContain('Nothing opened or closed this week');
    expect(html).not.toContain('This week:');
  });

  it('carries the flag through the mapper rather than coalescing it away', () => {
    // The shape `lastGoodCopy` has above, applied to the flag that says the four
    // joined figures are off the payload: carried when the rollup matched, and
    // invented for nobody when it did not. A `false` conjured for an unmatched
    // row would be this strip claiming those figures ARE present on a payload it
    // never saw — which is the one thing an absent flag does not say.
    const [matched] = contributionRows(
      [contribution({})],
      [summary({ joinedFiguresWithheld: true, closedThisWeek: undefined })],
    );
    const [unmatched] = contributionRows([contribution({ number: 99 })], []);
    expect(matched.joinedFiguresWithheld).toBe(true);
    expect(unmatched.joinedFiguresWithheld).toBeUndefined();
  });
});

/**
 * #782 — the rows were built on the board's whole address (#697) and the
 * SELECTION was not: `selected.includes(p.name)` lit every ring wearing the
 * pressed board's name. Two orgs each holding a "Roadmap" lit as one board.
 *
 * The strip is handed the addressed selection now, and a ring is pressed for
 * the board that was pressed. A selection that names no address still presses
 * every ring wearing the name, because that is all a name-only URL says — the
 * queue's own chip writes one, and both boards really are in the filter.
 */
describe('two boards with one name light as two rings (#782)', () => {
  const twins: ProjectContribution[] = [
    contribution({ org: 'acme', number: 3, name: 'Roadmap' }),
    contribution({ org: 'globex', number: 5, name: 'Roadmap', lastClosedAtISO: '2026-07-01T00:00:00.000Z' }),
  ];
  const strip = (selected: BoardSelection[]) =>
    renderToStaticMarkup(
      <ProjectContributions contributions={twins} projects={[]} selected={selected} onToggle={() => {}} />,
    );

  it('presses only the board the URL addressed', () => {
    const html = strip([{ org: 'globex', number: 5, name: 'Roadmap' }]);
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g) ?? []).toHaveLength(1);
  });

  it('presses the globex ring, not whichever one is drawn first', () => {
    // Both rings carry the same name, so position is the only thing that tells
    // them apart in the markup: acme is drawn first (it closed later).
    const html = strip([{ org: 'globex', number: 5, name: 'Roadmap' }]);
    const pressed = html.indexOf('aria-pressed="true"');
    const unpressed = html.indexOf('aria-pressed="false"');
    expect(unpressed).toBeLessThan(pressed);
  });

  it('presses the acme ring when that is the one the URL named', () => {
    const html = strip([{ org: 'acme', number: 3, name: 'Roadmap' }]);
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(html.indexOf('aria-pressed="true"')).toBeLessThan(html.indexOf('aria-pressed="false"'));
  });

  it('presses neither for an address no drawn board holds', () => {
    expect(strip([{ org: 'acme', number: 9, name: 'Roadmap' }]).match(/aria-pressed="true"/g)).toBeNull();
  });

  it('presses both for a name-only selection — a name is all it said', () => {
    expect(strip([{ name: 'Roadmap' }]).match(/aria-pressed="true"/g) ?? []).toHaveLength(2);
  });

  it('draws two rings, never one row for the pair', () => {
    expect(strip([]).match(/aria-pressed=/g) ?? []).toHaveLength(2);
  });
});

/**
 * The rollup has two absent states and they are not the same (#824 review).
 *
 * This is the defect the branch shipped: `useCachedState` seeds `mine` in the
 * `useState` initialiser, so on a return visit the FIRST render carries every
 * real board's name out of `/api/issues/mine` while `/api/projects` has not
 * answered. The strip drew each of them at "0% - No closes this week" until it
 * did. Deterministically, on the default page, for every returning reader.
 *
 * `Dashboard.tsx`'s own comment describes the same false zeros reached by the
 * other route, from #714: "THE WORST THING A REFUSED ORG CAN DO IS DRAW
 * NUMBERS".
 */
describe('a ring is not drawn until the rollup has answered (#824 review)', () => {
  const CONTRIB = [contribution({ number: 7, name: 'Board hardening', closed7d: 4 })];

  it('draws no ring and no figure while the rollup is still in flight', () => {
    const html = renderToStaticMarkup(
      <ProjectContributions contributions={CONTRIB} projects={null} selected={[]} onToggle={() => {}} />,
    );
    expect(html).not.toContain('0%');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('Board hardening');
    expect(html).not.toContain(formatWeeklyClosed(0, 0));
  });

  it('keeps the block’s place rather than appearing under the reader', () => {
    // A placeholder and not `null`: the boards ARE known on this render, so the
    // strip is coming, and a block that arrives when the second read lands
    // moves the queue below it down under somebody's eye.
    const html = renderToStaticMarkup(
      <ProjectContributions contributions={CONTRIB} projects={null} selected={[]} onToggle={() => {}} />,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading project progress');
  });

  it('keeps an unmatched membership selectable without claiming its progress', () => {
    // An answered rollup says nothing about a board absent from that answer.
    const html = renderToStaticMarkup(
      <ProjectContributions contributions={CONTRIB} projects={[]} selected={[]} onToggle={() => {}} />,
    );
    expect(html).toContain('Board hardening');
    expect(html).toContain('aria-pressed');
    expect(html).toContain('Progress was not read.');
    expect(html).not.toContain('0%');
    expect(html).not.toContain(formatWeeklyClosed(0, 0));
  });

  it('renders nothing at all when the reader is on no boards, whatever the rollup says', () => {
    // Quiet by default outranks the placeholder: an empty shell that pulses for
    // a strip that will never draw is worse than the absence it replaced.
    const html = renderToStaticMarkup(
      <ProjectContributions contributions={[]} projects={null} selected={[]} onToggle={() => {}} />,
    );
    expect(html).toBe('');
  });
});


it('disables the block after a failed read rather than hiding it, and invents no quiet rings (#923 R3, #1003)', () => {
  const html = renderToStaticMarkup(<ProjectContributions
    contributions={[contribution({ name: 'Delivery' }), contribution({ number: 8, name: 'Maintenance' })]}
    projects={null} failed selected={[]} onToggle={() => {}} />);
  // The block keeps its surface and its place in the column (#1003): a sentence
  // where a control was reads as "no projects", which is the claim about the org
  // this whole state exists to avoid making.
  expect(html).toContain('rounded-xl bg-surface');
  // `role="group"` beside it, because `aria-disabled` is inert on the `region`
  // a named `<section>` maps to by default (#1003 review).
  expect(html).toContain('role="group"');
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain('Project progress couldn’t be read just now.');
  // Disabled, never busy: nothing is in flight for this to be waiting on.
  expect(html).not.toContain('aria-busy');
  expect(html).not.toContain('0%');
  expect(html).not.toContain(formatWeeklyClosed(0, 0));
  // The shape is drawn, and it does not pulse (#1033): a failed read is not
  // loading, so the strip is drawn `still` and each of its three bars pins
  // `!animate-none` over the kit's own pulse. The count is fixed so an empty
  // shape cannot pass by matching nothing against nothing.
  expect(html.match(/!animate-none/g) ?? []).toHaveLength(3);
  expect(html.match(/animate-pulse/g) ?? []).toHaveLength(3);
  expect(html).not.toContain('motion-reduce:animate-none');
});

it('draws saved project progress without a notice above it', () => {
  const drawn = renderToStaticMarkup(<ProjectContributions
    contributions={[contribution({ name: 'Delivery' })]} projects={[summary({ number: 7 })]} failed selected={[]} onToggle={() => {}} />);
  expect(drawn).toContain('Delivery');
  expect(drawn).not.toContain('aria-disabled');
  expect(drawn).not.toContain('couldn’t be read');
  expect(drawn).not.toContain('Showing the');
});

describe('ProjectStrip status spacing', () => {
  it.each([null, undefined, ''])('omits the status line when the note is %s', (note) => {
    const html = renderToStaticMarkup(<ProjectStrip rows={[]} note={note} />);
    expect(html).not.toContain('role="status"');
  });

  it('keeps the status line when a read is unavailable', () => {
    const html = renderToStaticMarkup(<ProjectStrip rows={[]} note="Projects couldn’t be read just now." />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Projects couldn’t be read just now.');
  });
});

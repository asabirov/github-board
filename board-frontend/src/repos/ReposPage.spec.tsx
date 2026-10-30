import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup as renderBare } from 'react-dom/server';
import type { ReactElement } from 'react';
import { TooltipProvider } from '../ui/kit';
import { ApiError } from '../api/core';
import { setRepoDri, type RepoHealth, type RepoOwner, type RepoRow, type ReposView } from '../api/repos';
import { describeEditFailure, failureTextBudget } from '../issue/use-facet-edit';
import { createFacetEdit } from '../issue/use-facet-edit';
import { MenuOption } from '../ui/command-menu';
import { Tip } from '../ui/Tip';
import { FOCUS_RING, FOCUS_RING_WITHIN } from './controls';
import source from './ReposPage.tsx?raw';
import { Hint } from './repo-hint';
import { canSetDri, ReposBody } from './ReposPage';
import { meFixture } from '../me-fixture';
import type { Me } from '../use-me';
import { OwnerControl, OwnerMenu, OwnerPicker, ownerEdit, ownerPress } from './OwnerPicker';
import { Failed, PropertyRow, retryPress } from '../issue/PropertyRow';
import { RepoTile } from './RepoTile';
import { RepoLensSpark } from './RepoLensSpark';
import { RepoSpark, SparkChart } from './repo-spark';
import { ChartHint, ChartMark, ChartPoints } from '../ui/chart-pointer';
import { OrderMenu, OrderPicker } from './OrderPicker';
import { OwnerRow } from './OwnerRow';
import {
  buildTiles,
  deltaHint,
  flowLegend,
  flowTitle,
  ORDERS,
  orderAria,
  type RepoOrderKey,
  openHint,
  ownerAria,
  ownerHint,
  ownerSlotHint,
  ownerSlots,
  queueShare,
  NO_HEALTH,
  NO_MATCH_BODY,
  SEARCH_KEY_HINT,
  tileWord,
  weekHint,
} from './repos-vm';
import { tileOpens } from './tile-nav';
import { gotoPath, repoPath } from '../route';

// The board's test env is `node` (no DOM, no @testing-library) — the same
// constraint PropertiesPanel.spec.tsx and ProjectsView.spec.tsx work under. So
// the page is asserted in two halves, exactly as this repo asserts every other
// interactive surface:
//
//   · what a reader SEES — rendered to a static HTML string with
//     `react-dom/server` and asserted against the markup, with the query and the
//     facet passed in as props (`ReposBody` is the pure half of the page, and
//     `ReposMap` is the thin state holder above it);
//   · what a press DOES — driven through the very stores and handlers the
//     components mount, `createFacetEdit(ownerEdit(...))` being the same options
//     object `OwnerPicker` hands to `useFacetEdit`.
//
// Nothing here re-implements behaviour to test it: the write path under test is
// the write path that ships.

vi.mock('../api/repos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/repos')>()),
  setRepoDri: vi.fn(),
}));

// The only real navigation this page's own markup can perform (#696). Mocked
// rather than driven, because `gotoPath` writes to `window.history` and there is
// no window here; every other export stays the module's own, `repoPath`
// included, which the assertions below still compare against.
vi.mock('../route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../route')>()),
  gotoPath: vi.fn(),
}));

const dri = vi.mocked(setRepoDri);
const goto = vi.mocked(gotoPath);

beforeEach(() => {
  dri.mockReset();
});

/** Every render here goes through a <TooltipProvider>, because a tile's
 *  sparkline hints through the board's own tooltip (#576) and Radix refuses to
 *  render one outside a provider. The app has exactly one, at its root
 *  (App.tsx); this stands in for it. */
function renderToStaticMarkup(ui: ReactElement): string {
  return renderBare(<TooltipProvider>{ui}</TooltipProvider>);
}

function weeks(pairs: [number, number][]): RepoRow['weeks'] {
  const out = pairs.map(([opened, closed]) => ({ opened, closed }));
  while (out.length < 10) out.push({ opened: 0, closed: 0 });
  return out;
}

const NO_SECURITY = { depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null };

/**
 * Every fixture's health, by repo (#571).
 *
 * The page reads its rows and its health on two requests now, but a fixture is
 * easier to read as one object — so `repo()` still takes `ci` and `security`,
 * and files them here instead of onto the row. `healthOf` and `health()` are
 * how the tests hand them back to the page, which is the join the server makes.
 */
const HEALTH = new Map<string, RepoHealth>();

function repo(over: Partial<RepoRow> & { name: string } & Partial<RepoHealth>): RepoRow {
  const { security, ci, ciUrl, ...rest } = over;
  const row: RepoRow = {
    full: `acme/${over.name}`,
    key: over.name,
    htmlUrl: `https://github.com/acme/${over.name}`,
    description: null,
    weeks: weeks([]),
    open: 0,
    owner: null,
    language: null,
    pushedAt: null,
    ...rest,
  };
  HEALTH.set(row.full, { security: security ?? NO_SECURITY, ci: ci ?? null, ciUrl: ciUrl ?? null });
  return row;
}

/** One repo's health as the second read reports it. */
const healthOf = (row: RepoRow): RepoHealth =>
  HEALTH.get(row.full) ?? { security: NO_SECURITY, ci: null, ciUrl: null };

/** The whole map's health, landed — what the page holds once the second read
 *  resolves. `null` is that read still being in flight. */
const health = (): ReadonlyMap<string, RepoHealth> => HEALTH;

/** One tile as `buildTiles` assembles it, health and all. */
const tileOf = (row: RepoRow) => ({ row, health: healthOf(row) });

/** The word a repo's landed health draws, or null where it draws none. The
 *  third answer — the health not having landed — is the `#571` section's
 *  subject and never reachable from a row. */
function wordOf(row: RepoRow) {
  const slot = tileWord(healthOf(row));
  return slot.state === 'word' ? slot : null;
}

const ADA: RepoOwner = { login: 'octocat', name: 'Octocat' };

const BOARD = repo({
  name: 'board.example.com',
  key: 'board',
  description: 'Acme team organizational platform',
  weeks: weeks([[4, 5], [3, 6]]),
  open: 6,
  owner: ADA,
  ci: 'success',
  language: 'TypeScript',
});
const UI = repo({
  name: 'acme-ui',
  description: 'shared design-system component library',
  weeks: weeks([[12, 3], [20, 4]]),
  open: 80,
  ci: 'failure',
  security: { depHigh: 6, depModerate: 1, codeScanning: 0, secrets: 0, secretsUrl: null },
  language: 'TypeScript',
});
const ROADMAP = repo({ name: 'roadmap', description: 'The top-level Roadmap', weeks: weeks([[1, 1]]) });
/** The live shape that exposed the disagreement: the CI failing chip counts it,
 *  and the tile's word used to fire on `failure` alone, so pressing the chip
 *  yielded a tile carrying no word at all. */
const DOCS = repo({
  name: 'acme-docs',
  description: 'The docs site',
  open: 3,
  weeks: weeks([[2, 1]]),
  ci: 'action_required',
  security: { depHigh: 6, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null },
});
/** A leaked credential AND a red build — the tile draws one word, the worse. */
const INFRA = repo({
  name: 'acme-infra',
  open: 4,
  weeks: weeks([[2, 3]]),
  ci: 'failure',
  security: { depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 1, secretsUrl: null },
});
/** A busy queue and nothing else: no hazard word, no security alert — the
 *  tile a warning tone must never appear on. */
const PLATFORM = repo({
  name: 'platform',
  open: 12,
  weeks: weeks([[5, 1], [6, 2]]),
  ci: 'success',
});

function view(repos: RepoRow[] = [BOARD, UI, ROADMAP]): ReposView {
  return {
    updatedAt: '2026-08-08T09:00:00.000Z',
    repos,
    driOptions: ['octocat', 'IvanRoslov'],
    ownerWritability: 'writable',
  };
}

/** The map rendered at rest — no query, no facet, a viewer who may write, and
 *  the health already landed, which is the state a reader spends all but the
 *  first moment in. The moment before it has its own section (#571). */
function render(over: Partial<Parameters<typeof ReposBody>[0]> = {}): string {
  return renderToStaticMarkup(
    <ReposBody
      view={view()}
      health={health()}
      canWrite
      query=""
      orderKey="open"
      onQuery={() => {}}
      onOwner={() => {}}
      onOrder={() => {}}
      {...over}
    />,
  );
}

/** The same page as an element TREE rather than as markup. `ReposBody` is a
 *  plain function with no hooks, and a tooltip's hint lives in the tree, never
 *  in the markup (see `tips` below). */
function body(over: Partial<Parameters<typeof ReposBody>[0]> = {}) {
  return ReposBody({
    view: view(),
    health: health(),
    canWrite: true,
    query: '',
    orderKey: 'open',
    onQuery: () => {},
    onOwner: () => {},
    onOrder: () => {},
    ...over,
  });
}

/** How many tiles the grid drew — each tile carries its repo key. */
function tileKeys(html: string): string[] {
  return [...html.matchAll(/data-repo="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * One tile's own markup, off the rendered page.
 *
 * Bounded at the NEXT `data-repo`, because the tail of the document is not this
 * tile: unbounded, a tile that drew no count returned its NEIGHBOUR's class and
 * `not.toBeNull()` was satisfied by it. Under the default order the tile every
 * test below hinges on has `atlas-ui` behind it, drawing the same ordinary
 * class, so that substitution was silent.
 */
function tileHtml(html: string, key: string): string {
  const after = html.split(`data-repo="${key}"`)[1];
  expect(after, `no tile for ${key}`).toBeDefined();
  return after.split('data-repo="')[0];
}

/** The class the named repo's 19px count drew. Exactly one match inside the
 *  tile, for the same reason `RepoTile.spec.tsx`'s own `countClass` asks for
 *  one. */
function countClassFor(html: string, key: string): string {
  const found = [...tileHtml(html, key).matchAll(/class="([^"]*text-\[19px\][^"]*)"/g)].map((m) => m[1]);
  expect(found, `${key} drew no count of its own`).toHaveLength(1);
  return found[0];
}

/** The words a reader actually sees, class names and attributes stripped out. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const nameOf = (login: string) => (login === 'octocat' ? 'Octocat' : null);

describe('the repo map (#558)', () => {
  it('shows every repo as a tile', () => {
    expect(tileKeys(render())).toEqual(['acme-ui', 'board', 'roadmap']);
  });

  it('filters as you type, on name and on description', () => {
    // On the name…
    expect(tileKeys(render({ query: 'board' }))).toEqual(['board']);
    // …and on the description, which is the half a name search can't reach.
    expect(tileKeys(render({ query: 'design-system' }))).toEqual(['acme-ui']);
  });

  it('shows the empty state when nothing matches, naming the query', () => {
    const html = render({ query: 'zzz' });
    expect(tileKeys(html)).toEqual([]);
    expect(textOf(html)).toContain('No repo matches “zzz”');
  });

  it('a chosen owner narrows the grid', () => {
    // BOARD is Octocat's; the other two have no owner.
    const html = render({ owner: 'octocat' });
    expect(tileKeys(html)).toEqual(['board']);
  });

  it('narrows to the repos nobody owns, which the struck-out chip used to do', () => {
    const html = render({ owner: null });
    expect(tileKeys(html)).toEqual(['acme-ui', 'roadmap']);
  });

  it('shows the whole map again for an owner it has no repos for', () => {
    // A stale link, or a typo. The map does not go blank over it.
    const html = render({ owner: 'someone-who-left' });
    expect(tileKeys(html)).toHaveLength(3);
    expect(textOf(html)).not.toContain(' of 3');
  });

  it('states no count the row already states, and footnotes nothing (#574)', () => {
    const text = textOf(render());

    // The row carries these numbers. The lead sentence said the same four of
    // them one line above the controls that say them.
    expect(text).not.toContain('opening issues faster than');
    expect(text).not.toContain('a high or critical security alert');
    // The right-hand meta repeated the All chip's count and then named a sort
    // order nobody chose and cannot change.
    expect(text).not.toContain('most open first');
    // And the footnote explained the page's own implementation to somebody who
    // came here to find a repo.
    expect(text).not.toContain('dri organization custom property');

    expect(text).not.toContain('All 3');
    expect(tileKeys(render())).toHaveLength(3);
  });

  it('keeps the four struck-out chips off the row entirely (#583)', () => {
    // A map with nothing to report on any tile, so "CI failing" appearing would
    // be the chip and could be nothing else — UI's own tile still draws that
    // word, and it should.
    const text = textOf(render({ view: view([ROADMAP]) }));
    for (const label of ['Falling behind', 'No owner', 'CI failing']) {
      expect(text, label).not.toContain(label);
    }
    expect(buttonsOf(render()).some((b) => textOf(b).startsWith('All'))).toBe(false);
  });
});

describe('the owner row (#583)', () => {
  /** A map whose owners are the org's own shape: two people and the rest
   *  unowned. */
  const OWNED = view([
    repo({ name: 'a-board', owner: ADA, open: 9 }),
    repo({ name: 'b-cli', owner: ADA, open: 8 }),
    repo({ name: 'c-ui', owner: { login: 'IvanRoslov', name: 'Ivan Roslov' }, open: 7 }),
    repo({ name: 'd-loose', open: 6 }),
  ]);
  const owned = (over: Partial<Parameters<typeof ReposBody>[0]> = {}) => render({ view: OWNED, ...over });

  it('draws one face per owner the map records, and one for the repos nobody owns', () => {
    const html = owned();
    // Two people, by their Github photos, and the empty ring for nobody.
    expect(html).toContain('github.com/octocat.png');
    expect(html).toContain('github.com/IvanRoslov.png');
    const faces = [...html.matchAll(/aria-label="(?:[^"]*owns [^"]*|[^"]*nobody recorded as owner)"/g)];
    expect(faces).toHaveLength(3);
  });

  it('hides the member filter when the map has only one member', () => {
    const html = render({ view: view([repo({ name: 'solo', owner: ADA }), repo({ name: 'loose' })]) });
    expect(html.split('<div class="mt-[18px] grid')[0]).not.toContain('aria-label="Octocat owns 1 repo"');
  });

  it('keeps the member filter when the map has multiple members', () => {
    const html = owned();
    expect(html).toContain('github.com/octocat.png');
    expect(html).toContain('github.com/IvanRoslov.png');
  });

  it('says whose face it is and how many repos are behind it — a face says neither', () => {
    const html = owned();
    expect(html).toContain(`aria-label="${ownerSlotHint(ownerSlots(buildTiles(OWNED, 'open'))[0])}"`);
    expect(html).toContain('aria-label="Octocat owns 2 repos"');
    expect(html).toContain('aria-label="1 repo with nobody recorded as owner"');
  });

  /** The one control the row has switched on, whichever it is. */
  const pressedIn = (html: string) => buttonsOf(html).filter((b) => b.includes('aria-pressed="true"'));

  it('marks the chosen face and no other', () => {
    const on = pressedIn(owned({ owner: 'octocat' }));
    // Exactly one thing on the row is on: the face. `All` is off.
    expect(on).toHaveLength(1);
    expect(on[0]).toContain('octocat');
    expect(on[0]).toContain('aria-label="Octocat owns 2 repos"');
  });

  it('leaves no filter pressed while nothing narrows the map', () => {
    expect(pressedIn(owned())).toHaveLength(0);
  });

  it('every face’s count agrees with the tiles that face leaves standing', () => {
    // The number in the hint is the promise; the grid is the delivery.
    for (const slot of ownerSlots(buildTiles(OWNED, 'open'))) {
      const html = owned({ owner: slot.login });
      expect(tileKeys(html), slot.name).toHaveLength(slot.count);
      expect(html).toContain(`aria-label="${ownerSlotHint(slot)}"`);
    }
  });

  it('composes with the search field, neither narrowing replacing the other', () => {
    // Octocat owns two; one of them matches the typed word.
    expect(tileKeys(owned({ owner: 'octocat' }))).toEqual(['a-board', 'b-cli']);
    expect(tileKeys(owned({ query: 'cli' }))).toEqual(['b-cli']);
    expect(tileKeys(owned({ owner: 'octocat', query: 'cli' }))).toEqual(['b-cli']);
    // And where they disagree, what is left satisfies both — which is nothing.
    expect(tileKeys(owned({ owner: 'IvanRoslov', query: 'board' }))).toEqual([]);
  });

  it('draws no face at all for a map with no repos on it', () => {
    // Asymmetry is fine: an empty row beats a row of slots standing for nothing.
    const html = render({ view: view([]) });
    expect(elementsOfType(body({ view: view([]) }), OwnerRow)[0].slots).toEqual([]);
    expect(textOf(html)).not.toContain('All 0');
  });

  it('a second press on the chosen face clears it', () => {
    const picked: (string | null | undefined)[] = [];
    const slots = ownerSlots(buildTiles(OWNED, 'open'));
    const faces = elementsOfType(
      OwnerRow({ slots, chosen: 'octocat', onOwner: (o) => picked.push(o) }),
      'button',
    );
    expect(faces).toHaveLength(3);
    press(faces[0]); // the chosen face — a second press lets go of it
    press(faces[1]); // another person — single-select, so this replaces
    press(faces[2]); // the repos nobody owns
    expect(picked).toEqual([undefined, 'IvanRoslov', null]);


  });

  describe('the controls row is legible to a reader and to a keyboard (#572 follow-up)', () => {
    /** The controls row alone. Tiles carry owner names and owner buttons of
     *  their own, so a claim about what the ROW says has to stop at the grid. */
    const rowOf = (html: string) => html.split('<div class="mt-[18px] grid')[0];

    it('leaves the pressed face carrying no word at all', () => {
      // It wore the first name beside the portrait, and the slot grew to fit it:
      // pressing the first face moved that face 22px left and the last face 11px
      // right. A face is a face in every state now.
      const on = pressedIn(owned({ owner: 'octocat' }));
      expect(on).toHaveLength(1);
      expect(textOf(on[0])).toBe('');
    });

    it('gives the pressed face the same box as a resting one, so the row holds still', () => {
      const slots = ownerSlots(buildTiles(OWNED, 'open'));
      const faceOf = (chosen: string | null | undefined) =>
        elementsOfType(OwnerRow({ slots, chosen, onOwner: () => {} }), 'button')[0];
      // Everything that decides how wide the slot draws — nothing else about it.
      const box = (className: string) =>
        className.split(' ').filter((k) => /^(?:h-|w-|size-|rounded|p[lrxy]?-|gap-|max-\[560px\]:)/.test(k)).sort();
      expect(box(faceOf(slots[0].login).className as string)).toEqual(
        box(faceOf(undefined).className as string),
      );
    });

    it('gives every control on the row a focus ring of its own', () => {
      // Chrome's default is a 1px navy hairline, which on this page's near-black
      // is very nearly nothing — so tabbing the row lost the cursor entirely. This
      // is the sidebar's own treatment (`.side-item:focus-visible`), said once in
      // `controls.ts` so five controls cannot drift into five rings.
      const html = owned({ owner: 'octocat' });
      const focusable = buttonsOf(rowOf(html));
      expect(focusable.length).toBeGreaterThan(2);
      for (const control of focusable) expect(control, textOf(control)).toContain(FOCUS_RING);
      // The search field's focusable part is the input inside it, so the box that
      // draws the field wears the ring.
      expect(html).toContain(FOCUS_RING_WITHIN);
    });

    it('marks the nobody slot with something other than the pressed state’s own ring', () => {
      // Pressed, it was a solid ring inside a solid ring, which reads as a radio
      // button rather than as "the repos nobody owns".
      const pressed = pressedIn(owned({ owner: null }))[0];
      expect(pressed).toContain('border-dashed');
      expect(pressed.match(/shadow-\[0_0_0_1\.5px/g) ?? []).toHaveLength(1);
    });

    it('widens the faces where a thumb has to hit them', () => {
      // 26px targets at a 4px pitch at 420px wide.
      const row = OwnerRow({ slots: ownerSlots(buildTiles(OWNED, 'open')), chosen: undefined, onOwner: () => {} });
      const [face] = elementsOfType(row, 'button');
      expect(face.className).toContain('max-[560px]:w-7');
      expect(face.className).toContain('max-[560px]:h-7');
    });
  });
});

describe('the sparkline reads one week (#576)', () => {
  /** One tile's chart, rendered on its own. */
  function spark(row: RepoRow): string {
    return renderToStaticMarkup(<RepoSpark row={row} />);
  }

  it('divides the chart into one hit column per week', () => {
    const html = spark(UI);
    const columns = [...html.matchAll(/data-point="(\d+)"/g)].map((m) => Number(m[1]));
    expect(columns).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('makes every week a real button saying which week it is (#708)', () => {
    // The columns used to be ten `aria-hidden` spans with a pointer handler and
    // nothing else: a reader without a mouse could not reach one, and a reader
    // with a screen reader was not told they existed. On the shared chart they
    // are buttons carrying the same sentence the hint shows, so the week is
    // readable without a pointer at all.
    const columns = buttonsOf(spark(UI)).filter((b) => b.includes('data-point='));
    expect(columns).toHaveLength(10);
    columns.forEach((column, i) => {
      expect(column, `week ${i}`).toContain(`aria-label="${weekHint(UI, i)}"`);
      expect(column, `week ${i}`).not.toContain('aria-hidden');
    });
    // One tab stop for the whole chart, not ten. The Repos map draws 78 of these.
    expect(columns.filter((c) => c.includes('tabindex="0"'))).toHaveLength(1);
  });

  it('catches no press, so a click on the chart still opens the repo’s queue', () => {
    // The tile is clickable through a plain `div` (`RepoTile.tsx`), and
    // `tileOpens` refuses only a prevented default, a modifier or a non-primary
    // button. A `<button type="button">` prevents nothing on click, so the card
    // still gets the event — provided the strip grows no handler that would
    // swallow it. That is the thing to hold: what the strip does NOT carry.
    const [strip] = elementsOfType(chartAt(UI, 3), ChartPoints);
    expect(strip, 'the chart draws no hit strip').toBeDefined();
    const handlers = propsIn(ChartPoints(strip as Parameters<typeof ChartPoints>[0]))
      .flatMap((p) => Object.keys(p))
      .filter((k) => k.startsWith('on'));
    expect(handlers).not.toContain('onClick');
    expect(handlers).not.toContain('onMouseDown');
    expect(handlers).not.toContain('onPointerDown');
    // …and the walk really did reach the columns, or the three above are three
    // assertions about an empty list.
    expect(handlers).toContain('onPointerEnter');
    // Nothing on the tile prevents the default either, which is the other half
    // of what `tileOpens` reads.
    const plain = { defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 };
    expect(tileOpens(plain)).toBe(true);
  });

  it('keeps the window total as the chart’s accessible name, never as a hover title', () => {
    const html = spark(UI);
    // The total is what a screen reader is given for the shape as a whole…
    expect(html).toContain(`aria-label="${flowTitle(UI)}"`);
    // …and no longer the OS grey box that used to answer every week with it.
    expect(html).not.toContain(`title="${flowTitle(UI)}"`);
    expect(html).not.toMatch(/title="[^"]*over ten weeks/);
  });

  it('does not draw a direction delta on the tile', () => {
    expect(textOf(spark(UI))).not.toContain('↑25');
    expect(textOf(spark(UI))).not.toContain('↓25');
  });

  it('leaves chart accessibility focused on the weekly data', () => {
    const html = spark(UI);
    expect(html).not.toContain('up 25');
    expect(html).not.toContain('aria-hidden="true">↑25');
    expect(html).toContain('aria-label="32 opened, 7 closed over ten weeks"');
  });

  it('lets the chart occupy the full available width', () => {
    expect(spark(UI)).not.toContain('w-[30px]');
    expect(spark(UI)).toContain('flex-1');
  });

  it.each([null, undefined, '2026-09-15T00:00:00.000Z'])(
    'draws a zero spark regardless of the last push (%s)', (pushedAt) => {
      const quiet = repo({ name: 'quiet', pushedAt, openIssuesState: 'read' });
      const html = spark(quiet);
      expect(textOf(html)).not.toContain('pushed');
      expect(html).toContain('<svg');
      expect(html).toContain('viewBox="0 0 150 26"');
      expect(html).toContain(`aria-label="${flowTitle(quiet)}"`);
      const paths = [...html.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
      expect(paths).toHaveLength(2);
      for (const path of paths) {
        const coordinates = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        expect(coordinates[0]).toBe(3);
        expect(coordinates.at(-2)).toBe(147);
        expect(coordinates.filter((_, i) => i % 2 === 1).every((y) => y === 23)).toBe(true);
      }
      expect(buttonsOf(html).filter((b) => b.includes('data-point='))).toHaveLength(10);
    },
  );

  it('replaces an unread issue spark with the repo page’s failed-read message', () => {
    for (const row of [repo({ name: 'failed' }), UI]) {
      const html = spark({ ...row, openIssuesState: 'unreadable' });
      expect(textOf(html)).toBe('Open issues couldn’t be read just now.');
      expect(html).not.toContain('<svg');
      expect(html).not.toContain('data-point=');
      expect(html).not.toContain('opened,');
    }
  });

  it('draws a zero baseline without inventing weeks for an empty series', () => {
    const html = spark(repo({ name: 'empty', weeks: [] }));
    expect(textOf(html)).not.toContain('pushed');
    expect(html).toContain('<svg');
    expect(html).toContain('M3 23 C');
    expect(html).toContain('147.0 23.0');
    expect(html).not.toContain('data-point=');
    expect(html).not.toContain('data-dot=');
  });

  it('keeps the push age off active cards too', () => {
    expect(textOf(spark({ ...UI, pushedAt: new Date().toISOString() }))).not.toContain('pushed');
  });

  /** The chart at a chosen week. `SparkChart` is the pure half — `RepoSpark`
   *  holds the hovered week above it — so the marks a hover draws, and the side
   *  the hint takes, can be read without a DOM. */
  const chartAt = (row: RepoRow, week: number | null) =>
    SparkChart({ row, mark: week, read: week, onWeek: () => {} });

  /** The same chart, drawn. The mark is `ui/chart-pointer`'s `ChartMark` now
   *  (#708), so what it puts inside this svg is markup rather than an element
   *  this file's own tree walk can count — and markup is the stronger reading
   *  of "one dot" anyway. */
  const drawnAt = (row: RepoRow, week: number | null) =>
    renderToStaticMarkup(<SparkChart row={row} mark={week} read={week} onWeek={() => {}} />);
  const countOf = (html: string, tag: 'line' | 'circle' | 'rect') =>
    (html.match(new RegExp(`<${tag}[ /]`, 'g')) ?? []).length;
  /** Count the terminal dot and the pointer's dot together: the one-dot rule
   *  applies whether a week is marked or the chart is at rest. */
  const dotsOf = (html: string) =>
    (html.match(/data-dot="repo-spark"|data-mark="dot"/g) ?? []).length;
  const markOf = (html: string, kind: string) => (html.match(new RegExp(`data-mark="${kind}"`, 'g')) ?? []).length;

  it('holds the reading when the pointer leaves the chart, and drops the mark', () => {
    // The hint opens to the RIGHT — the direction the pointer travels to reach
    // it. The moment it clears the chart's right edge the mark goes, and if the
    // words went with it the open box rewrote itself to the last week: pointing
    // at week 2 read "36 opened and 25 closed, 7 weeks ago", and moving into
    // the box to read it, still open, it said "14 opened and 12 closed this
    // week".
    // Two lifetimes, two pieces of state: the mark is on the chart and goes when
    // the pointer goes; the words are in the box and hold.
    const left = SparkChart({ row: UI, mark: null, read: 2, onWeek: () => {} });
    expect(elementsOfType(left, ChartHint)).toHaveLength(0);
    // And nothing is drawn on a chart nobody is pointing at.
    const html = renderToStaticMarkup(<SparkChart row={UI} mark={null} read={2} onWeek={() => {}} />);
    expect(countOf(html, 'line')).toBe(1);
    expect(dotsOf(html)).toBe(1);
    expect(countOf(html, 'circle')).toBe(0);
  });

  // The rule the state holder applies — pointing sets both, leaving clears only
  // the mark — is `ui/chart-pointer.spec.tsx`'s now, where the function lives
  // (#708). Asserted in one place, not two.

  it('does not render a tooltip for a hovered week, while retaining the marker', () => {
    const chart = chartAt(UI, 3);
    expect(elementsOfType(chart, ChartHint)).toHaveLength(0);
    expect(markOf(renderToStaticMarkup(<SparkChart row={UI} mark={3} read={3} onWeek={() => {}} />), 'dot')).toBe(1);
  });

  it('marks the hovered week with one closed dot and the selected brand guide', () => {
    // `max` is taken across BOTH series over the whole window, so one spike
    // compresses every other week into the bottom pixels of a 26px box. Measured
    // on `acme`: on eight weeks of ten the two dot centres are 0.13px apart
    // while their radii sum to 4.3 — the closed dot physically covers the opened
    // one, including a week reading 19 opened and 38 closed. The second marker
    // was ink and no information; the dot names the week and the hint gives both
    // numbers.
    //
    // #951 selected a dashed brand guide, and it shipped here first (#997).
    // Since #1030 it is `ChartGuide`, shared with the Throughput chart. The
    // primary-ink rule remains absent, and the closed point keeps its single
    // halo and dot.
    const hovered = drawnAt(UI, 3);
    expect(markOf(hovered, 'hairline')).toBe(0);
    expect(markOf(hovered, 'rule')).toBe(0);
    expect(markOf(hovered, 'guide')).toBe(1);
    expect(hovered).toMatch(/data-mark="guide"[^>]*stroke="var\(--accent\)"[^>]*stroke-width="1.5"[^>]*stroke-dasharray="2 3"/);
    expect(markOf(hovered, 'foot'), 'the foot tick is a column chart’s zero day').toBe(0);
    expect(markOf(hovered, 'dot')).toBe(1);
    expect(markOf(hovered, 'halo')).toBe(1);
    // The closed series is `var(--accent)` on this tile, which is the
    // module's own default, so the dot matches the line it sits on with nothing
    // passed. Read off the mark's `stroke`, the dot being a round-capped
    // zero-length line rather than a `<circle>` since #708's review.
    expect([...hovered.matchAll(/data-mark="dot"[^>]*stroke="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'var(--accent)',
    ]);
    expect(markOf(drawnAt(UI, null), 'hairline')).toBe(0);
    expect(markOf(drawnAt(UI, null), 'dot')).toBe(0);
    expect(markOf(drawnAt(UI, null), 'guide')).toBe(0);
  });

  it('hands the mark the COLUMN a week owns, which is not the gap between two weeks (#708)', () => {
    // `ChartMark` cannot measure a column: these charts are
    // `preserveAspectRatio="none"`, so a width in viewBox units is a different
    // width on screen for every caller and only the caller knows its own scale.
    //
    // What it is handed is the strip's partition and NOT this chart's: ten equal
    // columns over a 150-unit box, so a column is 15 — while the distance
    // between two adjacent weeks, which used to be passed here, is 16, because
    // the points are inset by PAD 3 at each end. Drawn from the gap, the band at
    // week 0 ran from x -5, and this svg is `overflow-visible`, so it painted
    // there: over the delta figure beside the chart.
    const [drawn] = elementsOfType(chartAt(UI, 3), ChartMark);
    expect(drawn, 'a marked chart draws no mark').toBeDefined();
    expect(drawn.column).toEqual({ i: 3, count: UI.weeks.length, width: 150 });
    const cxAt = (week: number) =>
      Number(/data-mark="dot"[^>]*x1="([^"]+)"/.exec(drawnAt(UI, week))![1]);
    expect(cxAt(4) - cxAt(3), 'the gap between two weeks is wider than a week’s column')
      .toBeGreaterThan(150 / UI.weeks.length);

    // A chart of one week needs no special case: one point is one column and the
    // column is the whole box, which is the honest answer where there is no
    // neighbouring column to be confused with.
    const oneWeek = { ...UI, weeks: UI.weeks.slice(0, 1) };
    expect(elementsOfType(chartAt(oneWeek, 0), ChartMark)[0].column)
      .toEqual({ i: 0, count: 1, width: 150 });
  });

  it('carries ONE dot whether or not a week is marked, and never two', () => {
    // The chart ends on a terminal dot, and a marked week draws its own on the
    // closed series. Both are `var(--accent)` at r 2.1 and r 2.4 — the same
    // colour and near enough the same size — so a hovered chart carried two
    // indistinguishable blue dots and only the hairline said which one was being
    // reported. The terminal dot steps aside while a week is marked: one dot at
    // any moment, and the hairline already says which week it belongs to.
    for (const week of [null, 0, 3, 9]) {
      expect(dotsOf(drawnAt(UI, week)), `week ${week}`).toBe(1);
    }
    // And the one dot a marked chart draws is the MARKED week's, not the last
    // week's — otherwise suppressing the terminal dot would just be deleting the
    // reported mark and leaving the decoration.
    const cxOf = (html: string) =>
      (/data-mark="dot"[^>]*x1="([^"]+)"/.exec(html) ?? /data-dot="repo-spark"[^>]*x1="([^"]+)"/.exec(html))![1];
    expect(cxOf(drawnAt(UI, 3))).not.toBe(cxOf(drawnAt(UI, null)));
  });

  it('removes the retired tile delta without changing weekly chart hints', () => {
    expect(textOf(spark(UI))).not.toContain('↑25');
    expect(textOf(spark(BOARD))).not.toContain('↓4');
    expect(tipLabels(chartAt(UI, 3))).not.toContain(deltaHint(UI));
    expect(flowTitle(UI)).toBe('32 opened, 7 closed over ten weeks');
  });

});

/** Every plain string in a rendered SUBTREE, so a line can be asserted to be
 *  somewhere other than where it used to be. It does not descend into a child
 *  COMPONENT's output — nothing here needs it to, and the components in the
 *  controls row are identified by their element type instead. */
function wordsIn(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') return (out.push(node), out);
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) wordsIn(n, out);
    return out;
  }
  const el = node as { props?: Props };
  if (el.props?.children !== undefined) wordsIn(el.props.children, out);
  return out;
}

/** The controls row itself: the one wrapping <div> that lays the search field,
 *  the chips, the faces and the order control out on a line. */
function controlsRow(node: unknown): Props {
  const rows = elementsOfType(node, 'div').filter((p) => String(p.className).includes('flex-wrap'));
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Every onClick in a rendered element tree, in document order. The components
 *  under test are plain functions with no hooks, so calling one returns its
 *  tree and the handlers can be driven without a DOM. */
type Press = { stopPropagation: () => void };
function clickHandlers(node: unknown, out: ((e: Press) => void)[] = []): ((e: Press) => void)[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) clickHandlers(n, out);
    return out;
  }
  const el = node as { props?: { onClick?: (e: Press) => void; children?: unknown } };
  if (typeof el.props?.onClick === 'function') out.push(el.props.onClick);
  if (el.props?.children !== undefined) clickHandlers(el.props.children, out);
  return out;
}

/** Every element of a given type in a rendered tree, with its props.
 *
 *  A hint is NOT in the markup: the board's tooltip renders its label into a
 *  portal that exists only while the pointer is on the trigger, so
 *  `renderToStaticMarkup` sees the trigger and nothing else. The element tree is
 *  where a hint can be read, and where a trigger can be checked for handlers it
 *  should not have grown. */
type Props = Record<string, unknown> & { children?: unknown };
function elementsOfType(node: unknown, type: unknown, out: Props[] = []): Props[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) elementsOfType(n, type, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Props };
  if (el.type === type && el.props) out.push(el.props);
  if (el.props?.children !== undefined) elementsOfType(el.props.children, type, out);
  return out;
}

/** The hints a tree hangs off the board's tooltip, in document order.
 *
 *  `Hint`, not `Tip`: every hint on this page goes through the module's own
 *  bounded wrapper (#573 follow-up), and the label it carries is still the plain
 *  sentence `repos-vm.ts` wrote — the bounding is applied inside `Hint`, one
 *  level down, where a call site cannot forget it. */
/** Every <button> in a rendered page, as its own chunk of markup — so a state
 *  can be asserted on the control that wears it rather than on a distance
 *  between two attributes. */
function buttonsOf(html: string): string[] {
  return [...html.matchAll(/<button[\s\S]*?<\/button>/g)].map((m) => m[0]);
}

/** Fire a host element's onClick, as a press does. */
function press(el: Props): void {
  (el.onClick as () => void)();
}

/** A real press on one row of a command menu.
 *
 *  `MenuOption` is the board's shared chrome and it reports on `onMouseDown` —
 *  so that a click inside a popover cannot blur the field owning it before the
 *  select fires. Calling the row's `onSelect` directly would skip that, and the
 *  press under test would be the spec's own rather than the control's. So the
 *  row is rendered and its real handler is the thing that runs. */
function pressMenuRow(row: Props): void {
  const [button] = elementsOfType(MenuOption(row as Parameters<typeof MenuOption>[0]), 'button');
  (button.onMouseDown as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
}

function tips(node: unknown): Props[] {
  return elementsOfType(node, Hint);
}
function tipLabels(node: unknown): unknown[] {
  return tips(node).map((t) => t.label);
}

/** The chart's OWN hint, which is `ui/chart-pointer`'s and no longer this
 *  page's `Hint` (#708) — so `tips()` above finds the figure's box and not this
 *  one. Rendered a level down, because the side is a DEFAULT in that module and
 *  a default is not a prop: reading it off `ChartHint`'s element would report
 *  `undefined` for the very thing this page measured. */
function chartTip(node: unknown): Props {
  const [hint] = elementsOfType(node, ChartHint);
  expect(hint, 'the chart hangs no hint').toBeDefined();
  const [tip] = elementsOfType(ChartHint(hint as Parameters<typeof ChartHint>[0]), Tip);
  return { ...tip, label: (tip.label as ReactElement<{ children: unknown }>).props.children };
}

/** Every element's props in a tree, whatever its type — for asking what a
 *  subtree does NOT carry. */
function propsIn(node: unknown, out: Props[] = []): Props[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) propsIn(n, out);
    return out;
  }
  const el = node as { props?: Props };
  if (el.props) out.push(el.props);
  if (el.props?.children !== undefined) propsIn(el.props.children, out);
  return out;
}

describe('the owner control (#558)', () => {
  it('picking an owner writes it and shows the new owner', async () => {
    const returned: RepoOwner = { login: 'IvanRoslov', name: 'Ivan Roslov' };
    dri.mockResolvedValue(returned);
    const bumped: number[] = [];

    const store = createFacetEdit(ownerEdit(BOARD, { onWritten: () => bumped.push(1) }));
    await store.edit({ login: 'IvanRoslov', name: nameOf('IvanRoslov') });

    expect(dri).toHaveBeenCalledWith('acme', 'board.example.com', 'IvanRoslov');
    // Reconciled to what the server returned, not to the optimistic guess: the
    // tile now shows the name Github confirmed.
    expect(store.value).toEqual(returned);
    expect(bumped).toHaveLength(1);
    expect(textOf(renderToStaticMarkup(
      <OwnerPicker row={{ ...BOARD, owner: store.value }} driOptions={['octocat', 'IvanRoslov']} canWrite />,
    // First name on the tile — the footer shares its line with the coloured word
    // a repo with something to report draws, so the full name is one hover away
    // on the control's accessible name instead.
    ))).toContain('Ivan');
  });

  it('a write Github refused rolls back, says so, and offers no retry', async () => {
    // #577's shape exactly: Github answers a write it will never accept, and
    // the tile used to reply with four words and a button that could only ever
    // produce those four words again.
    dri.mockRejectedValue(new ApiError(403, 'set dri 403'));
    const bumped: number[] = [];

    const store = createFacetEdit(ownerEdit(BOARD, { onWritten: () => bumped.push(1) }));
    await store.edit({ login: 'IvanRoslov', name: 'Ivan Roslov' });

    // The prior owner is back — a refused write never keeps the optimistic value.
    expect(store.value).toEqual(ADA);
    expect(store.status).toBe('error');
    expect(bumped).toHaveLength(0);

    const html = renderToStaticMarkup(
      <OwnerControl
        row={BOARD}
        owner={store.value}
        editable
        status="error"
        failure={store.failure}
        onRetry={() => {}}
      />,
    );
    // What happened, rather than the fact that something did.
    expect(textOf(html)).toContain('The board isn’t allowed');
    expect(textOf(html)).not.toContain('Couldn’t save');
    // And no invitation to press a button that cannot change the answer. The
    // one control left is the note itself, which only dismisses (see below).
    expect(textOf(html)).not.toContain('Retry');
    expect(html).toContain('Click to dismiss');
  });

  it('a write that merely broke keeps its retry, and the retry still lands', async () => {
    dri.mockRejectedValueOnce(new ApiError(500, 'set dri 500'));
    const bumped: number[] = [];

    const store = createFacetEdit(ownerEdit(BOARD, { onWritten: () => bumped.push(1) }));
    await store.edit({ login: 'IvanRoslov', name: 'Ivan Roslov' });

    expect(store.value).toEqual(ADA);
    expect(store.failure).toEqual({ text: 'Couldn’t save', canRetry: true });

    const html = renderToStaticMarkup(
      <OwnerControl
        row={BOARD}
        owner={store.value}
        editable
        status="error"
        failure={store.failure}
        onRetry={() => {}}
      />,
    );
    expect(textOf(html)).toContain('Couldn’t save');
    expect(textOf(html)).toContain('Retry');

    dri.mockResolvedValue({ login: 'IvanRoslov', name: 'Ivan Roslov' });
    await store.retry();
    expect(store.value).toEqual({ login: 'IvanRoslov', name: 'Ivan Roslov' });
    expect(store.failure).toBeNull();
  });

  it('a permanent refusal still leaves a way back to a working tile', async () => {
    // Withholding Retry withholds the only control the tile had, so before this
    // the note stayed — no owner, no picker — until the tile unmounted. Sync
    // now could not clear it and neither could the rebuild (#577 round 2).
    dri.mockRejectedValue(new ApiError(403, 'set dri 403'));
    const store = createFacetEdit(ownerEdit(BOARD, { onWritten: () => {} }));
    await store.edit({ login: 'IvanRoslov', name: 'Ivan Roslov' });

    const failed = renderToStaticMarkup(
      <OwnerControl
        row={BOARD}
        owner={store.value}
        editable
        status="error"
        failure={store.failure}
        onDismiss={() => {}}
      />,
    );
    // No retry — pressing it could not work — but the note IS pressable.
    expect(textOf(failed)).not.toContain('Retry');
    expect(failed).toContain('<button');

    store.dismiss();

    const back = renderToStaticMarkup(
      <OwnerControl row={BOARD} owner={store.value} editable status={store.status} failure={store.failure} />,
    );
    // The owner that survived the refusal, and the picker, both back.
    expect(textOf(back)).toContain('Octocat');
    expect(back).toContain('Click to change');
  });

  it('a retryable failure keeps its retry and nests no control inside another', async () => {
    dri.mockRejectedValue(new ApiError(500, 'set dri 500'));
    const store = createFacetEdit(ownerEdit(BOARD, { onWritten: () => {} }));
    await store.edit({ login: 'IvanRoslov', name: 'Ivan Roslov' });

    const html = renderToStaticMarkup(
      <OwnerControl
        row={BOARD}
        owner={store.value}
        editable
        status="error"
        failure={store.failure}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(textOf(html)).toContain('Retry');
    // A <button> inside a <button> is invalid HTML, exactly as this file already
    // refuses for the tile's anchor. Retry is the way out here, so nothing wraps.
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('a background poll does not quietly erase a refusal the person never saw', async () => {
    // The map refetches every 120s and on focus. An owned repo hands down a new
    // owner OBJECT each time, an unowned one hands down null — so clearing on
    // refetch cleared the note on some tiles and not others, and on an owned
    // tile it could wipe the refusal before anyone read it, leaving the old
    // owner and a live picker as if nothing had happened.
    dri.mockRejectedValue(new ApiError(403, 'set dri 403'));
    const store = createFacetEdit(ownerEdit(BOARD, { onWritten: () => {} }));
    await store.edit({ login: 'IvanRoslov', name: 'Ivan Roslov' });
    expect(store.status).toBe('error');

    // What `useFacetEdit`'s effect does when the page hands down a new row.
    store.reset({ login: 'octocat', name: 'Octocat' });

    expect(store.status).toBe('error');
    expect(store.failure).not.toBeNull();
  });

  it('an unowned tile and an owned one answer a refetch identically', async () => {
    dri.mockRejectedValue(new ApiError(403, 'set dri 403'));
    const owned = createFacetEdit(ownerEdit(BOARD, { onWritten: () => {} }));
    const unowned = createFacetEdit(ownerEdit({ ...BOARD, owner: null }, { onWritten: () => {} }));
    await owned.edit({ login: 'IvanRoslov', name: 'Ivan Roslov' });
    await unowned.edit({ login: 'IvanRoslov', name: 'Ivan Roslov' });

    owned.reset({ login: 'octocat', name: 'Octocat' }); // a new object every poll
    unowned.reset(null); // the same null every poll

    expect([owned.status, unowned.status]).toEqual(['error', 'error']);
  });

  it('says saving is unavailable for the moment, and keeps the retry that fixes it', async () => {
    dri.mockRejectedValue(new ApiError(503, 'set dri 503'));
    const store = createFacetEdit(ownerEdit(BOARD, { onWritten: () => {} }));

    await store.edit({ login: 'IvanRoslov', name: 'Ivan Roslov' });

    const html = renderToStaticMarkup(
      <OwnerControl row={BOARD} owner={store.value} editable status="error" failure={store.failure} />,
    );
    expect(textOf(html)).toContain('Can’t save right now');
    // Retryable: a 503 on a tile is a rollout, and waiting a moment fixes it.
    expect(textOf(html)).toContain('Retry');
  });

  it('the page draws no owner control on any tile when the schema SAYS restricted', () => {
    const restricted = render({ view: { ...view(), ownerWritability: 'restricted' } });

    // Every tile still names its owner; not one of them offers to change it.
    expect(textOf(restricted)).toContain('Octocat');
    expect(restricted).not.toContain('Click to change');
    // And with the property writable it does — so this asserts the difference,
    // not merely the absence of a string.
    expect(render()).toContain('Click to change');
  });

  it('keeps the control on an org repo when a personal owner makes the union not-applicable (#1444)', () => {
    // Production since #1209: the served owners include the person's own
    // account. Its schema is `not-applicable`, so the server's fold makes the
    // union `not-applicable` while every org row still says `writable`.
    const PERSONAL = repo({
      name: 'notes',
      full: 'octocat/notes',
      htmlUrl: 'https://github.com/octocat/notes',
      ownerWritability: 'not-applicable',
    });
    const mixed = render({
      view: {
        ...view([{ ...BOARD, ownerWritability: 'writable' }, PERSONAL]),
        driOptionsByOrg: { 'acme': ['octocat', 'IvanRoslov'], octocat: ['octocat'] },
        ownerWritability: 'not-applicable',
      },
    });

    // The org repo offers its picker. The personal repo has a roster too, so
    // its missing picker comes from its own `not-applicable` row.
    expect(mixed.split('Click to change')).toHaveLength(2);
  });

  it('keeps the control when the schema was read but its setting was not understood', () => {
    // One of the two ways to reach `unknown`: the read SUCCEEDED and returned a
    // `values_editable_by` we do not recognise, so the allowed values are real.
    // There is something to pick, so the picker is drawn — and the write is
    // refused server-side out loud and retryably, which is a person's cue.
    const unknown = render({ view: { ...view(), ownerWritability: 'unknown' } });

    expect(unknown).toContain('Click to change');
  });

  it('draws no picker when there are no logins, whatever the writability kept', () => {
    // This USED to say "the other way to reach `unknown` is a read that
    // failed". That stopped being true when #649 split the union: a failed read
    // is `unreadable` now. The combination below is still reachable — a `dri`
    // row with a null `allowed_values` and a `values_editable_by` we do not
    // recognise — and it is still the case worth pinning, because the
    // writability KEEPS the control here and the empty options take it anyway.
    //
    // Which is the right trade: the menu would offer one row, "No owner", so
    // the only reachable action is destructive, on a control that cannot do the
    // thing it is for. And `ownerWriteEnv` re-reads the schema on every press,
    // so if the read recovers on that press the clear LANDS and wipes an owner
    // that was correctly set.
    const blind = render({ view: { ...view(), ownerWritability: 'unknown', driOptions: [] } });

    expect(textOf(blind)).toContain('Octocat'); // the owner is still shown
    expect(blind).not.toContain('Click to change');
  });

  it('draws no picker whenever the schema offers no logins, whatever it says about writing', () => {
    // The rule is "draw a picker when there is something to pick", not "when we
    // think we may write". An org with no allowed values has nothing to assign.
    const empty = render({ view: { ...view(), ownerWritability: 'writable', driOptions: [] } });

    expect(empty).not.toContain('Click to change');
  });

  it('treats a server too old to say anything as it always behaved', () => {
    // board-web can ship ahead of board-api. An absent field must not read as
    // "restricted" and blank the control across the map mid-deploy.
    const legacy = { ...view() } as Partial<ReposView>;
    delete legacy.ownerWritability;

    expect(render({ view: legacy as ReposView })).toContain('Click to change');
  });

  it('draws no owner control when the ORG has no dri property to write (#649)', () => {
    // `absent` is not "we could not tell" — the org's schema list read fine and
    // holds no such property. Permanent, like `restricted`, so the control that
    // writes it is not offered. `driOptions` is left populated on purpose: this
    // asserts the WRITABILITY withholds the control, not the empty-options
    // guard beside it, which would hide the picker either way and make the
    // assertion pass whatever this branch did.
    const none = render({ view: { ...view(), ownerWritability: 'absent' } });

    expect(none).not.toContain('Click to change');
    // …and the same view with the property merely unrecognised keeps it, so
    // this is the difference between two states rather than an absence.
    expect(render({ view: { ...view(), ownerWritability: 'unknown' } })).toContain('Click to change');
  });

  it('says the org has no owner field, instead of offering to set one (#649)', () => {
    // The shape the server actually sends for `absent`: no property means no
    // allowed values either. A repo nobody owns and a repo whose ORG cannot
    // record an owner must not read alike — that distinction is the point.
    const none = render({ view: { ...view(), ownerWritability: 'absent', driOptions: [] } });

    expect(textOf(none)).toContain('No owner field');
    expect(textOf(none)).not.toContain('Set owner');
    // The owned tile is untouched: the property holds a value there, and how it
    // got there is not the tile's sentence.
    expect(textOf(none)).toContain('Octocat');
    // And the unowned tiles DO say "Set owner" in every other state, so the
    // line above is a change of words rather than a string that never appears.
    expect(textOf(render())).toContain('Set owner');
  });

  it('never reads a failed schema read as a fact about the org (#649)', () => {
    // `unreadable` is a fact about this board's TOKEN. Printing the org's
    // limitation for it would be #577's error inverted.
    //
    // `driOptions` is left populated to ISOLATE the writability gate, and that
    // is not the combination a person meets: the server ships `allowedValues:
    // []` on every failed read (`github-repos.source.ts`), so in production the
    // picker goes anyway, by the empty-options gate the test above pins. What
    // this holds is that the WRITABILITY is not what took it — so a read that
    // recovers restores the control with no code change.
    const blind = render({ view: { ...view(), ownerWritability: 'unreadable' } });

    expect(textOf(blind)).not.toContain('No owner field');
    expect(textOf(blind)).toContain('Set owner');
    expect(blind).toContain('Click to change');
  });

  // The failure affordance is shared with every editable facet on the issue
  // page, and none of those pass a reason. This pins that they are untouched:
  // without a reason the note is the exact words and the exact Retry it has
  // always been (#577 changed the tile, not the issue page).
  it('no failure string outgrows the tile at the NARROWEST width the grid makes', () => {
    // Two things the old version of this guard got wrong. It measured `text`
    // alone, while a retryable note renders text + "·" + Retry — so it
    // under-measured every retryable case by the whole suffix. And it used
    // 274px, which is only what the tile happens to be on a wide screen: the
    // grid is `repeat(auto-fill,minmax(236px,1fr))`, so at a 1280 viewport the
    // tile is 237px. Both budgets below are measured there.
    for (const status of [400, 401, 403, 404, 422, 500, 502, 503]) {
      const failure = describeEditFailure(new ApiError(status, 'x'));
      expect(failure.text.length).toBeLessThanOrEqual(failureTextBudget(failure));
    }
  });

  it('the budget is not so generous that nothing could ever hit it', () => {
    const retryable = describeEditFailure(new ApiError(503, 'x'));
    expect(retryable.canRetry).toBe(true);
    // One character of headroom at the narrowest tile. If this ever reads as
    // comfortable, the budget has been raised rather than the string shortened.
    expect(failureTextBudget(retryable) - retryable.text.length).toBeLessThanOrEqual(2);
  });

  it('the guard rejects the string measured to wrap the card 14px taller', () => {
    // Driven at 237px: this exact text, with Retry beside it, took the card
    // from 112.546875 to 126.546875. The previous guard passed it.
    const wraps = { text: 'Couldn’t reach the board!!', canRetry: true };
    expect(wraps.text).toHaveLength(26);
    expect(wraps.text.length).toBeGreaterThan(failureTextBudget(wraps));
  });

  it('a permanent note may run longer than a retryable one, because Retry is not beside it', () => {
    // The suffix is the whole difference, so one budget for both would either
    // permit a wrap or forbid a string that fits.
    expect(failureTextBudget({ canRetry: false })).toBeGreaterThan(failureTextBudget({ canRetry: true }));
  });

  // The tile is clickable, so anything drawn inside it that does not stop its
  // own click opens the repo's page instead. Measured at 2df0a54, back when the
  // tile opened the queue: pressing Retry navigated to /overview?repo=board rather
  // than retrying. The destination has changed (#575); the trap has not.
  it('pressing Retry retries, and does not open the repo underneath it', () => {
    const retried: number[] = [];
    const press = { defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 };
    let stopped = false;

    retryPress({ ...press, stopPropagation: () => { stopped = true; } }, () => retried.push(1));

    expect(retried).toHaveLength(1);
    expect(stopped).toBe(true);
    // The tile's own handler only ever sees a click that reached it.
    const navigated: string[] = [];
    if (!stopped && tileOpens(press)) navigated.push(repoPath(BOARD.full));
    expect(navigated).toEqual([]);
  });

  it('pressing the red text of a retryable note does nothing at all', () => {
    // Not a control: Retry is. But it must not fall through to the tile either,
    // or the two red notes — one dismissible, one not — do opposite things.
    const navigated: string[] = [];
    const press = { defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 };
    let stopped = false;

    ownerPress({ ...press, stopPropagation: () => { stopped = true; } }, () => {});

    expect(stopped).toBe(true);
    if (!stopped && tileOpens(press)) navigated.push(repoPath(BOARD.full));
    expect(navigated).toEqual([]);
  });

  // Testing `retryPress` proves the function; it does not prove anything CALLS
  // it. These drive the components' own output — they are plain functions with
  // no hooks, so calling one yields the element tree its click handlers hang off
  // — which is the only thing that catches the wiring being undone.
  it('the Retry button is wired through the press that stops the click', () => {
    const retried: number[] = [];
    let stopped = false;

    const handlers = clickHandlers(Failed({ onRetry: () => retried.push(1) }));
    expect(handlers).toHaveLength(1);
    handlers[0]({ stopPropagation: () => { stopped = true; } });

    expect(retried).toHaveLength(1);
    expect(stopped).toBe(true);
  });

  it('the retryable note swallows its own click, so the tile beneath stays put', () => {
    let stopped = false;
    // One handler: the wrapper. Retry's own is inside <Failed>, pinned above.
    const handlers = clickHandlers(
      OwnerControl({
        row: BOARD,
        owner: ADA,
        editable: true,
        status: 'error',
        failure: { text: 'Couldn’t reach GitHub', canRetry: true },
        onRetry: () => {},
      }),
    );

    expect(handlers).toHaveLength(1);
    handlers[0]({ stopPropagation: () => { stopped = true; } });
    expect(stopped).toBe(true);
  });

  it('the dismiss note is wired to dismiss, and stops the click doing it', () => {
    const dismissed: number[] = [];
    let stopped = false;

    const handlers = clickHandlers(
      OwnerControl({
        row: BOARD,
        owner: ADA,
        editable: true,
        status: 'error',
        failure: { text: 'The board isn’t allowed', canRetry: false },
        onDismiss: () => dismissed.push(1),
      }),
    );

    expect(handlers).toHaveLength(1);
    handlers[0]({ stopPropagation: () => { stopped = true; } });
    expect(dismissed).toHaveLength(1);
    expect(stopped).toBe(true);
  });

  // `Failed` is shared with the eight issue-page editors, and PropertyRow's own
  // container takes clicks to open the facet's popover. Stopping the click
  // therefore changes those eight too — pressing Retry no longer opens the
  // editor on top of the retry. Pinned here, beside the other guards this file
  // already keeps for the shared component, because PropertyRow has no spec.
  it('pressing Retry on an issue-page row does not also open that row’s editor', () => {
    const opened: number[] = [];
    const row = PropertyRow({
      label: 'Assignees',
      editable: true,
      status: 'error',
      onEdit: () => opened.push(1),
      onRetry: () => {},
      children: null,
    });

    // The row really does have a handler to fall through to — without this the
    // rest of the test would pass against a row that simply had none.
    const container = clickHandlers(row);
    expect(container).toHaveLength(1);

    // Retry's own press, and what reaches the row after it.
    let stopped = false;
    retryPress({ stopPropagation: () => { stopped = true; } }, () => {});
    if (!stopped) container[0]({ stopPropagation: () => {} });

    expect(stopped).toBe(true);
    expect(opened).toEqual([]);
  });

  it('a caller that tracks no reason keeps the wording every other facet has', () => {
    const html = renderToStaticMarkup(<Failed onRetry={() => {}} />);
    expect(textOf(html)).toBe('Couldn’t save · Retry');
  });

  it('offers only the schema’s allowed values in the picker', () => {
    const html = renderToStaticMarkup(
      <OwnerMenu options={[{ login: 'octocat', label: 'Octocat' }, { login: null, label: 'No owner' }]} value={null} onPick={() => {}} />,
    );
    const text = textOf(html);
    // A search over the owners, since #1021; one value is not a size, so the
    // field names the set without a count.
    expect(html).toContain('placeholder="Search owners"');
    expect(text).toContain('Octocat');
    expect(text).toContain('No owner');
    // Nobody the `dri` schema doesn't allow — the menu can't offer a login
    // Github would refuse.
    expect(text).not.toContain('Ivan');
    expect(html.match(/\bcmdk-item=""/g)).toHaveLength(2);
  });

  it('does not offer to change the owner when the viewer cannot write', () => {
    const html = renderToStaticMarkup(
      <OwnerPicker row={BOARD} driOptions={['octocat', 'IvanRoslov']} canWrite={false} />,
    );
    expect(textOf(html)).toContain('Octocat');
    // The full name is still reachable — it just isn't what the tile prints.
    expect(html).toContain('Octocat');
    // A control that cannot work must not look like one.
    expect(html).not.toContain('<button');
    expect(html).not.toContain('role="button"');
  });
});

describe('the owner picker offers only what that repo’s own org would accept (#728)', () => {
  // Two orgs with different rosters — the shape the union view has served since
  // #697, and the one `driOptions` cannot answer for. It is every served org's
  // values concatenated (`ReposView.driOptions`), so it is NOT a list any one
  // org accepts, while the write gate compares against ONE org's. Offering the
  // union puts a login on the menu the target org's gate then refuses and the
  // press 400s: a control offered and then refused, which is what #635 and #653
  // exist to stop. `driOptionsByOrg` is the exact answer, keyed by the org in
  // its CONFIGURED spelling.
  const HUB = repo({ name: 'board.example.com', key: 'board', open: 9, owner: ADA });
  const ACME = repo({ name: 'widgets', full: 'Acme-Corp/widgets', key: 'widgets', open: 4 });

  const UNION = ['octocat', 'IvanRoslov', 'acme-dev'];

  function twoOrgs(over: Partial<ReposView> = {}): ReposView {
    return {
      ...view([HUB, ACME]),
      driOptions: UNION,
      driOptionsByOrg: { 'acme': ['octocat', 'IvanRoslov'], 'Acme-Corp': ['acme-dev'] },
      ...over,
    };
  }

  /** What each tile on the page was actually handed to offer, by repo key. The
   *  menu itself is not in the markup — it exists only while it is open, and
   *  this suite has no DOM to open it with — so the tile's own props are where
   *  the offer can be read, the same way the controls row is read below. */
  function offered(v: ReposView): Record<string, string[]> {
    const tiles = elementsOfType(body({ view: v }), RepoTile);
    expect(tiles.map((t) => (t.tile as { row: RepoRow }).row.key).sort()).toEqual(['board', 'widgets']);
    return Object.fromEntries(
      tiles.map((t) => [(t.tile as { row: RepoRow }).row.key, t.driOptions as string[]]),
    );
  }

  it('hands each tile its OWN org’s logins, not every served org’s', () => {
    expect(offered(twoOrgs())).toEqual({
      board: ['octocat', 'IvanRoslov'],
      widgets: ['acme-dev'],
    });
  });

  it('matches the org case-insensitively, so a spelling difference cannot empty a picker', () => {
    // The map is keyed as the org is CONFIGURED and `full` carries Github's own
    // spelling of it. The two differ by case on a routine deployment, and an
    // exact-match lookup would quietly hand that org's tiles the union — or,
    // once the fallback is gone, nothing at all.
    const flipped = twoOrgs({
      driOptionsByOrg: { 'Acme': ['octocat', 'IvanRoslov'], 'acme-corp': ['acme-dev'] },
    });

    expect(offered(flipped)).toEqual({ board: ['octocat', 'IvanRoslov'], widgets: ['acme-dev'] });
  });

  it('falls back to the union where the map carries no entry for that org', () => {
    // Not the same as an org whose entry is an empty list: that org was served
    // and has nothing to offer, this one was not described at all. Falling back
    // is what the page did before this field existed, and a repo whose org is
    // missing from the map is the one case where that is still the best answer.
    const partial = twoOrgs({ driOptionsByOrg: { 'acme': ['octocat', 'IvanRoslov'] } });

    expect(offered(partial)).toEqual({ board: ['octocat', 'IvanRoslov'], widgets: UNION });
  });

  it('treats a board-api too old to send the map exactly as the page behaved before it', () => {
    // board-web ships ahead of board-api, so across a deploy window the field is
    // simply not on the response. Absent is not "no org has any logins": every
    // tile goes on being offered the union, which is what it was offered
    // yesterday.
    const legacy = { ...twoOrgs() } as Partial<ReposView>;
    delete legacy.driOptionsByOrg;

    expect(offered(legacy as ReposView)).toEqual({ board: UNION, widgets: UNION });
  });

  it('withholds the picker on an org with no logins of its own, and keeps it on its neighbour', () => {
    // `OwnerPicker`'s empty-options gate now works off the list that repo
    // actually got, so it is decided per repo. An org whose schema read failed
    // reaches this with `[]` — and its tiles must not borrow another org's
    // logins to draw a menu that cannot write here.
    const html = render({ view: twoOrgs({ driOptionsByOrg: { 'acme': ['octocat'], 'Acme-Corp': [] } }) });

    expect(tileHtml(html, 'board')).toContain('Click to change');
    expect(tileHtml(html, 'widgets')).not.toContain('Click to change');
    // …and the same page with logins for both keeps both, so the line above is
    // a difference between two orgs rather than a picker nothing ever draws.
    const both = render({ view: twoOrgs() });
    expect(tileHtml(both, 'board')).toContain('Click to change');
    expect(tileHtml(both, 'widgets')).toContain('Click to change');
  });
});

describe('the page names the orgs it could not read, and says which read failed (#718)', () => {
  // Two sentences over two DIFFERENT org sets, and the difference is the whole
  // point of there being two. An org whose repo enumeration failed has no rows
  // here at all — "these numbers leave it out" is exactly true of it. An org
  // whose rows ARE on the map, with an ownership read or an alert read that
  // refused beside them, would be libelled by that sentence: the reader is
  // looking at its repos while being told they are missing.
  const HUB = repo({ name: 'board.example.com', key: 'board', open: 9, owner: ADA });
  const APLITENI = repo({ name: 'widgets', full: 'globex/widgets', key: 'widgets', open: 4 });
  /** The row-level state: no org-level list names an org whose `dri` read
   *  failed, so the org is reachable ONLY through its rows. */
  const OWNERLESS = repo({
    name: 'engine', full: 'gtm/engine', key: 'engine', open: 2, ownerState: 'unreadable',
  });

  const LEFT_OUT = 'These numbers leave out';
  const HERE = 'The repos are here for';

  function pageWith(
    over: Partial<ReposView>,
    healthOrgs: readonly string[] = [],
    rows: RepoRow[] = [HUB, APLITENI, OWNERLESS],
  ): string {
    return render({ view: { ...view(rows), ...over }, unreadHealthOrgs: healthOrgs });
  }

  it('draws neither sentence when nothing was unread', () => {
    // No reassuring state: a board that read everything says nothing about it.
    const html = textOf(render());
    expect(html).not.toContain(LEFT_OUT);
    expect(html).not.toContain(HERE);
  });

  it('says an org is LEFT OUT when its repos are absent from the map, and says nothing else', () => {
    // Rows that were all read, so the only gap on this page is the lost org and
    // the second sentence has nothing to be about.
    const html = textOf(pageWith({ unreadableOrgs: ['acme'] }, [], [HUB, APLITENI]));
    expect(html).toContain('These numbers leave out acme. The board could not read it.');
    expect(html).not.toContain(HERE);
  });

  it('says the repos ARE here for an org whose alert lists refused', () => {
    const html = textOf(pageWith({}, ['globex']));
    expect(html).toContain('The repos are here for globex. The board could not read its alerts.');
    expect(html).not.toContain(LEFT_OUT);
  });

  it('names an org that only its ROWS can name — no list carries a failed owner read', () => {
    // `ReposHealthView.unreadableOrgs` names the alert failures and
    // `ReposView.unreadableOrgs` names the lost enumerations. An ownership read
    // that failed is reported per ROW and nowhere else, so deriving it from the
    // rows is the only way this org is named at all.
    const html = textOf(pageWith({}));
    expect(html).toContain('The repos are here for gtm. The board could not read its owners.');
  });

  it('says BOTH when one org lost its owners and its alerts', () => {
    const html = textOf(pageWith({}, ['gtm']));
    expect(html).toContain('The repos are here for gtm. The board could not read its owners or its alerts.');
    // …and gtm is named once, not once per read.
    expect(html.match(/gtm/g)).toHaveLength(1);
  });

  it('never names an absent org in the second sentence as well', () => {
    // An org can be in both payloads' lists — its enumeration failed AND its
    // alert lists refused. It has no rows on the map, so only the first
    // sentence is true of it, and hearing about it twice is hearing two
    // different claims about one org.
    const html = textOf(pageWith({ unreadableOrgs: ['acme'] }, ['acme', 'globex']));
    expect(html).toContain('These numbers leave out acme');
    expect(html).toContain('The repos are here for globex');
    expect(html).not.toContain('here for acme');
  });

  it('matches an org across the two spellings, so one org is not named twice', () => {
    // The lists carry the CONFIGURED spelling and `full` carries Github's. A
    // case difference between them must not turn one org into two sentences.
    const html = textOf(pageWith({}, ['GTM']));
    expect(html).toContain('The repos are here for GTM. The board could not read its owners or its alerts.');
    expect(html).not.toContain('here for gtm —');
  });

  it('draws both sentences at once when both sets have something in them', () => {
    const html = textOf(pageWith({ unreadableOrgs: ['acme'] }, ['globex']));
    expect(html).toContain('These numbers leave out acme');
    expect(html).toContain('The repos are here for globex. The board could not read its alerts.');
  });
});

describe('what the board could not read is not what it read, on the tile (#718)', () => {
  // Every pairing below is two facts that draw the same today and must not: a
  // repo nobody owns beside one whose ownership read failed, and a repo with no
  // open alerts beside one whose alert lists refused. Each pair is asserted
  // together, because what matters is the DIFFERENCE — a test that only checked
  // the new words would pass on a tile that said them everywhere.
  const NOBODY = repo({ name: 'unowned', open: 9 });
  const UNREAD_OWNER = repo({ name: 'engine', open: 8, ownerState: 'unreadable' });
  const MEASURED_CLEAN = repo({ name: 'calm', open: 7 });
  const UNREAD_ALERTS = repo({ name: 'quiet-lib', open: 6, security: { ...NO_SECURITY, state: 'unreadable' } });
  /** Alerts unread AND a red build: the tile has one word and two candidates. */
  const BOTH = repo({
    name: 'infra', open: 5, ci: 'failure', security: { ...NO_SECURITY, state: 'unreadable' },
  });
  /**
   * The pairing this suite was missing, and it is an ordinary payload.
   *
   * `state: 'unreadable'` means ANY ONE of the org's three alert lists refused
   * (`repo.types.ts:197`), and the state is stamped onto a REAL row
   * (`repos.service.ts:54`). So Dependabot can refuse while secret scanning
   * answers and finds a credential — a counted 1 beside an unreadable state.
   */
  const LEAKY_UNREAD = repo({
    name: 'leaky-lib',
    open: 4,
    security: {
      ...NO_SECURITY,
      state: 'unreadable',
      secrets: 1,
      secretsUrl: 'https://github.com/acme/leaky-lib/security/secret-scanning/1',
    },
  });

  const page = (rows: RepoRow[], over: Partial<ReposView> = {}) =>
    render({ view: { ...view(rows), ...over } });

  it('an unread owner does not read as a repo nobody owns', () => {
    const html = page([NOBODY, UNREAD_OWNER]);
    expect(textOf(tileHtml(html, 'unowned'))).toContain('Set owner');
    expect(textOf(tileHtml(html, 'engine'))).toContain('Owner not read');
    expect(textOf(tileHtml(html, 'engine'))).not.toContain('Set owner');
  });

  it('and does not read as an org that has no owner field either', () => {
    // Three states in one slot, and the unread one wins over `absent`: an org
    // with no `dri` property is something the board KNOWS, and a read that
    // never landed cannot know it.
    const html = page([NOBODY, UNREAD_OWNER], { ownerWritability: 'absent', driOptions: [] });
    expect(textOf(tileHtml(html, 'unowned'))).toContain('No owner field');
    expect(textOf(tileHtml(html, 'engine'))).toContain('Owner not read');
  });

  it('keeps the picker on an unread owner, because the write can still land', () => {
    // The read that failed was the READ. Withholding the control here would
    // take away the one thing on the tile that could put the owner back.
    expect(tileHtml(page([UNREAD_OWNER]), 'engine')).toContain('Click to change');
  });

  it('tells a screen reader the owner was NOT READ, not that it is unset', () => {
    const html = page([NOBODY, UNREAD_OWNER]);
    expect(tileHtml(html, 'engine')).toContain('aria-label="Owner of engine, not read. Click to change."');
    expect(tileHtml(html, 'unowned')).toContain('aria-label="Owner of unowned, unset. Click to change."');
  });

  it('gives a viewer who may not write the same distinction, with no control to explain it', () => {
    // The read-only slot is a plain span — no button, no hover raise — so the
    // words are the whole of what that reader gets, and they must not say the
    // org records no owner when nobody could ask it.
    const html = render({ view: view([NOBODY, UNREAD_OWNER]), canWrite: false });
    expect(html).not.toContain('Click to change');
    expect(textOf(tileHtml(html, 'engine'))).toContain('Owner not read');
    expect(textOf(tileHtml(html, 'unowned'))).toContain('Set owner');
  });

  it('draws no empty avatar ring where the owner was not read', () => {
    // The ring is "a person slot with nobody in it" — a claim about the org,
    // and one the board does not get to make on a read that never landed. It
    // also costs about 22px of a slot that has 79 at 1280, where the label
    // needs 84 and was drawing "Owner not r…" — cutting the word that carries
    // the meaning. The unowned tile beside it keeps its ring.
    const html = render({ view: view([NOBODY, UNREAD_OWNER]) });
    const RING = 'shadow-[inset_0_0_0_1.5px_';
    expect(tileHtml(html, 'unowned')).toContain(RING);
    expect(tileHtml(html, 'engine')).not.toContain(RING);
  });

  it('says the alerts were not read where a measured repo says nothing at all', () => {
    const html = page([MEASURED_CLEAN, UNREAD_ALERTS]);
    // Silence on a tile means "counted, and there is nothing to report".
    expect(textOf(tileHtml(html, 'calm'))).not.toContain('not read');
    expect(textOf(tileHtml(html, 'quiet-lib'))).toContain('Alerts not read');
  });

  it('reports an org alert failure above the grid without repeating it on its cards (#1194)', () => {
    const rows = [UNREAD_ALERTS, BOTH, LEAKY_UNREAD];
    const html = render({ view: view(rows), health: new Map(rows.map(row => [row.full, healthOf(row)])), unreadHealthOrgs: ['ACME'] });
    expect(textOf(html)).toContain('The board could not read its alerts.');
    expect(textOf(html)).not.toContain('Alerts not read');
    expect(textOf(tileHtml(html, 'infra'))).toContain('CI failing');
    expect(textOf(tileHtml(html, 'leaky-lib'))).toContain('Leaked secret');
  });

  it('keeps a repo-specific gap visible when the page notice names another org (#1194)', () => {
    const html = render({ view: view([UNREAD_ALERTS]), health: new Map([[UNREAD_ALERTS.full, healthOf(UNREAD_ALERTS)]]), unreadHealthOrgs: ['globex'] });
    expect(textOf(tileHtml(html, 'quiet-lib'))).toContain('Alerts not read');
  });

  it('draws that word in the quiet tone, never the two the tile spends on faults', () => {
    // `danger` is a leaked credential and `warning` is a failing build. "We did
    // not look" must not sit at the weight of "we looked and it is bad".
    const tile = tileHtml(page([UNREAD_ALERTS]), 'quiet-lib');
    // The tooltip trigger adds its own attribute after the class, so the match
    // allows one — `[^>]*` and not `.*`, or it would run past the element.
    expect(tile).toMatch(/class="[^"]*text-muted[^"]*"[^>]*>Alerts not read/);
    expect(tile).not.toContain('text-danger');
    expect(tile).not.toContain('text-warn');
  });

  it('keeps a COUNTED alert over the unread word — a partly-refused read still counted', () => {
    // The rule this file already writes for CI, on the loudest signal the
    // surface has. One refused list does not unmeasure the list that answered,
    // so a counted credential is drawn as a credential — in the danger tone,
    // pointing at the alert — and not folded into "Alerts not read" in the
    // quietest ink the tile owns.
    const tile = tileHtml(page([LEAKY_UNREAD]), 'leaky-lib');
    expect(textOf(tile)).toContain('Leaked secret');
    expect(textOf(tile)).not.toContain('Alerts not read');
    // The address goes with it: a word a reader cannot follow is the other half
    // of this defect (#605).
    expect(tile).toContain('href="https://github.com/acme/leaky-lib/security/secret-scanning/1"');
    expect(tile).toContain('text-danger');
  });

  it('still says the alerts went unread where nothing was counted', () => {
    // The other side of the same rule: a repo whose lists refused and whose
    // counts are all zero has nothing measured to draw, so the unread word is
    // the whole of what the tile can honestly say.
    expect(textOf(tileHtml(page([UNREAD_ALERTS]), 'quiet-lib'))).toContain('Alerts not read');
  });

  it('keeps a MEASURED failure over the unread word, and draws only the one', () => {
    // The Actions read did not refuse, so the red build is a fact. Replacing it
    // with an absence would hide something actionable to report something that
    // is not — and the page's line above the grid states the loss anyway.
    const tile = textOf(tileHtml(page([BOTH]), 'infra'));
    expect(tile).toContain('CI failing');
    expect(tile).not.toContain('Alerts not read');
  });
});

describe('the nobody face stands for the repos the org records no owner for (#718)', () => {
  // The clean bill this issue is about, one control along: the avatar stack
  // counted 5 "with nobody recorded as owner" where 2 were unowned and 3 were
  // repos whose ownership read failed — folded together under one empty ring,
  // which is the claim `ownerSlots`' own doc says that slot makes.
  const NOBODY_A = repo({ name: 'a-lib', open: 9 });
  const NOBODY_B = repo({ name: 'b-lib', open: 8 });
  const UNREAD_1 = repo({ name: 'c-lib', open: 7, ownerState: 'unreadable' });
  const UNREAD_2 = repo({ name: 'd-lib', open: 6, ownerState: 'unreadable' });
  const OWNED_ONE = repo({ name: 'e-lib', open: 5, owner: ADA });
  const ROWS = [NOBODY_A, NOBODY_B, UNREAD_1, UNREAD_2, OWNED_ONE];
  const map = (over: Partial<Parameters<typeof ReposBody>[0]> = {}) =>
    render({ view: view(ROWS), ...over });

  it('counts the unowned repos and not the unread ones', () => {
    expect(map()).not.toContain('aria-label="2 repos with nobody recorded as owner"');
    // The slot is built from the rows, so this is the count the face draws and
    // the count the hint says, in one place.
    const slots = ownerSlots(buildTiles(view(ROWS), 'open'));
    expect(slots.find((s) => s.login === null)?.count).toBe(2);
  });

  it('narrows to those same repos when the face is pressed, so count and grid agree', () => {
    expect(tileKeys(map({ owner: null }))).toEqual(['a-lib', 'b-lib']);
  });

  it('leaves the unread repos on the map under All, where they have always been', () => {
    // They lose a filter, not a place. Inventing a face for them is a control
    // Octocat has not asked for.
    expect(tileKeys(map())).toEqual(['a-lib', 'b-lib', 'c-lib', 'd-lib', 'e-lib']);
  });
});

describe('the tile’s two clickable things (#558)', () => {
  const tile = () =>
    renderToStaticMarkup(<RepoTile tile={tileOf(BOARD)} driOptions={['octocat']} canWrite share={null} />);

  it('puts the real link on the repo name, and nothing interactive inside it', () => {
    const html = tile();
    // The link a person aims at — so cmd-click, middle-click and "copy link
    // address" all still work on the name. It leads to the repo's own page
    // (#575), which is what a tile on a map of repos should open; the filtered
    // queue it used to open is one step away, on the tile's action menu.
    expect(html).toContain(`href="${repoPath(BOARD.full)}"`);
    expect(html).toContain('href="/repo/acme/board.example.com"');
    // …and NOT to the queue, which is the whole of the change.
    expect(html).not.toContain('href="/overview?repo=board"');
    // One anchor, and no control nested inside it: a <button> inside an <a> is
    // invalid HTML and browsers recover from it inconsistently.
    expect(html.match(/<a\b/g)).toHaveLength(1);
    const anchor = /<a\b[\s\S]*?<\/a>/.exec(html)?.[0] ?? '';
    expect(anchor).toContain(BOARD.name);
    expect(anchor).not.toContain('<button');
    // …while the owner control IS in the tile, as a sibling of that anchor.
    expect(html).toContain('<button');
    // The tile itself is not an anchor wrapping the whole card.
    expect(html).not.toMatch(/<a\b[^>]*data-repo=/);
  });

  it('clicking the owner does not navigate', () => {
    // The DOM's own bubbling, spelled out: the owner's handler runs first, and
    // the tile's convenience handler only sees a click that reached it.
    const navigated: string[] = [];
    let stopped = false;
    const press = { defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 };

    ownerPress({ ...press, stopPropagation: () => { stopped = true; } }, () => {});
    if (!stopped && tileOpens(press)) navigated.push(repoPath(BOARD.full));

    expect(stopped).toBe(true);
    expect(navigated).toEqual([]);
    // …and a click that did reach the tile still opens the repo's page.
    expect(tileOpens(press)).toBe(true);
    // A modified click is the browser's to handle, never ours.
    expect(tileOpens({ ...press, metaKey: true })).toBe(false);
  });

  it('carries the ⋮ handle, drawn only on hover, focus or an open menu (#606)', () => {
    // Right-click was the only way to this menu and nothing said the menu was
    // there. The handle gives it a pointer path and a keyboard one; at rest it
    // is laid out but invisible, so the grid looks exactly as it did.
    const html = tile();
    const handle = buttonsOf(html).find((b) => b.includes('aria-label="Repo actions"'));
    expect(handle, 'the tile has a ⋮ handle').toBeDefined();
    for (const cls of ['opacity-0', 'group-hover:opacity-100', 'focus-visible:opacity-100']) {
      expect(handle, cls).toContain(cls);
    }
    // Absolutely placed, so fading it in reflows nothing.
    expect(handle).toContain('absolute');
    // Bottom-right, not top-right: the open count is the last child of the
    // first line and so flush with the content edge on all 78 tiles, while the
    // footer's right end is empty unless the repo drew a hazard word.
    expect(handle).toContain('top-2');
    expect(handle).toContain('right-2');
  });

  it('marks a hovered tile with an inset outline without lifting it (#931)', () => {
    const html = tile();
    expect(html).toContain('hover:[box-shadow:inset_0_0_0_2px_var(--accent)]');
    expect(html).not.toContain('hover:translate');
    expect(html).not.toContain('hover:-translate');
  });

  it('drops the heading’s gap where #608 drops the heading, and only there', () => {
    // The controls row clears the H1 with `mt-[26px]`. Below 900px #608 clips
    // that H1 to sr-only, which is `position: absolute` and so occupies no
    // height — leaving 26px of margin measuring from nothing, on top of the
    // rail's own 12px, above the first thing on a phone.
    const controls = /<div class="(mt-\[26px\][^"]*)"/.exec(render())?.[1] ?? '';
    expect(controls, 'the controls row exists').not.toBe('');
    expect(controls.split(/\s+/)).toContain('max-[900px]:mt-0');
    // The desktop gap is untouched — #608 pixel-diffed 1280 at zero differing
    // pixels and this must not spend that.
    expect(controls.split(/\s+/)).toContain('mt-[26px]');
    // Zeroed at exactly the width the heading stops drawing at, so the two
    // cannot drift apart.
    expect(controls).toContain('max-[900px]:');
  });

  it('reserves the ⋮ corner permanently, so the handle covers no word (#606)', () => {
    // Both boxes are anchored to the tile's right edge, so this is arithmetic
    // and not a width-dependent guess: the handle is `size-6` at `right-2`, so
    // it starts 32px in; the footer's last child is the word, whose right edge
    // is the content edge. `px-4` alone put that edge 16px in — the word's
    // rightmost 16px sat under an opaque button, which is `Leaked secret` read
    // as `Leaked secr`, and that tail is the word's own Hint trigger, so the
    // explanation could not be opened either.
    //
    // Reserved on the ROW and not on the word, so the placeholder bar and the
    // owner are inset by the same one number. Permanently and not on hover:
    // ActionMenu promises nothing moves on hover but opacity, and a word that
    // slides away from the pointer reaching for it is the worse bug.
    const footer = /<span class="(flex items-center gap-2[^"]*)"/.exec(tile())?.[1] ?? '';
    expect(footer, 'the footer row exists').not.toBe('');
    expect(footer.split(/\s+/), 'the footer reserves the handle corner').toContain('pr-4');
    // Not a hover-only variant — that is the shape this must never become.
    expect(footer).not.toMatch(/group-hover:|hover:/);

    // The bar draws on all 78 tiles until the health read lands, so it needs the
    // reservation as much as the word does; it is inside the same row.
    const pending = renderToStaticMarkup(
      <RepoTile tile={{ row: UI, health: null }} driOptions={[]} canWrite={false} share={null} />,
    );
    expect(pending).not.toContain('data-word-unsettled');
    expect(/<span class="(flex items-center gap-2[^"]*)"/.exec(pending)?.[1] ?? '').toContain('pr-4');
  });

  it('draws no coloured left border, on the tile that used to carry one (#607)', () => {
    // PLATFORM is the shape that wore it: a queue that gained ground week after
    // week, with a clean build and no alerts. The edge was the page's warning
    // tone spent on a repo with nothing wrong with it, and it answered no hover
    // of its own, so it went. The sparkline below draws the same ten weeks.
    const wasMarked = renderToStaticMarkup(<RepoTile tile={tileOf(PLATFORM)} driOptions={[]} canWrite={false} share={null} />);
    expect(wasMarked).not.toContain('border-l-2');
    expect(wasMarked).not.toContain('border-l-warn');
    // No warning tone anywhere on it — the border was the only candidate, and
    // this is what stops another one being added quietly in its place.
    expect(wasMarked).not.toContain('text-warning');
    // …and the compensating inset went with it, so this tile's text sits on the
    // plain padding every other tile uses.
    expect(wasMarked).not.toContain('pl-[14px]');
    expect(wasMarked).toContain('px-4');
    expect(tile()).not.toContain('border-l-2');
    expect(tile()).not.toContain('text-warning');
  });
});

describe('the tile’s one word (#578)', () => {
  const draw = (row: RepoRow) =>
    renderToStaticMarkup(<RepoTile tile={tileOf(row)} driOptions={[]} canWrite={false} share={null} />);

  it('says the CI conclusion that actually happened, and names CI as the thing', () => {
    // Distinct per conclusion, and each says what failed: "Failing" alone, next
    // to a repo name, does not name the CI as the thing that failed (#578).
    expect(textOf(draw(DOCS))).toContain('CI needs action');
    expect(textOf(draw(UI))).toContain('CI failing');
    expect(textOf(draw(repo({ name: 'slow', ci: 'timed_out' })))).toContain('CI timed out');
  });

  it('carries a word on every tile whose latest run wants a human', () => {
    // Verified live: the CI failing chip yielded 27 tiles and acme-docs
    // carried no word at all — a tile contradicting the filter that summoned it.
    // The chip is struck out (#583) and the word is what is left, so this now
    // asserts it over the whole map rather than over what the chip returned.
    const html = render({ view: view([BOARD, UI, DOCS, ROADMAP]) });
    const worded = [UI, DOCS, INFRA].map((r) => wordOf(r)?.text);

    expect(tileKeys(html)).toContain('acme-docs');
    expect(worded).toEqual(['CI failing', 'CI needs action', 'Leaked secret']);
    expect(textOf(html)).toContain('CI needs action');
    expect(textOf(html)).toContain('CI failing');
    // …and no word at all on the two whose runs are fine.
    expect(wordOf(BOARD)).toBeNull();
    expect(wordOf(ROADMAP)).toBeNull();
  });

  it('draws the worse of the two when a repo has both, and only one word', () => {
    const text = textOf(draw(INFRA));
    expect(text).toContain('Leaked secret');
    expect(text).not.toContain('CI failing');
  });

  it('says nothing at all where there is nothing to say', () => {
    // BOARD passes CI and carries no alerts. Asymmetry is intended: a tile with
    // nothing to report gets no filler so it can look complete.
    const text = textOf(draw(BOARD));
    for (const word of ['Passing', 'CI failing', 'Leaked secret', 'Clean', 'High']) {
      expect(text).not.toContain(word);
    }
  });

  it('leaves a repo’s language off the tile entirely', () => {
    // Two ordered scales and one arbitrary category drawn in one grammar was
    // what made the row unreadable (#578). BOARD is TypeScript.
    expect(draw(BOARD)).not.toContain('TypeScript');
  });
});

describe('the map draws before the health lands (#571)', () => {
  /** The page a moment after the first read resolved: rows in hand, health not
   *  yet. `null` is the whole of "not yet" on this page. */
  const pending = (over: Partial<Parameters<typeof ReposBody>[0]> = {}) =>
    render({ health: null, ...over });

  it('draws every tile from the first read alone', () => {
    // The defect, stated: the page held the whole grid behind one word until
    // Github's three alert APIs and an Actions lookup per repo had answered.
    expect(tileKeys(pending())).toEqual(['acme-ui', 'board', 'roadmap']);
  });

  it('draws search while problem badges wait for health', () => {
    const html = pending();
    expect(html).toContain('placeholder="Search repos"');
    expect(buttonsOf(html).some(button => button.includes('data-health='))).toBe(false);
  });

  it('leaves every tile word slot quiet while health is pending', () => {
    // Health is the only source that can justify a word; unresolved rows must
    // not invent one or reserve a per-tile footer bar.
    const html = pending();
    expect(html.match(/data-word-unsettled/g) ?? []).toHaveLength(0);
  });

  it('does not draw a per-tile placeholder while health is pending', () => {
    expect(pending()).not.toContain('WORD_BAR');
    expect(pending()).not.toContain('data-word-unsettled');
  });

  it('keeps pending health out of each tile’s accessible name', () => {
    // The page-level pending status carries the wait; individual tiles carry no
    // health claim until the response settles.
    expect(pending()).not.toContain('data-word-unsettled');
  });

  it('says no word at all while it is unsettled — not a word that could be wrong', () => {
    // acme-ui is the failing build in this view. Before the health lands the
    // page must not print its word, and must not print anyone else's either.
    const text = textOf(pending());
    for (const word of ['CI failing', 'CI needs action', 'CI timed out', 'Leaked secret']) {
      expect(text).not.toContain(word);
    }
  });

  it('replaces the placeholder with the word — or with nothing — once the health lands', () => {
    const settled = render();
    expect(settled).not.toContain('data-word-unsettled');
    expect(textOf(settled)).toContain('CI failing'); // acme-ui
    expect(textOf(settled)).not.toContain('CI needs action'); // nothing else has one
  });

  it('holds the grid under the security order, which sorts on what has not arrived', () => {
    // My partner's call, and the one order it applies to: `security` reads the
    // health, so drawing now would mean re-sorting the map under a reader who
    // is already looking at it.
    const html = pending({ orderKey: 'open', healthFilter: 'security' });
    expect(tileKeys(html)).toEqual([]);
    // The heading's row is still there — this holds the tiles, not the page.
    expect(textOf(html)).not.toContain('All 3');
    expect(html).toContain('placeholder="Search repos"');
  });

  it('renders a quiet structural pending state for a selected health filter', () => {
    const html = pending({ orderKey: 'open', healthFilter: 'security' });
    expect(tileKeys(html)).toEqual([]);
    expect(html).toContain('aria-label="Loading repository health"');
    expect(html).toContain('role="status"');
    expect(html).toContain('grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3');
    expect(html).toContain('min-h-[112px]');
    expect(html).toMatch(/<p role="status" class="sr-only">Loading repository health…<\/p>/);
  });

  it('keeps the pending structure only on unresolved health filters', () => {
    const held = pending({ orderKey: 'open', healthFilter: 'security' });
    expect(held).toContain('aria-label="Loading repository health"');
    // It is the held state's own line and nothing else's: gone once the health
    // has landed, gone when the read failed, and never there under an order
    // that draws at once.
    expect(render({ orderKey: 'open', healthFilter: 'security' })).not.toContain('aria-label="Loading repository health"');
    expect(render({ health: NO_HEALTH, orderKey: 'open', healthFilter: 'security' })).not.toContain('aria-label="Loading repository health"');
    expect(pending({ orderKey: 'open' })).not.toContain('aria-label="Loading repository health"');
  });

  it('does not mistake a held grid for an empty map', () => {
    // The empty state answers a settled filter; unresolved observations are not
    // evidence of zero matches.
    expect(textOf(pending({ orderKey: 'open', healthFilter: 'security' }))).not.toContain(NO_MATCH_BODY);
  });

  it('draws the tiles at once in the three orders that read the row alone', () => {
    for (const orderKey of ['open', 'recent', 'name'] as RepoOrderKey[]) {
      expect(tileKeys(pending({ orderKey })), orderKey).toHaveLength(3);
    }
  });

  it('settles every tile at an UNREAD security state when the health read failed (#718)', () => {
    // `NO_HEALTH` is what the page holds after a rejection: settled, carrying
    // nothing. "Nothing" used to mean four zeros on every tile, so a refused
    // read drew a clean bill of health for the WHOLE map — the same false
    // statement the per-org unread states fix, through a second door. This test
    // asserted that silence; it now checks the shared failure notice (#1194).
    const failed = render({ health: NO_HEALTH });
    const keys = tileKeys(failed);
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(textOf(tileHtml(failed, key)), key).not.toContain('Alerts not read');
    expect(textOf(failed).match(/Repository health could not be read; sync again to retry security alerts and CI results\./g)).toHaveLength(1);
    // The rest of the settling is unchanged: no placeholder left open for a row
    // that is not coming, no CI word invented, and the security order draws
    // rather than waiting forever.
    expect(failed).not.toContain('data-word-unsettled');
    expect(textOf(failed)).not.toContain('CI failing');
    expect(tileKeys(render({ health: NO_HEALTH, orderKey: 'open', healthFilter: 'security' }))).toHaveLength(0);
    expect(textOf(render({ health: NO_HEALTH, orderKey: 'open', healthFilter: 'security' }))).toContain('Security results couldn’t be read for 3 repositories');
  });
});

describe('the Repos page hints through its own tooltip (#573)', () => {
  const treeOf = (row: RepoRow) => RepoTile({ tile: tileOf(row), driOptions: [], canWrite: false, share: null });

  it('gives the bare open count its unit', () => {
    expect(tipLabels(treeOf(BOARD))).toContain(openHint(BOARD, null));
    expect(openHint(BOARD, null)).toBe('6 open issues');
  });

  it('hints the open count with its unit and nothing more (#607)', () => {
    // It named the warning left edge here once — the edge answered no hover of
    // its own, so its one explanation hung off a neighbouring element a tile's
    // width away. Both are gone; the number gets its unit and stops.
    expect(tipLabels(treeOf(PLATFORM))).toContain('12 open issues');
    for (const label of tipLabels(treeOf(PLATFORM))) expect(label).not.toContain('left edge');
  });

  it('hints the drawn word with what produced it, reusing repos-vm’s own words', () => {
    expect(tipLabels(treeOf(DOCS))).toContain(wordOf(DOCS)!.hint);
    expect(wordOf(DOCS)!.hint).toBe('Latest completed Actions run: Action required');
    expect(tipLabels(treeOf(INFRA))).toContain(wordOf(INFRA)!.hint);
    expect(wordOf(INFRA)!.hint).toBe('GitHub secret scanning found a credential in this repo');
  });

  it('opens the word’s hint BELOW the tile, which is the one side that cannot cover it', () => {
    // The word sits on the tile's bottom line at its right edge. Right was tried
    // and fails in the last column, where Radix flips the box left and lands it
    // inside the tile it is describing: at 1280 on `landing-ui` the box ran
    // x 964–1190 against its own tile at x 1019–1256, covering 171×31px of the
    // owner row and the sparkline; at 1440 on `acme-brain-component-app`,
    // 208×31px. Bounding the box could not fix it — the box is wider than the
    // gap between the tile's left edge and the word at its right. Below the
    // bottom line there is no tile, in any column, at any width.
    const word = tips(treeOf(INFRA)).find((t) => t.label === wordOf(INFRA)!.hint);
    expect(word!.side).toBe('bottom');
  });

  it('hints a repo’s description, and nothing where there is none', () => {
    expect(tipLabels(treeOf(BOARD))).toContain('Acme team organizational platform');
    // A tooltip repeating the name already on screen is a hover spent for
    // nothing — and the name is the only thing this tile could repeat.
    const bare = repo({ name: 'acme-voice', open: 2 });
    expect(tipLabels(treeOf(bare))).not.toContain('acme-voice');
  });

  it('finishes a cut name with a native title where no description can', () => {
    // The grid cuts names at every width it makes — `acme-deployment-extension-gateway`
    // renders as `acme-deployment-extensi…` at 1280. Where the repo has a
    // description the board's tooltip carries it and the rest of the name is one
    // click away; where it has none, this is the only reveal a pointer can reach,
    // and it is the case Tip.tsx keeps the native attribute for.
    const bare = repo({ name: 'acme-deployment-extension-gateway', open: 2 });
    const tree = treeOf(bare);
    const [anchor] = elementsOfType(tree, 'a');
    expect(anchor.title).toBe('acme-deployment-extension-gateway');
    // …and it is a title INSTEAD of a hint, never as well as one.
    expect(tipLabels(tree)).not.toContain('acme-deployment-extension-gateway');
  });

  it('leaves the name bare where a description already answers the hover', () => {
    // Two boxes in two skins for one pointer is the doubling #573 took off this
    // page. The description keeps the board's tooltip and the name keeps nothing.
    const tree = treeOf(BOARD);
    const [anchor] = elementsOfType(tree, 'a');
    expect(anchor.title).toBeUndefined();
    expect(tipLabels(tree)).toContain(BOARD.description);
  });

  it('replaces the OS grey box rather than doubling it', () => {
    // Tip.tsx keeps a plain `title` for two cases only, and a description is
    // neither: it is a hint, not truncated text.
    const html = renderToStaticMarkup(<RepoTile tile={tileOf(BOARD)} driOptions={[]} canWrite={false} share={null} />);
    expect(html).not.toContain(`title="${BOARD.description}"`);
    expect(html).not.toContain(`title="${BOARD.name}"`);
  });

  it('hovering the drawn word neither navigates the tile nor opens the owner menu', () => {
    const tree = treeOf(INFRA);
    const word = tips(tree).find((t) => t.label === wordOf(INFRA)!.hint);
    expect(word).toBeDefined();
    // A plain span for a trigger: no click of its own, so nothing new to press.
    const trigger = word!.children as ReactElement<{ onClick?: unknown }>;
    expect(trigger.props.onClick).toBeUndefined();
    // And the tile still has exactly its two handlers — the card, and the name
    // anchor — so no third clickable thing and no second menu trigger appeared.
    expect(clickHandlers(tree)).toHaveLength(2);
  });

  // ── the word reaches the thing it names (#605) ───────────────────────────
  //
  // `INFRA` above is the null-address case and stays exactly where it was: the
  // spec directly above this asserts its trigger has no click of its own and
  // the tile has its two handlers, which is what "renders exactly as today"
  // means. These two repos are the other half.
  const RUN = 'https://github.com/acme/reachable-run/actions/runs/42';
  const ALERT = 'https://github.com/acme/reachable-secret/security/secret-scanning/7';
  const RUN_REPO = repo({ name: 'reachable-run', ci: 'failure', ciUrl: RUN });
  const SECRET_REPO = repo({
    name: 'reachable-secret',
    security: { depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 1, secretsUrl: ALERT },
  });

  /** The word's trigger as an element, off the tree the tile actually returns. */
  function wordTrigger(row: RepoRow) {
    const tip = tips(treeOf(row)).find((t) => t.label === wordOf(row)!.hint);
    expect(tip, `no hint on the word ${row.name} draws`).toBeDefined();
    return tip!.children as ReactElement<{
      href?: string;
      target?: string;
      rel?: string;
      className?: string;
      onClick?: (e: { stopPropagation: () => void }) => void;
    }>;
  }

  it('sends the word to the address the read brought back, in a new tab (#605)', () => {
    // Both words, because they take their address from two different fields —
    // a tile wired to one of them would draw the other as inert and pass a
    // one-word spec.
    expect(wordTrigger(RUN_REPO).props.href).toBe(RUN);
    expect(wordTrigger(SECRET_REPO).props.href).toBe(ALERT);
    expect(wordTrigger(RUN_REPO).props.target).toBe('_blank');
    expect(wordTrigger(RUN_REPO).props.rel).toBe('noopener');
    // Guarded: `toBe(undefined)` on a mistyped prop would pass silently, so the
    // address is asserted to be a real string first.
    expect(typeof wordTrigger(SECRET_REPO).props.href).toBe('string');
  });

  it('reaching the run does NOT also open the repo page (#605)', () => {
    // The word sits inside the card's own onClick. Same shape as the owner
    // control's guard: the word's handler runs first and the tile's convenience
    // handler only ever sees a click that reached it.
    const navigated: string[] = [];
    let stopped = false;
    const press = { defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 };

    wordTrigger(RUN_REPO).props.onClick!({ ...press, stopPropagation: () => { stopped = true; } });
    if (!stopped && tileOpens(press)) navigated.push(repoPath(RUN_REPO.full));

    expect(stopped).toBe(true);
    expect(navigated).toEqual([]);
    // …and the same click, unstopped, still opens the repo's page — so the
    // assertion above is about the word's guard and not about a dead press.
    expect(tileOpens(press)).toBe(true);
  });

  it('leaves a word with no address exactly the span it was (#605)', () => {
    // Not a disabled link and not a link to nowhere: the element type itself
    // differs, so nothing about an unreachable word changed.
    const inert = wordTrigger(INFRA);
    expect(wordOf(INFRA)!.href).toBeNull();
    expect(inert.type).toBe('span');
    expect(inert.props.onClick).toBeUndefined();
    expect(wordTrigger(SECRET_REPO).type).toBe('a');
    // Same ink either way — the addressable word takes the tone class the inert
    // one has, and adds the shared text-link treatment.
    expect(inert.props.className).toContain('text-danger');
    expect(wordTrigger(SECRET_REPO).props.className).toContain('text-danger');
    expect(wordTrigger(SECRET_REPO).props.className).toContain('text-link');
    expect(inert.props.className).not.toContain('text-link');
  });

  it('hints the owner control with the FULL name and what pressing it does', () => {
    const control = OwnerControl({ row: BOARD, owner: ADA, editable: true, onPress: () => {} });
    expect(tipLabels(control)).toEqual([ownerHint(ADA)]);
    expect(ownerHint(ADA)).toBe('Octocat owns this repo. Picking a name here writes it on GitHub');
    // …and the OS grey box that used to carry the full name here is gone with
    // it. Left in place, a hover would answer twice, in two different skins.
    expect(renderToStaticMarkup(<>{control}</>)).not.toContain('title="Octocat"');
  });

  it('leaves the owner control’s accessible name and its press exactly as they were', () => {
    const control = OwnerControl({ row: BOARD, owner: ADA, editable: true, onPress: () => {} });
    const html = renderToStaticMarkup(<>{control}</>);
    expect(html).toContain(ownerAria(BOARD, ADA));
    // One control, not two: the hint wraps the button rather than adding one.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(clickHandlers(control)).toHaveLength(1);
  });

  it('hints nothing about writing on a tile whose owner cannot be changed', () => {
    // "Picking a name here writes it on Github" would be a lie where there is
    // nothing to pick. The full name stays reachable as truncated text, which is
    // one of the two cases Tip.tsx keeps a plain `title` for.
    const readOnly = OwnerControl({ row: BOARD, owner: ADA, editable: false });
    expect(tips(readOnly)).toHaveLength(0);
    expect(renderToStaticMarkup(<>{readOnly}</>)).toContain('title="Octocat"');
  });

  it('says nothing over an unset owner, whose label is not cut on any tile', () => {
    // A `title` is only ever allowed here to finish text the tile shortened. It
    // shortens a full name, so the owned slot above keeps one — but "Set owner"
    // is printed whole: 0 of the 49 unset tiles truncate it, at 420, 768, 1024,
    // 1280 or 1440, since #578 gave the slot the room the three pips held. A
    // title here would put the OS grey box back over a label already legible,
    // which is the thing #573 took off this page.
    const readOnly = OwnerControl({ row: BOARD, owner: null, editable: false });
    expect(renderToStaticMarkup(<>{readOnly}</>)).not.toContain('title=');
    expect(tips(readOnly)).toHaveLength(0);
  });

  it('names whose face each one is, and leaves All alone', () => {
    // The chips whose labels were categories are gone (#583); the faces that
    // replaced them say even less on their own, so every one carries a hint.
    const slots = ownerSlots(buildTiles(view(), 'open'));
    const labels = tipLabels(OwnerRow({ slots, chosen: undefined, onOwner: () => {} }));
    if (slots.filter((slot) => slot.login !== null).length > 1) {
      expect(labels).toHaveLength(slots.length);
      for (const slot of slots) expect(labels, slot.name).toContain(ownerSlotHint(slot));
    } else {
      expect(labels).toHaveLength(0);
    }
    // A hint on All could only restate the label, and it has none.
    expect(tipLabels(body())).not.toContain(undefined);
    expect(tipLabels(body())).not.toContain('All');
  });

  it('says what the / key does', () => {
    expect(tipLabels(body())).toContain(SEARCH_KEY_HINT);
    // …and only while the key is showing: a typed query replaces it with Clear.
    expect(tipLabels(body({ query: 'ui' }))).not.toContain(SEARCH_KEY_HINT);
  });
});

describe('a hint is bounded, so no sentence runs the width of the page', () => {
  /** Every surface on this page that hangs a hint. */
  const surfaces = () => [
    ['the page', body()],
    ['a tile', RepoTile({ tile: tileOf(UI), driOptions: [], canWrite: false, share: null })],
    ['the owner control', OwnerControl({ row: BOARD, owner: ADA, editable: true, onPress: () => {} })],
    ['the sparkline', SparkChart({ row: UI, mark: 3, read: 3, onWeek: () => {} })],
    [
      'the owner row',
      OwnerRow({ slots: ownerSlots(buildTiles(view(), 'open')), chosen: undefined, onOwner: () => {} }),
    ],
  ] as const;

  it('gives the label a width to wrap inside, keeping the sentence itself intact', () => {
    // The label stays exactly the sentence repos-vm wrote — the bounding is a
    // box, not an edit.
    const [tip] = elementsOfType(Hint({ label: openHint(UI, null), children: <span /> }), Tip);
    const bounded = tip.label as ReactElement<{ className: string; children: string }>;
    expect(bounded.props.children).toBe(openHint(UI, null));
    expect(bounded.props.className).toContain('max-w-');
    // `block`, or the bound does not bite: an inline span sizes to its longest
    // unbroken run and the box is as wide as the sentence again.
    expect(bounded.props.className).toContain('block');
  });

  it('leaves no surface here hanging a hint off the unbounded tooltip', () => {
    // Measured at 1280 before this: the open count's hint on a repo wearing the
    // warning border was ONE 631px line starting at x 166, with the content rail
    // at x 272 — the box ran back across the left navigation. `Tip` is app-wide
    // and takes no width, so the bound lives in this module's own `Hint`, and
    // reaching past it is the way to lose it again.
    for (const [name, tree] of surfaces()) {
      expect(elementsOfType(tree, Tip), name).toHaveLength(0);
      if (name !== 'the sparkline' && name !== 'the owner row') expect(elementsOfType(tree, Hint).length, name).toBeGreaterThan(0);
    }
  });
});

describe('the map can be read in another order (#587)', () => {
  /** Three repos that disagree about which is first under each order. */
  const FRESH = repo({
    name: 'fresh',
    open: 1,
    pushedAt: '2026-08-13T08:00:00.000Z',
    security: { depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null },
  });
  const LOUD = repo({
    name: 'loud',
    open: 4,
    pushedAt: '2026-06-01T08:00:00.000Z',
    security: { depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 1, secretsUrl: null },
  });
  const BUSY = repo({ name: 'busy', open: 40, pushedAt: '2026-07-01T08:00:00.000Z' });

  const three = view([FRESH, LOUD, BUSY]);
  const map = (orderKey: RepoOrderKey, over: Partial<Parameters<typeof ReposBody>[0]> = {}) =>
    render({ view: three, orderKey, ...over });

  it('draws the grid in the chosen order', () => {
    expect(tileKeys(map('open'))).toEqual(['busy', 'loud', 'fresh']);
    expect(tileKeys(map('recent'))).toEqual(['fresh', 'busy', 'loud']);
    expect(tileKeys(map('open', { healthFilter: 'security' }))).toEqual(['loud']);
    expect(tileKeys(map('name'))).toEqual(['busy', 'fresh', 'loud']);
  });

  it('says on the page which order the tiles are actually in', () => {
    expect(textOf(map('open'))).toContain('by open issues');
    expect(textOf(map('recent'))).toContain('by last push');
    // Never a word about an order the grid is not in: the label and the sort
    // read the same key, which is what the meta line #574 removed did not.
    expect(textOf(map('recent'))).not.toContain('by open issues');
  });

  it('re-arranges what the search and the owner left, and changes nothing about what they left', () => {
    const typed = { query: 'us' };
    expect(tileKeys(map('open', typed))).toEqual(['busy']);
    expect(tileKeys(map('name', typed))).toEqual(['busy']);

    const behind = view([
      repo({ name: 'early', open: 2, owner: ADA, pushedAt: '2026-01-01T00:00:00.000Z' }),
      repo({ name: 'late', open: 9, owner: ADA, pushedAt: '2026-08-12T00:00:00.000Z' }),
      repo({ name: 'calm', open: 30 }),
    ]);
    const chip = { view: behind, owner: 'octocat' };
    expect(tileKeys(render({ ...chip, orderKey: 'open' }))).toEqual(['late', 'early']);
    expect(tileKeys(render({ ...chip, orderKey: 'name' }))).toEqual(['early', 'late']);
  });

  it('offers three orders and marks the one the grid is actually in', () => {
    // Every order, not one. Pinned against `recent` alone, a menu that always
    // marked the first row passed — the check said `Open issues`, `recent` was
    // never the value it was compared against, and which row reads as chosen in
    // the live control was untested.
    for (const order of ORDERS) {
      const html = renderToStaticMarkup(
        <OrderMenu orderKey={order.key} onOrder={() => {}} onClose={() => {}} />,
      );
      expect(textOf(html)).toContain('Order');
      for (const other of ORDERS) expect(textOf(html)).toContain(other.label);
      // The check gutter is the shared menu chrome's; the row wearing it is the
      // order the grid is in.
      const rows = [...html.matchAll(/<button[\s\S]*?<\/button>/g)].map((m) => m[0]);
      expect(rows, order.key).toHaveLength(3);
      const checked = rows.filter((r) => r.includes('<svg'));
      expect(checked, order.key).toHaveLength(1);
      expect(textOf(checked[0]), order.key).toContain(order.label);
    }
  });

  it('reports the order a row was pressed on, and closes behind it', () => {
    // The gap this closes: deleting the call to `onOrder` left the whole control
    // inert and every one of these 900-odd tests green. `ReposMap.spec.tsx` mocks
    // the picker wholesale, and this file used to render the menu with a stub
    // `onPick` — so nothing anywhere joined a press to the order the grid takes.
    const picked: RepoOrderKey[] = [];
    let closed = 0;
    const rows = elementsOfType(
      OrderMenu({ orderKey: 'open', onOrder: (key) => picked.push(key), onClose: () => { closed += 1; } }),
      MenuOption,
    );
    expect(rows).toHaveLength(ORDERS.length);
    for (const row of rows) pressMenuRow(row);
    expect(picked).toEqual(ORDERS.map((o) => o.key));
    // Closing matters on its own: a menu that reported the order and stayed open
    // would sit over the grid it just re-arranged.
    expect(closed).toBe(ORDERS.length);
  });

  it('the control is a menu, and says so', () => {
    const html = map('recent');
    expect(html).toContain(`aria-label="${orderAria('recent')}"`);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
  });
});

/**
 * Who gets the owner editor (#584, #626).
 *
 * Asserted on the function and not through the page, because this suite has no
 * DOM: it renders `ReposBody` and `ReposMap` and never `ReposPage`, so nothing
 * on screen reads `canSetDri` at all. Two mutations proved that — deleting the
 * capability half, and returning `true` for everyone — and both survived all
 * 1070 tests before these cases existed.
 *
 * The refused case was INERT until task 8, which turned the guard on: before
 * that `/api/auth/me` reported every capability as `unknown` and no session
 * reaching the browser carried `refused`. It carries one now, but only after the
 * board's credential has actually been refused something, so this is still the
 * branch nothing else in the suite can catch.
 */
describe('who gets the owner editor (#584, #626)', () => {
  /**
   * A session exactly as `/api/auth/me` can produce it. `canWrite` is not a
   * free field — the server derives it from `writesEnabled` AND the ISSUE
   * capabilities in this same map — so `meFixture` derives it here too rather
   * than taking it.
   *
   * That is the whole reason this helper changed. The case below about a
   * refused `issue.labels` used to hand-build `canWrite: true` beside that
   * refusal, a payload #626 stopped the backend producing, and it went on
   * passing green while the real session took the picker off every tile.
   */
  const session = (
    over: { writesEnabled?: boolean; capabilities?: Record<string, string> } = {},
  ): Me => meFixture(over);

  it('withholds the editor from no session at all', () => {
    expect(canSetDri(null)).toBe(false);
  });

  it('withholds it while writes are off, whatever the capability says', () => {
    // Neither half of `writesEnabled` leaves a capability refusal behind: a
    // `board:read` actor is stopped at the guard and GITHUB_WRITE_ENABLED=false
    // at the envelope. So a picker gated on `repo.dri` alone would be drawn over
    // a write that 403s, and this is the case that says so.
    expect(canSetDri(session({ writesEnabled: false }))).toBe(false);
    expect(
      canSetDri(session({ writesEnabled: false, capabilities: { 'repo.dri': 'available' } })),
    ).toBe(false);
  });

  it('gives it to a session that can write and has met no refusal', () => {
    expect(canSetDri(session({ writesEnabled: true }))).toBe(true);
  });

  it('draws the control on `unknown`, because an unattempted capability is not a refusal', () => {
    // What /me reports for a capability nothing has been attempted on, which
    // after a restart is every one of them. If this ever reads false the control
    // disappears from the whole map on a session that has been refused nothing.
    expect(
      canSetDri(session({ writesEnabled: true, capabilities: { 'repo.dri': 'unknown' } })),
    ).toBe(true);
  });

  it('keeps it open when an ISSUE capability is refused (#626)', () => {
    // The defect this pair exists for. `canWrite` is the issue editor's gate and
    // carries the issue set's refusals, so gating this page on it took the owner
    // picker off every tile the moment a credential-wide `issue.labels` refusal
    // landed — with `repo.dri` still available and the DRI write still fine.
    const refusedLabels = session({
      writesEnabled: true,
      capabilities: { 'issue.labels': 'refused', 'repo.dri': 'available' },
    });
    // Asserted beside the picker: this is what the backend ships for that
    // session, and it is what reading `canWrite` here would have read.
    expect(refusedLabels.canWrite).toBe(false);
    expect(canSetDri(refusedLabels)).toBe(true);
  });

  it('withholds it once the credential has been refused this capability', () => {
    // Reachable since task 8 flipped CAPABILITY_GUARD_ENFORCING: /me now reports
    // whatever the registry recorded, so a credential Github has refused arrives
    // here as `refused`. Offering a control that cannot work is the lie in the
    // other direction, and this half is the only thing that stops it.
    expect(
      canSetDri(session({ writesEnabled: true, capabilities: { 'repo.dri': 'refused' } })),
    ).toBe(false);
    // Both halves, not either: a refused capability does not grant a write to a
    // session that never had one.
    expect(
      canSetDri(session({ writesEnabled: false, capabilities: { 'repo.dri': 'refused' } })),
    ).toBe(false);
  });
});

describe('what the map judges a count against', () => {
  // Names of their own, shared with no other fixture in this file: `repo()`
  // writes into the module-wide HEALTH map keyed by `full`, so reusing a name
  // rewrites that repo's health for every test, and the tiles asserted on
  // elsewhere quietly lose their CI word.
  //
  // The counts are chosen so narrowing MOVES the line rather than leaving it
  // where it was — the only arrangement that can catch a share read off the
  // filtered grid. Whole map: (12 + 4 + 30) / 3 = 15, and `atlas` at 12 is
  // under it. Narrowed to the two atlases, or to Octocat's three, `beacon`'s 30
  // is gone and the share falls to 8 — so a share read off what is on screen
  // would promote `atlas` to heavy on a keystroke.
  const ROWS = [
    repo({ name: 'atlas', open: 12, owner: { login: 'octocat', name: 'Octocat' } }),
    repo({ name: 'atlas-ui', open: 4, owner: { login: 'octocat', name: 'Octocat' } }),
    repo({ name: 'beacon', open: 30, owner: { login: 'IvanRoslov', name: 'Ivan' } }),
    repo({ name: 'cinder', open: 0, owner: { login: 'octocat', name: 'Octocat' } }),
  ];

  it('draws the three tones on the map it derived the share from', () => {
    // The fixture's own floor: without this, the two tests below could hold
    // while every tile drew the same class.
    const whole = render({ view: view(ROWS) });
    expect(countClassFor(whole, 'beacon')).toContain('text-fg');
    expect(countClassFor(whole, 'atlas')).toContain('text-dim');
    expect(countClassFor(whole, 'cinder')).toContain('text-muted');
  });

  it('does not move the line when a typed word narrows the grid', () => {
    // The share is the ORG's shape, not the search result's. Typing "atlas"
    // must not promote a repo to heavy that was ordinary a keystroke ago, or
    // the same tile reads two ways on two screens.
    const whole = render({ view: view(ROWS) });
    const typed = render({ view: view(ROWS), query: 'atlas' });
    expect(tileKeys(typed)).toEqual(['atlas', 'atlas-ui']);
    expect(countClassFor(typed, 'atlas')).toBe(countClassFor(whole, 'atlas'));
    expect(countClassFor(typed, 'atlas')).toContain('text-dim');
  });

  it('hangs the derived line off the hover of the tile it made heavy', () => {
    // The tone says a tile is over the line; the number it is over is findable
    // only here, which is what #695 asked for. Nothing else in this diff reads
    // the tile's hover: `RepoTile` could hand `Hint` a bare `null` and every
    // tone on the grid would still be right, with the whole suite green.
    const share = queueShare(ROWS);
    expect(share).toBe(15);
    const hintsOn = (row: RepoRow) =>
      tipLabels(RepoTile({ tile: tileOf(row), driOptions: [], canWrite: false, share }));
    expect(hintsOn(ROWS[2])).toContain('30 open issues — more than its share, which on this map is 15');
    expect(hintsOn(ROWS[0])).toContain('12 open issues');
  });

  it('does not move the line when a face narrows the grid', () => {
    const whole = render({ view: view(ROWS) });
    const pressed = render({ view: view(ROWS), owner: 'octocat' });
    expect(tileKeys(pressed)).toEqual(['atlas', 'atlas-ui', 'cinder']);
    expect(countClassFor(pressed, 'atlas')).toBe(countClassFor(whole, 'atlas'));
    expect(countClassFor(pressed, 'atlas')).toContain('text-dim');
  });
});

it('does not render a separate issue-flow info control', () => {
  expect(textOf(render())).not.toContain('↑↓ change in open issues');
  expect(render()).not.toContain('Issue flow information');
});

it('intersects health with search and ownership, preserving the selected order', () => {
  const rows = view([
    repo({ name: 'a-fail', owner: ADA, ci: 'failure', open: 2 }),
    repo({ name: 'b-fail', owner: ADA, ci: 'timed_out', open: 8 }),
    repo({ name: 'c-fail', owner: { login: 'IvanRoslov', name: 'Ivan' }, ci: 'action_required', open: 12 }),
    repo({ name: 'd-clear', owner: ADA, ci: 'success' }),
  ]);
  expect(tileKeys(render({ view: rows, owner: ADA.login, query: 'fail', healthFilter: 'ci', orderKey: 'open' }))).toEqual(['b-fail', 'a-fail']);
  expect(tileKeys(render({ view: rows, owner: ADA.login, query: 'fail', healthFilter: 'ci', orderKey: 'name' }))).toEqual(['a-fail', 'b-fail']);
});


it.each(['prs', 'ci-cost'] as const)('uses singular weeks and counts in %s chart point labels', lens => {
  const html = renderToStaticMarkup(<RepoLensSpark metric={{
    lens, value: 0, label: '0', hint: '', series: [2, 1, 0],
  }} />);
  const values = lens === 'prs'
    ? ['2 PRs opened', '1 PR opened', '0 PRs opened']
    : ['$2.00 net billed USD', '$1.00 net billed USD', '$0.00 net billed USD'];
  expect(html).toContain(`aria-label="2 weeks earlier: ${values[0]}"`);
  expect(html).toContain(`aria-label="1 week earlier: ${values[1]}"`);
  expect(html).toContain(`aria-label="Trailing 7 days: ${values[2]}"`);
});

describe('problem badges', () => {
  const problemButtons = (over: Partial<Parameters<typeof ReposBody>[0]> = {}) =>
    buttonsOf(render(over)).map(textOf);

  it('removes permanent filters when no problems are observed', () => {
    for (const health of [null, NO_HEALTH, new Map()]) {
      const labels = problemButtons({ health });
      expect(labels).not.toContain('All 3');
      expect(labels).not.toContain('Failing CI');
      expect(labels).not.toContain('Security issues');
      expect(labels.some(label => /failing CI|security issue|leaked secret/.test(label))).toBe(false);
    }
  });

  it('counts observed failing repositories and security alerts, not all repositories', () => {
    const rows = [
      repo({ name: 'badge-a', ci: 'failure', security: { ...NO_SECURITY, secrets: 99 } }),
      repo({ name: 'badge-b', ci: 'timed_out' }),
      repo({ name: 'badge-clean', ci: 'success' }),
    ];
    expect(problemButtons({ view: view(rows) })).toEqual(expect.arrayContaining(['2 failing CI', '99 leaked secrets']));
    HEALTH.set(rows[0].full, { ...healthOf(rows[0]), security: { ...NO_SECURITY, secrets: 99, depHigh: 2 } });
    expect(problemButtons({ view: view(rows) })).toEqual(expect.arrayContaining(['99 leaked secrets', '2 vulnerable dependencies', '2 failing CI']));
    expect(problemButtons({ view: view(rows) })).not.toContain('101 security issues');
  });

  it('hides badges for known healthy repos and retains observed partial results', () => {
    const clean = repo({ name: 'badge-healthy', ci: 'success' });
    expect(problemButtons({ view: view([clean]) }).some(label => /failing CI|security issue|leaked secret/.test(label))).toBe(false);
    const partial = repo({ name: 'badge-partial', security: { ...NO_SECURITY, state: 'unreadable', secrets: 1 } });
    expect(problemButtons({ view: view([partial]) })).toContain('1 leaked secret');
    expect(problemButtons({ view: view([partial]), query: 'no-match' })).not.toContain('1 leaked secret');
  });

  it('keeps distinct problem filters and uses danger for leaked secrets', () => {
    const rows = [repo({ name: 'secret-only', security: { ...NO_SECURITY, secrets: 99 } }),
      repo({ name: 'dependency-only', security: { ...NO_SECURITY, depModerate: 1 } }),
      repo({ name: 'code-only', security: { ...NO_SECURITY, codeScanning: 2 } })];
    const props = { view: view(rows) };
    const buttons = elementsOfType(body(props), 'button');
    const secrets = buttons.find(button => button['data-health'] === 'secrets')!;
    expect(secrets).toBeDefined();
    expect(secrets.className).toContain('text-danger');
    expect(problemButtons(props)).toEqual(expect.arrayContaining(['99 leaked secrets', '1 vulnerable dependency', '2 code scanning alerts']));
    for (const [healthFilter, name] of [['secrets', 'secret-only'], ['dependencies', 'dependency-only'], ['code-scanning', 'code-only']] as const) {
      const html = render({ ...props, healthFilter });
      expect(html).toContain(name);
      for (const other of ['secret-only', 'dependency-only', 'code-only'].filter(value => value !== name)) expect(html).not.toContain(other);
    }
  });

  it('does not flash the clear action while health is pending', () => {
    expect(problemButtons({ health: null, healthFilter: 'security' })).not.toContain('Clear health filter');
  });

  it('toggles badges and lets a stale selected filter be cleared', () => {
    const selected: string[] = [];
    const rows = [repo({ name: 'badge-toggle', ci: 'failure' })];
    const props = { view: view(rows), onHealth: (value: string) => selected.push(value) };
    const badge = (over = {}) => elementsOfType(body({ ...props, ...over }), 'button')
      .find(button => button['data-health'] === 'ci')!;
    press(badge());
    press(badge({ healthFilter: 'ci' }));
    const clear = elementsOfType(body({ ...props, health: new Map(), healthFilter: 'ci' }), 'button')
      .find(button => button.children === 'Clear health filter')!;
    expect(clear.className).toContain('text-link');
    expect(String(clear.className).split(' ')).not.toContain('underline');
    press(clear);
    expect(selected).toEqual(['ci', 'all', 'all']);
  });
});

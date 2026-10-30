/**
 * What the repo page DRAWS (#575/#582, four tabs since #828).
 *
 * The board's test env is `node` with no DOM, so this renders `RepoBody` — the
 * page's pure half — to a static HTML string, exactly as `ReposPage.spec.tsx`
 * renders `ReposBody`. The stateful half above it owns only the fetch.
 *
 * `draw` is Overview and `drawAt` is one of the other three. The open-issues
 * block was on every render of this page until #828 and is the Issues tab now,
 * so the assertions about it moved with it rather than being dropped: the block
 * is the same block, at an address of its own.
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeBlock, TooltipProvider, type CodeLang, type CodeVariant } from '../ui/kit';
import { MissingRepoState, RepoBody, keyTops } from './RepoPage';
import { readmeFence, UNKNOWN_LANG } from './readme-code';
import { ciSpendCard } from './repo-page-vm';
import { BLOCK } from '../ui/block';
import { contrast, rgb, themeTokens, THEMES } from '../../test/kit-contrast';
import { BlockHeader } from '../ui/BlockHeader';
import { PAGE_READING } from '../ui/PageHeading';
import { IssuesSection, RepoTabRow } from './RepoSections';
import { repoTabs } from './repo-tabs';
import type { ClickLike } from './tile-nav';
import { gotoPath, REPO_SECTIONS, type RepoSection } from '../route';
import type { RepoMember, RepoOpenIssue, RepoOpenPr, RepoPageView, RepoPreviousPeriod, RepoPrior, RepoRow } from '../api/repos';

// The only real navigation this page can perform, mocked exactly as
// `ReposPage.spec.tsx` mocks it: `gotoPath` writes to `window.history`, and
// there is no window here. Everything else in `../route` is the real thing.
vi.mock('../route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../route')>()),
  gotoPath: vi.fn(),
}));

const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const weeks = (n: number, o: number, c: number) => Array.from({ length: n }, () => ({ opened: o, closed: c }));

const REPO: RepoRow = {
  full: 'acme/board.example.com',
  name: 'board.example.com',
  key: 'board',
  htmlUrl: 'https://github.com/acme/board.example.com',
  description: 'Acme team organizational platform',
  weeks: weeks(10, 4, 5),
  open: 3,
  owner: { login: 'octocat', name: 'Octocat' },
  language: 'TypeScript',
  pushedAt: ago(1),
};

/** Open issues as the server can actually send them: newest first, and never
 *  more of them than the repo has open. The block caps at five, so a fixture
 *  pairing a row count with an unrelated open count describes a payload nothing
 *  can produce — which is how #826's show-all row came to be asserted under a
 *  list that was already showing everything. */
const issues = (n: number): RepoOpenIssue[] =>
  Array.from({ length: n }, (_, i) => ({
    number: 584 + i,
    title: i === 0 ? 'The board never checks what it is allowed to do' : `Another thing that is open (${i})`,
    htmlUrl: `https://github.com/acme/board.example.com/issues/${584 + i}`,
    createdAt: ago(2 + i),
    author: 'octocat',
    labels: [],
  }));

/** Open pull requests as the server sends them, newest first. */
const openPrs = (n: number): RepoOpenPr[] =>
  Array.from({ length: n }, (_, i) => ({
    number: 900 + i,
    title: i === 0 ? 'The repo page splits into four tabs' : `Another thing in flight (${i})`,
    htmlUrl: `https://github.com/acme/board.example.com/pull/${900 + i}`,
    createdAt: ago(1 + i),
    author: 'octocat',
    authorIsBot: false,
    draft: i === 1,
  }));

const member = (over: Partial<RepoMember> = {}): RepoMember => ({
  login: 'octocat',
  name: 'Octocat',
  assigned: 2,
  openedIssues: 5,
  openedPrs: 3,
  dri: false,
  ...over,
});

function view(over: Partial<RepoPageView> = {}): RepoPageView {
  return {
    updatedAt: ago(0),
    repo: REPO,
    readme: { state: 'present', markdown: '# Board\n\nA line.' },
    pullRequests: {
      state: 'read', open: 2, closedMerged: 312,
      weeks: weeks(10, 6, 5).map((w) => ({ opened: w.opened, merged: w.closed })),
      openPrs: openPrs(2),
    },
    ciSpend: { state: 'read', weeks: Array.from({ length: 10 }, () => ({ minutes: 120, netUsd: 1.5 })) },
    // Three open, three drawn — everything this repo has open is on screen.
    openIssues: issues(3),
    members: { people: [member({ dri: true }), member({ login: 'ivan', name: null, assigned: 0, openedIssues: 1, openedPrs: 0 })], prsUnreadable: false },
    ...over,
  };
}

/** Six open, five drawn: the only shape whose show-all row has anything behind
 *  it, and the one the block's own cap produces. */
const capped = (over: Partial<RepoPageView> = {}) =>
  view({ repo: { ...REPO, open: 6 }, openIssues: issues(5), ...over });

/** Overview — the bare `/repo/:owner/:name`, which is what `section` absent
 *  means and what every link written before #828 opens. */
const draw = (v: RepoPageView) =>
  renderToStaticMarkup(<TooltipProvider><RepoBody view={v} now={NOW} /></TooltipProvider>);

/** One of the other three tabs, at its own address. */
const drawAt = (v: RepoPageView, section: RepoSection) =>
  renderToStaticMarkup(<TooltipProvider><RepoBody view={v} now={NOW} section={section} /></TooltipProvider>);

/** Every element of the tree `RepoBody` returns, unrendered. A static-markup
 *  string carries no handler, and whether this block intercepts its own click
 *  is the one thing the row is for. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [el, ...elements(el.props.children)];
}

/**
 * Every `BlockHeader` label this view draws, in page order, ASSERTING as it goes
 * that each one's own wrapper carries the block surface (#825).
 *
 * Walked with the parent in hand, which `elements()` above cannot give: the
 * question is not whether a `BLOCK` exists somewhere in the tree, it is whether
 * the element AROUND this label is one. The readme had a label and a block on
 * the same page and no block around that label.
 */
function blockLabels(v: RepoPageView, section?: RepoSection): string[] {
  const seen: string[] = [];
  type Wrapper = ReactElement<{ children?: ReactNode; label?: ReactNode; className?: string }>;
  const walk = (node: ReactNode, parent: Wrapper | null): void => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, parent)); return; }
    if (!isValidElement(node)) return;
    const el = node as Wrapper;
    if (el.type === BlockHeader) {
      const label = String(el.props.label);
      seen.push(label);
      expect(parent, `"${label}" has no element around it to carry the block`).not.toBeNull();
      expect(parent?.props.className ?? '', `"${label}" is not on the block surface`).toContain(BLOCK);
    }
    // A tab body is a COMPONENT since #828, and a component's output is not in
    // the element tree until something calls it — so the walk that used to see
    // this whole page saw `<Overview />` and stopped, finding nothing. It calls
    // them instead, which keeps the question list-free: a section added later is
    // walked because it is a child here, not because anybody remembered it.
    //
    // Chrome that needs a real render — anything holding state or context —
    // throws on being called this way and is skipped. Silence is not available
    // to it: every caller below pins the labels it expects, so a body that
    // stopped being walked fails on the set rather than passing on an empty one.
    // That is the assertion that caught this split.
    if (typeof el.type === 'function') {
      // The `try` covers the CALL and nothing else. Wrapping the walk of the
      // result as well swallows this helper's own failed assertions, which is
      // how a guard goes quiet: with the block surface taken off `SectionCard`
      // the three tab sections stayed green, because the expectation that
      // should have failed was caught here and discarded.
      let out: ReactNode = null;
      let rendered = false;
      try {
        out = (el.type as (props: unknown) => ReactNode)(el.props);
        rendered = true;
      } catch {
        /* not callable outside a render — chrome, not a section */
      }
      if (rendered) walk(out, parent);
    }
    walk(el.props.children, el);
  };
  // React logs an "invalid hook call" through `console.error` for each piece of
  // chrome the probe above declines to render, and the walk visits several. The
  // silence is scoped to this call and restored in a `finally`, so a genuine
  // error from anywhere else in the suite still prints: what is muted is the
  // noise of a question this helper asks on purpose, and nothing else.
  const complain = console.error;
  console.error = () => {};
  try {
    walk(RepoBody({ view: v, now: NOW, section }), null);
  } finally {
    console.error = complain;
  }
  return seen;
}

/** A click as `tile-nav` reads one, plus the one thing it does not read: the
 *  default this page's handler is or is not allowed to prevent. */
type Press = ClickLike & { preventDefault: () => void };

/** The show-all row itself. Found by its destination, so a row moved back into
 *  the block header is still found — the position is asserted separately, and
 *  this must not go quiet when it moves.
 *
 *  Walked from the Issues SECTION rather than from `RepoBody`, because that is
 *  where the block lives since #828 and `elements` does not call a component: a
 *  walk from the page would find the section's element and stop at it, and the
 *  row would go quiet exactly the way this helper's note above says it must not. */
const showAllRow = (v: RepoPageView = capped()) =>
  elements(IssuesSection({ view: v, now: NOW }))
    .find((el) => el.type === 'a' && (el.props as { href?: string }).href === '/overview?repo=acme%2Fboard.example.com') as
    ReactElement<{ href: string; onClick?: (e: Press) => void }> | undefined;

/** Rendered text with the tags stripped — what a reader actually reads. */
const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, '’').replace(/\s+/g, ' ');

describe('the repo page, populated (#575)', () => {
  it('names the repo with its owner, its description, and who owns it', () => {
    const t = textOf(draw(view()));
    expect(t).toContain('acme/');
    expect(t).toContain('board.example.com');
    expect(t).toContain('Acme team organizational platform');
    expect(t).toContain('Octocat');
    expect(t).not.toContain('octocat');
    expect(draw(view())).toContain('href="/people/octocat"');
  });

  /**
   * ONE FIGURE PER CARD, AND THE HEADER IS ITS UNIT (the reporter, over #1197).
   *
   * Each card leads with the number a reader came for — 3 open issues, 2 open
   * pull requests, $15.00 of CI — and nothing stands above it. The ten-week
   * pair #1197 drew over the chart (`50 closed 40 opened`) is off the card:
   * two windows in one 90px column, the right-now count underneath the
   * ten-week one, and the reporter read the wrong one first. The window's
   * totals still exist where they qualify the picture they belong to — the
   * chart's own accessible name — and nowhere as a figure.
   */
  it('draws the three trend cards, each headed and each leading with one figure', () => {
    const html = draw(view());
    const t = textOf(html);
    expect(t).toContain('Issues 3 ');
    expect(t).toContain('Pull requests 2 ');
    expect(t).toContain('CI spend $15.00 ');
    // No unit word anywhere beside a figure: the header carries it.
    expect(t).not.toContain('3 open ');
    expect(t).not.toContain('2 open ');
    expect(t).not.toContain('net billed');
    // The ten-week pair is gone from the cards…
    expect(t).not.toContain('50 closed');
    expect(t).not.toContain('50 merged');
    expect(t).not.toContain('40 opened');
    expect(t).not.toContain('60 opened');
    // …and survives only where it names the chart that draws it.
    expect(html).toContain('aria-label="40 opened and 50 closed in the last 10 weeks"');
    expect(html).toContain('aria-label="60 opened and 50 merged in the last 10 weeks"');
    // …and NOT the all-time closed count, which is a different window (#582).
    expect(t).not.toContain('312 closed');
  });

  it('says an unread stretch of the window in a sentence of its own (#694, #961)', () => {
    const prWeeks = (n: number) => weeks(n, 6, 5).map((w) => ({ opened: w.opened, merged: w.closed }));
    const t = textOf(draw(view({
      pullRequests: { state: 'read', open: 1, closedMerged: 312, weeks: [null, null, null, ...prWeeks(7)] },
    })));
    expect(t).toContain('3 earlier weeks were not read.');
  });

  it('agrees with itself when exactly one week went unread (#694)', () => {
    const prWeeks = (n: number) => weeks(n, 6, 5).map((w) => ({ opened: w.opened, merged: w.closed }));
    const t = textOf(draw(view({
      pullRequests: { state: 'read', open: 1, closedMerged: 312, weeks: [null, ...prWeeks(9)] },
    })));
    expect(t).toContain('1 earlier week was not read.');
  });

  /**
   * THE UNREAD COUNT RIDES UNDER THE CHART IT SHORTENS (#694, #961, #1240 R1).
   *
   * #1240 R1 moved it up against #1197's ten-week totals, and while those
   * existed that was right: they summed the COVERED windows only, so on a short
   * read the card's biggest numbers were partial and the sentence saying so
   * stood 158px and a whole picture below them.
   *
   * Those totals are off the card. What leads it now is `pr.open` — a right-now
   * count that no unread WINDOW makes partial — so above the chart this would
   * qualify a number it has nothing to say about. The chart is the one thing
   * left that the missing weeks actually shorten, and the order in the markup
   * is what says so. It is said once either way, never in both places.
   */
  it.each([
    ['a partly read window', 6, 4],
    ['a window nothing reached', 10, 0],
  ])('counts the unread weeks under the chart they shorten, for %s', (_what, missing, read) => {
    const prWeeks = (n: number) => weeks(n, 6, 5).map((w) => ({ opened: w.opened, merged: w.closed }));
    const html = draw(view({
      pullRequests: {
        state: 'read', open: 1, closedMerged: 312,
        weeks: [...Array.from({ length: missing }, () => null), ...prWeeks(read)],
      },
    }));
    const note = html.indexOf(`${missing} earlier weeks were not read.`);
    // The PR card is the second of the three, so its chart is the second one.
    const chart = html.indexOf('viewBox="0 0 324 56"', html.indexOf('Pull requests'));
    expect(note).toBeGreaterThan(-1);
    expect(chart).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(chart);
    expect(html.match(/earlier weeks were not read\./g)?.length).toBe(1);
  });

  /**
   * NOTHING ON THIS PAGE CAPTIONS ANYTHING (#1240) — A RULE, NOT ONE LINE.
   *
   * The approved mockup said "last 14 days" on the CI card above a ten-week
   * chart; #961 replaced that with one line above the cards, and #1240 took the
   * line away too — the reporter called it filler twice, then made it a rule:
   * no standalone caption, no heading suffix that is really one, no sentence
   * under a chart describing the chart, no sentence introducing the row.
   *
   * The test of a caption is whether it DESCRIBES the figures or IS one. Two
   * strings on this page stay, and neither describes: `N earlier weeks were not
   * read.` counts the weeks that are NOT on the chart, and the free-allowance
   * note counts the $0.00 weeks that ran — both report something no other
   * element reports. `vs 10 weeks ago` is not a sentence at all; it is the
   * baseline half of the delta it sits inside, and `+2` alone names no period.
   */
  it('captions the cards with nothing at all (#1240)', () => {
    const html = draw(view());
    const t = textOf(html);
    expect(t).not.toContain('14 days');
    expect(t).not.toContain('Last 10 weeks.');
    expect(t).not.toContain('compared with');
    // Nothing in the page's VISIBLE words names the window here: this view
    // sends no `previous`, so no delta carries a baseline either.
    expect(t).not.toContain('10 weeks');
    // The cards open the tab and each opens with its figure: nothing stands
    // between the tab row and the first card, and nothing between a card's
    // header and its number.
    expect(t).toContain('Members 2 Issues 3 ');
    expect(t).toContain('Pull requests 2 ');
    expect(t).toContain('CI spend $15.00 ');
  });

  it('renders the readme as markdown, with GFM on', () => {
    // remark-gfm is the plugin that gets forgotten; a table proves it is not.
    const html = draw(view({ readme: { state: 'present', markdown: '| a | b |\n| - | - |\n| 1 | 2 |' } }));
    expect(html).toContain('<table>');
  });
});

describe('the readme draws fenced code through the kit’s CodeBlock (#963)', () => {
  // Markup only. The suite has no DOM, so the copy button's press, the scroll
  // of a long line and the colours are not exercised here; they were looked at
  // in a browser, on #963.
  const kit = (code: string, lang: CodeLang, variant: CodeVariant = 'default') =>
    renderToStaticMarkup(<CodeBlock code={code} lang={lang} variant={variant} scroll copy />);
  const readme = (markdown: string) => draw(view({ readme: { state: 'present', markdown } }));

  it('draws a labelled fence as exactly the block the kit draws for it', () => {
    const html = readme("```ts\nconst a = 'b';\n```");
    expect(html).toContain(`<div class="md-code">${kit("const a = 'b';", 'ts')}</div>`);
    expect(html).not.toContain('language-ts');
  });

  it('still draws a fence with no label, and one in a language the kit has no grammar for', () => {
    const html = readme('```\nboard-frontend/   the SPA\n```\n\n```go\nfunc main() {}\n```');
    expect(html).toContain(kit('board-frontend/   the SPA', UNKNOWN_LANG));
    expect(html).toContain(kit('func main() {}', UNKNOWN_LANG));
  });

  it('draws a `#`-comment language with the shell grammar, which keeps an apostrophe in a comment', () => {
    const code = "# Don't retry here\ndef fetch(url):\n    return get(url)  # it's cached";
    const html = readme('```python\n' + code + '\n```');
    expect(html).toContain(kit(code, 'bash'));
    // With the fallback's grammar, which has no comments, the same text is one
    // string from `Don't` to `it's`, the line of code between them included.
    const strings = (markup: string) => [...markup.matchAll(/<span class="text-success">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(strings(html)).toEqual([]);
    expect(strings(kit(code, UNKNOWN_LANG))).toContain('def fetch(url):');
  });

  it('draws a diff or patch fence with the kit’s diff variant', () => {
    const code = '-const a = 1;\n+const a = 2;';
    expect(readme('```diff\n' + code + '\n```')).toContain(kit(code, UNKNOWN_LANG, 'diff'));
    expect(readme('```patch\n' + code + '\n```')).toContain(kit(code, UNKNOWN_LANG, 'diff'));
  });

  it('keeps inline code inline', () => {
    const html = readme('Run `pnpm dev` now.');
    expect(html).toContain('<p>Run <code>pnpm dev</code> now.</p>');
    expect(html).not.toContain('md-code');
    expect(html).not.toContain('data-line');
  });

  it('draws one line per source line, with no empty line for the closing fence', () => {
    expect(readme('```bash\nls\ncd x\n```').match(/data-line=/g)).toHaveLength(2);
  });

  it('escapes markup inside a fence rather than drawing it', () => {
    // From the readme's wrapper on: the page above it draws a real avatar <img>.
    const html = readme('```html\n<img src=x onerror=alert(1)><script>alert(1)</script>\n```');
    const md = html.slice(html.indexOf('class="pj-md'));
    expect(md).toContain('&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;');
    expect(md).not.toContain('<img');
    expect(md).not.toContain('<script');
  });
});

describe('readmeFence maps a fence label onto a kit grammar and variant (#963)', () => {
  it('knows the names readmes use, in any case', () => {
    expect(readmeFence(['language-TypeScript'])).toEqual({ lang: 'ts', variant: 'default' });
    expect(readmeFence(['language-js']).lang).toBe('ts');
    expect(readmeFence(['language-jsx']).lang).toBe('tsx');
    expect(readmeFence(['language-sh']).lang).toBe('bash');
    expect(readmeFence('language-json').lang).toBe('json');
    expect(readmeFence(['language-YAML']).lang).toBe('bash');
    expect(readmeFence(['language-Diff'])).toEqual({ lang: UNKNOWN_LANG, variant: 'diff' });
  });

  it('falls back for a language it does not know, a missing label, and a prototype key', () => {
    const fallback = { lang: UNKNOWN_LANG, variant: 'default' };
    expect(readmeFence(['language-go'])).toEqual(fallback);
    expect(readmeFence(undefined)).toEqual(fallback);
    expect(readmeFence([])).toEqual(fallback);
    expect(readmeFence(['language-constructor'])).toEqual(fallback);
    expect(readmeFence(['language-__proto__'])).toEqual(fallback);
    expect(readmeFence(['language-hasOwnProperty'])).toEqual(fallback);
  });
});

describe('each figure says how it moved against the previous period (#962)', () => {
  const read = (value: number): RepoPrior => ({ state: 'read', value });
  const prior = (openIssues: RepoPrior, openPrs: RepoPrior, ciNetUsd: RepoPrior): RepoPreviousPeriod =>
    ({ openIssues, openPrs, ciNetUsd });

  it('puts a signed change under each figure', () => {
    // 3 open issues now and 1 then; 2 open PRs now and 5 then; $15.00 billed
    // now and $12.50 then.
    const t = textOf(draw(view({ previous: prior(read(1), read(5), read(12.5)) })));
    expect(t).toContain('3 +2 vs 10 weeks ago');
    expect(t).toContain('2 −3 vs 10 weeks ago');
    // No "net billed" beside the amount since #1197: "CI spend" heads the card
    // and "$" carries the unit, so the words repeated both.
    expect(t).toContain('$15.00 +$2.50 vs previous 10 weeks');
    expect(t).not.toContain('net billed');
  });

  it('says a figure that did not move in words, never as a zero', () => {
    const t = textOf(draw(view({ previous: prior(read(3), read(2), read(15)) })));
    expect(t.match(/No change vs 10 weeks ago/g)?.length).toBe(2);
    expect(t).toContain('No change vs previous 10 weeks');
    expect(t).not.toContain('Last 10 weeks.');
    expect(t).not.toMatch(/[+−]\$?0(\.00)?\b|0%/);
  });

  it('says a repo too young for a previous period is too new, on every card', () => {
    const none: RepoPrior = { state: 'none' };
    expect(textOf(draw(view({ previous: prior(none, none, none) }))).match(/Too new to compare/g)?.length).toBe(3);
  });

  it('says a comparison it could not make, and one it was never sent, the same way', () => {
    const unknown: RepoPrior = { state: 'unknown' };
    expect(textOf(draw(view({ previous: prior(read(1), unknown, read(15)) })))).toContain('2 Couldn’t compare');
    // A board-api older than #962 sends no `previous` at all.
    expect(textOf(draw(view())).match(/Couldn’t compare/g)?.length).toBe(3);
    expect(textOf(draw(view()))).not.toContain('vs ');
  });

  it('draws an amount in the figure’s ink, and the words for no amount quieter', () => {
    const html = draw(view({ previous: prior(read(1), { state: 'none' }, read(15)) }));
    expect(html).toMatch(/<p class="[^"]*font-semibold[^"]*text-fg[^"]*">\+2 vs 10 weeks ago<\/p>/);
    expect(html).toMatch(/<p class="[^"]*text-dim[^"]*">Too new to compare<\/p>/);
  });

  it('claims no comparison over a page with no figure, and captions nothing', () => {
    const quiet = view({
      repo: { ...REPO, weeks: weeks(10, 0, 0), open: 0 },
      pullRequests: { state: 'read', open: 0, closedMerged: 0, weeks: [] },
      ciSpend: { state: 'read', weeks: Array.from({ length: 10 }, () => ({ minutes: 0, netUsd: 0 })) },
    });
    const t = textOf(draw(quiet));
    expect(t).not.toContain('compared with');
    // The cards open the tab. Nothing stands between the tab row and them.
    expect(t).toContain('Members 2 Issues Nothing opened or closed.');
    expect(t).not.toContain('10 weeks');
  });

  it('draws no line at all where no card says anything about a period', () => {
    // Both reads failed and the repo has no pull requests: nothing on the page
    // is about ten weeks, so a line naming them would qualify nothing.
    const t = textOf(draw(view({
      repo: { ...REPO, weeks: weeks(10, 0, 0), open: 0 },
      openIssues: [],
      openIssuesState: 'unreadable',
      pullRequests: { state: 'read', open: 0, closedMerged: 0, weeks: [] },
      ciSpend: { state: 'unreadable' },
    })));
    expect(t).not.toContain('10 weeks');
  });
});

describe('the four tabs are four addresses, drawn as navigation (#828)', () => {
  /** What only one of the four tabs can draw. A tab's own LABEL is no good as a
   *  marker: the row names all four on every one of them, which is the point of
   *  the row. */
  const ONLY_ON = {
    overview: 'viewBox="0 0 324 56"',                       // the trend charts
    issues: '/issues/584',                                  // an open issue's row
    prs: '/pull/900',                                       // an open pull request's row
    members: '2 open issues assigned',                      // a member's own line
  } as const;

  it('draws a nav of four links, one per address', () => {
    const html = draw(view());
    expect(html).toContain('<nav aria-label="Repo sections"');
    for (const href of [
      '/repo/acme/board.example.com',
      '/repo/acme/board.example.com/issues',
      '/repo/acme/board.example.com/prs',
      '/repo/acme/board.example.com/members',
    ]) {
      expect(html, href).toContain(`href="${href}"`);
    }
  });

  it('marks the tab you are on with aria-current, exactly once', () => {
    const at = (html: string) => (html.match(/aria-current="page"/g) ?? []).length;
    expect(at(draw(view()))).toBe(1);
    for (const section of ['issues', 'prs', 'members'] as const) {
      const html = drawAt(view(), section);
      expect(at(html), section).toBe(1);
      // …and on the right one: the mark sits on the anchor whose href is this
      // address, not on whichever anchor came first.
      const anchor = html.slice(html.indexOf(`href="/repo/acme/board.example.com/${section}"`));
      expect(anchor.slice(0, 120), section).toContain('aria-current="page"');
    }
  });

  it('says it is navigation and not a widget that swaps panels', () => {
    // `role="tab"` / `aria-selected` describe a control that changes what is on
    // screen in place. Every one of these changes the address, so a reader told
    // it is a tablist is told the wrong thing about what pressing it does.
    for (const section of [undefined, 'issues', 'prs', 'members'] as const) {
      const html = section ? drawAt(view(), section) : draw(view());
      expect(html, String(section)).not.toContain('role="tab"');
      expect(html, String(section)).not.toContain('aria-selected');
    }
  });

  it('puts the count on the three tabs that have one, and none on Overview', () => {
    const nav = (html: string) => html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    const html = draw(view());
    // Three open issues, two open pull requests, two people.
    expect(nav(html)).toContain('>3<');
    expect(nav(html)).toContain('>2<');
    // Overview's own label carries no figure beside it.
    expect(nav(html)).toContain('>Overview</a>');
  });

  it('draws each tab’s own content, and no other tab’s', () => {
    const drawn = {
      overview: draw(view()),
      issues: drawAt(view(), 'issues'),
      prs: drawAt(view(), 'prs'),
      members: drawAt(view(), 'members'),
    };
    for (const [on, html] of Object.entries(drawn)) {
      for (const [tab, marker] of Object.entries(ONLY_ON)) {
        expect(html.includes(marker), `${marker} on ${on}`).toBe(tab === on);
      }
    }
  });

  it('keeps the row on every tab, so there is a way back off each of them', () => {
    for (const section of ['issues', 'prs', 'members'] as const) {
      expect(drawAt(view(), section), section).toContain('href="/repo/acme/board.example.com"');
    }
  });

  it('hands a modified press on a tab back to the browser', () => {
    // The same rule the show-all row keeps, and from the same helper: written
    // per anchor, that guard has already been got wrong once on this page.
    const tabs = elements(RepoTabRow({ tabs: repoTabs(view(), undefined) }))
      .filter((el) => el.type === 'a') as ReactElement<{ href: string; onClick?: (e: Press) => void }>[];
    expect(tabs).toHaveLength(4);
    const press = (onClick: ((e: Press) => void) | undefined, over: Partial<Press> = {}) => {
      let prevented = false;
      onClick?.({
        defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0,
        preventDefault: () => { prevented = true; },
        ...over,
      });
      return prevented;
    };
    for (const t of tabs) {
      expect(press(t.props.onClick), `${t.props.href} plain`).toBe(true);
      for (const held of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
        expect(press(t.props.onClick, { [held]: true }), `${t.props.href} ${held}`).toBe(false);
      }
      expect(press(t.props.onClick, { button: 1 }), `${t.props.href} middle`).toBe(false);
    }
    expect(vi.mocked(gotoPath)).toHaveBeenCalledWith('/repo/acme/board.example.com/members');
  });
});

describe('the Members tab draws a short list as a short one (#828)', () => {
  const HALF_BLIND = view({
    pullRequests: { state: 'unreadable' },
    members: { people: [member({ openedPrs: 0 })], prsUnreadable: true },
  });

  it('says the pull requests could not be read, in the same words the card uses', () => {
    const t = textOf(drawAt(HALF_BLIND, 'members'));
    expect(t).toContain('Pull requests couldn’t be read just now.');
    expect(t).toContain('anybody who only opens them is missing');
    // The people it did find are still drawn: they are real.
    expect(t).toContain('Octocat');
  });

  it('counts no pull request in a row, and puts no count on the tab', () => {
    const html = drawAt(HALF_BLIND, 'members');
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    // No `Members 1`: the list is short by everybody who only opens pull
    // requests, so the row may not present it as the whole of who works here.
    expect(nav).not.toContain('>1<');
    // The row keeps the numbers that were read and drops the clause that would
    // have been a zero. "0 pull requests" is the shape this page never draws;
    // the sentence above the list is where pull requests are mentioned at all.
    const t = textOf(html);
    expect(t).toContain('2 open issues assigned, opened 5 issues ');
    expect(t).not.toContain('0 pull request');
    expect(t).not.toContain('opened 5 issues and');
  });

  it('never says nobody works here when the half that would name them failed', () => {
    const t = textOf(drawAt(view({
      pullRequests: { state: 'unreadable' },
      members: { people: [], prsUnreadable: true },
    }), 'members'));
    expect(t).toContain('Pull requests couldn’t be read just now.');
    expect(t).not.toContain('Nobody has opened an issue or a pull request here in the last 10 weeks');
  });

  it('says a login the roster does not carry exactly once', () => {
    // `name ?? login` followed by the login unconditionally printed
    // `anton-khovanskiy anton-khovanskiy`, which is what a row looks like for
    // every contributor the team roster has never heard of.
    const t = textOf(drawAt(view({
      members: { people: [member({ login: 'anton-khovanskiy', name: null })], prsUnreadable: false },
    }), 'members'));
    expect(t.match(/anton-khovanskiy/g) ?? []).toHaveLength(1);
  });

  it('says so when this board was never sent the list at all', () => {
    // The deploy window: board-web ships before board-api. An empty list would
    // be a claim about the repo made by a fact about the payload.
    const t = textOf(drawAt(view({ members: undefined }), 'members'));
    expect(t).toContain('This board hasn’t been sent who works on this repo.');
  });
});

describe('the PRs tab (#828)', () => {
  it('lists the open pull requests, ages them, and marks a draft', () => {
    const html = drawAt(view(), 'prs');
    const t = textOf(html);
    expect(t).toContain('The repo page splits into four tabs');
    expect(t).toContain('opened yesterday');
    expect(html).toContain('https://github.com/acme/board.example.com/pull/900');
    // A draft is the one state an open pull request has that changes what to do
    // about it, and the fixture's second row is one.
    expect(t).toContain('Draft');
  });

  it('names who opened each one, and marks a bot as one', () => {
    // Measured on 2026-09-03: all 8 open pull requests on this very repo are
    // dependabot's. Unmarked, the tab reads as eight people waiting on you.
    const t = textOf(drawAt(view({
      pullRequests: {
        state: 'read', open: 3, closedMerged: 312,
        weeks: weeks(10, 6, 5).map((w) => ({ opened: w.opened, merged: w.closed })),
        openPrs: [
          { ...openPrs(1)[0], number: 700, title: 'A person opened this', author: 'IvanRoslov' },
          { ...openPrs(1)[0], number: 701, title: 'Bump react from 19.2.6 to 19.2.7', author: 'dependabot', authorIsBot: true },
          { ...openPrs(1)[0], number: 702, title: 'Opened by somebody who has since gone', author: null },
        ],
      },
    }), 'prs'));
    expect(t).toContain('IvanRoslov');
    expect(t).toContain('dependabot');
    expect(t.match(/Bot/g) ?? []).toHaveLength(1);
    // A ghost account is a person nobody can name any more, not a machine: the
    // row says nothing rather than "unknown", and is never marked Bot.
    expect(t).not.toContain('unknown');
    expect(t).not.toContain('null');
  });

  it('says a failed read in the same words the trend card does', () => {
    const t = textOf(drawAt(view({ pullRequests: { state: 'unreadable' } }), 'prs'));
    expect(t).toContain('Pull requests couldn’t be read just now');
    expect(t).not.toContain('No open pull requests');
  });

  it('says the list is capped rather than drawing the cap as the count', () => {
    const t = textOf(drawAt(view({
      pullRequests: {
        state: 'read', open: 118, closedMerged: 312,
        weeks: weeks(10, 6, 5).map((w) => ({ opened: w.opened, merged: w.closed })),
        openPrs: openPrs(4),
      },
    }), 'prs'));
    expect(t).toContain('118 open');
    expect(t).toContain('The newest 4 pull requests are here.');
  });
});

describe('the Issues tab is the whole open queue (#828)', () => {
  // Every assertion below was on Overview until #828, where the block showed
  // five rows of the queue. The block did not change; its address did. It is
  // drawn on ONE tab now, which is the other half of the move and is held by
  // "each tab draws its own content and no other's" below.
  it('closes the issue list with a way into the repo’s filtered queue', () => {
    // The tile's primary click now opens this page, so the queue it used to
    // open has to be reachable FROM here — that is #575's "one step away". It
    // sits under the last row rather than in the header since #826, and it
    // counts the repo's whole queue, not the rows: six open, five drawn.
    const html = drawAt(capped(), 'issues');
    expect(html).toContain('href="/overview?repo=acme%2Fboard.example.com"');
    expect(textOf(html)).toContain('Show all 6 open issues');
    // Under the last row, which is where a reader's eye lands and the whole of
    // why it moved out of the header. Moving it back leaves every string above
    // true, so the position is what has to be held.
    expect(html.indexOf('href="/overview?repo=acme%2Fboard.example.com"')).toBeGreaterThan(html.lastIndexOf('/issues/588'));
  });

  it('keeps that row’s click, so the queue opens in the board and not in a reload', () => {
    // The markup is identical whether or not the anchor intercepts its own
    // click, and an anchor that does not is a full page load out of the SPA.
    // So this asks the element, not the string.
    expect(showAllRow(), 'the show-all row is drawn at all').toBeDefined();
    expect(typeof showAllRow()?.props.onClick).toBe('function');
  });

  it('hands every modified press back to the browser, and takes only the plain one', () => {
    // Driven through the handler that ships. Written inline, this guard read ⌘
    // and ctrl only, so shift+click and alt+click were swallowed: a reader
    // asking for a new window got their current page replaced instead. The rule
    // is `tileOpens`, which the repo grid has kept since #558.
    const onClick = showAllRow()?.props.onClick;
    const press = (over: Partial<Press> = {}) => {
      let prevented = false;
      onClick?.({
        defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0,
        preventDefault: () => { prevented = true; },
        ...over,
      });
      return prevented;
    };
    expect(press(), 'a plain press is the board’s').toBe(true);
    for (const held of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      expect(press({ [held]: true }), `${held} belongs to the browser`).toBe(false);
    }
    expect(press({ button: 1 }), 'a middle click belongs to the browser').toBe(false);
    // …and the plain one really did navigate, or the line above is satisfied by
    // a handler that prevents the default and then does nothing.
    expect(vi.mocked(gotoPath)).toHaveBeenCalledWith('/overview?repo=acme%2Fboard.example.com');
  });

  it('offers no way to the rest when the rest is already on screen', () => {
    // Three open, three drawn. #826 gated this row on the repo's open count
    // alone, so every repo with one to five open issues drew all of them and
    // then offered to show them.
    const html = drawAt(view(), 'issues');
    expect(html).toContain('>3 open<'); // the block header still counts them
    expect(textOf(html)).not.toContain('Show all');
    expect(html).not.toContain('href="/overview?repo=acme%2Fboard.example.com"');
  });

  it('draws no state pill, because every row in this block is open', () => {
    // A pill reading "Open" on every row of a block captioned "Open issues" is
    // furniture that says nothing, and the greyed title it paired with had one
    // other state to mean anything against (#826). Its own markup is what this
    // holds: every fixture row here is open, so "Closed" could not appear
    // whether the pill is drawn or not.
    const html = drawAt(view(), 'issues');
    expect(html).not.toContain('rounded-full bg-elevated');
    expect(textOf(html)).not.toContain('Closed');
    expect(html).toContain('>Open issues<');
  });

  it('ages an open issue and links it out to Github', () => {
    const html = drawAt(view(), 'issues');
    expect(textOf(html)).toContain('opened 2 days ago');
    expect(html).toContain('https://github.com/acme/board.example.com/issues/584');
  });

  it('says the list is capped instead of drawing the cap as the count', () => {
    // The service caps this list; the count above it is the repo's whole open
    // queue. Without the line between them a reader has a header saying 137
    // over a hundred rows and no account of the difference.
    const t = textOf(drawAt(view({ repo: { ...REPO, open: 137 }, openIssues: issues(100) }), 'issues'));
    expect(t).toContain('137 open');
    expect(t).toContain('The newest 100 issues are here.');
    expect(t).toContain('Show all 137 open issues');
  });

  it('tells an empty queue from a capped one, in words', () => {
    const t = textOf(drawAt(view({ repo: { ...REPO, open: 0 }, openIssues: [] }), 'issues'));
    expect(t).toContain('No open issues');
    expect(t).not.toContain('are here.');
    expect(t).not.toContain('Show all');
  });
});

describe('a failed issue read says so on BOTH of the pages that draw it (#837)', () => {
  /** What the payload looks like when this repo's own fetch failed: no rows, and
   *  `open` and `weeks` rolled up from the same ingest, so both read zero for the
   *  reason the list is empty. Every figure here is a zero nobody measured. */
  const unread = () => view({
    repo: { ...REPO, open: 0, weeks: weeks(10, 0, 0) },
    openIssues: [],
    openIssuesState: 'unreadable',
  });

  it('the Overview card says the read failed rather than a quiet quarter', () => {
    // The regression: the Issues tab gained the third answer and this card did
    // not, so the Overview drew "Nothing opened or closed in ten weeks" — the
    // exact false positive #837 exists to kill — one click from the tab saying
    // the read failed.
    const t = textOf(draw(unread()));
    // The block header, not the page text: since #1240 the card is headed
    // "Issues", which the tab row beside it also says, so `toContain` on the
    // rendered text would pass on the tab alone.
    expect(blockLabels(unread())).toContain('Issues');
    expect(t).toContain('Open issues couldn’t be read just now');
    expect(t).not.toContain('Nothing opened or closed');
  });

  it('and the Issues tab says it in the same words, because it is one read', () => {
    const t = textOf(drawAt(unread(), 'issues'));
    expect(t).toContain('Open issues couldn’t be read just now');
    expect(t).not.toContain('No open issues');
  });

  it('draws no figure at all, so nothing on the page reads as measured', () => {
    // Not merely the right sentence. The label and the line are CONTIGUOUS,
    // which is only true when nothing sits between them: no `0 open`, no window
    // heading, and no ten-week chart of zeros — a flat line through zero draws
    // as a measurement, and there was nothing to measure.
    const t = textOf(draw(unread()));
    expect(t).toContain('Issues Open issues couldn’t be read just now.');
    // The tab beside it prints no count either, for the same reason.
    expect(t).toContain('Overview Issues PRs 2');
  });

  it('keeps today’s answer where the payload carries no state', () => {
    // A board-api older than #837 sends none, and absent is a fact about the
    // payload rather than about the read.
    const t = textOf(draw(view({
      repo: { ...REPO, open: 0, weeks: weeks(10, 0, 0) },
      openIssues: [],
      openIssuesState: undefined,
    })));
    expect(t).toContain('Nothing opened or closed.');
    expect(t).not.toContain('couldn’t be read');
  });
});

describe('CI spend — a week that ran for nothing does not draw as silence (#582)', () => {
  const freeWeeks = (kinds: ('idle' | 'free' | 'billed')[]) => ({
    state: 'read' as const,
    weeks: kinds.map((k) => (
      k === 'billed' ? { minutes: 400, netUsd: 4.12 } : k === 'free' ? { minutes: 53, netUsd: 0 } : { minutes: 0, netUsd: 0 }
    )),
  });

  it('marks the free weeks on the baseline, and leaves the idle ones bare', () => {
    // Measured: acme-docs ran 53, 303 and 94 minutes in three consecutive
    // weeks, billed $0.00 for all three. On a dollars-only chart those weeks are
    // pixel-identical to silent ones — this is what stops that.
    const html = draw(view({ ciSpend: freeWeeks(['idle', 'free', 'billed', 'idle']) }));
    expect(html).toContain('data-free-week="1"');
    expect(html).not.toContain('data-free-week="0"');
    expect(html).not.toContain('data-free-week="2"');
    expect(html).not.toContain('data-free-week="3"');
  });

  it('says it in words too, because the mark is small and the claim is not', () => {
    const t = textOf(draw(view({ ciSpend: freeWeeks(['free', 'free', 'billed']) })));
    expect(t).toContain('2 weeks used the included allowance; $0 was billed for that work');
  });

  it('a whole window billed at nothing still says the repo built', () => {
    // $0.00 headline, and it must NOT read as "no CI ran".
    const t = textOf(draw(view({ ciSpend: freeWeeks(['free', 'free', 'free']) })));
    expect(t).toContain('$0.00');
    expect(t).toContain('3 weeks used the included allowance; $0 was billed for that work');
    expect(t).not.toContain('No CI ran');
  });

  it('a window where nothing ran at all says exactly that, once', () => {
    const t = textOf(draw(view({ ciSpend: freeWeeks(['idle', 'idle']) })));
    expect(t).toContain('CI spend No CI ran.');
  });
});

describe('a chart that answers a pointer, and the week it has none of (#877)', () => {
  /**
   * EVERY CHART ON THIS PAGE ANSWERS NOW, which two of them did not before #877.
   * The hit strip is what a reader points at, so its columns are what says a
   * chart answers — one button per week, each naming its own week in the board's
   * one chart grammar.
   */
  it('lays a hit column per week on all three cards, each naming its week', () => {
    const html = draw(view());
    expect((html.match(/data-point=/g) ?? []).length).toBe(30); // the last 10 weeks x 3
    const t = textOf(html);
    // The pair charts join their two counts with "and"; the CI chart reports one
    // reading and takes the comma. Both sentences are `repo-page-vm`'s.
    expect(html).toContain('aria-label="this week, ');
    expect(t).toContain('CI spend $15.00');
  });

  /**
   * THE CARD WITH NO WEEKS AT ALL, which is a `read` card and not an absence.
   *
   * `prFlowCard` answers `read` whenever the repo HAS pull requests, and drops
   * every window the read's cap did not reach — so a busy repo whose windows all
   * came back `null` produces `covered: []` with `uncovered: 10`. There is no
   * week for the reading box to name there, and asking it for week -1 threw and
   * took the whole page with it. The chart draws and answers nothing instead,
   * which is the guard `dashboard/Pulse.tsx` keeps for the same case.
   */
  it('draws a card whose windows were all unread, instead of throwing on week -1', () => {
    const unread = view({
      pullRequests: { state: 'read', open: 4, closedMerged: 9, weeks: Array.from({ length: 10 }, () => null) },
    });
    const t = textOf(draw(unread));
    expect(t).toContain('Pull requests');
    expect(t).toContain('10 earlier weeks were not read');
    // It answers nothing, because there is nothing to point at.
    expect(draw(unread)).not.toContain('40 opened and 36 merged');
  });

  /** Why `CiChart` needs no such guard, held as the invariant rather than as a
   *  sentence: a CI window with no weeks has no minutes and no dollars, so the
   *  card is `nothing` and the chart is never drawn at all. */
  it('never hands the CI chart a read card with no weeks in it', () => {
    expect(ciSpendCard({ state: 'read', weeks: [] }).kind).toBe('nothing');
  });
});

describe('the empty repo still draws a page (#575, definition of done)', () => {
  // No repo in acme lacks a readme, so this path is real and unobservable
  // against the live org. It is held here instead.
  const EMPTY = view({
    repo: { ...REPO, description: null, weeks: weeks(10, 0, 0), open: 0, owner: null, pushedAt: ago(14) },
    readme: { state: 'absent' },
    pullRequests: { state: 'read', open: 0, closedMerged: 0, weeks: [] },
    ciSpend: { state: 'read', weeks: Array.from({ length: 10 }, () => ({ minutes: 0, netUsd: 0 })) },
    openIssues: [],
    members: { people: [], prsUnreadable: false },
  });

  it('says in words what is absent, and never draws it as zero', () => {
    const t = textOf(draw(EMPTY));
    expect(t).toContain('Nothing opened or closed. Pushed 2 weeks ago.'); // the repo is alive; its queue is not
    expect(t).toContain('No pull requests in this repo');
    expect(t).toContain('No CI ran.');
    // Three cards that each say what did not happen, and no line over them
    // saying over what (#1240). An empty card's own sentence is the whole of
    // what the page claims here.
    expect(t).not.toContain('10 weeks');
    expect(t).toContain('No readme');
    // Not "No issues in this repo": a repo whose queue is entirely closed has
    // issues, and that block is not about them (#826). It is the Issues tab
    // since #828, so the sentence is asked for where it is drawn.
    expect(textOf(drawAt(EMPTY, 'issues'))).toContain('No open issues');
  });

  it('draws a page on every tab, not just on the one with something to say', () => {
    // An empty repo's Issues, PRs and Members are three absences, and each gets
    // its own sentence rather than a blank card or a spinner that never ends.
    expect(textOf(drawAt(EMPTY, 'prs'))).toContain('No pull requests in this repo');
    expect(textOf(drawAt(EMPTY, 'members'))).toContain('Nobody has opened an issue or a pull request here');
  });

  it('draws no chart at all where there was nothing to measure', () => {
    // A flat line through zero reads as a measurement. There was none. (The ⋯
    // handle is an svg too, so this asks about charts rather than about svgs —
    // a populated page has three of them and an empty one has none.)
    const charts = (html: string) => html.match(/viewBox="0 0 324 56"/g)?.length ?? 0;
    expect(charts(draw(view()))).toBe(3);
    expect(charts(draw(EMPTY))).toBe(0);
  });

  it('pads nothing — the page ends after the readme line', () => {
    // Guards against filler creeping into the cards that have no data (#254).
    const html = draw(EMPTY);
    expect(html).not.toContain('data-free-week');
    expect(html.length).toBeLessThan(draw(view()).length);
  });
});

describe('a read that failed is told apart from a repo that has none', () => {
  it('offers the words of a retry, not a zero', () => {
    const t = textOf(draw(view({
      readme: { state: 'unreadable' },
      pullRequests: { state: 'unreadable' },
      ciSpend: { state: 'unreadable' },
    })));
    expect(t).toContain('Pull requests couldn’t be read just now');
    expect(t).toContain('CI spend couldn’t be read just now');
    expect(t).toContain('The readme couldn’t be read just now');
    // …and none of the three claims there is none of the thing.
    expect(t).not.toContain('No pull requests');
    expect(t).not.toContain('No readme');
  });
});

describe('the repo page tells an unread owner from an unowned repo (#718)', () => {
  it('says the owner was not read, instead of offering to set one', () => {
    // The same false claim the tile used to make, in a second place: "Set
    // owner" says the org records no owner for this repo, and an ownership read
    // that failed says nothing of the kind. This page has room for the whole
    // sentence, so it draws it rather than the tile's three words.
    const unread = textOf(draw(view({ repo: { ...REPO, owner: null, ownerState: 'unreadable' } })));
    expect(unread).toContain('Owner not read');
    expect(unread).toContain('The owner couldn’t be read just now.');
    expect(unread).not.toContain('Set owner');
  });

  it('still offers to set one where the org simply records none', () => {
    // The pair, so the line above is a difference rather than a string that
    // replaced another everywhere.
    const unowned = textOf(draw(view({ repo: { ...REPO, owner: null, ownerState: 'read' } })));
    expect(unowned).toContain('Set owner');
    expect(unowned).not.toContain('not read');
  });
});

describe('house rules the page has to keep', () => {
  /**
   * Every labelled section of this page sits on the block surface (#825).
   *
   * The readme did not. It was a `Readme` label over markdown running straight
   * on the page canvas — no fill, no radius, no padding — under four sections
   * that all had one, and 580px short of the block above it once the rail caps.
   * The file's own header had claimed "every card is BLOCK" since #575 and was
   * simply wrong, which is the reason this is a test and not a sentence: a claim
   * in a comment is read by whoever is already looking at the right line.
   *
   * Asked of the element tree, so it holds for the label a future section adds
   * without anybody remembering to extend a list. `BlockHeader` is the page's
   * one way to label a block, so finding them all IS the list.
   */
  it('puts every BlockHeader on the block surface, on every tab', () => {
    // Asked of all four addresses (#828), not just the one a bare path lands
    // on: three of this page's five labelled blocks moved onto tabs, and a rule
    // about "every labelled section of this page" that only ever visited
    // Overview would stop covering them the day they moved.
    //
    // The sets are pinned per tab, which is what stops this going quiet. The
    // walk calls components to reach a tab body, and a body it could not call
    // would simply contribute nothing — indistinguishable from a page with no
    // blocks, unless somebody wrote down what each tab owes.
    expect(blockLabels(capped())).toEqual(['Issues', 'Pull requests', 'CI spend', 'Readme']);
    expect(blockLabels(capped(), 'issues')).toEqual(['Open issues']);
    expect(blockLabels(capped(), 'prs')).toEqual(['Open pull requests']);
    expect(blockLabels(capped(), 'members')).toEqual(['Members']);
    // And every section the router can name is one of the four above, so a
    // fifth tab lands here as a failure rather than as an unvisited address.
    expect(REPO_SECTIONS).toEqual(['issues', 'prs', 'members']);
  });

  it('keeps the block when a card has nothing to show', () => {
    // The three absent states and the two readme ones a repo can actually reach.
    // A block that disappears when its content does is the same fault as #825,
    // one state further in, and `Absent` is a second place it could come back.
    const empty = view({
      readme: { state: 'absent' },
      pullRequests: { state: 'unreadable' },
      ciSpend: { state: 'unreadable' },
      openIssues: [],
      repo: { ...REPO, open: 0, weeks: weeks(10, 0, 0) },
    });
    blockLabels(empty);
    // The three tabs in their empty and unreadable states too: a block that
    // disappears with its content is the same fault one address further along.
    for (const section of REPO_SECTIONS) blockLabels(empty, section);
    blockLabels(view({ readme: { state: 'unreadable' } }));
  });

  it('holds the readme prose to the reading measure inside its block', () => {
    // The block is the page's width; the line length is not. Dropping the
    // measure would fix #825 by making a 1392px line of prose at a capped rail.
    //
    // A plain substring, not a regex over the markup. `PAGE_READING` is
    // `max-w-[812px]`, so a pattern built from it needs its brackets escaped,
    // and a hand-rolled escape is what CodeQL called an incomplete sanitizer on
    // the first push of this branch (js/incomplete-sanitization, high). The
    // arrow test below already carries the same lesson in prose.
    expect(draw(view())).toContain(`class="pj-md ${PAGE_READING}"`);
  });

  it('uses no ALL-CAPS label and ends no heading in a full stop', () => {
    const html = draw(view());
    for (const label of ['Issues', 'Pull requests', 'CI spend', 'Readme']) {
      expect(html).toContain(`>${label}<`);
    }
    // The three block labels that moved onto tabs of their own (#828), each
    // asked for where it is drawn.
    expect(drawAt(view(), 'issues')).toContain('>Open issues<');
    expect(drawAt(view(), 'prs')).toContain('>Open pull requests<');
    expect(drawAt(view(), 'members')).toContain('>Members<');
    for (const section of ['issues', 'prs', 'members'] as const) {
      expect(drawAt(view(), section), section).not.toContain('uppercase');
    }
    expect(html).not.toContain('uppercase');
  });

  it('spells it Github, and never draws the external-link arrow', () => {
    const html = draw(view({ readme: { state: 'unreadable' } }));
    expect(html).not.toContain('GitHub');
    expect(html).not.toContain('↗');
  });

  it('keeps every arrow out of the name a screen reader reads', () => {
    // `{head.showAll} →` as a bare text node made the link's accessible name
    // "Show all 6 open issues right arrow". The arrow is decoration and says so
    // in `aria-hidden`, exactly as PageCrumb's back arrow does. This asks about
    // arrows rather than about the two glyphs somebody remembered — the ↗ rule
    // above never covered →, which is a different character.
    //
    // Unicode's three arrow blocks: Arrows, the dingbat arrows ↗ came from, and
    // Supplemental Arrows-B.
    //
    // Asked of the element tree and not of the rendered string. Stripping
    // `aria-hidden` subtrees out of markup with a regex is the shape of an
    // incomplete sanitizer, which is what it reads as to a scanner and to the
    // next person — and it is guesswork besides, since it cannot see nesting.
    // The tree knows which element each glyph is under.
    const arrows = /[←-⇿➔-➿⤀-⥿]/u;
    const spoken: string[] = [];
    const seen: string[] = [];
    const walk = (node: ReactNode, hidden: boolean) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, hidden));
      if (typeof node === 'string' || typeof node === 'number') {
        const glyphs = [...String(node)].filter((c) => arrows.test(c));
        seen.push(...glyphs);
        if (!hidden) spoken.push(...glyphs);
        return;
      }
      if (!isValidElement(node)) return;
      const props = node.props as { children?: ReactNode; 'aria-hidden'?: unknown };
      walk(props.children, hidden || props['aria-hidden'] === 'true' || props['aria-hidden'] === true);
    };
    // Both halves of the page: the tab row, which draws no arrow and must not
    // start, and the Issues tab, which draws the one arrow this is about. A walk
    // from `RepoBody` alone stops at the section's own element — `elements`
    // does not call a component — and would report an empty `seen` as a pass.
    walk(RepoBody({ view: capped(), now: NOW }), false);
    walk(IssuesSection({ view: capped(), now: NOW }), false);

    expect(spoken).toEqual([]);
    // …and the page does draw one, or the line above is a rule about nothing.
    expect(seen).toContain('→');
  });
});

describe('the free-week mark can actually be seen (#582)', () => {
  const tickOf = (html: string) => /<line[^>]*data-free-week="0"[^>]*>/.exec(html)?.[0] ?? '';

  it('draws at full tone, not the trace’s 0.55', () => {
    // Measured before this: rgb(90,96,113) on rgb(31,34,45) = 2.53:1, under
    // WCAG 1.4.11's 3:1 for an informational non-text graphic. This is the mark
    // that keeps net-billed-cost honest, so it is the last thing here allowed
    // to be hard to see.
    const tick = tickOf(draw(view({
      ciSpend: { state: 'read', weeks: [{ minutes: 53, netUsd: 0 }, { minutes: 9, netUsd: 2 }] },
    })));
    expect(tick).toContain('stroke="var(--muted)"');
    expect(tick).not.toContain('opacity');
  });

  it('keeps its width off the viewport, so the tone holds at every size', () => {
    // `preserveAspectRatio="none"` scales x with the card: as a rect the mark
    // painted 2.041px at 1440 and 1.210px at 1024, and a sub-pixel mark never
    // reaches full tone — measured 3.738:1 there against 5.147:1 wide. A
    // non-scaling stroke takes the width out of the transform.
    const tick = tickOf(draw(view({ ciSpend: { state: 'read', weeks: [{ minutes: 53, netUsd: 0 }] } })));
    expect(tick).toContain('vector-effect="non-scaling-stroke"');
    expect(tick).toContain('stroke-width="2"');
  });

  it('has no magnitude — every free week is the same mark', () => {
    // The moment its height varies it is a second series, and minutes are not
    // a trend. Height is y1−y2, and it may not move with the minutes.
    const html = draw(view({
      ciSpend: { state: 'read', weeks: [{ minutes: 5, netUsd: 0 }, { minutes: 900, netUsd: 0 }, { minutes: 1, netUsd: 3 }] },
    }));
    const marks = [...html.matchAll(/data-free-week="\d"[^>]*?y1="([\d.]+)"[^>]*?y2="([\d.]+)"/g)]
      .map((m) => Number(m[1]) - Number(m[2]));
    expect(marks).toHaveLength(2);
    expect(new Set(marks).size).toBe(1);
  });

});

/**
 * WHAT #1197 LEFT ON THE PAGE ONCE ITS FIGURES CAME OFF.
 *
 * #1197 did two things: it drew the window's two totals as 34px figures above
 * each flow chart, and it took the 0.55 stroke-opacity off the reference trace
 * so the two series were opaque and legible. The reporter struck the figures
 * — one number per card, and it is the open count — and kept the strokes.
 *
 * So what is asserted here is the strokes: both series opaque, at tokens that
 * clear WCAG 1.4.11's 3:1 for an informational non-text graphic, with the dot
 * legends that used to stand in for labels still gone. On main the trace was
 * `--muted` at 0.55, which composited to 2.48:1 light and 2.53:1 dark
 * against the card — a real shortfall, and the reason the opacity went.
 */
describe('both flow series stay opaque and legible (#1197)', () => {
  it('matches the two strokes to Throughput, with no dot legends and no 0.55', () => {
    const html = draw(view());
    const cards = [...html.matchAll(/<section[^>]*>([\s\S]*?)<\/section>/g)]
      .map((match) => match[1]).filter((card) => card.includes('data-dot="repo-flow"'));
    expect(cards).toHaveLength(2);
    for (const [i, card] of cards.entries()) {
      expect(card).toContain('stroke="var(--chart-series)"');
      expect(card).toContain('stroke="var(--muted)"');
      expect(card).not.toContain('stroke-opacity="0.55"');
      expect(card).not.toContain('size-[5px]');
      // Nothing above the chart is painted in a series colour any more: the
      // 34px pair went with the words that told its two numbers apart.
      const above = card.slice(0, card.indexOf('<svg'));
      expect(above).not.toContain('text-[34px]');
      expect(above).not.toContain('style="color:var(--chart-series)"');
      expect(above).not.toContain('style="color:var(--muted)"');
      // THE SERIES WORD IS BACK ON THE CARD, once, at the end of its own line.
      // It is not the 34px figure #1197 drew and not the dot legend that
      // preceded it: no number, no swatch, no row under the chart — a word in
      // the gutter the chart reserves, centred on the point its line ends at.
      // Between the totals coming off and this, the card drew two lines of
      // different colour with nothing naming either.
      const word = i === 0 ? 'closed' : 'merged';
      const key = card.slice(card.indexOf('</svg>'));
      expect(textOf(card).match(new RegExp(`\\b${word}\\b`, 'g'))).toHaveLength(1);
      expect(textOf(card).match(/\bopened\b/g)).toHaveLength(1);
      expect(key).toContain(`>${word}</span>`);
      expect(key).toContain('>opened</span>');
      // Text ink, not the line's own colour: `--chart-series` has a 4.4:1 floor in
      // dark, which a 1.9px line may take under 1.4.11 and 11.5px text may not
      // under 1.4.3. What carries the colour to the word is the terminal dot.
      expect(key).not.toContain('var(--chart-series)');
      expect(card).toContain('data-dot="repo-flow-trace"');
      expect(card).toContain(`${word} in `);
    }
  });

  it.each(THEMES)('keeps the trace above 3:1 and the card words above 4.5:1 in %s', (theme) => {
    // 1.4.11, not 1.4.3: with the figures gone these two tokens paint only
    // lines. The threshold is the same 3:1 either way, which is why the one
    // reading covers both and why removing the figures loosened nothing.
    // `--chart-series` is a per-accent color-mix (#1450), which no hex reading
    // resolves. check-chart-contrast.mjs measures it as painted, for every
    // accent, at floors above this 3:1.
    const tokens = themeTokens(theme);
    const background = rgb(tokens['--surface']);
    expect(contrast(rgb(tokens['--muted']), background)).toBeGreaterThanOrEqual(3);
    // The words on the card are body text and keep the text threshold.
    for (const token of ['--dim', '--muted']) {
      expect(contrast(rgb(tokens[token]), background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('charts the covered PR weeks only, and draws no figure off them', () => {
    const html = draw(view({
      repo: { ...REPO, weeks: weeks(10, 4, 0) },
      pullRequests: { state: 'read', open: 4, closedMerged: 312,
        weeks: [null, { opened: 7, merged: 0 }, { opened: 2, merged: 0 }] },
    }));
    const text = textOf(html);
    // The card leads with `pr.open`, which no unread window makes partial…
    expect(text).toContain('Pull requests 4 ');
    // …the covered totals name the chart, over the window they actually sum
    // and not the one the page draws: two of ten windows came back, so the
    // name says two of ten rather than claiming all ten…
    expect(html).toContain('aria-label="9 opened and 0 merged in 2 of the last 10 weeks"');
    expect(text).not.toContain('0 merged 9 opened');
    expect(text).not.toContain('0 closed 40 opened');
    // …the weeks the read never reached are counted under it…
    expect(text).toContain('1 earlier week was not read');
    // …and the all-time closed count is a different window (#582).
    expect(text).not.toContain('312 merged');
  });

  it('does not present unread PR weeks as a measured zero', () => {
    const text = textOf(draw(view({
      pullRequests: { state: 'read', open: 4, closedMerged: 9, weeks: [null, null] },
    })));
    expect(text).not.toContain('0 merged');
    expect(text).toContain('2 earlier weeks were not read');
  });

  /** Main asserted this on Overview — "blue text means link on this page" —
   *  and the describe block that replaced it did not carry it forward. It is
   *  the other half of moving the CI chart onto the board's chart blue: the
   *  page has exactly one meaning for `--accent`, and a stroke painted in
   *  it asked a reader to tell a line from a link by size. */
  it('paints no word on Overview in the brand, because blue here means link', () => {
    expect(draw(view()).match(/text-accent/g) ?? []).toHaveLength(0);
  });

  it('keeps exactly one brand-coloured word on the Issues tab, and it is the link', () => {
    const html = drawAt(capped(), 'issues');
    expect(html.match(/text-accent/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="/overview?repo=acme%2Fboard.example.com"');
  });
});

/**
 * THE STANDING RULE, GUARDED AT THE PLACE IT WAS BREAKABLE (#1240; review F4).
 *
 * The reporter's rule for this page is that nothing here describes the figures,
 * it only states them — no line above the cards, no heading suffix, no sentence
 * under a chart. Two of those three were guarded. The third was not: a review
 * injected `<p className={UNDER}>Closed against opened, week by week.</p>` after
 * the Issues card's chart and it passed all 212 specs and the copy gate, because
 * the checks that carried the rule counted mentions of the window and read the
 * space ABOVE the cards.
 *
 * What closes it is a whole-card reading rather than a third position: the exact
 * visible words of every card that draws a chart, in order. A card is a short,
 * closed list of things — its header, its one figure, its delta, the two words
 * naming its lines, and a sentence that COUNTS something the picture cannot show
 * — so pinning the list costs one assertion and refuses a sentence wherever it
 * is put. The two counting sentences are in it by name; the guard is not a rule
 * about full stops that a caption can be written around.
 */
describe('nothing on a card describes the card (#1240)', () => {
  const read = (value: number): RepoPrior => ({ state: 'read', value });
  /** Every card on the tab, in order, as markup. */
  const cardsOf = (html: string) =>
    [...html.matchAll(/<section[^>]*>([\s\S]*?)<\/section>/g)].map((m) => m[1]);
  /** A full row: all three cards drawn, each with a delta, the PR read short of
   *  its window and the CI window carrying free weeks — so both counting
   *  sentences are on the page and the guard is not vacuous. */
  const row = () => draw(view({
    previous: { openIssues: read(1), openPrs: read(5), ciNetUsd: read(12.5) },
    pullRequests: {
      state: 'read', open: 2, closedMerged: 312,
      weeks: [null, null, null, null, null, null, { opened: 6, merged: 5 }, { opened: 6, merged: 5 },
        { opened: 6, merged: 5 }, { opened: 6, merged: 5 }],
      openPrs: [],
    },
    ciSpend: {
      state: 'read',
      weeks: [
        ...Array.from({ length: 3 }, () => ({ minutes: 53, netUsd: 0 })),
        ...Array.from({ length: 7 }, () => ({ minutes: 120, netUsd: 1.5 })),
      ],
    },
  }));

  it('says exactly this and nothing else, on every card that draws a chart', () => {
    const drawn = cardsOf(row()).filter((card) => card.includes('<svg'));
    expect(drawn).toHaveLength(3);
    expect(drawn.map((card) => textOf(card).trim())).toEqual([
      'Issues 3 +2 vs 10 weeks ago closed opened',
      'Pull requests 2 −3 vs 10 weeks ago merged opened 6 earlier weeks were not read.',
      'CI spend $10.50 −$2.00 vs previous 10 weeks 3 weeks used the included allowance; $0 was billed for that work',
    ]);
  });

  /** The two sentences the page keeps under a chart, and the whole of the
   *  reason they are not captions: each COUNTS something the picture cannot
   *  show. The unread weeks are the ones NOT drawn; the free weeks are the ones
   *  whose real work draws a line identical to silence. */
  const COUNTS = [
    /^\d+ earlier weeks? (?:was|were) not read\.$/,
    /^\d+ weeks? used the included allowance; \$0 was billed for that work$/,
  ];

  it('lets nothing follow a chart but one of those two counts', () => {
    for (const card of cardsOf(row()).filter((c) => c.includes('<svg'))) {
      // Everything after the chart, with the key words taken off the front:
      // those are in the gutter the chart reserves, beside their own lines,
      // not under it.
      const under = textOf(card.slice(card.lastIndexOf('</svg>')))
        .replace(/^\s*(?:closed|merged|opened)\s+(?:closed|merged|opened)\s*/, '')
        .trim();
      if (under === '') continue;
      expect(COUNTS.some((shape) => shape.test(under)), `under a chart: ${under}`).toBe(true);
    }
  });
});

/**
 * THE THREE CARDS ARE REGIONS, and until now they were not (review F3).
 *
 * `<section>` with no accessible name is ignored by Chrome's AX tree, so the
 * page carried exactly one landmark — its title — and the header was a loose
 * `StaticText` above a paragraph reading "5". With the unit word gone from the
 * figure that paragraph no longer survives being read out of linear order; on
 * main it read "3 open". Naming each section from the header it already draws
 * costs one attribute and buys both: the figure is named, and a screen-reader
 * user can reach and skip the three cards instead of reading the tab top to
 * bottom.
 */
describe('each Overview card names itself (#1240 review F3)', () => {
  const ids = ['repo-card-issues', 'repo-card-prs', 'repo-card-ci'];

  it('points each card at the header it already draws', () => {
    const html = draw(view());
    for (const id of ids) {
      expect(html).toContain(`<section class="${BLOCK} px-[18px] pb-[17px] pt-4" aria-labelledby="${id}">`);
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('keeps the region when the card has nothing to draw', () => {
    // A card that failed to read is still a card. A region that appears and
    // disappears with the payload is worse than none: the reader's map of the
    // page changes under them.
    const html = draw(view({
      openIssuesState: 'unreadable',
      pullRequests: { state: 'unreadable' },
      ciSpend: { state: 'unreadable' },
    }));
    for (const id of ids) {
      expect(html).toContain(`aria-labelledby="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
  });
});

/**
 * WHERE THE TWO KEY WORDS SIT (review F1).
 *
 * Nothing lays out in the board's `node` test env, so this is the one piece of
 * the key that can be wrong with every spec green: a word printed over the
 * other names nothing, and a word printed outside the chart's 56px either
 * changes the card's height or is clipped.
 */
describe('the flow key holds its words on their own lines (#1197)', () => {
  it('leaves two lines that finish far apart exactly where they finish', () => {
    expect(keyTops(53, 3)).toEqual([49, 7]);
    expect(keyTops(20, 40)).toEqual([20, 40]);
  });

  it('pushes two lines that finish together apart, about their midpoint', () => {
    expect(keyTops(28, 30)).toEqual([22, 36]);
    expect(keyTops(30, 28)).toEqual([36, 22]);
  });

  it('holds a pushed pair inside the chart rather than off either end', () => {
    // Two lines that finish at the same point are a tie, and a tie puts the
    // hero first — it is the line the card is about.
    expect(keyTops(0, 0)).toEqual([7, 21]);
    expect(keyTops(56, 56)).toEqual([35, 49]);
  });
});

describe('a repo this board does not carry gets a state (#575 follow-up)', () => {
  const missing = (status: 'not-found' | 'error') =>
    renderToStaticMarkup(<MissingRepoState status={status} owner="acme" name="not-a-repo" />);

  it('names what happened in a heading and offers the way back as a link', () => {
    const html = missing('not-found');
    expect(textOf(html)).toContain('Not on this board');
    expect(textOf(html)).toContain('isn’t a repo this board carries');
    expect(html).toContain('href="/repos"');
    expect(textOf(html)).toContain('Back to Repos');
    // A heading, not the page's smallest type — this was one 12.5px <p>.
    expect(html).toContain('<h1');
  });

  it('hands a modified press on the way back to the browser (#828)', () => {
    // This link guarded on ⌘ and ctrl and swallowed shift and alt — the same
    // defect #575 fixed on the queue row, in the second place on this page that
    // had it. Asked of the element: the markup is identical either way.
    const back = elements(MissingRepoState({ status: 'not-found', owner: 'acme', name: 'not-a-repo' }))
      .find((el) => el.type === 'a' && (el.props as { href?: string }).href === '/repos') as
      ReactElement<{ href: string; onClick?: (e: Press) => void }> | undefined;
    expect(back, 'the way back is drawn at all').toBeDefined();
    const press = (over: Partial<Press> = {}) => {
      let prevented = false;
      back?.props.onClick?.({
        defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0,
        preventDefault: () => { prevented = true; },
        ...over,
      });
      return prevented;
    };
    expect(press(), 'a plain press is the board’s').toBe(true);
    for (const held of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      expect(press({ [held]: true }), `${held} belongs to the browser`).toBe(false);
    }
    expect(press({ button: 1 }), 'a middle click belongs to the browser').toBe(false);
    expect(vi.mocked(gotoPath)).toHaveBeenCalledWith('/repos');
  });

  it('does not tell a failed read that the repo is absent', () => {
    const t = textOf(missing('error'));
    expect(t).toContain('Couldn’t read this repo');
    expect(t).not.toContain('isn’t a repo');
  });
});

/**
 * The repo page is permission-sensitive in whole (#892 review, C2).
 *
 * Every figure on it comes from `/api/repos/:owner/:name/page`, which
 * `ReposService` serves off its permission-sensitive state — the security
 * posture, the CI spend and the members among them. A check that finds the same
 * repositories reauthorizes none of that.
 */
describe('a fresh access check re-reads this page (#892)', () => {
  const SOURCE = readFileSync(new URL('./RepoPage.tsx', import.meta.url), 'utf8');

  it('uses the shared reader without putting the section in its query key', () => {
    expect(SOURCE).toContain('useBoardRead<RepoPageView>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/page`)');
    const hook = readFileSync(new URL('../cache/use-board-read.ts', import.meta.url), 'utf8');
    expect(hook).toContain('useAccessEpoch()');
    expect(hook).toContain('readClient.invalidateQueries');
    expect(hook).toContain('readValue<T>(query.data)');
  });

  it('leaves the reader on the section they chose', () => {
    // `section` reaches the body as a prop off the route and is in no fetch key,
    // so a re-read cannot move the tab.
    expect(SOURCE).toContain('<RepoBody view={view} now={Date.now()} section={section} />');
  });
});

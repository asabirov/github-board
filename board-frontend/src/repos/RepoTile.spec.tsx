/**
 * Three tones for the count, over one floor (#695, revising #613).
 *
 * WHICH tone a count gets is `countTone`'s answer and is pinned in
 * `repos-vm.spec.ts`. What cannot be seen from there is the class that answer
 * turns into, which is the whole of the contrast argument: the rule is a class
 * on a span, so this is the level it can be pinned at — render tiles that
 * differ only in their queue length, and read the count each one drew.
 *
 * `renderToStaticMarkup` is how the whole of this surface is tested (see the
 * header of `ReposPage.spec.tsx`): the board's test env is `node`, and a static
 * string is enough to answer what a reader sees. The provider is there because
 * the count hangs a `Hint` off the board's tooltip and Radix refuses to render
 * one outside a provider.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup as renderBare } from 'react-dom/server';
import type { ReactElement } from 'react';
import { TooltipProvider } from '../ui/kit';
import { parseHTML } from 'linkedom';
import type { RepoRow } from '../api/repos';
import { RepoTile } from './RepoTile';
import { repoMetric } from './repos-vm';

function render(ui: ReactElement): string {
  return renderBare(<TooltipProvider>{ui}</TooltipProvider>);
}

function row(over: Partial<RepoRow> & { name: string }): RepoRow {
  return {
    full: `acme/${over.name}`,
    key: over.name,
    htmlUrl: `https://github.com/acme/${over.name}`,
    description: null,
    weeks: Array.from({ length: 10 }, () => ({ opened: 0, closed: 0 })),
    open: 0,
    owner: null,
    language: null,
    pushedAt: null,
    ...over,
  };
}

/** The class the 19px figure carries, off the rendered markup rather than off
 *  the constant — the constant agreeing with itself proves nothing. */
function countClass(html: string): string {
  const found = [...html.matchAll(/class="([^"]*text-\[19px\][^"]*)"/g)].map((m) => m[1]);
  expect(found, 'the tile drew no 19px count').toHaveLength(1);
  return found[0];
}

const tile = (over: Partial<RepoRow> & { name: string }) => ({ row: row(over), health: null });

const HEAVY = 'text-fg';
const ORDINARY = 'text-dim';
const EMPTY = 'text-muted';

/** Every class the 19px count may carry, written out rather than imported: the
 *  constant agreeing with itself proves nothing (see `countClass` above). */
const COUNT = 'repo-metric text-[19px] font-semibold leading-none tabular-nums';
const RAMP = [`${COUNT} ${EMPTY}`, `${COUNT} ${ORDINARY}`, `${COUNT} ${HEAVY}`];

describe('the open count', () => {
  it.each([false, true])('leaves a zero issue count empty (explicit lens: %s)', (withLens) => {
    const empty = tile({ name: 'quiet', open: 0 });
    const html = render(<RepoTile tile={withLens ? { ...empty, metric: repoMetric(empty, 'issues') } : empty} driOptions={[]} canWrite={false} share={7} />);
    const { document } = parseHTML(html);
    expect(document.querySelector('[data-repo-metric="issues"]')?.textContent).toBe('');
    expect(document.querySelector('[data-repo="quiet"]')).not.toBeNull();
  });

  it('keeps positive counts and unavailable issue reads visible', () => {
    for (const [open, openIssuesState, expected] of [[3, 'read', '3'], [0, 'unreadable', 'Unavailable']] as const) {
      const item = tile({ name: 'r', open, openIssuesState });
      const { document } = parseHTML(render(<RepoTile tile={{ ...item, metric: repoMetric(item, 'issues') }} driOptions={[]} canWrite={false} share={7} />));
      expect(document.querySelector('[data-repo-metric="issues"]')?.textContent).toBe(expected);
    }
  });

  it('keeps zero counts in other lenses visible', () => {
    const item = tile({ name: 'r', open: 0 });
    const metric = repoMetric(item, 'prs', { pullRequests: { state: 'read', open: 0, closedMerged: 0, weeks: [] } });
    const { document } = parseHTML(render(<RepoTile tile={{ ...item, metric }} driOptions={[]} canWrite={false} share={7} />));
    expect(document.querySelector('[data-repo-metric="prs"]')?.textContent).toBe('0');
  });

  it('sets an empty queue, an ordinary one and one over its share three ways', () => {
    // The whole of what #695 asked for: sweeping the grid, a reader can tell an
    // empty repo from a busy one and a drowning one from either, without
    // reading the digits.
    const at = (open: number) =>
      countClass(render(<RepoTile tile={tile({ name: 'r', open })} driOptions={[]} canWrite={false} share={7} />));
    expect(at(0)).toContain(EMPTY);
    expect(at(3)).toContain(ORDINARY);
    expect(at(82)).toContain(HEAVY);
  });

  it('never sets the headline below the figure derived from it (#613)', () => {
    // #613's guard, kept. The faint zero it removed was the tertiary ink at 45%
    // — 2.12:1 against the tile where an ordinary count read 6.75:1 and the
    // 11.5px figure UNDER it read 5.15:1. That inversion is still the defect.
    //
    // What changed is where the floor is. The zero is now that same 11.5px
    // figure's tone — tertiary at full strength, 5.15:1 — so the headline is
    // never the fainter of the two. Anything below it, and any dimming at all,
    // is the thing #613 removed coming back under another number.
    for (const open of [0, 1, 7, 8, 82]) {
      const cls = countClass(
        render(<RepoTile tile={tile({ name: 'r', open })} driOptions={[]} canWrite={false} share={7} />),
      );
      // Asserted WHOLE, not searched for a good token. A search can say a good
      // token is PRESENT; it cannot say a dimmed one is absent, and both ways
      // past it are spellings of the exact ink #613 deleted:
      // `text-muted/45` satisfies any `\b`-terminated token match, and
      // `text-muted dark:text-muted/40` satisfies even a
      // whitespace-terminated one while being 2.12:1 in the one theme #613
      // measured. Three strings are the whole of what this span may draw, so
      // the guard names all three and refuses everything else — including a
      // legitimate-looking utility, which is a decision worth stopping for.
      expect(RAMP, `${open} open`).toContain(cls);
    }
  });

  it('sets every count the same where the map derived no share', () => {
    // A map with nothing on it to compare against does not get to call one tile
    // loud. Only the zero still recedes — that reading needs no comparison.
    const at = (open: number) =>
      countClass(render(<RepoTile tile={tile({ name: 'r', open })} driOptions={[]} canWrite={false} share={null} />));
    expect(at(3)).toBe(at(82));
    expect(at(0)).not.toBe(at(3));
  });

  it('puts no second colour on a tile that already carries a coloured word', () => {
    // #613's non-goal, and the reason the ramp is neutral: the footer word owns
    // `text-danger` for a leaked credential and `text-warn` for a
    // failing CI, and a heavy count must not read as a third thing gone wrong.
    const html = render(
      <RepoTile
        tile={{ row: row({ name: 'acme-landing', open: 13 }), health: { security: { depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null }, ci: 'failure', ciUrl: null } }}
        driOptions={[]}
        canWrite={false}
        share={7}
      />,
    );
    expect(countClass(html)).not.toContain('danger');
    expect(countClass(html)).not.toContain('warning');
    expect(html, 'the footer word still reports standing').toContain('CI failing');
  });
});

describe('the repo action affordance', () => {
  it('places the card menu at the top of the tile and omits the arrow delta', () => {
    const html = render(<RepoTile tile={tile({ name: 'r', open: 3, weeks: [{ opened: 4, closed: 1 }] })} driOptions={[]} canWrite={false} share={7} />);
    expect(html, 'a 44px target on a touch screen').toContain('absolute top-2 right-2 [@media(pointer:coarse)]:size-11');
    expect(html).not.toContain('↑3');
    expect(html).not.toContain('↓3');
  });

  it('reserves the top-right handle corner from the open count', () => {
    const html = render(<RepoTile tile={tile({ name: 'r', open: 3 })} driOptions={[]} canWrite={false} share={7} />);
    expect(html).toContain('flex items-baseline gap-2.5 pr-4 [@media(pointer:coarse)]:pr-9');
  });
});

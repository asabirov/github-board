import { describe, expect, it } from 'vitest';
import type { ViewerIssue } from './viewer-issue';
import { canCloseIssue, closeTargetOf, issueReference, issueReferenceParts, middleElide, stackMarkdown } from './board-card';

/** Minimal ViewerIssue fixture — only the fields the board-mode power reads. */
function mk(o: Partial<ViewerIssue>): ViewerIssue {
  return {
    repo: 'acme',
    number: 1,
    title: 'An issue',
    htmlUrl: 'https://github.com/acme/acme/issues/1',
    state: 'open',
    assignees: [],
    labels: [],
    projects: [],
    type: 'feature',
    createdAt: '2026-07-01T00:00:00Z',
    ...o,
  };
}

// These lock the ported board-mode dispatch power to the retired IssueQueue's
// exact behaviour (#394) — the regression-prone surface the spec calls out.
describe('stackMarkdown — Copy-for-agent (ported verbatim from IssueQueue)', () => {
  it('renders the header + a dash line + an indented URL per issue', () => {
    const md = stackMarkdown('Bugs', [
      mk({ number: 7, title: 'Login loops', repo: 'acme', htmlUrl: 'https://github.com/acme/acme/issues/7' }),
      mk({ number: 9, title: 'Slow sync', repo: 'board', htmlUrl: 'https://github.com/acme/board/issues/9' }),
    ]);
    expect(md).toBe(
      [
        '## Open issues — Bugs',
        '',
        '- Login loops — acme #7',
        '  https://github.com/acme/acme/issues/7',
        '- Slow sync — board #9',
        '  https://github.com/acme/board/issues/9',
      ].join('\n'),
    );
  });

  it('marks a blocked issue with " (blocked)" after the ref', () => {
    const md = stackMarkdown('Features', [mk({ number: 3, title: 'Export', blocked: true })]);
    expect(md).toContain('- Export — acme #3 (blocked)');
  });

  it('an empty stack is just the header line + a blank line', () => {
    expect(stackMarkdown('Feedback', [])).toBe('## Open issues — Feedback\n');
  });
});

describe('card context-menu model (ported from IssueQueue)', () => {
  it('the copy reference is repo#number', () => {
    expect(issueReference(mk({ repo: 'board', number: 42 }))).toBe('board#42');
  });

  // #662/#674: the board card prints the same reference the menu copies. These
  // pin the two to one function, so a change to either lands on both.
  it('the card meta is the copy reference, split so the number survives truncation', () => {
    const i = mk({ repo: 'acme-deployment-extension-v2', number: 1234 });
    const parts = issueReferenceParts(i);
    expect(parts).toEqual({ repo: 'acme-deployment-extension-v2', number: '#1234' });
    // Only the repo half is the truncating one; the number half carries the `#`
    // so a card that cuts the repo still reads as an identifier.
    expect(parts.repo).not.toContain('#');
    expect(parts.number).toBe('#1234');
    // …and rejoined it is byte-for-byte what Copy reference puts on the clipboard.
    expect(parts.repo + parts.number).toBe(issueReference(i));
  });

  it('splits at the LAST # so a repo name containing one keeps its number', () => {
    // Not a Github-legal repo name, but the split must not depend on that.
    expect(issueReferenceParts(mk({ repo: 'od#d', number: 8 })))
      .toEqual({ repo: 'od#d', number: '#8' });
  });

  it('offers Close only for a real Github issue URL that is still open', () => {
    const open = mk({});
    expect(canCloseIssue(open, false)).toBe(true);
    // A card marked closed (post-close) no longer offers the action.
    expect(canCloseIssue(open, true)).toBe(false);
    // A non-Github URL can't resolve a close target → no action.
    expect(canCloseIssue(mk({ htmlUrl: 'https://example.com/x' }), false)).toBe(false);
  });

  it('resolves the close target owner/repo/number/title from the html URL', () => {
    const t = closeTargetOf(mk({ number: 5, title: 'Fix it', htmlUrl: 'https://github.com/acme/board/issues/5' }));
    expect(t).toEqual({ owner: 'acme', repo: 'board', number: 5, title: 'Fix it' });
  });

  it('has no close target for a non-Github URL', () => {
    expect(closeTargetOf(mk({ htmlUrl: 'not-a-url' }))).toBeNull();
  });
});

// #662 review: the card names its repo in a 210px column, where the longest repo
// in the org doesn't fit. These pin HOW it doesn't fit. The measurement is a
// character count here and glyph widths in the card; the algorithm is the same
// one, which is the whole point of `fits` being injected.
describe('middleElide — how a repo name gives way in a narrow column', () => {
  /** A budget in characters, standing in for the card's canvas measurement. */
  const upTo = (n: number) => (candidate: string) => Array.from(candidate).length <= n;

  const LONG = 'acme-deployment-extension-v2';

  it('returns the text untouched when it already fits, and measures it once', () => {
    let asked = 0;
    const fits = (c: string) => { asked += 1; return upTo(40)(c); };
    expect(middleElide(LONG, fits)).toBe(LONG);
    expect(asked).toBe(1);
  });

  it('cuts from the middle, keeping the head and the tail', () => {
    expect(middleElide(LONG, upTo(20))).toBe('acme-depl…tension-v2');
  });

  it('keeps the tail, so two repos sharing this org\'s prefix stay distinguishable', () => {
    // The reason the cut is in the middle: tail truncation renders both of these
    // as `acme-deployment-…` and the reader cannot tell which repo the card is in.
    const ext = middleElide('acme-deployment-extension-v2', upTo(20));
    const api = middleElide('acme-deployment-api', upTo(20));
    expect(ext).not.toBe(api);
    // Both keep the end of their own name, which is the part that differs.
    expect(ext).toBe('acme-depl…tension-v2');
    expect(api).toBe('acme-deployment-api');
  });

  it('spends the whole budget — the result is as long as it is allowed to be', () => {
    for (const budget of [8, 12, 16, 20, 25]) {
      const out = middleElide(LONG, upTo(budget));
      expect(Array.from(out).length).toBe(budget);
    }
  });

  it('is always strictly shorter than what it replaced', () => {
    const out = middleElide(LONG, upTo(Array.from(LONG).length - 1));
    expect(Array.from(out).length).toBeLessThan(Array.from(LONG).length);
  });

  it('degrades to the cut mark alone when almost nothing fits', () => {
    expect(middleElide(LONG, upTo(2))).toBe('…2');
    expect(middleElide(LONG, upTo(1))).toBe('…');
    // Not even the cut mark fits (a card narrower than one glyph): still say
    // something rather than render an empty meta row.
    expect(middleElide(LONG, () => false)).toBe('…');
  });

  it('never eats the #number, because the number is not what it is handed', () => {
    // The card elides `parts.repo` only; `parts.number` is a sibling span the
    // algorithm never sees. This pins that composition.
    const parts = issueReferenceParts(mk({ repo: LONG, number: 1234 }));
    const shown = middleElide(parts.repo, upTo(12)) + parts.number;
    expect(shown).toBe('acme-…ion-v2#1234');
    expect(shown.endsWith('#1234')).toBe(true);
  });
});

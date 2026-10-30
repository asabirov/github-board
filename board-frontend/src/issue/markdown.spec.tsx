import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
// Vite's `?raw`, the house route to a source file in this package (see App.spec.ts).
import PAGE_SOURCE from './IssuePage.tsx?raw';
import { Markdown } from './markdown';

// The issue page's renderer, now its own module (#693). It is extracted so the
// composer's PREVIEW draws through the SAME component the thread does — a second
// renderer would agree today and drift the first time a plugin or an override
// moves. Every assertion below is about the pipeline a reader actually sees.
const HERE = { owner: 'acme', repo: 'board' };

const html = (md: string) => renderToStaticMarkup(<Markdown here={HERE}>{md}</Markdown>);

describe('the one markdown renderer the issue page and its composer share (#693)', () => {
  it('renders GFM tables, which CommonMark alone prints as raw pipes', () => {
    const out = html('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<th>a</th>');
    expect(out).not.toContain('| a | b |');
  });

  it('renders a GFM task list as checkboxes, disabled for a reader', () => {
    const out = html('- [x] done\n- [ ] not');
    expect(out).toContain('class="task-list-item"');
    expect(out).toMatch(/<input[^>]*checked[^>]*disabled|<input[^>]*disabled[^>]*checked/);
  });

  it('resolves a #123 reference against the issue’s OWN repo, via githubRefs', () => {
    expect(html('fixed in #123'))
      .toContain('href="https://github.com/acme/board/issues/123"');
  });

  it('arms the body’s task checkboxes when — and only when — a toggle is passed', () => {
    const reader = html('- [ ] a task');
    expect(reader).not.toContain('pj-task-editable');
    const writer = renderToStaticMarkup(
      <Markdown here={HERE} onToggleTask={() => {}}>{'- [ ] a task'}</Markdown>,
    );
    expect(writer).toContain('pj-task-editable');
    expect(writer).not.toMatch(/<input[^>]*\sdisabled/);
  });

  // The rule the extraction exists to enforce, so it outlives the prose that
  // states it: inside `src/issue/`, exactly ONE production module builds a
  // markdown render, and everything that draws issue markdown — the body, the
  // comments, a composer's preview — comes out of it. A second `ReactMarkdown`
  // call here is the drift, and it would agree with this one on the day it was
  // written. `github-refs.ts` imports the package for a TYPE only, which is why
  // the predicate is the value import rather than the module name.
  //
  // Specs are exempt: `body-tasks.spec.tsx` and `github-refs.spec.tsx` drive
  // ReactMarkdown directly on purpose, to assert against the real pipeline.
  // `src/repos/RepoPage.tsx` is a different surface and out of this rule.
  it('is the only production module under src/issue that renders markdown', () => {
    const sources = import.meta.glob('./*.tsx', { query: '?raw', import: 'default', eager: true });
    const modules = Object.entries(sources as Record<string, string>)
      .filter(([path]) => !path.includes('.spec.'));
    // The glob is the assertion's own subject, so prove it read real bytes
    // before believing a "nobody else does this" answer off it.
    expect(modules.length).toBeGreaterThan(2);
    const renderers = modules
      .filter(([, src]) => /^import ReactMarkdown/m.test(src))
      .map(([path]) => path);
    expect(renderers).toEqual(['./markdown.tsx']);
  });

  it('is the module IssuePage imports, not a copy kept beside it', () => {
    expect(PAGE_SOURCE).toMatch(/from '\.\/markdown'/);
    // A local `function Markdown(` back in the page is the drift this move exists
    // to prevent: two renderers, one of which the composer's preview would miss.
    expect(PAGE_SOURCE).not.toMatch(/function Markdown\(/);
  });
});

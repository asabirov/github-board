import { describe, expect, it } from 'vitest';
import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isTaskListItem, setTaskChecked, taskLineOf } from './body-tasks';

// Render markdown through the SAME pipeline the page uses and collect the task
// checkboxes exactly as the interactive `li` renderer wires them (the production
// helpers isTaskListItem + taskLineOf) — proving the (line, checked) set agrees
// with what react-markdown + remark-gfm actually render, the only authority on
// what a checkbox is. This is the regression guard for C1: a naive regex re-count
// disagreed with the renderer inside fences/blockquotes.
function wiredTasks(md: string): { line: number; checked: boolean }[] {
  const out: { line: number; checked: boolean }[] = [];
  const components: Components = {
    li(props) {
      if (isTaskListItem(props.node)) {
        const line = taskLineOf(props.node)!;
        const cb = Children.toArray(props.children).find(
          (c) => isValidElement<{ type?: string }>(c) && c.props.type === 'checkbox',
        );
        const checked = isValidElement<{ checked?: boolean }>(cb) && cb.props.checked === true;
        out.push({ line, checked });
      }
      return <li>{props.children}</li>;
    },
  };
  renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{md}</ReactMarkdown>,
  );
  return out;
}

describe('task checkbox extraction agrees with the renderer (#426)', () => {
  it('excludes a fake `- [ ]` inside a code fence — the real task after it wins', () => {
    const md = ['- [ ] A', '```', '- [ ] fake', '```', '- [x] B'].join('\n');
    // The renderer emits exactly 2 checkboxes: A (line 1), B (line 5). The fenced
    // `- [ ]` on line 3 is a code sample, never a checkbox.
    expect(wiredTasks(md)).toEqual([
      { line: 1, checked: false },
      { line: 5, checked: true },
    ]);
  });

  it('excludes an indented-code false task', () => {
    const md = ['Prose paragraph.', '', '    - [ ] indented fake', '', '- [x] real'].join('\n');
    expect(wiredTasks(md)).toEqual([{ line: 5, checked: true }]);
  });

  it('INCLUDES a real task inside a blockquote, with its true source line', () => {
    const md = ['- [ ] before', '', '> - [x] quoted', '', '- [ ] after'].join('\n');
    expect(wiredTasks(md)).toEqual([
      { line: 1, checked: false },
      { line: 3, checked: true },
      { line: 5, checked: false },
    ]);
  });

  it('gives byte-identical duplicate task lines DISTINCT source lines', () => {
    const md = ['- [ ] ship it', '- [ ] ship it', '- [ ] ship it'].join('\n');
    expect(wiredTasks(md).map((t) => t.line)).toEqual([1, 2, 3]);
  });

  it('handles ordered-list tasks', () => {
    const md = ['1. [ ] one', '2. [x] two'].join('\n');
    expect(wiredTasks(md)).toEqual([
      { line: 1, checked: false },
      { line: 2, checked: true },
    ]);
  });

  it('emits no wired tasks for a body with no task list', () => {
    expect(wiredTasks('just text\n\n- a normal bullet')).toEqual([]);
  });
});

describe('setTaskChecked (#426, optimistic line flip)', () => {
  it('flips exactly the addressed source line, never the fenced fake', () => {
    const md = ['- [ ] A', '```', '- [ ] fake', '```', '- [x] B'].join('\n');
    const out = setTaskChecked(md, 5, false).split('\n');
    expect(out[4]).toBe('- [ ] B'); // line 5 unchecked
    expect(out[2]).toBe('- [ ] fake'); // fenced fake (line 3) untouched
  });

  it('flips a blockquote task line', () => {
    expect(setTaskChecked('> - [x] quoted', 1, false)).toBe('> - [ ] quoted');
  });

  it('flips the addressed duplicate line only', () => {
    const dup = ['- [ ] ship it', '- [ ] ship it'].join('\n');
    expect(setTaskChecked(dup, 2, true)).toBe(['- [ ] ship it', '- [x] ship it'].join('\n'));
  });

  it('preserves CRLF line endings', () => {
    const crlf = ['- [ ] a\r', '- [ ] b\r'].join('\n');
    expect(setTaskChecked(crlf, 2, true)).toBe(['- [ ] a\r', '- [x] b\r'].join('\n'));
  });

  it('is a guarded no-op on an out-of-range / non-task line', () => {
    expect(setTaskChecked('- [ ] a', 99, true)).toBe('- [ ] a');
    expect(setTaskChecked('plain', 1, true)).toBe('plain');
  });
});

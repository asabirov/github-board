import { describe, expect, it } from 'vitest';
import { setTaskChecked, TaskToggleError } from './body-tasks';

// A body whose task-looking lines span the tricky GFM cases the renderer excludes
// or shifts. Line numbers (1-based) are what the client sends, sourced from
// react-markdown's node positions — NOT an occurrence count.
const BODY = [
  '- [ ] A real', //                1  (real task)
  '```', //                         2
  '- [ ] fake in fence', //         3  (NOT a task: fenced code sample)
  '```', //                         4
  '    - [ ] indented fake', //     5  (NOT a task: indented code block)
  '', //                            6
  '> - [x] quoted', //              7  (real task, inside a blockquote)
  '', //                            8
  '- [x] B real', //                9  (real task)
  '1. [ ] ordered', //             10  (real task, ordered list)
].join('\n');

describe('setTaskChecked (#426) — line-addressed', () => {
  it('flips exactly the addressed source line, leaving all others untouched', () => {
    const out = setTaskChecked(BODY, 9, false).split('\n');
    expect(out[8]).toBe('- [ ] B real'); // line 9 unchecked
    expect(out[0]).toBe('- [ ] A real'); // line 1 untouched
    expect(out[6]).toBe('> - [x] quoted'); // line 7 untouched
  });

  it('does NOT corrupt a fenced `- [ ]` when the real task after it is toggled', () => {
    // Regression for C1: addressing line 9 (real B) never rewrites line 3 (the
    // fake inside the code fence).
    const out = setTaskChecked(BODY, 9, false).split('\n');
    expect(out[2]).toBe('- [ ] fake in fence'); // byte-for-byte unchanged
    expect(out[4]).toBe('    - [ ] indented fake'); // indented-code fake unchanged
  });

  it('toggles a task INSIDE a blockquote (the `>`-prefixed real task)', () => {
    const out = setTaskChecked(BODY, 7, false).split('\n');
    expect(out[6]).toBe('> - [ ] quoted');
  });

  it('checks an ordered-list task by its line', () => {
    const out = setTaskChecked(BODY, 10, true).split('\n');
    expect(out[9]).toBe('1. [x] ordered');
  });

  it('setting a box to the state it already holds is a stable no-op on the text', () => {
    expect(setTaskChecked(BODY, 1, false)).toBe(BODY); // already unchecked
    expect(setTaskChecked(BODY, 9, true)).toBe(BODY); // already checked
  });

  it('toggles the RIGHT line when two task lines are byte-identical', () => {
    const dup = ['- [ ] ship it', '- [ ] ship it'].join('\n');
    expect(setTaskChecked(dup, 2, true)).toBe(['- [ ] ship it', '- [x] ship it'].join('\n'));
    expect(setTaskChecked(dup, 1, true)).toBe(['- [x] ship it', '- [ ] ship it'].join('\n'));
  });

  it('preserves CRLF line endings (only the one marker char changes)', () => {
    const crlf = ['- [ ] a\r', '- [ ] b\r'].join('\n');
    expect(setTaskChecked(crlf, 1, true)).toBe(['- [x] a\r', '- [ ] b\r'].join('\n'));
  });

  it('throws TaskToggleError for a non-positive / out-of-range line', () => {
    expect(() => setTaskChecked(BODY, 0, true)).toThrow(TaskToggleError);
    expect(() => setTaskChecked(BODY, 999, true)).toThrow(TaskToggleError);
    expect(() => setTaskChecked(BODY, -1, true)).toThrow(TaskToggleError);
  });

  it('throws TaskToggleError when the addressed line is not a task-list item', () => {
    expect(() => setTaskChecked(BODY, 6, true)).toThrow(TaskToggleError); // blank line
    expect(() => setTaskChecked(BODY, 2, true)).toThrow(TaskToggleError); // ``` fence opener
    expect(() => setTaskChecked('plain prose', 1, true)).toThrow(TaskToggleError);
  });

  // The backend's guard is single-line-syntactic by design: it cannot see GFM
  // block context, so a `- [ ]` that only LOOKS like a task (inside a fence) still
  // parses as one here. That is safe because the CLIENT never addresses such a
  // line — react-markdown never renders a checkbox for it, so its source line is
  // never sent (see body-tasks.spec.tsx, which proves the exclusion end-to-end).
  it('flips a syntactic task line regardless of block context (client is the GFM gate)', () => {
    expect(setTaskChecked('```\n- [ ] x\n```', 2, true)).toBe('```\n- [x] x\n```');
  });
});

/**
 * Body task-list checkbox transform (#426). GitHub stores a task-list item's
 * checked state IN the issue body markdown (`- [ ]` / `- [x]`), so ticking one on
 * the board means rewriting that single line and writing the whole body back
 * through the shared fail-closed write path.
 *
 * The toggle is addressed by 1-based SOURCE LINE, not occurrence index. The client
 * decides *which* checkbox exists and its line from react-markdown's own GFM parse
 * (the renderer is the only authority on what is a checkbox — a `- [ ]` inside a
 * code fence or a wrongly-shifted occurrence count is NOT one). The server then
 * flips the marker on exactly that line, validating it IS syntactically a task
 * line (else 400) — a line-addressed edit, never a re-scan/re-count that could
 * disagree with the renderer and corrupt a fenced code sample.
 *
 * Pure and framework-free so it unit-tests directly.
 */

/**
 * A GFM task-list line: an optional blockquote prefix (`>` possibly repeated,
 * for `> - [ ] quoted`), leading indent, a list marker (`-`/`*`/`+`, or an ordered
 * `1.`/`1)`), whitespace, then the checkbox `[ ]` / `[x]` followed by end-of-line
 * or whitespace. Three capture groups so a flip rewrites ONLY the single marker
 * char and preserves everything else byte-for-byte (prefix, indentation, ordering,
 * a trailing `\r` from a CRLF body, the item text).
 */
const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\](?:\s[\s\S]*)?)$/;

/** Thrown when a toggle addresses a line that isn't a task list item (out of
 *  range, or the line no longer parses as a task after a server-side body change)
 *  — the controller maps it to a 400 rather than a silent no-op or a 500. */
export class TaskToggleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskToggleError';
  }
}

/**
 * Set the task-list checkbox on `line` (1-based, into the raw body) to `checked`,
 * returning the full rewritten body. Only the one `[ ]`↔`[x]` marker on that line
 * changes. Throws `TaskToggleError` when `line` is out of range or its content is
 * not a task-list item — so a stale line (the body changed since the page loaded)
 * fails loudly instead of editing the wrong content.
 */
export function setTaskChecked(body: string, line: number, checked: boolean): string {
  if (!Number.isInteger(line) || line < 1) {
    throw new TaskToggleError(`task line must be a positive integer (got ${line})`);
  }
  const lines = body.split('\n');
  const i = line - 1;
  if (i >= lines.length) {
    throw new TaskToggleError(`body has no line ${line}`);
  }
  const m = TASK_LINE.exec(lines[i]);
  if (!m) {
    throw new TaskToggleError(`line ${line} is not a task-list item`);
  }
  lines[i] = `${m[1]}${checked ? 'x' : ' '}${m[3]}`;
  return lines.join('\n');
}

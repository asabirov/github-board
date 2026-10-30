/**
 * Body task-list checkbox mapping (#426). GitHub stores a task's checked state in
 * the issue body markdown (`- [ ]` / `- [x]`). The page renders the body with
 * react-markdown + remark-gfm, and a writer can tick a box — which patches the
 * matching raw line and writes it back through the fail-closed edit path.
 *
 * The renderer is the ONLY authority on what is a checkbox: a `- [ ]` inside a code
 * fence or an indented code block is NOT one, a `> - [ ]` inside a blockquote IS,
 * and an occurrence count re-derived by regex would disagree with it (and, over a
 * fenced sample, silently corrupt issue content). So the toggle is addressed by
 * react-markdown's own node position — the task list-item's 1-based SOURCE LINE —
 * and each box's checked state is read from that same rendered node. These two
 * helpers read a hast node the custom `li` renderer receives; `setTaskChecked` is
 * the optimistic local flip of that exact line while the server write is in flight.
 * Mirrors board-service/src/issue-detail/body-tasks.ts.
 */

/** The subset of a react-markdown hast element node these helpers read. */
export interface MdNode {
  properties?: { className?: unknown } | null;
  position?: { start?: { line?: number } | null } | null;
}

/** True when a hast `<li>` node is a GFM task-list item (remark-gfm tags it with
 *  the `task-list-item` class) — the renderer's own verdict, not a regex guess. */
export function isTaskListItem(node: MdNode | undefined | null): boolean {
  const cls = node?.properties?.className;
  if (Array.isArray(cls)) return cls.includes('task-list-item');
  if (typeof cls === 'string') return cls.split(/\s+/).includes('task-list-item');
  return false;
}

/** The task item's 1-based source line, from the renderer's node position — the
 *  toggle address. Null when the node carries no position (never, in practice, for
 *  a parsed list item), so the caller can leave that box read-only. */
export function taskLineOf(node: MdNode | undefined | null): number | null {
  const l = node?.position?.start?.line;
  return typeof l === 'number' ? l : null;
}

/** A GFM task-list line: optional blockquote prefix (`>`), indent, list marker,
 *  the checkbox. Three groups so an optimistic flip rewrites ONLY the marker char.
 *  Matches the backend twin. */
const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\](?:\s[\s\S]*)?)$/;

/** Optimistically flip the checkbox on 1-based `line` for the in-flight render —
 *  the same line the server will flip. A guarded no-op when the line is out of
 *  range or not a task (the UI never throws mid-render; the server is the one that
 *  rejects a stale line). */
export function setTaskChecked(body: string, line: number, checked: boolean): string {
  if (!Number.isInteger(line) || line < 1) return body;
  const lines = body.split('\n');
  const i = line - 1;
  if (i >= lines.length) return body;
  const m = TASK_LINE.exec(lines[i]);
  if (!m) return body;
  lines[i] = `${m[1]}${checked ? 'x' : ' '}${m[3]}`;
  return lines.join('\n');
}

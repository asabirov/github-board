import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Only `quotaRefusal` may put ISSUES_NOT_NOW_CODE on a 503 (#1046 review).
 *
 * The browser draws its saved Overview queue and metrics over a 503 only when
 * the body carries that code (`board-frontend/src/team/overview-saved.ts`), and
 * the queue it draws names the oldest issue by title. Board-api answers 503 for
 * other reasons on the same reads: the expiry interceptor withholding an answer
 * its access check has outlived, the Github principal guard, the session check.
 * Give any of them the code and a reader who has lost the org is shown its
 * issues. `projects-not-now-code.spec.ts` guards the Projects code the same way,
 * after a verifier put it on the interceptor and the principal guard and every
 * spec stayed green.
 *
 * `quotaRefusal` is reached from `listIssues` and `resolveScope` alone, and only
 * when every failure behind the lost scope was Github refusing on quota. That
 * test is covered in `github-issues.source.spec.ts`; this pins that nothing
 * else sends the code.
 */

const SRC = join(__dirname, '..');
const SOURCE = 'issues-metrics/github-issues.source.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !/\.(db-)?spec\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The source with its comments and import statements blanked, line count
 *  kept, so what is left is code that USES a name. Naive about `//` inside a
 *  string, which no line naming the code has. */
function codeOnly(text: string): string[] {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*import\s[\s\S]*?from\s*['"][^'"]+['"];?/gm, blank)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''));
}

const NAMES = /ISSUES_NOT_NOW_CODE|issues_not_now/;
const DECLARATION = "export const ISSUES_NOT_NOW_CODE = 'issues_not_now';";

/** The lines of `quotaRefusal`'s body: from its signature to the first line
 *  that closes a top-level function. */
function quotaRefusalLines(lines: string[]): [number, number] {
  const start = lines.findIndex((l) => /^function quotaRefusal\(/.test(l));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return [start, end];
}

describe('the issues "not now" code rides only on quotaRefusal’s 503 (#1046)', () => {
  const uses = sourceFiles(SRC).flatMap((file) => codeOnly(readFileSync(file, 'utf8'))
    .map((text, i) => ({ file: relative(SRC, file), line: i + 1, text: text.trim() }))
    .filter((u) => NAMES.test(u.text)));

  it('is declared once, in github-issues.source.ts', () => {
    expect(uses.filter((u) => u.text === DECLARATION).map((u) => u.file)).toEqual([SOURCE]);
  });

  it('is used nowhere but inside quotaRefusal', () => {
    const source = codeOnly(readFileSync(join(SRC, SOURCE), 'utf8'));
    const [start, end] = quotaRefusalLines(source);
    expect(start, 'quotaRefusal not found; this spec reads its body').toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const inside = (u: { file: string; line: number }) => u.file === SOURCE && u.line > start && u.line <= end;
    const outside = uses.filter((u) => u.text !== DECLARATION).filter((u) => !inside(u))
      .map((u) => `${u.file}:${u.line}  ${u.text}`);
    expect(outside, 'only quotaRefusal may send the code the browser draws its saved copy over').toEqual([]);
    // And quotaRefusal does use it: a scan that found nothing proves nothing.
    expect(uses.filter(inside)).toHaveLength(1);
  });
});

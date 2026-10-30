import ts from 'typescript-api';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Only `ProjectsService.totalFailure` may put PROJECTS_NOT_NOW_CODE on a 503
 * (#1042 review, round 3; widened by #1107).
 *
 * The browser draws its saved Projects copy over a 503, and a board page keeps
 * the board it already has, only when the body carries that code
 * (`board-frontend/src/projects/projects-last-good.ts`). Board-api answers 503
 * for other reasons on the same reads: the expiry interceptor withholding an
 * answer its access check has outlived, the Github principal guard, the session
 * check. Give any of them the code and the copy comes back over a board the
 * reader may have lost. A verifier did exactly that to the interceptor and the
 * principal guard, and every auth and projects spec stayed green, because each
 * asserts its own status and message and none asks what else rides in the body.
 *
 * A scan rather than one spec per source, because the next 503 source is one
 * nobody has written a spec for yet. Every route to the code on the wire has
 * to name it, as the constant or as the string, so the names are what this
 * looks for.
 *
 * #1111 scans every async method for constructed throws, rather than naming
 * today's two scope walkers. Bare construction on a future read fails too;
 * catch bindings and rejection callback parameters may propagate an error.
 */

const SRC = join(__dirname, '..');

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

const NAMES = /PROJECTS_NOT_NOW_CODE|projects_not_now/;
const DECLARATION = "export const PROJECTS_NOT_NOW_CODE = 'projects_not_now';";

/** The lines of one class member's body: from its signature to the first line
 *  that closes a class member at this file's two-space indent. */
function memberLines(lines: string[], signature: RegExp): [number, number] {
  const start = lines.findIndex((l) => signature.test(l));
  const end = lines.findIndex((l, i) => i > start && l === '  }');
  return [start, end];
}

const SERVICE = 'projects/projects.service.ts';

describe('the "not now" code rides only on totalFailure’s 503 (#1035, #1107)', () => {
  const service = codeOnly(readFileSync(join(SRC, SERVICE), 'utf8'));
  const uses = sourceFiles(SRC).flatMap((file) => codeOnly(readFileSync(file, 'utf8'))
    .map((text, i) => ({ file: relative(SRC, file), line: i + 1, text: text.trim() }))
    .filter((u) => NAMES.test(u.text)));

  it('is declared once, in projects-last-good.ts', () => {
    expect(uses.filter((u) => u.text === DECLARATION).map((u) => u.file)).toEqual(['projects/projects-last-good.ts']);
  });

  it('is used nowhere but inside ProjectsService.totalFailure', () => {
    const [start, end] = memberLines(service, /^ {2}private totalFailure\(/);
    expect(start, 'totalFailure not found; this spec reads its body').toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const outside = uses.filter((u) => u.text !== DECLARATION)
      .filter((u) => !(u.file === SERVICE && u.line > start && u.line <= end))
      .map((u) => `${u.file}:${u.line}  ${u.text}`);
    expect(outside, 'only totalFailure may send the code a browser keeps a board over').toEqual([]);
    // And totalFailure does use it: a scan that found nothing proves nothing.
    expect(uses.filter((u) => u.file === SERVICE)).toHaveLength(1);
  });

  // Read every async method, including future scope walkers. A constructed
  // failure must go through totalFailure; propagating an existing error stays
  // legal. This also covers throws nested in a loop or callback.
  const ast = ts.createSourceFile(SERVICE, readFileSync(join(SRC, SERVICE), 'utf8'), ts.ScriptTarget.Latest, true);
  const reads: ts.MethodDeclaration[] = [];
  function collect(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) reads.push(node);
    ts.forEachChild(node, collect);
  }
  collect(ast);
  it('finds asynchronous reads to inspect', () => expect(reads.length).toBeGreaterThan(0));
  it.each(reads.map((read) => [read.name.getText(ast), read] as const))('%s constructs failures only through totalFailure', (_name, read) => {
    const faults: string[] = [];
    function inspect(node: ts.Node): void {
      if (ts.isThrowStatement(node)) {
        const expression = node.expression;
        const total = ts.isCallExpression(expression)
          && ts.isPropertyAccessExpression(expression.expression)
          && expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword
          && expression.expression.name.text === 'totalFailure';
        let propagated = false;
        if (ts.isIdentifier(expression)) {
          for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
            if (ts.isCatchClause(parent) && parent.variableDeclaration?.name.getText(ast) === expression.text) propagated = true;
            if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))
              && parent.parameters.some((p) => p.name.getText(ast) === expression.text)) propagated = true;
          }
        }
        if (!total && !propagated) faults.push(node.getText(ast));
      }
      ts.forEachChild(node, inspect);
    }
    inspect(read);
    expect(faults, 'new read failures must throw this.totalFailure(...); identifiers may propagate an existing error').toEqual([]);
  });
});

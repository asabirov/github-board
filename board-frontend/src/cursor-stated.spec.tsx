import { describe, expect, it } from 'vitest';
// The package carries no node types; `fonts-import.spec.ts` says so the same way.
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
// @ts-expect-error node:path is untyped here; it exists in vitest's node env.
import { dirname, join, normalize } from 'node:path';
// @ts-expect-error node:url is untyped here; it exists in vitest's node env.
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ts from 'typescript-api';
import { MenuOption } from './ui/command-menu';

/**
 * Every control a click acts on says what the cursor does over it (#1023).
 *
 * The kit's rule is `Guidelines/Controls/What the cursor says`: what a click
 * acts on shows the hand, a row inside a menu keeps the arrow, and what cannot
 * be pressed shows neither. It also says "write it; nothing inherits it", and
 * on this board that is literal. Tailwind v4's preflight leaves a `<button>` on
 * `cursor: default`, so a button nobody wrote a cursor for draws the arrow and
 * nothing anywhere goes red. #934 was the Repos quick filters; #1023 was
 * "+ Add to project…" and, measured in a browser on 2026-09-11, twenty-odd
 * other kinds of control across five pages.
 *
 * So this reads the SOURCE, not the markup. The suite can render, but it
 * renders only what some spec mounts, and the component nobody wrote a spec
 * for is the one most likely to have forgotten. Here the parser finds every
 * lowercase JSX control in `src`, and its class list is followed through
 * constants, imports and helper functions to every string literal it can
 * reach. The kit's own components are not read: the kit writes their cursors
 * itself, hand on Button, Tabs, Toggle and Checkbox, arrow on every menu item.
 *
 * Stating a cursor is not enough; it has to be one the guideline gives that
 * row. A control takes the hand, or the arrow when pressing it does nothing. A
 * menu row takes the arrow and nothing else. A control that can be disabled and
 * shows the hand gives the page's cursor back through
 * `disabled:pointer-events-none`, as the kit's Button does. `cursor-help` and
 * the rest are in no row, so they fail however deliberately they were written.
 *
 * What this cannot see, said plainly:
 * - the cursor a browser draws. A stylesheet rule written later can override
 *   any class this finds, and nothing here computes a style.
 * - which branch applies. A class list reaching `cursor-pointer` on one arm of
 *   a conditional passes, even when the other arm is the one rendered.
 * - a class handed in by a caller through `className` or `{...props}`. Those
 *   read as nothing, which fails loudly, so the fix goes inside the component.
 * - a control made clickable some other way: `addEventListener`, a ref, or a
 *   dynamic tag like `<Tag>`.
 * - whether a `<button>` with no handler of its own opens anything. A kit
 *   trigger `asChild` gives one its click invisibly, so every button has to
 *   state a cursor, and one that opens nothing states `cursor-default`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Design sandboxes routed from nothing; the copy gate's `NOT_SHIPPED` names
 *  the same four. Each is checked to exist, so a rename cannot leave an
 *  exemption behind for whatever file takes the name next. */
const NOT_SHIPPED = ['cockpit-preview.tsx', 'cockpit-variants.tsx', 'vouch-preview.tsx', 'vouch-variants.tsx'];

/** Roles a click acts on. `option` and the `menuitem` family are menu rows. */
const ROLES = new Set(['button', 'tab', 'switch', 'checkbox', 'radio', 'option', 'menuitem', 'menuitemradio', 'menuitemcheckbox']);

/** Controls left without a cursor on purpose, keyed `file:marker`, each with
 *  the reason. A marker is the control's aria-label, or its first four class
 *  tokens, so a row goes stale when the control it excuses is rewritten. */
const LEFT_ALONE: Record<string, string> = {
  'issues-viewer/FilterBar.tsx:flex min-h-9 w-full flex-wrap':
    "The search field's frame. Its onClick only puts focus in the input it holds, so it is a field and not a button; the kit's own field frame writes no cursor either, and the input inside shows the text cursor.",
};

const files = (ext: RegExp) =>
  (readdirSync(HERE, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((f) => ext.test(f) && !/\.spec\./.test(f))
    .map((f) => f.split('\\').join('/'));

/** The cursor a stylesheet under `src` gives each class, read off the SUBJECT
 *  of each selector only: `.pj-md .task-list-item input.pj-task-editable`
 *  states a cursor for `pj-task-editable`, not for every element under `.pj-md`. */
function cssCursorClasses(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files(/\.css$/)) {
    const css = readFileSync(join(HERE, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const value = /(?:^|[;\s])cursor\s*:\s*([\w-]+)/.exec(body)?.[1];
      if (!value) continue;
      for (const sel of selectors.split(',')) {
        const subject = sel.trim().split(/[\s>+~]+/).pop() ?? '';
        for (const [, cls] of subject.matchAll(/\.([\w-]+)/g)) out.set(cls, value);
      }
    }
  }
  return out;
}

/** `stars` holds the files an `export * from` names, which is how `ui/kit/index.ts` hands on
 *  the kit's class constants, such as the `AUTH_FILLED_BUTTON` that AuthScreen's buttons take. */
interface Mod { sf: ts.SourceFile; decls: Map<string, ts.Node[]>; imports: Map<string, { file: string; name: string }>; stars: string[] }
const mods = new Map<string, Mod | null>();

function resolveImport(from: string, spec: string): string | null {
  const base = normalize(join(dirname(from), spec)).split('\\').join('/');
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) {
    const abs = join(HERE, cand);
    if (/\.tsx?$/.test(cand) && existsSync(abs) && statSync(abs).isFile()) return cand;
  }
  return null;
}

function parse(rel: string, src: string): Mod {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const decls = new Map<string, ts.Node[]>();
  const imports = new Map<string, { file: string; name: string }>();
  const stars: string[] = [];
  const add = (name: string, n: ts.Node) => decls.set(name, [...(decls.get(name) ?? []), n]);
  const walk = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) add(n.name.text, n.initializer);
    else if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text, n);
    else if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)
             && n.moduleSpecifier.text.startsWith('.')) {
      const file = resolveImport(rel, n.moduleSpecifier.text);
      const named = n.importClause?.namedBindings;
      if (file && named && ts.isNamedImports(named)) {
        for (const el of named.elements) imports.set(el.name.text, { file, name: (el.propertyName ?? el.name).text });
      }
    } else if (ts.isExportDeclaration(n) && !n.exportClause && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const file = resolveImport(rel, n.moduleSpecifier.text);
      if (file) stars.push(file);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return { sf, decls, imports, stars };
}

function mod(rel: string): Mod | null {
  if (!mods.has(rel)) {
    const abs = join(HERE, rel);
    mods.set(rel, existsSync(abs) ? parse(rel, readFileSync(abs, 'utf8')) : null);
  }
  return mods.get(rel) ?? null;
}

function follow(name: string, m: Mod, seen: Set<ts.Node>): string[] {
  const local = m.decls.get(name);
  if (local) return local.flatMap((n) => (seen.has(n) ? [] : (seen.add(n), literals(n, m, seen))));
  const imp = m.imports.get(name);
  const target = imp ? mod(imp.file) : null;
  if (target && imp) return follow(imp.name, target, seen);
  return m.stars.flatMap((f) => { const star = mod(f); return star ? follow(name, star, seen) : []; });
}

/** What a function hands back: its expression body, or every `return` in its
 *  own body (not a nested function's). */
function returned(fn: ts.FunctionLikeDeclaration, m: Mod, seen: Set<ts.Node>): string[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return literals(fn.body, m, seen);
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isReturnStatement(n) && n.expression) out.push(...literals(n.expression, m, seen));
    else if (!ts.isFunctionLike(n)) ts.forEachChild(n, walk);
  };
  ts.forEachChild(fn.body, walk);
  return out;
}

/** Every string literal an expression can reach. */
function literals(n: ts.Node, m: Mod, seen: Set<ts.Node>): string[] {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
  if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) return [n.text];
  if (ts.isIdentifier(n)) return follow(n.text, m, seen);
  if (ts.isPropertyAccessExpression(n)) return literals(n.expression, m, seen);
  if (ts.isPropertyAssignment(n)) return literals(n.initializer, m, seen);
  if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return returned(n, m, seen);
  if (ts.isTypeNode(n) || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) return [];
  const out: string[] = [];
  ts.forEachChild(n, (c) => { out.push(...literals(c, m, seen)); });
  return out;
}

export interface Control { file: string; line: number; tag: string; why: string; marker: string; tokens: string[]; menuRow: boolean; disabled: boolean }

/** `onClick={(e) => e.stopPropagation()}` keeps a click from reaching what is
 *  behind, a popover inside a clickable tile say. The element it sits on acts
 *  on nothing, so it is not a control. */
function onlyStops(v: ts.JsxAttributeValue | undefined): boolean {
  const fn = v && ts.isJsxExpression(v) ? v.expression : undefined;
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  const body = ts.isBlock(fn.body)
    ? fn.body.statements.map((s) => (ts.isExpressionStatement(s) ? s.expression : undefined))
    : [fn.body];
  return body.length > 0 && body.every((e) => !!e && ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)
    && (e.expression.name.text === 'stopPropagation' || e.expression.name.text === 'preventDefault'));
}

/** Every lowercase JSX element a click acts on, in one parsed file. */
function controlsOf(rel: string, m: Mod): Control[] {
  const out: Control[] = [];
  const walk = (n: ts.Node) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /^[a-z]/.test(n.tagName.getText(m.sf))) {
      const tag = n.tagName.getText(m.sf);
      const attrs = new Map<string, ts.JsxAttributeValue | undefined>();
      const spreads: ts.Expression[] = [];
      for (const p of n.attributes.properties) {
        if (ts.isJsxAttribute(p)) attrs.set(p.name.getText(m.sf), p.initializer);
        else if (ts.isJsxSpreadAttribute(p)) spreads.push(p.expression);
      }
      const lit = (name: string) => {
        const v = attrs.get(name);
        if (v && ts.isStringLiteral(v)) return v.text;
        if (v && ts.isJsxExpression(v) && v.expression && ts.isStringLiteral(v.expression)) return v.expression.text;
        return undefined;
      };
      const role = lit('role');
      const type = lit('type');
      const acts = attrs.has('onClick') && !onlyStops(attrs.get('onClick'));
      let why: string | null = null;
      if (tag === 'button' || tag === 'summary' || tag === 'select') why = tag;
      else if (tag === 'input' && (type === 'checkbox' || type === 'radio')) why = `input type=${type}`;
      else if (role && ROLES.has(role)) why = `role=${role}`;
      else if (tag === 'a' ? !attrs.has('href') && acts : acts) why = `${tag} with onClick`;
      if (why) {
        const seen = new Set<ts.Node>();
        const cls = attrs.get('className');
        const raw = [
          ...(cls ? literals(cls, m, seen) : []),
          ...spreads.flatMap((s) => literals(s, m, seen)),
        ];
        const tokens = raw.join(' ').split(/\s+/).filter(Boolean);
        out.push({
          file: rel,
          line: m.sf.getLineAndCharacterOfPosition(n.getStart(m.sf)).line + 1,
          tag,
          why,
          marker: lit('aria-label') ?? tokens.slice(0, 4).join(' '),
          tokens,
          menuRow: !!role && (role.startsWith('menuitem') || role === 'option') || spreads.some((s) => s.getText(m.sf) === 'MENU_ROW'),
          disabled: attrs.has('disabled'),
        });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(m.sf);
  return out;
}

/** What is wrong with one control's cursor, or null. */
export function verdict(c: Control, cssCursor: Map<string, string>): string | null {
  // Every cursor the control states, by value: `cursor-help` is `help`, and a
  // class a stylesheet gives `cursor: pointer` is `pointer`. A variant such as
  // `disabled:` or `hover:` states nothing for the control at rest.
  const said = new Set<string>();
  for (const t of c.tokens) {
    const m = /^!?cursor-([a-z-]+)$/.exec(t);
    if (m) said.add(m[1]);
    const css = cssCursor.get(t);
    if (css) said.add(css);
  }
  const other = [...said].find((v) => !(c.menuRow ? ['default'] : ['pointer', 'default']).includes(v));
  if (c.menuRow) {
    if (said.has('pointer')) return 'is a menu row and shows the hand; a menu row keeps the arrow (`cursor-default`)';
    if (other) return `is a menu row and writes \`cursor-${other}\`; a menu row keeps the arrow (\`cursor-default\`)`;
    if (!said.has('default')) return 'is a menu row that does not write `cursor-default`; the arrow is a decision, not an omission';
    return null;
  }
  if (other) return `writes \`cursor-${other}\`, which no row of the guideline gives a control; write \`cursor-pointer\`, or \`cursor-default\` if pressing it does nothing`;
  if (!said.size) return 'states no cursor; write `cursor-pointer`, or `cursor-default` if pressing it does nothing';
  if (c.disabled && said.has('pointer') && !c.tokens.includes('disabled:pointer-events-none')) {
    return "can be disabled and would still show the hand; the guideline gives a disabled control the page's cursor, through `disabled:pointer-events-none`";
  }
  return null;
}

const describeControl = (c: Control, why: string) => `${c.file}:${c.line} <${c.tag}> (${c.why}) "${c.marker}" ${why}`;

describe('every control a click acts on states its cursor (#1023)', () => {
  const css = cssCursorClasses();
  const shipped = files(/\.tsx$/).filter((f) => !NOT_SHIPPED.includes(f));
  const controls = shipped.flatMap((f) => controlsOf(f, mod(f)!));

  it('finds the controls it is about, so an empty walk cannot pass', () => {
    // Measured 2026-09-11: 67 controls in shipped source, 60 of them `<button>`.
    expect(controls.length).toBeGreaterThan(60);
    // The issue page's ⋯ trigger, whose hand is written in a class constant, so
    // this also proves constants are followed.
    expect(controls.some((c) => c.file === 'issue/IssuePage.tsx' && c.marker === 'Issue actions' && c.tokens.includes('cursor-pointer'))).toBe(true);
  });

  it('every sandbox it skips still exists', () => {
    for (const f of NOT_SHIPPED) expect(existsSync(join(HERE, f)), f).toBe(true);
  });

  it('no control is missing its cursor, and no menu row shows the hand', () => {
    const wrong = controls
      .map((c) => ({ c, why: verdict(c, css) }))
      .filter(({ c, why }) => why && !LEFT_ALONE[`${c.file}:${c.marker}`])
      .map(({ c, why }) => describeControl(c, why!));
    expect(wrong).toEqual([]);
  });

  it('every row of LEFT_ALONE still names a control', () => {
    const live = new Set(controls.map((c) => `${c.file}:${c.marker}`));
    expect(Object.keys(LEFT_ALONE).filter((k) => !live.has(k))).toEqual([]);
  });
});

describe('the walker can go red', () => {
  const css = new Map<string, string>();
  const one = (src: string) => controlsOf('synthetic.tsx', parse('synthetic.tsx', src));

  it('flags a bare button, and passes one whose constant carries the hand', () => {
    const [bare] = one(`const X = () => <button className="flex items-center">x</button>;`);
    expect(verdict(bare, css)).toMatch(/states no cursor/);
    const [held] = one(`const B = 'flex cursor-pointer'; const X = () => <button className={\`\${B} px-2\`}>x</button>;`);
    expect(verdict(held, css)).toBeNull();
  });

  it('follows a helper function to what it returns', () => {
    const [c] = one(`function cls(on: boolean) { return on ? 'cursor-pointer a' : 'cursor-pointer b'; }
      const X = () => <button className={cls(true)}>x</button>;`);
    expect(verdict(c, css)).toBeNull();
  });

  it('flags a menu row that shows the hand, and one that states nothing', () => {
    const [hand] = one(`const X = () => <div role="menuitem" className="cursor-pointer" onClick={f} />;`);
    expect(verdict(hand, css)).toMatch(/keeps the arrow/);
    const [bare] = one(`const X = () => <button {...MENU_ROW} className="flex" />;`);
    expect(verdict(bare, css)).toMatch(/decision, not an omission/);
  });

  it('flags a hand that survives `disabled`, and takes only the page cursor back', () => {
    const [bare] = one(`const X = () => <button disabled={busy} className="cursor-pointer">x</button>;`);
    expect(verdict(bare, css)).toMatch(/disabled/);
    const [arrow] = one(`const X = () => <button disabled={busy} className="cursor-pointer disabled:cursor-default">x</button>;`);
    expect(verdict(arrow, css)).toMatch(/disabled:pointer-events-none/);
    const [page] = one(`const X = () => <button disabled={busy} className="cursor-pointer disabled:pointer-events-none">x</button>;`);
    expect(verdict(page, css)).toBeNull();
  });

  it('flags a cursor no row of the guideline gives, on a control and on a menu row', () => {
    const [help] = one(`const X = () => <button className="inline-flex cursor-help">x</button>;`);
    expect(verdict(help, css)).toMatch(/`cursor-help`, which no row/);
    const [row] = one(`const X = () => <div role="option" className="cursor-help" onClick={f} />;`);
    expect(verdict(row, css)).toMatch(/menu row and writes `cursor-help`/);
    const [tip] = one(`const X = () => <button className="tip">x</button>;`);
    expect(verdict(tip, new Map([['tip', 'help']]))).toMatch(/`cursor-help`/);
    expect(verdict(tip, new Map([['tip', 'pointer']]))).toBeNull();
  });

  it('does not count a panel whose click only stops there, and counts one that does more', () => {
    expect(one(`const X = () => <div onClick={(e) => e.stopPropagation()}><p>x</p></div>;`)).toEqual([]);
    const [c] = one(`const X = () => <div onClick={(e) => { e.stopPropagation(); open(); }}>x</div>;`);
    expect(verdict(c, css)).toMatch(/states no cursor/);
  });

  it('counts a link as the browser does: `href` is the hand, `onClick` alone is not', () => {
    expect(one(`const X = () => <a href="/x">x</a>;`)).toEqual([]);
    const [c] = one(`const X = () => <a onClick={f}>x</a>;`);
    expect(verdict(c, css)).toMatch(/states no cursor/);
  });
});

describe('the shared menu row, as rendered', () => {
  it('keeps the arrow: `cursor-default`, never the hand', () => {
    const html = renderToStaticMarkup(<MenuOption onSelect={() => {}}>Remove from project</MenuOption>);
    expect(html).toMatch(/class="[^"]*\bcursor-default\b/);
    expect(html).not.toContain('cursor-pointer');
  });
});

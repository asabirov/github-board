/**
 * A confirmed close nudges the whole board, not just the row (#692).
 *
 * Closing from a card left every other mounted view — the counts, the stacks,
 * the lists — serving the numbers they held before the write, because the close
 * was the one in-board write that never bumped the refresh nonce
 * (`sync/sync-status.tsx`, #384). The seven facet editors all bump; this one did
 * not.
 *
 * The click itself cannot be driven here: the suite runs with `environment:
 * 'node'`, so no event is dispatched and no effect fires. So
 * the confirm's body is `runClose`, effects injected the way `repo-actions.ts`
 * injects its own, and the tests below drive that. What the tests cannot see —
 * that the button's press reaches `runClose` carrying the REAL bump from the
 * provider, and that every surface mounting the dialog sits under that provider
 * — is read off the sources at the bottom of this file. Those source matchers
 * read brace-balanced slices rather than lines, because a reformat of a file
 * this feature does not own is not a defect and must not turn them red.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api/core';
import { CLOSE_CHOICES, type ChosenCloseReason } from '../close-reason';
import { CloseReasonChoices, runClose, type CloseEffects, type CloseTarget } from './CloseIssueAlert';

const target: CloseTarget = { owner: 'acme', repo: 'board', number: 12, title: 'A close leaves the rest stale' };

/** The opening tag of the span `text` is drawn in, so a test can read what is
 *  on it. Whether the note is HIDDEN is the whole question in #1054, and
 *  `toContain(note)` answers it the same way for a note nobody can see. */
function spanAround(html: string, text: string): string {
  const at = html.indexOf(text);
  if (at < 0) throw new Error(`not in the markup: ${text}`);
  return html.slice(html.lastIndexOf('<span', at), at);
}

/** The five effects, recorded, with the order they fired in. `close` answers
 *  with the reason Github kept. */
function effects(close: (t: CloseTarget, r: ChosenCloseReason) => Promise<string | null>) {
  const order: string[] = [];
  const track = <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    vi.fn((...a: A): R => { order.push(name); return fn(...a); });
  const fx: CloseEffects = {
    close: track('close', close),
    say: track('say', () => {}),
    bump: track('bump', () => {}),
    closed: track('closed', () => {}),
    dismiss: track('dismiss', () => {}),
  };
  return { fx, order, mock: fx as { [K in keyof CloseEffects]: ReturnType<typeof vi.fn> } };
}

describe('runClose — the confirmed close (#692)', () => {
  it('asks the rest of the board to re-read, once the write has landed', async () => {
    const { fx, order, mock } = effects(() => Promise.resolve('completed'));

    await runClose(target, 'completed', fx);

    expect(mock.bump).toHaveBeenCalledTimes(1);
    // After the write, never instead of it: a bump before the close would send
    // every other view back to the server for the numbers it already has.
    expect(order.indexOf('bump')).toBeGreaterThan(order.indexOf('close'));
  });

  it('still writes, says so, tells its caller and shuts', async () => {
    const { fx, mock } = effects(() => Promise.resolve('completed'));

    await runClose(target, 'completed', fx);

    expect(mock.close).toHaveBeenCalledWith(target, 'completed');
    expect(mock.say).toHaveBeenCalledWith('Closed board#12 as completed');
    expect(mock.closed).toHaveBeenCalledTimes(1);
    expect(mock.dismiss).toHaveBeenCalledTimes(1);
  });

  it('leaves the board alone when the close is refused', async () => {
    const { fx, mock } = effects(() => Promise.reject(new ApiError(503, 'close 503')));

    await runClose(target, 'completed', fx);

    expect(mock.say).toHaveBeenCalledWith('Issue writes are turned off right now.', 'danger');
    // Nothing was written, so nothing anywhere is stale — and the dialog stays
    // up with the sentence, which is what it did before this change.
    expect(mock.bump).not.toHaveBeenCalled();
    expect(mock.closed).not.toHaveBeenCalled();
    expect(mock.dismiss).not.toHaveBeenCalled();
  });
});

describe('the close asks why (#1006)', () => {
  it('offers exactly the reasons Github takes for a close, in its order', () => {
    // `reopened` and `null` are the other two `state_reason` values, and
    // neither closes anything.
    expect(CLOSE_CHOICES.map((c) => c.reason)).toEqual(['completed', 'not_planned', 'duplicate']);
    expect(CLOSE_CHOICES.map((c) => c.label)).toEqual(['Completed', 'Not planned', 'Duplicate']);
  });

  it('sends the reason chosen, and says the one Github recorded', async () => {
    const { fx, mock } = effects((_t, r) => Promise.resolve(r));

    await runClose(target, 'not_planned', fx);
    expect(mock.close).toHaveBeenCalledWith(target, 'not_planned');
    expect(mock.say).toHaveBeenCalledWith('Closed board#12 as not planned');

    await runClose(target, 'duplicate', fx);
    expect(mock.say).toHaveBeenLastCalledWith('Closed board#12 as a duplicate');
  });

  it('on a stale card, says the reason Github kept and where to change it, and still dims the row', async () => {
    // Github ignores the reason unless the state changes, so an issue closed
    // before the press answers with the reason it already had.
    const { fx, mock } = effects(() => Promise.resolve('completed'));

    await runClose(target, 'not_planned', fx);

    expect(mock.say).toHaveBeenCalledWith(
      'board#12 was already closed on GitHub, as completed. Change the reason there.',
      'danger',
    );
    // It IS closed, so the row is right to dim and nothing is left to confirm.
    expect(mock.bump).toHaveBeenCalledTimes(1);
    expect(mock.closed).toHaveBeenCalledTimes(1);
    expect(mock.dismiss).toHaveBeenCalledTimes(1);
  });

  it('names no reason where the service did not say one', async () => {
    const { fx, mock } = effects(() => Promise.resolve(null));

    await runClose(target, 'not_planned', fx);

    expect(mock.say).toHaveBeenCalledWith('Closed board#12');
  });

  it('renders the three as one radio group with the chosen one checked', () => {
    // Static markup is as far as this suite reaches: no click lands here. That a
    // click moves the check is read in the browser.
    const html = renderToStaticMarkup(<CloseReasonChoices value="not_planned" onChange={() => {}} />);
    const radios = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map(([tag]) => ({
      value: /value="([^"]+)"/.exec(tag)?.[1],
      checked: /aria-checked="true"/.test(tag),
    }));
    expect(radios).toEqual([
      { value: 'completed', checked: false },
      { value: 'not_planned', checked: true },
      { value: 'duplicate', checked: false },
    ]);
    expect(html).toContain('role="radiogroup"');
    for (const c of CLOSE_CHOICES) expect(html).toContain(c.label);
  });

  it('tells whoever picks Duplicate that the board will not link the two issues (#1048)', () => {
    // Github hears "duplicate" and never which issue, and no label can say
    // that. It used to sit under Duplicate for every reader; it is drawn now
    // for the one who chose it, which is the moment it matters.
    const note = CLOSE_CHOICES.find((c) => c.reason === 'duplicate')?.note ?? '';
    expect(note).toMatch(/won’t link it to the issue it duplicates/);
    expect(spanAround(renderToStaticMarkup(<CloseReasonChoices value="duplicate" onChange={() => {}} />), note)).not.toContain(
      'invisible',
    );
    // Github's names carry the other two, so they get no line under them.
    expect(CLOSE_CHOICES.filter((c) => c.note).map((c) => c.reason)).toEqual(['duplicate']);
  });

  it('keeps the note’s room when Duplicate is not the choice, so choosing it moves nothing (#1054)', () => {
    // The note is in the markup under every choice and hidden under the other
    // two, which is what reserves its height: `visibility: hidden` holds the
    // box and leaves the accessibility tree, so the sentence joins Duplicate's
    // accessible name only once it is checked. Rendered ONLY when chosen, the
    // alert grew as the radio moved and carried all three rows up 10.4px.
    //
    // This reads the class off the span, not the height: the suite has no DOM
    // and cannot measure a box. What `invisible` does to that box is read in a
    // browser, and #1054 is where that reading was delivered.
    const note = CLOSE_CHOICES.find((c) => c.reason === 'duplicate')?.note ?? '';
    for (const value of ['completed', 'not_planned'] as const) {
      const html = renderToStaticMarkup(<CloseReasonChoices value={value} onChange={() => {}} />);
      expect(html).toContain(note);
      expect(spanAround(html, note)).toContain('invisible');
    }
  });
});

// ── what the node environment cannot render, read off the sources ────────────

const SOURCES = import.meta.glob('../**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Glob keys are relative to this file; `src`-relative reads better in a failure. */
const srcPath = (key: string) => (key.startsWith('./') ? `ui/${key.slice(2)}` : key.slice(3));
const BY_PATH: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCES).map(([k, v]) => [srcPath(k), v]),
);
const isSpec = (path: string) => /\.spec\.tsx?$/.test(path);
const modules = Object.keys(BY_PATH).filter((p) => !isSpec(p));

/** The text inside the `{ … }` that opens at `open`, by counting braces. Every
 *  matcher below reads a slice found this way rather than a line found by its
 *  indentation — the first version of this keyed on where the closing brace sat
 *  and went red the moment the call moved inside a `try`. */
function braced(src: string, open: number): string {
  if (src[open] !== '{') return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** `confirm()`'s whole body — everything one press runs. */
function confirmBody(src: string): string {
  const m = /function\s+confirm\s*\(/.exec(src);
  return m ? braced(src, src.indexOf('{', m.index + m[0].length)) : '';
}

/** The effects object handed to `runClose`, however the call is laid out —
 *  `null` when there is no such call at all, which is a different answer from
 *  a call that hands over nothing. */
function runCloseEffects(src: string): string | null {
  // The chosen reason may sit between the target and the effects (#1006).
  const m = /runClose\s*\(\s*target\s*,\s*(?:\w+\s*,\s*)?\{/.exec(src);
  return m ? braced(src, m.index + m[0].length - 1) : null;
}

/** The confirming button, opening tag to closing tag. Cancel is a different
 *  element, so nothing here can be satisfied by the wrong control. */
function pressButton(src: string): string {
  const m = /<AlertDialogAction[\s>]/.exec(src);
  if (!m) return '';
  const end = src.indexOf('</AlertDialogAction>', m.index);
  return end < 0 ? '' : src.slice(m.index, end);
}

/** Is the `bump` handed to `runClose` the one the PROVIDER gave, rather than
 *  something else of that name?
 *
 *  A property called `bump` is not the property under test: rewriting the
 *  effects object to `bump: () => {},` leaves the hook call sitting unused above
 *  it, satisfies every other flag, passes every runtime test, and refreshes
 *  nothing. So the value has to be the binding `useRefreshBump()` returned —
 *  either shorthand, which IS that binding, or spelled out as it. And that
 *  binding has to be the only one of its name in the file, or the shorthand
 *  could be some nearer `bump` declared over the top of it.
 *
 *  The binding's NAME is read out of the source rather than assumed, here and
 *  in `fromContext`: renaming it is a refactor, not a defect. */
function handsProviderBump(src: string, effects: string): boolean {
  const bound = /const\s+(\w+)\s*=\s*useRefreshBump\(\s*\)/.exec(src)?.[1];
  if (!bound) return false;
  const declarations = src.match(new RegExp(`\\b(?:const|let|var)\\s+${bound}\\b`, 'g')) ?? [];
  if (declarations.length !== 1) return false;
  const shorthand = bound === 'bump' && /(^|[\s,{])bump\s*,/.test(effects);
  const spelledOut = new RegExp(`(^|[\\s,{])bump\\s*:\\s*${bound}\\s*(,|$)`).test(effects);
  return shorthand || spelledOut;
}

/** The whole chain a close depends on, as one verdict over the source: the
 *  press runs `confirm()`, `confirm()` runs `runClose`, and what it hands over
 *  is the bump the provider gave it. A function rather than a run of
 *  assertions, so each link can be put through it again with that link cut.
 *
 *  Everything empty-slice rather than throwing, so a source that stops looking
 *  like this reads as "not wired" and reds. */
function bumpWiring(src: string) {
  const press = pressButton(src);
  const effects = runCloseEffects(confirmBody(src));
  return {
    imported: /import\s*\{[^}]*\buseRefreshBump\b[^}]*\}\s*from\s*'\.\.\/sync\/sync-status'/.test(src),
    fromContext: /const\s+\w+\s*=\s*useRefreshBump\(\s*\)/.test(src),
    pressRunsConfirm: /onClick/.test(press) && /\bconfirm\s*\(\s*\)/.test(press),
    confirmRunsClose: effects !== null,
    handsProviderBump: handsProviderBump(src, effects ?? ''),
  };
}

/** Undo one thing in the source, asserting that thing was there to undo: a
 *  mutant that changed nothing passes every matcher and proves nothing. */
function mutate(src: string, pattern: RegExp, replacement = ''): string {
  expect(src, `the source should contain ${pattern}`).toMatch(pattern);
  return src.replace(pattern, replacement);
}

describe('the dialog is wired to the real refresh bump', () => {
  const self = BY_PATH['ui/CloseIssueAlert.tsx'];

  it('reads its own source', () => {
    expect(self, 'ui/CloseIssueAlert.tsx').toBeTruthy();
    expect(self).toContain('export async function runClose');
  });

  // `useRefreshBump()` off the context is the only bump that reaches other
  // views; a locally-defined `bump` would satisfy every test above and move
  // nothing on screen. And the press is the start of the chain: `runClose` can
  // be perfect and reach nobody if the button never calls `confirm()`.
  it('runs the whole chain from the press to the bump', () => {
    expect(bumpWiring(self)).toEqual({
      imported: true,
      fromContext: true,
      pressRunsConfirm: true,
      confirmRunsClose: true,
      handsProviderBump: true,
    });
  });

  // The check above reads TEXT, and a text check is the kind that quietly stops
  // matching what it was written for. So every link of the verdict is run once
  // against a source with that link cut, and has to come back false.
  it('would notice each way the chain could come undone', () => {
    const noImport = mutate(self, /import\s*\{[^}]*\buseRefreshBump\b[^}]*\}\s*from\s*'\.\.\/sync\/sync-status';\n/);
    expect(bumpWiring(noImport).imported).toBe(false);

    const localBump = mutate(self, /const\s+\w+\s*=\s*useRefreshBump\(\s*\);/, 'const bump = () => {};');
    expect(bumpWiring(localBump).fromContext).toBe(false);

    const deadButton = mutate(self, /void\s+confirm\(\s*\)\s*;?/);
    expect(bumpWiring(deadButton).pressRunsConfirm).toBe(false);

    const noClose = mutate(self, /runClose\s*\(\s*target\s*,\s*(?:\w+\s*,\s*)?\{/, 'nothingAtAll({');
    expect(bumpWiring(noClose).confirmRunsClose).toBe(false);

    // Either spelling of the property — shorthand, or spelled out as a rename
    // would leave it — so the mutant survives a refactor the verdict tolerates.
    const noBump = mutate(self, /\bbump\s*(?:,|:\s*\w+\s*,)\s*/);
    expect(bumpWiring(noBump).handsProviderBump).toBe(false);

    // The one that passes everything else: a property named `bump` that is not
    // the provider's, with the hook call left above it doing nothing.
    const shadowed = mutate(self, /(^|[\s,{])bump\s*(?:,|:\s*\w+\s*,)/, '$1bump: () => {},');
    expect(bumpWiring(shadowed)).toMatchObject({ fromContext: true, confirmRunsClose: true });
    expect(bumpWiring(shadowed).handsProviderBump).toBe(false);

    // And the same trick one scope in: a nearer `bump` the shorthand would pick
    // up instead, leaving the provider's untouched above it.
    const bound = /const\s+(\w+)\s*=\s*useRefreshBump\(/.exec(self)![1];
    const redeclared = mutate(self, /(\n\s*)await runClose\(/, `$1const ${bound} = () => {};$1await runClose(`);
    expect(bumpWiring(redeclared).handsProviderBump).toBe(false);
  });
});

/** Every relative `from '…'` in a module, resolved to a `src`-relative `.tsx`. */
function importsOf(path: string): string[] {
  const dir = path.split('/').slice(0, -1);
  const out: string[] = [];
  for (const m of BY_PATH[path].matchAll(/from '(\.[^']*)'/g)) {
    const parts = [...dir];
    for (const seg of m[1].split('/')) {
      if (seg === '.') continue;
      else if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    const resolved = `${parts.join('/')}.tsx`;
    if (BY_PATH[resolved]) out.push(resolved);
  }
  return out;
}

/** The modules that reach `roots` by importing them, directly or through others. */
function importersOf(roots: string[]): Set<string> {
  const reached = new Set(roots);
  for (;;) {
    const before = reached.size;
    for (const path of modules) {
      if (!reached.has(path) && importsOf(path).some((i) => reached.has(i))) reached.add(path);
    }
    if (reached.size === before) return reached;
  }
}

/** The component names `App.tsx` renders OUTSIDE its `<SyncProvider>`. */
function outsideProvider(appSrc: string, names: string[]): string[] {
  const open = /<SyncProvider[\s>]/.exec(appSrc);
  const close = /<\/SyncProvider\s*>/.exec(appSrc);
  if (!open || !close || close.index < open.index) return names;
  return names.filter((name) =>
    [...appSrc.matchAll(new RegExp(`<${name}[\\s/>]`, 'g'))].some(
      (m) => m.index! < open.index || m.index! > close.index,
    ),
  );
}

describe('every surface that can close an issue sits under the sync provider', () => {
  const app = BY_PATH['App.tsx'];
  const mounts = modules.filter((p) => BY_PATH[p].includes('<IssueActions'));
  const reaching = importersOf(mounts);
  // The pages `App` itself renders that lead, however deep, to a close menu.
  const pages = modules
    .filter((p) => reaching.has(p) && importsOf('App.tsx').includes(p))
    .map((p) => p.split('/').pop()!.replace('.tsx', ''));

  it('finds the sources, the menus and the pages above them', () => {
    expect(app, 'App.tsx').toBeTruthy();
    expect(modules.length).toBeGreaterThan(20);
    expect(mounts.length).toBeGreaterThanOrEqual(4);
    expect(reaching.has('App.tsx')).toBe(true);
    // A floor and two names, not the list: which pages reach a close menu is
    // another lane's to grow, and a listed expectation would go red on a page
    // added correctly. The assertion that matters is the derived one below.
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages).toContain('Dashboard');
    expect(pages).toContain('TeamView');
  });

  // `useRefreshBump()` outside `SyncProvider` is the context default: a no-op.
  // A page moved above the provider would close issues into silence, and this
  // is the only thing in the suite that would notice.
  it('renders every one of them inside it', () => {
    expect(outsideProvider(app, pages)).toEqual([]);
  });

  // The check above passes on a file it cannot read, so the same function is put
  // through a copy of App with a close-capable page rendered outside the
  // provider. The mutant is built from a pattern rather than from a quoted line
  // of App.tsx: how that file lays its JSX out is not this feature's business,
  // and a reformat there must not red a check about the provider.
  it('would notice a page rendered outside the provider', () => {
    const lifted = mutate(app, /<\/SyncProvider\s*>/, '$&\n        <Dashboard />');
    expect(outsideProvider(lifted, pages)).toEqual(['Dashboard']);
  });
});

import { describe, expect, it } from 'vitest';
import { composeMe, mayWrite, type Me } from './use-me';
import { meFixture } from './me-fixture';
import type { Person } from './api/people';

// The board's test env is `node` (no DOM, no @testing-library), so — as with
// use-facet-edit — we drive the pure composition the hook wraps rather than
// render the hook. composeMe IS everything useMe does with the response.

const person = (o: Partial<Person>): Person => ({
  id: o.id ?? 'x@example.com',
  displayName: o.displayName ?? 'X',
  emails: o.emails ?? [o.id ?? 'x@example.com'],
  clickupNames: [],
  githubLogin: o.githubLogin ?? null,
});

const ANTON = person({
  id: 'anton.khovanskiy@example.com',
  displayName: 'Anton Khovanskiy',
  githubLogin: 'anton-khovanskiy',
});

describe('composeMe', () => {
  it('resolves the display name from the People table', () => {
    const me = composeMe({ email: 'anton.khovanskiy@example.com', isAdmin: false, adminsUnread: false, writesEnabled: false, canWrite: false, githubLogin: null, capabilities: {}, orgs: [] }, [ANTON]);
    expect(me.name).toBe('Anton Khovanskiy');
  });

  it('degrades an unresolved person to the email local part', () => {
    const me = composeMe({ email: 'stranger@example.com', isAdmin: true, adminsUnread: false, writesEnabled: true, canWrite: true, githubLogin: null, capabilities: {}, orgs: [] }, []);
    expect(me).toMatchObject({ name: 'stranger', isAdmin: true, canWrite: true });
  });

  // #520 — the session's Github handle is the server's answer, carried through
  // as-is. The People table is a different question (who is on the roster) and
  // must not overwrite what /me said about the signed-in account.
  it('carries the session Github login through', () => {
    const me = composeMe(
      { email: 'anton.khovanskiy@example.com', isAdmin: false, adminsUnread: false, writesEnabled: false, canWrite: false, githubLogin: 'anton-khovanskiy', capabilities: {}, orgs: [] },
      [ANTON],
    );
    expect(me.githubLogin).toBe('anton-khovanskiy');
  });

  // #584 — the capability map is the server's answer too, and nothing composes
  // with it: the People table has no opinion on what the board's credential may do.
  it('carries the capability map through untouched', () => {
    const me = composeMe(
      { email: 'stranger@example.com', isAdmin: false, adminsUnread: false, writesEnabled: true, canWrite: true, githubLogin: null, capabilities: { 'repo.dri': 'refused' }, orgs: [] },
      [ANTON],
    );
    expect(me.capabilities).toEqual({ 'repo.dri': 'refused' });
  });

  // #626 — the two write flags are carried separately, because they answer
  // different questions: `writesEnabled` is the session and the config,
  // `canWrite` is that plus the issue editor's capabilities. A composition that
  // dropped one, or read one off the other, would put the repos page and the
  // issue editor back on a single gate.
  it('carries both write flags through, including the pair that disagree', () => {
    const me = composeMe(
      {
        email: 'stranger@example.com',
        isAdmin: false,
        adminsUnread: false,
        writesEnabled: true,
        canWrite: false,
        githubLogin: null,
        capabilities: { 'issue.labels': 'refused' }, orgs: [],
      },
      [ANTON],
    );
    expect(me).toMatchObject({ writesEnabled: true, canWrite: false });
  });

  it('keeps githubLogin null when the server did not link the account (#520)', () => {
    const me = composeMe({ email: 'stranger@example.com', isAdmin: false, adminsUnread: false, writesEnabled: false, canWrite: false, githubLogin: null, capabilities: {}, orgs: [] }, [ANTON]);
    expect(me.githubLogin).toBeNull();
  });
});

// #635 — the one reader of the per-capability map. Every control that performs
// a named write asks this, so the map is read in one place rather than retyped
// at each control.
//
// The session is built the way `/api/auth/me` builds it (#626): `canWrite` is
// not a free field, it is `writesEnabled` AND no `issue.*` capability refused,
// so `meFixture` derives it rather than taking it. Hand-building a pair the
// server cannot produce is what let the defect below pass green.
const session = (o: { writesEnabled?: boolean; capabilities?: Record<string, string> } = {}): Me =>
  meFixture(o);

describe('mayWrite', () => {
  it('refuses no session at all, and a session that cannot write', () => {
    expect(mayWrite(null, 'issue.labels')).toBe(false);
    expect(mayWrite(session({ writesEnabled: false }), 'issue.labels')).toBe(false);
  });

  it('allows a session that can write and has met no refusal', () => {
    expect(mayWrite(session({ writesEnabled: true }), 'issue.labels')).toBe(true);
    expect(
      mayWrite(session({ writesEnabled: true, capabilities: { 'issue.labels': 'available' } }), 'issue.labels'),
    ).toBe(true);
  });

  // An old board-service ships no map at all, which composeMe reads as `{}`
  // (api.ts): the board knows nothing about what it may do, and knowing nothing
  // refuses nothing. Same answer for a key the map simply has not recorded yet.
  it('allows on `unknown` and on a key the map does not carry', () => {
    expect(
      mayWrite(session({ writesEnabled: true, capabilities: { 'issue.labels': 'unknown' } }), 'issue.labels'),
    ).toBe(true);
    expect(mayWrite(session({ writesEnabled: true, capabilities: {} }), 'issue.labels')).toBe(true);
  });

  it('refuses only the capability that was actually refused', () => {
    const me = session({ writesEnabled: true, capabilities: { 'issue.labels': 'refused' } });
    expect(mayWrite(me, 'issue.labels')).toBe(false);
    expect(mayWrite(me, 'issue.state')).toBe(true);
  });

  // The defect #635 exists to remove, re-entering through its own fix. The
  // session half is `writesEnabled` and never `canWrite` (#626): `canWrite`
  // folds in every `issue.*` refusal, so reading it here would have withheld
  // the repo owner picker and the feedback form's send (since removed, #1450)
  // the moment a credential-wide `issue.labels` refusal landed — with
  // `repo.dri` still available and the write still fine. `boot-alert.file`
  // stands for any other write outside the issue editor.
  //
  // The two fields can only disagree since #626 split them, which is why this
  // case could not be written before. `canWrite` is asserted beside the verdict
  // because it is exactly what the wrong half would have read.
  it('reads the session half, not the issue editor\'s gate (#626)', () => {
    const refusedLabels = session({
      writesEnabled: true,
      capabilities: { 'issue.labels': 'refused', 'repo.dri': 'available', 'boot-alert.file': 'available' },
    });
    expect(refusedLabels.canWrite).toBe(false);
    expect(mayWrite(refusedLabels, 'repo.dri')).toBe(true);
    expect(mayWrite(refusedLabels, 'boot-alert.file')).toBe(true);
    // The issue editor's own controls compose the same session half with their
    // own key, which is strictly finer than `canWrite`: only the refused facet
    // goes quiet, not all nine.
    expect(mayWrite(refusedLabels, 'issue.labels')).toBe(false);
    expect(mayWrite(refusedLabels, 'issue.state')).toBe(true);
  });

  // Both halves, not either: a refused capability does not grant a write to a
  // session that never had one.
  it('refuses a writeless session even where the capability is refused', () => {
    expect(
      mayWrite(session({ writesEnabled: false, capabilities: { 'issue.labels': 'refused' } }), 'issue.labels'),
    ).toBe(false);
  });
});

/**
 * Nothing may read `canWrite` off a session (#635).
 *
 * `canWrite` is the ISSUE editor's whole set composed into one bit —
 * `writesEnabled` AND no `issue.*` capability refused — so one refused
 * `issue.labels` collapses it to false. A surface gating on it goes dark over a
 * refusal that was never about it: that is what took the repos page's owner
 * picker and the feedback form's send off the screen while their own
 * capabilities still read `available`, and what darkened eight editor controls
 * to withhold one. Reading it IS #635, arriving again.
 *
 * A surface asks about the ONE write it makes — `mayWrite(me, capability)` — so
 * the correct number of production readers of this field is ZERO. It stayed
 * zero on a sentence in `use-me.ts` until this; a check keeps it there.
 */
const SOURCES = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Specs say `me.canWrite` constantly — asserting the composition is their job
 *  (this file does it eight lines up). `use-me.ts` declares the field, `api/me.ts`
 *  narrows it off the wire, `me-fixture.ts` derives it the way the server does.
 *  Those four are the whole legitimate set; every other file is a surface. */
const ALLOWED = new Set(['./use-me.ts', './api/me.ts', './me-fixture.ts']);
const isSpec = (path: string) => /\.spec\.tsx?$/.test(path);
const SURFACES = Object.entries(SOURCES).filter(([p]) => !isSpec(p) && !ALLOWED.has(p));

/**
 * Source with its comments removed, so prose ABOUT `canWrite` — of which this
 * change left a great deal — cannot be read as a read of it.
 *
 * The `//` arm fires only at the START of a line. Stripping every `//` strips
 * the ones inside string literals too, and then a single double slash anywhere
 * on a line hides a read on that same line: `const u = "a // b"; me.canWrite`
 * scanned clean. Sparing `://` covered the URL case and nothing else — a path,
 * an "and/or", any string with two slashes in it still swallowed the line. That
 * miss needed no intent, which is what made it worth closing.
 *
 * Every line comment in this package is written at the start of its line, so
 * the narrowing costs one thing: a TRAILING comment quoting a read shape is no
 * longer stripped and trips the guard. That is a false POSITIVE — loud, and
 * rewordable — where the bug it replaces was silent. The spec below asserts
 * both halves of that trade.
 *
 * Block comments are still stripped without regard for strings; the one shape
 * that gets past is pinned as a known miss below, with why a string-aware
 * lexer is the wrong trade here.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)(\s*)\/\/[^\n]*/g, '$1$2');

/**
 * The shapes a session read takes. Anchored to something that identifies a
 * session on every one, which is what keeps the `src/repos/**` prop out:
 * `canWrite={canWrite}`, `canWrite: boolean` and `!canWrite` are the bare
 * identifier and match none of these.
 *
 * That prop is a real one: `src/repos/**` passes a LOCAL `canWrite` down four
 * components, fed by `canSetDri(me)` — a different capability entirely. Those
 * files must be scanned, not excused, because the owner-picker collapse happened
 * there and a genuine `me.canWrite` added there tomorrow is exactly what this
 * has to catch. So the matcher is shaped like a session READ rather than like
 * the identifier, and the sentinel case below proves those files are read and
 * pass on their merits.
 *
 * What it deliberately does NOT catch, stated rather than left to be found: a
 * destructure off a differently-named, un-annotated variable that happens to
 * hold a `Me` (`const { canWrite } = session`), and any read reached through an
 * index signature or a `JSON.parse` result. Both need a reader to go out of
 * their way; the shapes below are the ones a person writes by hand. Widening to
 * the bare identifier is the tempting mistake — it would fire on four `repos/`
 * files that are correct, and a guard that cries wolf gets an allowlist entry
 * for the whole directory, which is how the real read gets in.
 */
const READ_SHAPES: { name: string; re: RegExp }[] = [
  { name: 'member access (me.canWrite / me?.canWrite)', re: /(?:\?\.|\.)\s*canWrite\b/ },
  { name: 'computed access (me["canWrite"])', re: /\[\s*['"`]canWrite['"`]\s*\]/ },
  { name: 'destructure annotated Me ({ canWrite }: Me)', re: /\{[^{}]*\bcanWrite\b[^{}]*\}\s*:\s*Me\b/ },
  { name: 'destructure off a session ({ canWrite } = …me…)', re: /\{[^{}]*\bcanWrite\b[^{}]*\}\s*=[^;\n]*\bme\b/ },
];

const readsIn = (src: string) =>
  READ_SHAPES.filter(({ re }) => re.test(stripComments(src))).map(({ name }) => name);

describe('#635 — no surface reads `canWrite` off the session', () => {
  // Three vacuity gates before the guard itself. Each one, on its own, is the
  // difference between this suite proving something and printing a tick: a
  // source-scanning guard whose glob stops matching passes while proving
  // nothing. So the glob has to find files, the files have to have bytes, and
  // the one file whose contents this suite can predict has to contain what it
  // predicts.
  it('the glob actually found the source tree', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(150);
    expect(SURFACES.length).toBeGreaterThan(100);
  });

  it('every file it scanned has bytes in it', () => {
    const empty = SURFACES.filter(([, src]) => src.trim().length === 0).map(([p]) => p);
    expect(empty).toEqual([]);
  });

  // The one file whose contents this suite can predict, asserted so a glob that
  // silently stopped reaching `repos/` turns red. It also states the case the
  // matcher has to get right: this file is full of the identifier and holds no
  // read.
  it('scans the repos files that carry a prop of the same name, and clears them', () => {
    const owner = SOURCES['./repos/OwnerPicker.tsx'];
    expect(owner).toBeTypeOf('string');
    expect(owner).toContain('canWrite');
    expect(readsIn(owner)).toEqual([]);
  });

  it('no production surface reads it', () => {
    const offenders = SURFACES.map(([p, src]) => [p, readsIn(src)] as const).filter(([, hits]) => hits.length > 0);
    expect(offenders).toEqual([]);
  });

  // The matcher has to be able to say yes. Each shape is put in front of it,
  // so a regex that silently stopped matching — a `\b` lost to an edit, a group
  // that no longer closes — is caught here rather than by passing everything.
  it('recognises every shape it claims to', () => {
    for (const source of [
      'const x = me.canWrite;',
      'if (me?.canWrite) return null;',
      'const x = me["canWrite"];',
      'function Row({ canWrite }: Me) { return canWrite; }',
      'const { canWrite } = me;',
    ]) {
      expect(readsIn(source)).not.toEqual([]);
    }
  });

  // …and has to be able to say no, on the exact shape `src/repos/**` uses.
  it('is not fooled by a local prop that shares the name', () => {
    for (const source of [
      'function Tile({ canWrite }: { canWrite: boolean }) { return canWrite; }',
      '<OwnerPicker canWrite={canWrite} />',
      'if (!canWrite || driOptions.length === 0) return null;',
    ]) {
      expect(readsIn(source)).toEqual([]);
    }
  });

  // Prose is not a read. This change left `canWrite` discussed in six files.
  it('does not read a comment about the field as a use of it', () => {
    expect(readsIn('// never `me.canWrite`\n  // nor me.canWrite here\n/* see me.canWrite */\nconst a = 1;')).toEqual([]);
  });

  /**
   * …and does not eat real code while doing it.
   *
   * A stripper that removes everything after a `//` removes it from inside
   * string literals too, so one double slash anywhere on a line hides a read on
   * that same line. That needs no intent — a URL, a path, an "and/or" — which
   * is what separates it from the misses listed above the shapes. Hence the
   * `//` arm fires only at the START of a line, which is how every line comment
   * in this package is written, and a `//` in the middle of a line is left
   * alone whether it opens a comment or sits in a string.
   */
  it('finds a read on a line whose string literal contains a double slash', () => {
    for (const source of [
      'const u = "a // b"; const y = me.canWrite;',
      'const u = "https://x.test"; const y = me.canWrite;',
      'const p = "and/or"; const y = me.canWrite;',
    ]) {
      expect(readsIn(source)).not.toEqual([]);
    }
  });

  /**
   * The price of that, asserted rather than left to be discovered: a TRAILING
   * `//` comment is no longer stripped, so one that quotes a read shape trips
   * the guard on correct code.
   *
   * It is the right way round. This is a false POSITIVE — a red build on a line
   * a person can reword or turn into a block comment — where the alternative
   * was a false negative that says nothing. No file in the package has one
   * today (checked, not assumed), and the guard is green.
   */
  it('known trade: a trailing comment quoting a read shape trips it', () => {
    expect(readsIn('const a = 1; // never write me.canWrite here')).not.toEqual([]);
  });

  /**
   * The one miss left in the stripper, pinned so a future fix reddens this and
   * has to come back for the doc block above.
   *
   * Block comments are stripped without regard for string literals, so a `/*`
   * INSIDE a string swallows source up to the next close. Unlike `//` this one
   * does take going out of your way, and no file in the package contains it.
   * Making the stripper string-aware would mean a hand-rolled lexer, and a
   * lexer that mistakes a regex literal's character class for a string quote
   * swallows real code SILENTLY — the failure direction this guard exists to
   * avoid. This spec's own `READ_SHAPES` contains such a class.
   */
  it('known miss: a block-comment opener inside a string literal hides a read', () => {
    expect(readsIn('const u = "/*"; const y = me.canWrite; const v = "*/";')).toEqual([]);
    // Unterminated, it strips nothing and the read is found — so the miss is
    // narrower than "a slash-star in a string", and the fixture says which.
    expect(readsIn('const u = "/*"; const y = me.canWrite;')).not.toEqual([]);
  });
});

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

// Removing the boot assertion must let these seven mutations through. They run
// compiled production modules in a fresh process, without the source census.
const root = resolve(__dirname, '../..');
let dist: string;
let reader: string;
let schema: string;
let names: string;
beforeAll(() => {
  dist = mkdtempSync(join(root, '.naming-boot-'));
  execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json', '--outDir', dist], { cwd: root });
  reader = readFileSync(join(dist, 'config/github-orgs.js'), 'utf8');
  schema = readFileSync(join(dist, 'config/config.schema.js'), 'utf8');
  names = readFileSync(join(dist, 'config/setting-names.js'), 'utf8');
}, 120000);
afterAll(() => { if (dist) rmSync(dist, { recursive: true, force: true }); });

function probe(body?: string, changedSchema = schema, changedNames = names) {
  const changedReader = body
    ? reader.replace(/function feedbackRepo\(config\) \{[\s\S]*?\n\}/, `function feedbackRepo(config) {\n${body}\n}`)
    : reader;
  if (body) expect(changedReader).not.toBe(reader);
  writeFileSync(join(dist, 'config/github-orgs.js'), changedReader);
  writeFileSync(join(dist, 'config/config.schema.js'), changedSchema);
  writeFileSync(join(dist, 'config/setting-names.js'), changedNames);
  return spawnSync(process.execPath, ['scripts/check-naming-settings.mjs', dist], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
}

/**
 * The classified key these mutations hang a conditional default off.
 *
 * It was `ISSUES_METRICS_REPOS`, the one classified key the source census
 * excluded; that key is retired (#1209 part 4). `PRODUCT_FEEDBACK_REPO` took
 * its place until the feedback-removal slice retired it too, so `BOOT_ALERT_REPO`
 * now stands in: it is classified as naming a repository AND already carries a
 * presence condition, so appending a second `when` exercises the walk on a real
 * declaration rather than on an invented one.
 *
 * It is spelled as the COMPILED declaration, because `schema` above is read out
 * of `tsc`'s output: the indentation is four more spaces than the source's, and
 * the imported refusal arrives as `github_orgs_1.BOOT_ALERT_REPO_UNSET`.
 * Every mutation asserts the replacement changed something, so a compiler
 * emitting this differently fails here rather than passing vacuously.
 */
const BRANCHED_KEY =
  'BOOT_ALERT_REPO: Joi.string()\n' +
  "        .when('GITHUB_WRITE_ENABLED', { is: true, then: Joi.required(), otherwise: Joi.optional() })\n" +
  "        .messages({ 'any.required': github_orgs_1.BOOT_ALERT_REPO_UNSET }),";

/** The same new setting the two cases above add, so the refusal and the
 *  coverage are shown on one key rather than on two that might differ. */
const NEW_KEY = 'CUSTOMER_STREAM_REPOSITORY';
function withNewKey(declaration: string) {
  const changed = schema.replace(
    "ISSUE_DETAIL_CACHE_TTL_MS: Joi.number().default(60000),",
    `${NEW_KEY}: ${declaration},\n    ISSUE_DETAIL_CACHE_TTL_MS: Joi.number().default(60000),`,
  );
  expect(changed).not.toBe(schema);
  return changed;
}

const fallback = "const DEFAULT = ['unconfigured-owner', 'unconfigured-repo'].join('/');";
const shapes = [
  ['a: renamed destructuring', 'const { FEEDBACK_REPO: repo = DEFAULT } = process.env; return repo;'],
  ['b: guarded assignment', "let repo = config.get('FEEDBACK_REPO'); if (!repo) repo = DEFAULT; return repo;"],
  ['c: class field and later method', "class Reader { constructor() { this.full = config.get('FEEDBACK_REPO'); } read() { return this.full ?? DEFAULT; } } return new Reader().read();"],
  ['d: truthiness ternary', "const full = config.get('FEEDBACK_REPO'); return full?.trim() ? full : DEFAULT;"],
  ['e: distant fallback', "const full = config.get('FEEDBACK_REPO'); const work = []; " + Array.from({ length: 80 }, (_, i) => `work.push(${i});`).join(' ') + ' return full ?? DEFAULT;'],
  ['f: indirect key', "const KEY = 'FEEDBACK_REPO'; return config.get(KEY) ?? DEFAULT;"],
] as const;

describe('compiled naming settings boot guard (#1183)', () => {
  it.each(shapes)('rejects review escape %s', (_name, body) => {
    const result = probe(`${fallback}\n${body}`);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('FEEDBACK_REPO');
    expect(result.stderr).toContain('without environment provenance');
  });

  it('rejects review escape g: inline example in a conditional boot refusal', () => {
    const changed = schema.replace("'any.required': github_orgs_1.BOOT_ALERT_REPO_UNSET", "'any.required': 'Set BOOT_ALERT_REPO to acme/board'");
    expect(changed).not.toBe(schema);
    const result = probe(undefined, changed);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('BOOT_ALERT_REPO');
    expect(result.stderr).toContain('refusal names');
  });

  it('rejects a runtime-assembled schema default on an optional setting', () => {
    const changed = schema.replace('BOOT_ALERT_REPO: Joi.string()', "BOOT_ALERT_REPO: Joi.string().default(() => ['unconfigured-owner', 'alerts'].join('/'))");
    expect(changed).not.toBe(schema);
    const result = probe(undefined, changed);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('BOOT_ALERT_REPO');
    expect(result.stderr).toContain('without environment provenance');
  });

  it('rejects a reader that substitutes a value even when the environment names one', () => {
    const result = probe("if (config.get('FEEDBACK_REPO') == null) throw new Error('FEEDBACK_REPO is not set'); return 'unconfigured-owner/other';");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('without environment provenance');
  });

  // Which settings get value-checked used to be decided by a regex over key
  // NAMES, which is the mechanism #1183 was filed to replace: a check that
  // enumerates spellings is always one spelling behind. These three drive the
  // replacement — every key the schema declares is classified, and an
  // unclassified key is refused whatever it is called.

  it('rejects a naming setting spelled outside the old key pattern', () => {
    const result = probe(undefined, withNewKey("Joi.string().default(() => ['unconfigured-owner', 'stream'].join('/'))"));
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(NEW_KEY);
  });

  it('rejects a new setting nobody classified, whatever it names', () => {
    // No default at all: the refusal is about the setting being unclassified,
    // not about the value, so the next one cannot be waved through by having
    // nothing to resolve yet.
    const result = probe(undefined, withNewKey('Joi.string().optional()'));
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(NEW_KEY);
    expect(result.stderr).toContain('setting-names.ts');
  });

  it('checks the value of a new setting once it is classified as naming one', () => {
    // Without this the two above would be satisfied by a check that only ever
    // complains, and a key could be classified into silence rather than into
    // coverage.
    const classified = names.replace('    FEEDBACK_LABELS: null,', `    ${NEW_KEY}: 'repo',\n    FEEDBACK_LABELS: null,`);
    expect(classified).not.toBe(names);
    const declared = withNewKey("Joi.string().default(() => ['unconfigured-owner', 'stream'].join('/'))");
    const result = probe(undefined, declared, classified);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(NEW_KEY);
    expect(result.stderr).toContain('without environment provenance');

    const honest = probe(undefined, withNewKey('Joi.string().optional()'), classified);
    expect(honest.status, honest.stdout + honest.stderr).toBe(0);
    expect(honest.stdout).toContain('4 settings');
  });

  it('rejects dropping a classified setting out of the schema', () => {
    // A rename leaves the same count of keys behind, so a floor on how many the
    // check found cannot see one leave coverage.
    const changed = schema.replace(/    BOOT_ALERT_REPO: Joi\.string\(\)\n(?:        \..*\n)+/, '');
    expect(changed).not.toBe(schema);
    const result = probe(undefined, changed);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('BOOT_ALERT_REPO');
  });

  it('rejects a default parked in a branch no other setting in this check varies', () => {
    // Joi lets a declaration depend on another
    // key, and every boot above leaves the rest at their schema default —
    // `PROJECTS_SOURCE` at `fixture` — so a default parked behind `github`
    // resolved for nobody and passed. The branches are read off the schema's own
    // description, because a list of switches to vary would be the enumeration
    // #1183 removes.
    const changed = schema.replace(
      BRANCHED_KEY,
      BRANCHED_KEY.replace(/,$/, '') +
        ".when('PROJECTS_SOURCE', { is: 'github', then: Joi.string().default('unconfigured-owner/stream') }),",
    );
    expect(changed).not.toBe(schema);
    const result = probe(undefined, changed);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('BOOT_ALERT_REPO');
    expect(result.stderr).toContain('without environment provenance');

    // And the branch itself is not the offence, so this cannot be satisfied by
    // refusing every conditional declaration: the same `when` carrying no
    // default of its own is accepted. The count is the walk's own receipt — the
    // presence condition the schema already carries is on `BOOT_ALERT_REPO`, so
    // the walk is exercised on a real declaration and not only on this mutation.
    const honest = probe(undefined, schema.replace(
      BRANCHED_KEY,
      BRANCHED_KEY.replace(/,$/, '') + ".when('PROJECTS_SOURCE', { is: 'github', then: Joi.string() }),",
    ));
    expect(honest.status, honest.stdout + honest.stderr).toBe(0);
    expect(honest.stdout).toContain('2 declared branches');
  });

  it('rejects a default behind a condition the schema states as a schema, not a value', () => {
    // The branch walk reaches a branch by building the environment its
    // condition names, which it can only do when the condition is a VALUE. An
    // `is` written as a schema allows no literal, so the walk built no overlay,
    // counted no branch and said nothing — and a default parked there resolved
    // for a real deployment (#1244 review). This is not an exotic idiom: the
    // schema already writes one next door, `GITHUB_STORE_DATABASE_URL`
    // depending on `Joi.string().min(1)`.
    const changed = schema.replace(
      BRANCHED_KEY,
      BRANCHED_KEY.replace(/,$/, '') +
        ".when('PROJECTS_SOURCE', { is: Joi.string().pattern(/^git/), then: Joi.string().default('unconfigured-owner/stream') }),",
    );
    expect(changed).not.toBe(schema);
    const result = probe(undefined, changed);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('BOOT_ALERT_REPO');
    // By the DECLARATION, not by a resolved value: nothing here reaches the
    // branch, and saying which of the two refused is the point.
    expect(result.stderr).toContain('somewhere nothing here resolves');
  });

  it('rejects a runtime-assembled default behind a condition stated as a schema', () => {
    // The two blind spots at once, which is the strongest form of the escape:
    // no environment here reaches the branch, so nothing resolves the default,
    // and the default has no written value for a reader to find. Joi keeps the
    // function in `flags.default` all the same — it survives `describe()` and
    // not `JSON.stringify` — so the refusal names the kind instead of a value.
    const changed = schema.replace(
      BRANCHED_KEY,
      BRANCHED_KEY.replace(/,$/, '') +
        ".when('PROJECTS_SOURCE', { is: Joi.string().pattern(/^git/), then: Joi.string().default(() => ['unconfigured-owner', 'stream'].join('/')) }),",
    );
    expect(changed).not.toBe(schema);
    const result = probe(undefined, changed);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('BOOT_ALERT_REPO');
    expect(result.stderr).toContain('assembled at runtime');
  });

  it('rejects a default reachable only when two conditions hold at once', () => {
    // The walk recursed into a nested `when` and pushed each condition as its
    // own overlay, so a default behind an outer AND an inner condition was
    // reached by neither — while the count of branches went UP, which reads as
    // more coverage than before (#1244 review).
    const changed = schema.replace(
      BRANCHED_KEY,
      BRANCHED_KEY.replace(/,$/, '')
        + ".when('PROJECTS_SOURCE', { is: 'github', then: Joi.string()"
        + ".when('DELIVERY_SOURCE', { is: 'fixture', then: Joi.string().default('unconfigured-owner/stream') }) }),",
    );
    expect(changed).not.toBe(schema);
    const result = probe(undefined, changed);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('BOOT_ALERT_REPO');
    // By a RESOLVED value: both conditions are values, so composing them builds
    // an environment that reaches the branch and the default comes back.
    expect(result.stderr).toContain('without environment provenance');

    // And neither shape is the offence in itself, so this cannot be satisfied
    // by refusing every condition the walk cannot state: both carrying no
    // default of their own are accepted, and the receipt says which of them the
    // walk reached and which it did not.
    const honest = probe(undefined, schema.replace(
      BRANCHED_KEY,
      BRANCHED_KEY.replace(/,$/, '')
        + ".when('PROJECTS_SOURCE', { is: Joi.string().pattern(/^git/), then: Joi.string() }),",
    ));
    expect(honest.status, honest.stdout + honest.stderr).toBe(0);
    expect(honest.stdout).toContain('1 declared branch');
    expect(honest.stdout).toContain('1 condition stated as a schema');
  });

  it('accepts the real compiled config and readers', () => {
    const result = probe();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('1 declared branch');
  });
});

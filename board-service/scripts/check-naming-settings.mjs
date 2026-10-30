#!/usr/bin/env node
/**
 * Primary no-defaults guard (#1183), run by check-di-boot before its environment
 * is populated. Executes compiled settings readers and real Nest config boots.
 *
 * WHICH settings it checks comes from `config/setting-names.ts`, which
 * classifies every key the schema declares, and this refuses to run when the
 * two disagree either way. It used to come from a regex over key names, which
 * was the same defect in a new place: #1183's whole argument is that a check
 * enumerating spellings is one spelling behind, and `CUSTOMER_STREAM_REPOSITORY`
 * was that spelling (#1183 review).
 *
 * WHAT it checks, for a key that names something, is the resolved VALUE against
 * the environment input it was given, through the compiled shared readers and a
 * real ConfigModule boot — and then the DECLARATION, because a default parked in
 * a branch is a default no boot here resolves. The walk near the bottom reaches
 * a branch by building the environment its condition names, and what no
 * environment here reaches is refused by reading the description instead.
 *
 * What it does not do is execute consumer code, read `process.env` on the
 * application's behalf, or import the application's own ConfigModule. That is
 * three shapes it cannot see, and none of them is a spelling.
 * `config/github-orgs.ts` names all three and `docs/testing/naming-settings.md`
 * says what would close each. Naming ONE of them here, in closed form, is what
 * told the last reader the map was finished (#1244 review).
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(process.argv[2] ?? resolve(root, 'dist'));

try {
  // Never inherit an operator's environment or .env: either can mask a default.
  process.env = {};
  require('reflect-metadata');
  const { ConfigModule, ConfigService } = require('@nestjs/config');
  const { Test } = require('@nestjs/testing');
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const settings = require(resolve(dist, 'config/github-orgs.js'));
  const { configValidationSchema: schema } = require(resolve(dist, 'config/config.schema.js'));
  const { SETTING_NAMES } = require(resolve(dist, 'config/setting-names.js'));

  function refusal(key, error) {
    const message = String(error?.message ?? error);
    if (!message.includes(key)) throw new Error(`${key}: unexpected reader failure: ${message}`);
    // This is emitted operator-facing prose, never source text. The seventh
    // #1178 escape is a conditional refusal with a real repository as an example.
    if (/acme|globex|octocat|example\.com/i.test(message)) {
      throw new Error(`${key}: refusal names a real organisation or repository: ${message}`);
    }
  }

  function same(key, actual, expected) {
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`${key} resolved ${JSON.stringify(actual)} without environment provenance; expected ${JSON.stringify(expected)}`);
    }
  }

  function read(key, fn, expected) {
    let actual;
    try { actual = fn(); }
    catch (error) {
      refusal(key, error);
      if (expected !== undefined) throw error;
      return;
    }
    same(key, actual, expected);
  }

  /**
   * Whether the schema WRITES a default anywhere in a key's declaration, and
   * what it is where that can be said — whether or not any environment here
   * reaches it.
   *
   * This reads the declaration; the walk below resolves it. The difference is
   * what each can be blind to. The walk reaches a branch by building the
   * environment its condition names, so it is blind to a condition stated as a
   * schema rather than a value — `is: Joi.string().pattern(/^git/)` allows no
   * literal to build one from — and it was blind to a default standing behind
   * two conditions at once (#1244 review). Reading the tree is blind to neither.
   * Where the value was WRITTEN makes no difference either: a module const
   * composed into a branch describes the same as an inline literal, which is
   * what took the reviewer's escape past the source census as well.
   *
   * It is blind to nothing else here. `flags.default` is PRESENT for a default
   * assembled at runtime — Joi keeps the function there — and present for a
   * `Joi.ref`. Only its value is unsayable, so the refusal says the kind
   * instead. Serialising the description first is what hides those: they
   * survive `describe()` and not `JSON.stringify`.
   */
  function declaredDefaults(description, out = []) {
    if (Object.hasOwn(description?.flags ?? {}, 'default')) out.push(description.flags.default);
    for (const item of description?.items ?? []) declaredDefaults(item, out);
    for (const branch of [...(description?.whens ?? []), ...(description?.matches ?? [])]) {
      for (const nested of [branch.then, branch.otherwise, branch.schema]) if (nested) declaredDefaults(nested, out);
    }
    return out;
  }

  /** A default in a refusal, for the two kinds that have no value to print. */
  const shown = (value) => {
    if (typeof value === 'function') return 'assembled at runtime';
    if (value && typeof value === 'object') return `taken from ${JSON.stringify(value)}`;
    return JSON.stringify(value);
  };

  /**
   * Every condition the schema itself makes a key's declaration depend on, as an
   * environment overlay that REACHES the branch. Read from `describe()` — the
   * same reading the classification check above trusts — so a nested `when`
   * inside a `when`, and an `alternatives().conditional()`, are found without
   * either being spelled here.
   *
   * Conditions COMPOSE down the recursion: a branch inside a branch is reached
   * by an overlay carrying both, because a default standing behind two at once
   * is reached by neither alone. Until #1244 each nested condition was pushed as
   * an overlay of its own, and the count of branches went UP while such a
   * default rode in — the receipt moving in the direction that reads as more
   * coverage.
   *
   * A condition the schema states as a SCHEMA — `is: Joi.string().min(1)`, which
   * `GITHUB_STORE_DATABASE_URL` is already written with — allows no literal, so
   * there is no environment to build and the subtree behind it is not walked.
   * That is counted and printed rather than skipped in silence: what covers it
   * is `declaredDefaults` above, and the receipt has to say the walk did not.
   */
  function conditionsIn(description, found = { reaching: [], unstated: 0 }, reached = {}) {
    for (const branch of [...(description?.whens ?? []), ...(description?.matches ?? [])]) {
      const on = branch.ref?.path?.[0];
      const literals = (branch.is?.allow ?? []).filter((value) => ['string', 'number', 'boolean'].includes(typeof value));
      if (on && literals.length) {
        for (const literal of literals) {
          const overlay = { ...reached, [on]: String(literal) };
          found.reaching.push(overlay);
          if (branch.then) conditionsIn(branch.then, found, overlay);
        }
      } else if (on) {
        found.unstated += 1;
      }
      // The `otherwise` side is explored under the conditions already
      // accumulated: "not that value" is what leaving the key unset already
      // says, so there is nothing more to add to the overlay.
      if (branch.otherwise) conditionsIn(branch.otherwise, found, reached);
    }
    return found;
  }

  // Which keys name something is a total classification of the schema, checked
  // both ways before anything is read. A key nobody classified is refused by
  // name rather than skipped, so a new setting arrives as a failing check
  // instead of as uncovered ground; a classification the schema no longer
  // declares is refused too, which is what a rename looks like from here.
  const described = schema.describe().keys;
  const declared = Object.keys(described);
  const unclassified = declared.filter((key) => !Object.hasOwn(SETTING_NAMES, key));
  if (unclassified.length) {
    throw new Error(`${unclassified.join(', ')}: declared by the schema and missing from config/setting-names.ts. `
      + 'Say there whether each names a Github organisation or repository, or names nothing on Github.');
  }
  const departed = Object.keys(SETTING_NAMES).filter((key) => !declared.includes(key));
  if (departed.length) {
    throw new Error(`${departed.join(', ')}: classified in config/setting-names.ts and no longer declared by the schema. `
      + 'A renamed or removed setting leaves coverage silently otherwise.');
  }
  const keys = declared.filter((key) => SETTING_NAMES[key] !== null);
  if (!keys.length) throw new Error('config/setting-names.ts classifies no setting as naming a Github organisation or repository');
  // What each kind is fed. A list takes one entry, because what is compared is
  // whether the value that came back is the one supplied. These live here and
  // not beside the classification: they are this probe's fixtures, and nothing
  // the application ships has a use for them.
  const PROBE_VALUES = { org: 'probe-owner', orgs: 'probe-owner', repo: 'probe-owner/probe-repo', repos: 'probe-owner/probe-repo' };
  const unfed = keys.filter((key) => PROBE_VALUES[SETTING_NAMES[key]] === undefined);
  if (unfed.length) throw new Error(`${unfed.join(', ')}: classified as ${unfed.map((key) => SETTING_NAMES[key]).join(', ')}, which this check has no value to supply`);
  const named = Object.fromEntries(keys.map((key) => [key, PROBE_VALUES[SETTING_NAMES[key]]]));
  // No key is classified `org` any more: the four surface pins that were are
  // retired (#1209 part 4), and `orgsFor`/`orgFor` went with them. The filter
  // stays so the next key somebody classifies `org` is refused until a reader
  // here exercises it, rather than arriving uncovered.
  const orgKeys = keys.filter((key) => SETTING_NAMES[key] === 'org');

  // Raw config is intentional: a required schema key otherwise refuses before
  // the reader runs and hides exactly the six read-site escapes from #1178.
  for (const env of [{}, {
    GITHUB_ORGS: 'probe-first,probe-second', FEEDBACK_REPO: 'probe-first/feedback',
  }, {
    GITHUB_ORGS: 'probe-third', FEEDBACK_REPO: 'probe-third/other',
  }]) {
    process.env = { ...env };
    const config = new ConfigService(env);
    read('FEEDBACK_REPO', () => settings.feedbackRepo(config), env.FEEDBACK_REPO);
    read('GITHUB_ORGS', () => settings.githubOrgs(config), env.GITHUB_ORGS?.split(','));
    if (!env.GITHUB_ORGS) continue;
    if (orgKeys.length > 0) {
      throw new Error(
        `these keys are classified 'org' and no shared reader here executes them: ` +
          `${orgKeys.join(', ')}. The four that were classified this way are retired ` +
          '(#1209 part 4). Add a reader above before classifying another one.',
      );
    }
  }

  let boots = 0;
  for (const ISSUES_SOURCE of ['fixture', 'github']) {
    for (const GITHUB_WRITE_ENABLED of ['false', 'true']) {
      const switches = {
        ISSUES_SOURCE, GITHUB_WRITE_ENABLED, IDENTITY_SOURCE: 'db', BOOT_ALERT_ASSIGNEE: 'probe-recipient',
        AUTH_DISABLED: 'false', DATABASE_URL: 'postgresql://probe:probe@localhost:5432/probe',
      };
      for (const omitted of [null, ...keys]) {
        const env = { ...named, ...switches };
        if (omitted) delete env[omitted];
        process.env = { ...env };
        const { value, error } = schema.validate(env, { abortEarly: false, allowUnknown: true });
        for (const key of keys) {
          const actual = value[key];
          // An empty optional repository list names nothing.
          if (env[key] === undefined && actual === '' && SETTING_NAMES[key] === 'repos') continue;
          same(key, actual, env[key]);
        }
        if (error) refusal(omitted, error);
        let module;
        let bootFailure;
        try {
          const configModule = await ConfigModule.forRoot({
            ignoreEnvFile: true, validationSchema: schema,
            validationOptions: { abortEarly: false, allowUnknown: true },
          });
          module = await Test.createTestingModule({ imports: [configModule] }).compile();
          const resolved = module.get(ConfigService);
          for (const key of keys) same(key, resolved.get(key), value[key]);
          boots += 1;
        } catch (bootError) {
          bootFailure = bootError;
        } finally {
          await module?.close();
        }
        if (error) {
          if (!bootFailure) throw new Error(`${omitted}: Nest boot accepted settings the schema refused`);
          refusal(omitted, bootFailure);
        } else if (bootFailure) throw bootFailure;
      }
    }
  }
  // A default parked in a BRANCH is a default the boots above never reach. Joi
  // lets a declaration depend on another key — `.when('PROJECTS_SOURCE', { is:
  // 'github', then: ... })` — and every boot above leaves the other switches at
  // their schema default, so such a default resolves for nobody here and passes.
  // `ISSUES_METRICS_REPOS` was where that bit: it was the one classified key the
  // source census excluded, on the argument that an empty list is a legitimate
  // answer for it, so this check was its only cover (#1183 review). That key is
  // retired (#1209 part 4), and this check stays because the next `.when` will
  // come without one.
  //
  // Which branches exist is read off the schema's own description rather than
  // named here. A list of switches to vary would be the enumeration #1183
  // removes, and it would be one switch behind the next `.when`.
  //
  // Two passes over the same description, because one was not enough (#1244
  // review). Resolving a branch requires an environment that reaches it, and
  // only a condition stated as a VALUE names one; reading the declaration
  // requires nothing to reach it and sees every default the schema writes.
  let branches = 0;
  let unstated = 0;
  for (const key of keys) {
    const found = conditionsIn(described[key]);
    unstated += found.unstated;
    for (const condition of found.reaching) {
      branches += 1;
      const env = { ...named, ...condition };
      delete env[key];
      const { value } = schema.validate(env, { abortEarly: false, allowUnknown: true });
      // An empty optional repository list names nothing, the same allowance the
      // boots above make.
      if (value[key] === '' && SETTING_NAMES[key] === 'repos') continue;
      same(key, value[key], undefined);
    }
    // Resolved first, then read, so each refusal comes from the check that
    // actually covers its shape: a default anything here resolves is refused by
    // the value that came back, and only what nothing resolves falls through to
    // the declaration. The same empty-list allowance applies, and it is the only
    // default any of these keys may carry.
    const written = declaredDefaults(described[key])
      .filter((value) => !(value === '' && SETTING_NAMES[key] === 'repos'));
    if (written.length) {
      throw new Error(`${key} declares a default ${shown(written[0])} somewhere nothing here resolves; `
        + 'a setting that names a Github organisation or repository is named by the deployment or refused by name.');
    }
  }
  if (!boots) throw new Error('naming settings guard completed no successful config boots');
  const unwalked = unstated ? `, ${unstated} condition stated as a schema and not walked` : '';
  console.log(`check-naming-settings: ${keys.length} settings, ${boots} config boots, ${branches} declared branches${unwalked}, compiled readers and conditional refusals passed.`);
} catch (error) {
  console.error(`check-naming-settings: ${error.message}`);
  process.exitCode = 1;
}

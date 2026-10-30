import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { configValidationSchema } from './config.schema';
import { SETTING_NAMES } from './setting-names';
import { feedbackScopeFrom } from '../auth/feedback-visibility';
import { githubOrgs, parseGithubOrgs } from './github-orgs';
import { RETIRED_SETTINGS } from './retired-settings';

/** An org login no default could ever have handed back, used wherever a test
 *  needs A org rather than a particular one. `acme` on purpose: it is the
 *  org the fixtures describe, so a stale default cannot be mistaken for it. */
const SOME_ORG = 'acme';

/** The keys every deployment must now name (#1175), so a test about one thing
 *  is not answered by a required key's absence. `required-settings.spec.ts`
 *  owns the refusals themselves. */
const NAMED = {
  GITHUB_ORGS: SOME_ORG,
  FEEDBACK_REPO: `${SOME_ORG}/board`,
};

/** A ConfigService over an env the schema has validated — the shape the app
 *  runs on, so a test cannot accidentally assert against a default Joi would
 *  have applied differently. */
function validated(env: Record<string, string> = {}): ConfigService {
  const { value, error } = configValidationSchema.validate({ ...NAMED, ...env }, { allowUnknown: true });
  expect(error, `env did not validate: ${error?.message}`).toBeUndefined();
  return new ConfigService(value);
}

/** A ConfigService built straight from an object, the way specs across the tree
 *  build one — never through the schema, so no Joi default stands between the
 *  value and the resolver. This is why the empty-list refusal cannot live in
 *  Joi alone. */
const raw = (env: Record<string, unknown> = {}) => new ConfigService(env);

describe('GITHUB_ORGS resolves the org every surface serves (#647)', () => {
  it('has no default at all: a board that names no org does not boot (#1175)', () => {
    // It defaulted to `acme`, then to `acme` after the 2026-09-16
    // rename, and the day between those two is the whole argument: an
    // ORGANISATION lookup by a former login does not resolve, three surfaces
    // logged an error each on every boot, and nothing here was told. A board
    // that names no organisation is now refused by name — see
    // `required-settings.spec.ts` for the sentence it gives.
    expect(configValidationSchema.validate({}).error?.message).toMatch(/GITHUB_ORGS/);
    expect(() => githubOrgs(raw({}))).toThrow(/GITHUB_ORGS/);
  });

  it('a deployment naming only globex authorizes no write against acme', () => {
    // Every write gate reads the owner scope — issue-detail's `env()` and its
    // addProject owner check, the feedback source, the repo dri route. They read
    // `PROJECTS_OWNER` and `ISSUES_METRICS_ORG` until #1209 part 4 retired both,
    // and one answer now serves all of them. It may not still say acme.
    expect(githubOrgs(validated({ GITHUB_ORGS: 'globex' }))).toEqual(['globex']);
  });

  it('a GITHUB_ORGS that parses to nothing refuses every write', () => {
    for (const nothing of ['', '   ', ',', ' , ', ',,']) {
      // Joi is the first door...
      expect(configValidationSchema.validate({ ...NAMED, GITHUB_ORGS: nothing }).error?.message, nothing).toMatch(
        /GITHUB_ORGS/,
      );
      // ...and the resolver is the second, because a spec-built config never
      // sees Joi at all.
      expect(() => githubOrgs(raw({ GITHUB_ORGS: nothing })), nothing).toThrow(/GITHUB_ORGS/);
    }
  });

  it('an ABSENT GITHUB_ORGS refuses too, and says something different from an empty one (#1175)', () => {
    // Absent and empty are different mistakes and get different sentences. Both
    // refuse: until #1175 the absent case was handed the documented default,
    // which is the one of the two an operator never sees go wrong.
    expect(() => githubOrgs(raw({}))).toThrow(/GITHUB_ORGS is not set/);
    expect(() => githubOrgs(raw({ GITHUB_ORGS: '   ' }))).toThrow(/names no org/);
  });

  it('refuses a value that is not a Github org login', () => {
    for (const bad of ['acme hub', 'acme/board', 'org!', 'acme_hub', 'acme.hub']) {
      expect(configValidationSchema.validate({ ...NAMED, GITHUB_ORGS: bad }).error?.message, bad).toMatch(/GITHUB_ORGS/);
      expect(() => githubOrgs(raw({ GITHUB_ORGS: bad })), bad).toThrow(/GITHUB_ORGS/);
    }
  });

  it('the schema and the resolver cannot disagree about what parses', () => {
    // One derivation: whatever Joi accepts, `githubOrgs` reads, because Joi
    // validates by running `githubOrgs`'s own parser.
    // `a,,b` is two orgs and a stray comma, accepted for the same reason
    // FEEDBACK_LABELS accepts one: an empty segment between two real names is a
    // typo that costs nothing, while a value that parses to NO name is the one
    // that switches a control off, and that is refused above.
    for (const ok of ['acme', 'globex,acme', ' globex , acme ', 'Acme', 'a,,b', 'acme ,']) {
      const { value, error } = configValidationSchema.validate({ ...NAMED, GITHUB_ORGS: ok });
      expect(error, ok).toBeUndefined();
      expect(githubOrgs(new ConfigService(value)).length, ok).toBeGreaterThan(0);
    }
  });
});

describe('one Github org is read once, however many times it is spelled (#718)', () => {
  it('names an org twice in two casings and reads it once', () => {
    // Github org logins are case-insensitive, so this string names ONE org. Now
    // that the Repos surface reads per org and SUMS the answers, the same org
    // read twice doubles every alert count and every Actions dollar, and says
    // nothing about having done so.
    expect(parseGithubOrgs('acme,Acme')).toEqual(['acme']);
  });

  it('keeps the FIRST spelling the operator wrote, not the last', () => {
    // The surviving spelling is what every surface displays and what `?org=`
    // answers in, so a later duplicate's casing must not overwrite it.
    expect(parseGithubOrgs('Acme,acme')).toEqual(['Acme']);
    expect(parseGithubOrgs('a,b,A')).toEqual(['a', 'b']);
  });

  it('leaves a list with no duplicates exactly as written, in order', () => {
    expect(parseGithubOrgs('globex,acme,selgeo')).toEqual(['globex', 'acme', 'selgeo']);
    expect(parseGithubOrgs(' globex , acme ')).toEqual(['globex', 'acme']);
  });

  it('still refuses a list that parses to no org at all', () => {
    // Deduplication cannot empty a non-empty list, but the refusal is what a
    // write pin stands on, so it is asserted on the same four inputs as before.
    for (const nothing of ['', '   ', ',', ',,']) {
      expect(() => parseGithubOrgs(nothing), JSON.stringify(nothing)).toThrow(/GITHUB_ORGS/);
    }
  });

  it('the schema and the resolvers agree that the duplicate is one org', () => {
    // Joi validates by running this parser, so a duplicate list still boots —
    // and every resolver behind it answers one org, not two.
    const { value, error } = configValidationSchema.validate({ ...NAMED, GITHUB_ORGS: 'acme,Acme' });
    expect(error).toBeUndefined();
    const config = new ConfigService(value);
    expect(githubOrgs(config)).toEqual(['acme']);

  });
});

/** Every `.ts` under `src/`, specs excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

/**
 * Comments are not call sites. `projects/github-projects.source.ts` records in
 * prose that it USED to hold an `orgFor` call, and a census reading raw text
 * reports that file as an offender — verified before that check was written.
 * `identity/github-derived-logins.source.ts` names `orgs[0]` in a comment for
 * the same reason.
 *
 * A `//` inside a STRING is not a comment either, and cutting on the text alone
 * could not tell the two apart: the rule was `(^|[^:])//.*$`, and the `[^:]`
 * was there because the authors had already met `https://` and answered that
 * one spelling. A path with a doubled separator in it, on the same line as a
 * read, took the read away with it and the census reported a clean file
 * (#1244 review) — a census blinded by the source it is reading. So the line is
 * SCANNED rather than matched, and a `//` only ends the line when no quote is
 * open. `https://` needs no clause of its own under that rule.
 */
const withoutComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => {
    let quote = '';
    for (let i = 0; i < line.length; i += 1) {
      if (quote) {
        if (line[i] === '\\') i += 1;
        else if (line[i] === quote) quote = '';
      } else if (line[i] === "'" || line[i] === '"' || line[i] === '`') quote = line[i];
      else if (line[i] === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  })
  .join('\n');

/**
 * A read of `key` off `ConfigService`, as a regex source.
 *
 * ONE spelling of what a settings read looks like, because the whole argument of
 * this file is that a check enumerating shapes is one shape behind: `getOrThrow`
 * gaining an overload must not be learned here and unlearned in the census
 * below. `key` is interpolated raw, so it may be an alternation or a capture.
 */
const READ = (key: string) => `get(?:OrThrow)?(?:<[^>]*>)?\\(\\s*['"\`]${key}['"\`]`;

/** Any setting read off `ConfigService`, with its key captured. */
const SETTING_READ = new RegExp(`\\b${READ('([A-Z][A-Z0-9_]*)')}`, 'g');

/**
 * NO default names an organisation or a repository, checked instead of
 * described (#1175).
 *
 * #1166 wrote the previous version of this census: every default had to name
 * ONE organisation, held in one constant, so a rename would be a single edit.
 * The edit still had to be MADE, and twice in two days it was not — the
 * organisation on 2026-09-16, and two repositories on 2026-09-17, one of them
 * this board's own.
 *
 * Both renames were invisible in the same way. Github REDIRECTS a repository
 * path, so every read addressed as `owner/name` carried on working; what broke
 * was the reads that address something else. An ORGANISATION lookup by a former
 * login does not resolve, so three surfaces logged an error each on every boot
 * for a day. The Github SEARCH API follows no rename, so a search-backed
 * surface answered `422 Validation Failed` on every load until the deployment
 * was corrected by hand.
 *
 * So the rule is no longer "the defaults agree". It is that the defaults are
 * GONE: a deployment that needs one of these settings names it, and one that
 * does not is refused at boot by name. `required-settings.spec.ts` drives every
 * refusal. This census is secondary (#1183): it covers dormant source the
 * compiled boot probe cannot execute; the probe checks resolved values and
 * runtime-built defaults, on every setting `setting-names.ts` classifies as
 * naming one. Add execution coverage rather than regex alternatives.
 *
 * The two do not partition the space, and they leave THREE directions open, not
 * one (#1183 review, #1244 review). Say all of them, because naming a map's
 * holes in closed form and getting the count wrong is how this claim has been
 * wrong twice: the previous count of two was published in five sentences while
 * a `.default('acme')` behind `is: Joi.string().pattern(...)` passed every
 * gate here.
 *
 * A LIVE read the probe does not execute: a class that binds a naming key with
 * `this.x = config.get(KEY)` and substitutes its own value in a later method
 * passes both, because the probe runs only the shared readers and the binding
 * regex below captures no name to follow.
 *
 * A key read off `process.env` rather than `ConfigService`: the declaration
 * census below reads `config.get` call sites, so a `process.env` read leaves the
 * key undeclared, and an unclassified key is a key neither half has an opinion
 * about. The fallback census does cover `process.env` — but only for the eight
 * keys `SPELLED_KEYS` names, which is a list and so is one spelling behind.
 *
 * And a value handed to ConfigModule from outside the schema: the probe rebuilds
 * the application's config rather than importing `app.module.ts`, so a `load:`
 * factory there is declared by no schema and defaulted at no call site.
 *
 * What is no longer open is a default parked in a BRANCH. The probe both walks
 * the branches the description names, composing conditions, and reads the
 * declaration for what no environment reaches — so a default behind a pattern,
 * behind two conditions at once, or assembled at runtime is refused by name
 * (#1244 review). `docs/testing/naming-settings.md` says what would close the
 * three that remain.
 */
describe('no setting defaults to an organisation or a repository (#1175)', () => {
  /** The two keys that name a REPOSITORY. Each is a decision of its own —
   *  where feedback lands, and where a bad boot reports — and none of them may
   *  be decided by silence. */
  const REPO_KEYS = ['FEEDBACK_REPO', 'BOOT_ALERT_REPO'] as const;

  /** Every key that could name the organisation or a repository inside it. */
  const SPELLED_KEYS = ['GITHUB_ORGS', ...REPO_KEYS];

  /**
   * A read of one of these keys that supplies a value when the key is ABSENT —
   * a default, in any of the shapes below.
   *
   *     config.get<string>('FEEDBACK_REPO', anything)
   *     config.getOrThrow<string>('FEEDBACK_REPO', anything)
   *     config.get<string>('FEEDBACK_REPO') ?? anything
   *     process.env.FEEDBACK_REPO || anything
   *     const { FEEDBACK_REPO = anything } = process.env
   *     const repo = config.get<string>('FEEDBACK_REPO');
   *     if (!repo) return anything;
   *
   * It reads the SHAPE and not the value, which is what #1175 widened. The
   * #1166 version demanded a string literal after the fallback, so
   * `get('FEEDBACK_REPO', DEFAULT_FEEDBACK_REPO)` was the approved answer and a
   * constant holding a stale organisation passed every gate in this repository.
   * There is no approved answer now: a fallback of any kind is a default, and a
   * default is what nobody can keep true.
   *
   * The last three shapes are round 2's, and each was proven to get through the
   * first cut by committing it to `src/` and watching this file stay green:
   *
   *  - the destructuring default still demanded a QUOTE after the `=`, which is
   *    exactly the flaw #1175 called out and fixed on the Joi side in the same
   *    change. A constant went through. It now matches an `=` at all.
   *  - `getOrThrow(key, default)` is a real `ConfigService` method that takes a
   *    default, and the read was anchored on `get(` alone.
   *  - a read BOUND to a name and given its substitute a line later is the
   *    plainest way a default comes back, and no regex anchored on the read's
   *    own expression sees it. So the binding is captured and the value is
   *    followed: a `??`, a `||`, a guarded `return` or a ternary that answers
   *    with something other than absence is a default.
   *
   * Propagating ABSENCE is not supplying a value: `return null` and `return
   * undefined` behind a guard are clean, and so is a `throw` — which is what
   * both readers in this tree do. Nothing else is: normalising an unset key to
   * `''` decides what the key means when nobody set it, which is the promise
   * being withdrawn.
   *
   * A key merely READ is clean — `config.get<string>('FEEDBACK_REPO')` with
   * nothing after it is the shape every reader uses, and the refusal lives with
   * the reader rather than at the call site.
   *
   * Where this stops, said plainly because the next person will reach for a
   * wider pattern first (#1183 review). The binding shapes are `const`, `let`
   * and `var`, and the value is followed `WINDOW` characters. A read bound to a
   * CLASS FIELD — `this.owner = config.get('PROJECTS_OWNER')` in a constructor,
   * `this.owner ?? 'some-owner'` in a method three hundred lines down — is
   * neither: there is no binding name to follow, and the substitution is past
   * any window a function-sized one could have. The boot probe does not execute
   * that method either, so nothing in this repository sees it. Learning one more
   * binding shape would leave the check one shape behind, which is the position
   * #1175 and #1183 were both filed from; `docs/testing/naming-settings.md`
   * carries what would actually close it.
   */
  /** How far past a binding its value is followed. Long enough for the guard
   *  that follows a read, short enough not to reach the next function. */
  const WINDOW = 600;

  /** Which of these shapes a source carries, named, so a failure says what to
   *  look for rather than only that something matched. */
  const fallbacksIn = (source: string, names: readonly string[]): string[] => {
    const key = `(?:${names.join('|')})`;
    const read = READ(key);
    const found: string[] = [];
    const shapes: [string, RegExp][] = [
      ['a second argument to the read', new RegExp(`${read}\\s*,`)],
      [
        'a ?? or || on the read itself',
        new RegExp(`(?:${read}\\s*\\)|process\\.env\\.${key})\\s*(?:\\?\\?|\\|\\|)`),
      ],
      ['a destructuring default', new RegExp(`[{,]\\s*${key}\\s*=\\s*[^=>]`)],
    ];
    for (const [name, shape] of shapes) if (shape.test(source)) found.push(name);

    // The bound read, which needs the binding's NAME and so cannot be one regex.
    const binding = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]*)?=\\s*[^;]*?${read}`, 'g');
    const answer = `(?!\\s*(?:undefined|null)\\b)`;
    for (const match of source.matchAll(binding)) {
      const name = match[1];
      const after = source.slice(match.index, match.index + WINDOW);
      const absent = `(?:!\\s*${name}|${name}\\s*===?\\s*(?:null|undefined))`;
      const substituted = [
        new RegExp(`\\b${name}\\s*(?:\\?\\?|\\|\\|)`),
        new RegExp(`if\\s*\\(\\s*${absent}\\s*\\)\\s*\\{?\\s*return${answer}`),
        new RegExp(`${absent}\\s*\\?${answer}`),
      ];
      if (substituted.some((shape) => shape.test(after))) {
        found.push(`a fallback on ${name}, the value the read was bound to`);
        break;
      }
    }
    return found;
  };

  const carriesFallback = (source: string, names: readonly string[]) => fallbacksIn(source, names).length > 0;

  it('no source carries a fallback for any of them, this module included', () => {
    // `config/github-orgs.ts` was exempt from the #1166 census because it was
    // where the one approved constant lived. It is not exempt now: there is no
    // constant, so there is nowhere in this tree a default may sit.
    const offenders = sourceFiles(join(__dirname, '..'))
      .map((f) => [f, fallbacksIn(withoutComments(readFileSync(f, 'utf8')), SPELLED_KEYS)] as const)
      .filter(([, shapes]) => shapes.length > 0)
      .map(([f, shapes]) => `${f.slice(f.indexOf('/src/') + 5)} (${shapes.join('; ')})`)
      .sort();
    expect(
      offenders,
      [
        'these decide what one of these settings means when nobody has set it, which is the',
        'promise #1175 withdrew: the organisation was renamed on 2026-09-16 and two repositories',
        'on 2026-09-17, and nothing here was told either time. Read the key with no fallback and',
        'refuse an absent one by name, the way `githubOrgs` and `feedbackRepo` do.',
      ].join(' '),
    ).toEqual([]);
  });

  it('the schema declares no default for any of them either', () => {
    // The census above reads call sites; a Joi default lives in one file and is
    // written across several lines, so it is read by slicing the declaration out
    // rather than by a regex that would stop at the first newline.
    const schema = readFileSync(join(__dirname, 'config.schema.ts'), 'utf8');
    const declaration = (key: string): string => {
      const at = schema.search(new RegExp(`^\\s*${key}\\s*:`, 'm'));
      if (at < 0) return '';
      const body = schema.slice(at);
      // From the line AFTER this key's own, so the search for the next key
      // cannot find this one again and return an empty declaration.
      const nl = body.indexOf('\n');
      if (nl < 0) return body;
      const next = body.slice(nl).search(/^\s*[A-Z][A-Z0-9_]*\s*:/m);
      return next < 0 ? body : body.slice(0, nl + next);
    };
    const defaulted = SPELLED_KEYS.filter((key) => /\.default\(/.test(withoutComments(declaration(key))));
    expect(
      defaulted,
      'these carry a Joi default. Require the key of the deployments that read it and leave it ' +
        'absent for the rest, so a board that needs one and names none is refused rather than ' +
        'handed a guess.',
    ).toEqual([]);
  });

  it('a boot that names nothing is refused, by name', () => {
    // The census above is a reading of the tree; this is the behaviour it exists
    // to protect, taken off the schema itself. Until #1175 this same call
    // returned a complete configuration naming a real organisation and three
    // real repositories.
    const { error } = configValidationSchema.validate({}, { abortEarly: false });
    expect(error?.message).toContain('GITHUB_ORGS is not set');
    expect(error?.message).toContain('FEEDBACK_REPO is not set');
  });

  it('every schema key is classified, and the ones that name something are these three', () => {
    // `check-naming-settings.mjs` picks the settings it value-checks out of
    // `SETTING_NAMES` and refuses to run when that and the schema disagree
    // either way, which is what stops a new setting arriving uncovered. Saying
    // it again here puts the same failure in the unit suite, a second rather
    // than a compile and 28 boots away.
    const declared = Object.keys(configValidationSchema.describe().keys);
    expect(declared.filter((key) => !Object.hasOwn(SETTING_NAMES, key)), 'declared and unclassified').toEqual([]);
    expect(Object.keys(SETTING_NAMES).filter((key) => !declared.includes(key)), 'classified and undeclared').toEqual([]);
    // `SPELLED_KEYS` stays its own list because this census asks a different
    // question of it — no Joi default. It held `ISSUES_METRICS_REPOS` too, which
    // legitimately defaulted to the empty list; that key is retired (#1209 part
    // 4), so the two lists are the same three keys and this is what keeps them so.
    expect(declared.filter((key) => SETTING_NAMES[key] !== null).sort())
      .toEqual([...SPELLED_KEYS].sort());
  });

  it('every setting the service reads is declared, so classification can reach it', () => {
    // The classification above is total over the keys the schema DECLARES, and
    // that qualifier is load-bearing: a key nobody declared is in neither set,
    // so neither direction of the boot check fires and `SPELLED_KEYS` does not
    // hold it either. `config.get('DELIVERY_REPO', 'acme/board')` — the
    // plainest default there is — passed every gate in this repository,
    // including this file and the full service suite (#1183 review).
    //
    // It is not a hypothetical shape. Four keys were read this way and declared
    // nowhere, three of them in the same file as `BOOT_ALERT_REPO`, whose own
    // undeclared-ness is how a key that decides where this board writes stayed
    // invisible until #1175. This makes the schema the place a setting has to
    // pass through, so the classification cannot be outrun by a read.
    //
    // It reads source text, which is why it lives here rather than in the boot
    // probe: an undeclared key is exactly what a probe reading the schema
    // structurally cannot see.
    const reads = new Map<string, string[]>();
    for (const file of sourceFiles(join(__dirname, '..'))) {
      const where = file.slice(file.indexOf('/src/') + 5);
      for (const [, key] of withoutComments(readFileSync(file, 'utf8')).matchAll(SETTING_READ)) {
        reads.set(key, [...new Set([...(reads.get(key) ?? []), where])]);
      }
    }
    const declared = Object.keys(configValidationSchema.describe().keys);
    const undeclared = [...reads.keys()]
      .filter((key) => !declared.includes(key))
      .sort()
      .map((key) => `${key} (${reads.get(key)!.join(', ')})`);
    expect(
      undeclared,
      'these are read off ConfigService and declared by no schema, so nothing classifies them and ' +
        'no check here or at boot has an opinion about what they name. Declare each in ' +
        'config.schema.ts and say in setting-names.ts whether it names a Github organisation or ' +
        'repository. A key read from process.env rather than ConfigService is not covered by this.',
    ).toEqual([]);

    // Without this the check could be vacuous: a pattern that matches no read
    // reports every key as declared, whatever the tree holds.
    const keysIn = (source: string) => [...source.matchAll(SETTING_READ)].map(([, key]) => key);
    expect(reads.size, 'settings read across src/').toBeGreaterThan(20);
    expect(keysIn("config.get<string>('FEEDBACK_REPO')")).toEqual(['FEEDBACK_REPO']);
    expect(keysIn("this.config.getOrThrow<string>('BOOT_ALERT_REPO')")).toEqual(['BOOT_ALERT_REPO']);
    expect(keysIn("config.get<number>('PROJECTS_CACHE_TTL_MS', 300000)")).toEqual(['PROJECTS_CACHE_TTL_MS']);
    // An indirect key names nothing to declare, and a lowercase read of some
    // other map is not a setting at all.
    expect(keysIn('config.get(KEY)')).toEqual([]);
    expect(keysIn("cache.get('someEntry')")).toEqual([]);
  });

  it('both repository keys are declared, so the schema is where their rule lives', () => {
    // `BOOT_ALERT_REPO` was not declared until #1175, so its only default lived
    // in the notifier and nothing at boot could see it — which is how a key that
    // decides where the board writes under its shared token stayed invisible to
    // every check in this file.
    const declared = Object.keys(configValidationSchema.describe().keys);
    for (const key of REPO_KEYS) expect(declared, key).toContain(key);
  });

  it('every key a deployment must name is required by the schema, not only by its reader', () => {
    // Joi is the first door. A reader that refuses is the second, and the two
    // must not disagree about which deployments owe which key.
    const required = (key: string): boolean =>
      configValidationSchema.validate({ ...NAMED, [key]: undefined }, { allowUnknown: true }).error?.message.includes(key) ?? false;
    expect(required('GITHUB_ORGS'), 'GITHUB_ORGS').toBe(true);
    expect(required('FEEDBACK_REPO'), 'FEEDBACK_REPO').toBe(true);
  });

  it('both censuses discriminate: they fire on every default and on none of the honest reads', () => {
    // Without this each check could be vacuous — a regex that matches nothing
    // reports a clean tree whatever the tree holds.
    const fires = (source: string) => carriesFallback(source, SPELLED_KEYS);
    // The literal shapes the #1166 census already caught.
    expect(fires("config.get<string>('FEEDBACK_REPO', 'acme/board')")).toBe(true);
    expect(fires("config.get<string>('FEEDBACK_REPO') ?? 'acme/board'")).toBe(true);
    expect(fires("config.get<string>('FEEDBACK_REPO') || 'acme/board'")).toBe(true);
    expect(fires("process.env.GITHUB_ORGS ?? 'acme'")).toBe(true);
    expect(fires("config.get('BOOT_ALERT_REPO', 'acme/board')")).toBe(true);
    // And the shape #1166 APPROVED, which is the whole of what #1175 widened: a
    // constant is a default, and the constant is what went stale.
    expect(fires("config.get<string>('FEEDBACK_REPO', DEFAULT_FEEDBACK_REPO)")).toBe(true);
    expect(fires("config.get<string>('FEEDBACK_REPO') ?? DEFAULT_FEEDBACK_REPO")).toBe(true);
    expect(fires("const { FEEDBACK_REPO = 'acme/x' } = process.env")).toBe(true);

    // Round 2: the three shapes that got through the first cut, each proven by
    // committing it to `src/` and watching this file stay green at 48/48.
    expect(fires('const { FEEDBACK_REPO = DEFAULT_FEEDBACK_REPO } = process.env;')).toBe(true);
    expect(fires('const { GITHUB_ORGS = fallbackOrgs } = process.env;')).toBe(true);
    expect(fires("config.getOrThrow<string>('FEEDBACK_REPO', 'acme/board')")).toBe(true);
    expect(fires("config.getOrThrow<string>('FEEDBACK_REPO') ?? DEFAULT_FEEDBACK_REPO")).toBe(true);
    expect(
      fires("const full = c.get<string>('FEEDBACK_REPO');\n  if (!full) return DEFAULT_FEEDBACK_REPO;\n  return full;"),
    ).toBe(true);
    expect(
      fires("const full = c.get<string>('FEEDBACK_REPO');\n  if (full == null) return DEFAULT_FEEDBACK_REPO;"),
    ).toBe(true);
    expect(fires("const full = c.get<string>('FEEDBACK_REPO');\n  return full ?? DEFAULT_FEEDBACK_REPO;")).toBe(true);
    expect(fires("const full = c.get<string>('FEEDBACK_REPO');\n  return !full ? DEFAULT_FEEDBACK_REPO : full;")).toBe(true);
    expect(fires("const orgs = c.get<string>('GITHUB_ORGS');\n  if (!orgs) { return DEFAULT_GITHUB_ORGS; }")).toBe(true);

    // A key merely READ stays clean, which is every reader in the tree today.
    expect(fires("config.get<string>('FEEDBACK_REPO')")).toBe(false);
    expect(fires('githubOrgs(this.config)')).toBe(false);
    expect(fires('feedbackRepo(this.config)')).toBe(false);
    // Both readers in this tree, whole: a bound read that REFUSES is not a
    // default, and neither is one that propagates the absence it found.
    expect(
      fires("const full = config.get<string>('FEEDBACK_REPO');\n  if (full == null) throw new Error(FEEDBACK_REPO_UNSET);\n  return full;"),
    ).toBe(false);
    expect(
      fires("const full = config.get<string>('BOOT_ALERT_REPO');\n  if (full == null) return null;\n  return split(full);"),
    ).toBe(false);
    // A neighbouring key with a default of its own is not this rule's business.
    expect(fires("config.get<string>('FEEDBACK_LABELS', 'feedback')")).toBe(false);
    expect(fires(withoutComments("// was get<string>('FEEDBACK_REPO', 'x')"))).toBe(false);
    // And a `//` inside a STRING is not a comment, so it cannot take the read
    // on its line away with it (#1244 review). Both halves are the test: the
    // comment still goes, and the string stays.
    expect(
      fires(withoutComments(
        "const doc = 'docs/delivery//scope.md';\n  return config.get<string>('FEEDBACK_REPO', 'acme/x') + doc;",
      )),
    ).toBe(true);
    expect(fires(withoutComments("const url = 'https://board'; // get<string>('FEEDBACK_REPO', 'x')"))).toBe(false);
    expect(withoutComments("const url = 'https://x'; // gone")).toBe("const url = 'https://x'; ");
    // Reading a key is not writing one: a comparison and an arrow are not `=`.
    expect(fires('if (name === undefined || FEEDBACK_REPO === value) return;')).toBe(false);
    expect(fires('rows.map(({ FEEDBACK_REPO }) => FEEDBACK_REPO);')).toBe(false);

    const joiDefault = /\.default\(/;
    expect(joiDefault.test("FEEDBACK_REPO: Joi.string().default('acme/board'),")).toBe(true);
    expect(joiDefault.test('FEEDBACK_REPO: Joi.string().default(DEFAULT_FEEDBACK_REPO),')).toBe(true);
    expect(joiDefault.test("FEEDBACK_REPO: Joi.string().required().messages({ 'any.required': X }),")).toBe(false);
  });
});

/**
 * Both documented fixture boots name every setting they now have to (#1166,
 * #1175).
 *
 * `FIXTURE_OWNER` was `DEFAULT_GITHUB_ORGS` until the organisation was renamed,
 * and `fixture-projects.source.ts` went on asserting the equality in prose after
 * it stopped holding. Nothing noticed, because the two documented ways to boot
 * on fixtures disagreed: `.env.example` pinned the org and the container command
 * did not, so `pnpm start:dev` drew 2 boards while `docker run` drew 0 — with no
 * error between them, because an org a fixture has nothing for is an org with
 * nothing going on.
 *
 * #1175 makes the same pair matter for a second reason and in a louder way:
 * with no defaults left, a documented boot that omits `GITHUB_ORGS` or
 * `FEEDBACK_REPO` does not draw an empty page, it does not start. So both boots
 * are read here, for both keys, and both are MEASURED in `PR-1175.md` rather
 * than assumed — the last round of this work broke the container path and found
 * out only because a reviewer built the image.
 */
describe('the documented fixture boots name what a boot now requires (#1166, #1175)', () => {
  /** The org every fixture row is written against. Private to each source, so it
   *  is read here the way an operator meets it: off the line they are told to
   *  type. */
  const FIXTURE_ORG = 'acme';

  /** The repository the fixture Projects submissions are written against.
   *  `fixture-projects.source.ts` seeds three of them, and the visibility rule
   *  only recognises a submission inside `FEEDBACK_REPO`. The ISSUE fixture
   *  writes its own into `acme/board`, so no single value covers both;
   *  this is the one a local board recognised before the organisation was
   *  renamed, and it is what both documented boots now name. */
  const FIXTURE_FEEDBACK_REPO = `${FIXTURE_ORG}/board`;

  it('both documented fixture boots pin the org, because no default does', () => {
    const example = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
    expect(example, '.env.example no longer pins the fixture org').toMatch(
      new RegExp(`^GITHUB_ORGS=${FIXTURE_ORG}$`, 'm'),
    );
    const contributing = readFileSync(join(__dirname, '../../../CONTRIBUTING.md'), 'utf8');
    expect(contributing, 'the documented container command no longer names the fixture org').toContain(
      `-e GITHUB_ORGS=${FIXTURE_ORG}`,
    );
  });

  it('both name the fixture feedback repository, which a boot now requires (#1175)', () => {
    const example = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
    expect(example, '.env.example no longer names FEEDBACK_REPO, so a copy of it does not boot').toMatch(
      new RegExp(`^FEEDBACK_REPO=${FIXTURE_FEEDBACK_REPO.replace('.', '\\.')}$`, 'm'),
    );
    const contributing = readFileSync(join(__dirname, '../../../CONTRIBUTING.md'), 'utf8');
    expect(
      contributing,
      'the documented container command no longer names FEEDBACK_REPO, so the image does not boot',
    ).toContain(`-e FEEDBACK_REPO=${FIXTURE_FEEDBACK_REPO}`);
  });

  it('a copy of `.env.example` validates against the schema with nothing added', () => {
    // The whole claim `.env.example` makes. With four settings newly required
    // this is where an unedited copy stops booting, and it is cheaper to read
    // here than off a container.
    const env: Record<string, string> = {};
    for (const raw of readFileSync(join(__dirname, '../../.env.example'), 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
    const { error } = configValidationSchema.validate(env, { allowUnknown: true, abortEarly: false });
    expect(error?.message, 'a copy of .env.example no longer boots').toBeUndefined();
    // And the fixture submissions are inside the scope it names, which is what
    // makes the visibility rule reachable in local dev at all.
    expect(feedbackScopeFrom(new ConfigService(env))).toEqual({
      owner: FIXTURE_ORG,
      repo: 'board',
      labels: ['feedback'],
    });
  });

  it('the two sources that go quiet for any other org still gate on it', () => {
    // If either stops gating, the two pins above become the stale advice
    // instead, and this test is where that gets noticed.
    for (const rel of ['projects/fixture-projects.source.ts', 'delivery/fixture-delivery.source.ts']) {
      const source = readFileSync(join(__dirname, '..', rel), 'utf8');
      expect(source, rel).toContain(`const FIXTURE_OWNER = '${FIXTURE_ORG}'`);
      expect(source, `${rel} no longer refuses an org that is not the fixture owner`).toMatch(
        /org !== FIXTURE_OWNER/,
      );
    }
  });
});

describe('a documented setting no code reads is gone (#647 task 1)', () => {
  it('GITHUB_REPO is not declared, documented or read', () => {
    expect(Object.keys(configValidationSchema.describe().keys)).not.toContain('GITHUB_REPO');
    const example = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
    expect(example, '.env.example still documents GITHUB_REPO').not.toMatch(/^GITHUB_REPO=/m);
    const readme = readFileSync(join(__dirname, '../../../README.md'), 'utf8');
    expect(readme, 'README.md still names GITHUB_REPO').not.toContain('GITHUB_REPO');
    const readers = sourceFiles(join(__dirname, '..')).filter((f) => readFileSync(f, 'utf8').includes('GITHUB_REPO'));
    expect(readers, 'these read a setting that no longer exists').toEqual([]);
  });

  it('no retired setting is declared, documented as a value, or read', () => {
    // The shape of the GITHUB_REPO check above, applied to the four owner pins
    // #1209 part 4 retired. A key still declared would be a key an operator can
    // set and reasonably expect to work; a `KEY=` line in `.env.example` is the
    // same promise in a file somebody copies. Naming them in PROSE stays legal,
    // and is how an operator is told to remove one.
    const declared = Object.keys(configValidationSchema.describe().keys);
    const example = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
    for (const key of RETIRED_SETTINGS) {
      expect(declared, `${key} is still declared`).not.toContain(key);
      expect(example, `.env.example still assigns ${key}`).not.toMatch(new RegExp(`^${key}=`, 'm'));
      expect(SETTING_NAMES, `${key} is still classified`).not.toHaveProperty(key);
    }
    // One file reads them, and reading them is its whole job: it reports what an
    // operator left behind. It reads `process.env`, not `ConfigService`, so the
    // declaration census above has nothing to say about it either.
    const readers = sourceFiles(join(__dirname, '..'))
      .filter((f) => RETIRED_SETTINGS.some((key) => withoutComments(readFileSync(f, 'utf8')).includes(key)))
      .map((f) => f.slice(f.indexOf('/src/') + 5))
      .sort();
    expect(readers, 'these read a setting that no longer exists').toEqual(['config/retired-settings.ts']);
  });

  it('no key names an organisation on its own any more', () => {
    // The four that did are retired. A fifth `*_ORG` or `*_OWNER` key declared
    // later would reach no resolver and narrow nothing, which is a setting that
    // lies; this is where that gets noticed.
    const declared = Object.keys(configValidationSchema.describe().keys).filter(
      (k) => k.endsWith('_ORG') || k.endsWith('_OWNER'),
    );
    expect(declared, 'these look like owner pins and no resolver reads one').toEqual([]);
  });
});

/**
 * NARROWING a plural answer back to one org, checked instead of described (#718).
 *
 * #697 moved every read surface off a singular resolver. It did not keep them
 * from asking the plural one and then taking `[0]`, which is the same defect
 * spelled differently: Repos asked `metricsOrgs`, kept the list for its write
 * check and pinned `this.org = this.orgs[0] ?? ''` for every read, so a two-org
 * `GITHUB_ORGS` served the first org's repos and nothing else. A comment in
 * that file was the only thing saying not to.
 *
 * So the rule is checked: a surface takes the WHOLE answer and iterates it,
 * tolerating one org failing rather than losing the rest. There is no singular
 * resolver left to name one org on purpose — `orgFor` went with the pins at
 * #1209 part 4 — so a write that has to land in one org finds it IN the answer
 * rather than off the front of it, which is what `servesOwner` and the
 * `guardWrite` envelopes do.
 */
describe('a read does not narrow a plural answer to one org (#718)', () => {
  /** The resolver that answers a LIST, and the only one there is. */
  const PLURAL_RESOLVERS = 'githubOrgs';

  /** A call to it. One level of nested parentheses is enough for every spelling
   *  in this tree — `githubOrgs(config)`, `githubOrgs(this.config)`. */
  const PLURAL_CALL = `(?:${PLURAL_RESOLVERS})\\s*\\((?:[^()]|\\([^()]*\\))*\\)`;

  /** The two spellings of "the first one". `[i]` in a loop is not one of them,
   *  which is what most of the tree does with the answer and must stay legal. */
  const FIRST_OF = `(?:\\[\\s*0\\s*\\]|\\.at\\(\\s*0\\s*\\))`;

  /** `const [first] = …` — destructuring that binds a LEADING element, so the
   *  first org arrives without either spelling above. A `[...all]` rest keeps
   *  the whole list and is not a hit. */
  const TAKES_FIRST = `\\[\\s*(?!\\.\\.\\.)[A-Za-z_][A-Za-z0-9_]*\\s*[,\\]][^=;\\n]*=\\s*(?:await\\s+)?`;

  /** Whatever a plural call was assigned to, so the narrowing can be found on
   *  the NAME as well as on the call: `const orgs = …`, `this.orgs = …`,
   *  `private readonly orgs: string[] = …`. The #718 shape is this one — the
   *  call and the `[0]` were two lines apart, which is why a check that only
   *  read the call site would have missed it. */
  const boundToPlural = () =>
    new RegExp(
      `(?:^|[^\\w$.])((?:this\\.)?[A-Za-z_][A-Za-z0-9_]*)\\s*(?::[^=;\\n]*)?=\\s*(?:await\\s+)?(?:${PLURAL_RESOLVERS})\\s*\\(`,
      'gm',
    );

  /** Every narrowing read in one source, as the text that spells it. Returns the
   *  hits rather than a boolean so the discriminator below can say WHAT was seen
   *  — a matcher that fired for the wrong reason reads exactly like one that
   *  fired for the right one. */
  const narrowingReads = (source: string): string[] => {
    const hits = [
      ...source.matchAll(new RegExp(`${PLURAL_CALL}\\s*${FIRST_OF}`, 'g')),
      ...source.matchAll(new RegExp(`${TAKES_FIRST}${PLURAL_CALL}`, 'g')),
    ].map((m) => m[0]);
    for (const [, bound] of source.matchAll(boundToPlural())) {
      const name = bound.replace(/^this\./, '');
      const read = `\\b(?:this\\.)?${name}\\s*${FIRST_OF}`;
      const taken = `${TAKES_FIRST}(?:this\\.)?${name}\\b`;
      hits.push(...[...source.matchAll(new RegExp(`${read}|${taken}`, 'g'))].map((m) => m[0]));
    }
    return hits.map((h) => h.replace(/\s+/g, ' ').trim());
  };

  /**
   * Files allowed to narrow, each with the reason. Empty today, and an entry is
   * a claim that one org is the whole point of that line — which for a READ it
   * never is. `config/github-orgs.ts` was excluded by path while it DEFINED
   * `orgFor` as `githubOrgs(config)[0]`; that definition is gone (#1209 part 4),
   * so the file is covered like every other.
   */
  const NARROWS_BY_DESIGN: string[] = [];

  it('no source takes the first org out of a plural answer', () => {
    const offenders = sourceFiles(join(__dirname, '..'))
      .filter((f) => narrowingReads(withoutComments(readFileSync(f, 'utf8'))).length > 0)
      .map((f) => f.slice(f.indexOf('/src/') + 5))
      .sort();
    expect(
      offenders,
      [
        '`githubOrgs` answers a LIST, and taking `[0]`,',
        "`.at(0)` or `const [first] =` off it serves the first org in GITHUB_ORGS",
        'and silently drops the rest — that is #718, and #697 before it.',
        'Iterate the whole answer instead, letting one org fail without losing the',
        'others (see projects.service.ts and delivery.service.ts for the shape).',
        'If a WRITE has to land in exactly one org, find that org IN the answer',
        'the way `servesOwner` does, not off the front of it.',
        'If one org really is the whole point here, add the path to',
        'NARROWS_BY_DESIGN in this spec with a comment saying which read it is and',
        'why the other orgs may be dropped.',
      ].join(' '),
    ).toEqual([...NARROWS_BY_DESIGN].sort());
  });

  it('the census discriminates: it fires on every narrowing spelling and on none of the honest ones', () => {
    // Without this the check could be vacuous — a regex that matches nothing
    // reports a clean tree whatever the tree holds. NARROWS_BY_DESIGN being
    // empty is exactly the case where that would go unnoticed.

    // Subscripted straight off the call, both spellings.
    expect(narrowingReads('const o = githubOrgs(this.config)[0];')).toEqual(['githubOrgs(this.config)[0]']);
    expect(narrowingReads('const o = githubOrgs(this.config).at(0);')).toEqual(['githubOrgs(this.config).at(0)']);
    expect(narrowingReads('const [first] = githubOrgs(config);')).toEqual(['[first] = githubOrgs(config)']);

    // The #718 shape itself: the call on one line, the narrowing on the next.
    expect(narrowingReads("this.orgs = githubOrgs(this.config);\nthis.org = this.orgs[0] ?? '';")).toEqual([
      'this.orgs[0]',
    ]);
    expect(narrowingReads('this.orgs = githubOrgs(this.config);\nconst o = this.orgs.at(0);')).toEqual([
      'this.orgs.at(0)',
    ]);
    expect(narrowingReads('this.orgs = githubOrgs(this.config);\nconst [first] = this.orgs;')).toEqual([
      '[first] = this.orgs',
    ]);
    // Through a local and a constructor property, not only a field.
    expect(narrowingReads('const orgs = githubOrgs(config);\nreturn orgs[0];')).toEqual(['orgs[0]']);
    expect(narrowingReads('private readonly orgs: string[] = githubOrgs(config),\nx = orgs.at(0);')).toEqual([
      'orgs.at(0)',
    ]);

    // The honest readers: iterate, test membership, index by a loop variable.
    expect(narrowingReads('for (const org of githubOrgs(this.config)) await this.read(org);')).toEqual([]);
    expect(narrowingReads('return githubOrgs(this.config).some((o) => o === asked);')).toEqual([]);
    expect(narrowingReads('const orgs = githubOrgs(this.config);\nreturn orgs.map((o) => o.trim());')).toEqual([]);
    expect(narrowingReads('const orgs = githubOrgs(this.config);\nthis.log(`${orgs[i]} unreadable`);')).toEqual([]);
    expect(narrowingReads('const orgs = githubOrgs(this.config);\nconst [...all] = orgs;')).toEqual([]);
    // A `[0]` on something that never came from the resolver.
    expect(narrowingReads("const owner = repo.full.split('/')[0];")).toEqual([]);

    // Prose is not a call site: both comment shapes, and a URL survives.
    expect(narrowingReads(withoutComments('// a producer that pins `githubOrgs(config)[0]` (#647)'))).toEqual([]);
    expect(narrowingReads(withoutComments('/** the resolver that stood here answered `githubOrgs(c)[0]` */'))).toEqual(
      [],
    );
    expect(
      narrowingReads(withoutComments('const o = githubOrgs(config)[0]; // was the whole list')),
    ).toEqual(['githubOrgs(config)[0]']);
  });
});

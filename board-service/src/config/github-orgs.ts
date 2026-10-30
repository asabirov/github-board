import { githubPrincipal } from '../auth/github-principal';
import { ConfigService } from '@nestjs/config';

/** Owner resolution for personal requests and machine jobs (#647, #1209). Personal owners come from App discovery, while `GITHUB_ORGS` supplies machine scope. */

/** A Github org login: alphanumeric and hyphen, nothing else. */
const ORG_LOGIN = /^[A-Za-z0-9-]+$/;

/**
 * NO setting here names an organisation or a repository when nobody has (#1175).
 *
 * #1166 took nine copies of one organisation login down to one constant, so a
 * rename would be a single edit. This removes the constant: a single edit still
 * has to be MADE, and twice in two days it was not.
 *
 * The organisation was renamed on 2026-09-16.
 * Nothing in this repository was told, and nothing noticed for a day, because
 * Github REDIRECTS a repository path across a rename — every read addressed as
 * `owner/name` carried on working, while the surfaces that ask about an
 * ORGANISATION logged an error each on every boot. A repository was renamed
 * on 2026-09-17, and a search-backed surface answered `422 Validation Failed`
 * on every load, because the Github SEARCH API follows no rename; it was
 * corrected by hand in the deployment.
 *
 * A default is a promise that being silent is safe, and this repository cannot
 * keep it. The severe case has not happened and is the reason to close it now: an
 * organisation login is FREE the moment a rename completes, and
 * `FEEDBACK_REPO` decides which repository a person's words are written into
 * under the board's shared write token.
 *
 * So each of the three is required of the deployments that read it, and a
 * deployment that does not name one is refused at boot BY NAME rather than
 * handed a guess. `parseGithubOrgs` has refused a `GITHUB_ORGS` that parses to
 * no organisation since #647, on exactly this reasoning; a deployment that never
 * set the key was in the same position and was the one being handed a guess.
 *
 * `required-settings.spec.ts` drives every refusal. The primary
 * `check-naming-settings.mjs` boot probe executes the compiled shared readers
 * below — `githubOrgs` and `feedbackRepo` — and a real ConfigModule boot, and
 * compares every resolved naming value with the environment input it was given,
 * runtime-built defaults included. WHICH settings those are comes from `setting-names.ts`,
 * which classifies every key the schema declares and is checked against it both
 * ways, so a new setting cannot arrive uncovered under a new spelling.
 * `github-orgs.spec.ts` retains the secondary source census for dormant defaults
 * the probe never executes, and requires every key `src/` reads off
 * `ConfigService` to be declared, so a read cannot outrun the classification.
 *
 * A default parked in a BRANCH resolves for none of those boots, and the probe
 * covers that in two passes rather than one, because one was not enough. It
 * WALKS the branches the schema's own description names, composing conditions so
 * that a default standing behind two at once is reached — and then it READS the
 * declaration, because a condition the schema states as a schema rather than a
 * value (`is: Joi.string().min(1)`, which `GITHUB_STORE_DATABASE_URL` is already
 * written with) names no environment to build. Between them, a default the
 * schema writes anywhere into one of these declarations is refused whether or
 * not anything here reaches it, and whether it is a literal, a `Joi.ref` or a
 * function. The walk alone covered neither shape and its receipt did not say so,
 * which is how a `.default('acme')` behind a pattern passed every gate in
 * this repository (#1244 review).
 *
 * THREE shapes get past all of that, and none of them is a spelling.
 *
 * A CONSUMER: a class that reads one of these keys straight off `ConfigService`
 * and substitutes its own value in a later method is not executed by the probe,
 * and its `this.x = config.get(KEY)` binding is not a shape the census follows.
 * Closing that means executing consumer read sites, or routing every naming read
 * through the readers below so nothing absent is left for a caller to default —
 * not a wider pattern.
 *
 * A key read from `process.env` instead of `ConfigService`: the declaration
 * census reads `config.get` call sites, so such a key can stay undeclared, and
 * an undeclared key is classified by nothing.
 *
 * And a value handed to ConfigModule from OUTSIDE the schema. The probe models
 * the application's config by rebuilding it — `ignoreEnvFile`, the schema, the
 * validation options — rather than by importing `app.module.ts`, so a `load:`
 * factory added there would supply naming values that no schema declares and no
 * `config.get` call site defaults, and neither half would have an opinion.
 * Nothing is written that way today: `app.module.ts` passes `isGlobal`, the
 * schema and the options and nothing else. Closing it means the probe taking the
 * application's own ConfigModule options instead of reconstructing them.
 *
 * `docs/testing/naming-settings.md` holds all three, and what would close them.
 */

/**
 * What an operator is told when `GITHUB_ORGS` is absent.
 *
 * ABSENT and EMPTY are different mistakes and get different sentences. A key
 * nobody set is a deployment that never mentioned the setting, and what it needs
 * to know is that the setting exists. A key that PARSES to no organisation is
 * somebody's value, and `parseGithubOrgs` has its own sentence for that below.
 *
 * No example login appears in either. A worked example naming a real
 * organisation is this same defect in prose: silent, stale after the next
 * rename, and typed in by hand.
 */
export const GITHUB_ORGS_UNSET =
  'GITHUB_ORGS is not set, so this board cannot say which Github organisation it serves, and no ' +
  'write could say which organisation it may target. Set it to the org login(s) this board ' +
  'serves, comma-separated. There is no default: an organisation login is free the moment a ' +
  'rename completes, so a board that guesses one is a board that can read a stranger\'s.';

/**
 * What an operator is told when `FEEDBACK_REPO` is absent.
 *
 * This key is required of EVERY deployment, with no flag in front of it, and
 * `required-settings.spec.ts` carries the argument: `feedbackScopeFrom` — the
 * rule that tells a person's submission from an ordinary issue — is built in
 * five service constructors on every boot.
 */
export const FEEDBACK_REPO_UNSET =
  'FEEDBACK_REPO is not set, so this board cannot say which repository holds the feedback people ' +
  'sent it. Set it to the `owner/name` the old feedback form filed into. It tells an old ' +
  'submission apart from an ordinary issue, so a board that guesses it can show somebody\'s ' +
  'words to a static agent token.';

/** What an operator is told when `BOOT_ALERT_REPO` is absent on a board that can
 *  write. `GITHUB_WRITE_ENABLED` is the switch: `reportBootErrors` returns
 *  before anything else without it. */
export const BOOT_ALERT_REPO_UNSET =
  'BOOT_ALERT_REPO is not set, so a boot that found something wrong would have nowhere to file ' +
  'its report. Set it to the `owner/name` this board reports its own failed boots into, or set ' +
  'GITHUB_WRITE_ENABLED=false.';

/**
 * The repository the old feedback form filed into (#1450 removed the form), and
 * the repository the visibility rule recognises a submission in. One reader for
 * five sources, so they cannot disagree on which repository that is.
 *
 * It throws rather than answering an empty string. Joi requires the key, so a
 * deployment cannot reach this unset; a `ConfigService` built straight from an
 * object can, and that is every spec in this tree.
 */
export function feedbackRepo(config: ConfigService): string {
  const full = config.get<string>('FEEDBACK_REPO');
  if (full == null) throw new Error(FEEDBACK_REPO_UNSET);
  const id = Number(config.get<number>('FEEDBACK_REPO_ID'));
  return githubPrincipal()?.repositories.find(repo => repo.id === id)?.full_name ?? full;
}

/**
 * THE parser. Joi validates `GITHUB_ORGS` by running this, so the pattern and
 * the parser cannot disagree — a schema that accepted a string this read
 * differently would be the fifteen-copies problem again, in two copies.
 *
 * It refuses an empty list rather than returning one — including when the caller
 * is `githubOrgs` and the operator set `GITHUB_ORGS` to whitespace. An empty
 * list would have
 * to mean either "no org" or "any org" at every call site, and on a write pin
 * the second reading is a write into a stranger's repo. Neither is a thing an
 * operator can have meant, so the only safe answer is to fail.
 *
 * Joi rejects `''`, but `'   '`, `','` and `',,'` all validate clean against a
 * bare `Joi.string()` and parse to nothing — the same three values
 * `FEEDBACK_LABELS` had to be hardened against, for the same reason.
 *
 * It returns each org ONCE, folding case the way Github folds a login:
 * `acme,Acme` names one org and used to parse to two. A surface that
 * reads per org and SUMS the answers then counted that org twice — on Repos
 * every alert count and every Actions dollar doubled, and nothing on the page
 * said the list had repeated itself (#718). The spelling that survives is the
 * FIRST one the operator wrote, because that is what the surfaces display and
 * what `?org=` answers in. Deduplication cannot empty a list that had an org in
 * it, so the refusal above still stands behind every answer.
 */
export function parseGithubOrgs(raw: string | undefined | null): string[] {
  const seen = new Set<string>();
  const orgs = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((org) => {
      const folded = org.toLowerCase();
      if (seen.has(folded)) return false;
      seen.add(folded);
      return true;
    });
  if (orgs.length === 0) {
    throw new Error(
      'GITHUB_ORGS names no org, so no surface could say which org it serves and no write could ' +
        'say which org it may target. Set it to the org login(s) this board serves, ' +
        'comma-separated.',
    );
  }
  const bad = orgs.filter((org) => !ORG_LOGIN.test(org));
  if (bad.length > 0) {
    throw new Error(
      `GITHUB_ORGS must be comma-separated Github org logins (letters, digits and hyphens); ` +
        `these are not: ${bad.map((o) => JSON.stringify(o)).join(', ')}`,
    );
  }
  return orgs;
}

/**
 * Personal App owners in discovery order, or configured machine owners when
 * no request context exists. GITHUB_ORGS never caps a person's discovery.
 *
 * Throws on a key nobody set, and on a list that parses to nothing. Joi is the
 * first door and this is the second, because specs across the tree build a
 * `ConfigService` from a plain object and never see the schema at all — so a
 * rule that lived only in Joi would be absent from every test that matters.
 *
 * The two refusals are separate because they are separate mistakes: the first
 * says the setting exists and has to be added, the second says the value names
 * no organisation. Neither hands back a guess, which is what the default it
 * replaced did (#1175).
 */
export function githubOrgs(config: ConfigService): string[] {
  const person = githubPrincipal();
  if (person) return person.owners.map((o) => o.login);
  const named = config.get<string>('GITHUB_ORGS');
  if (named == null) throw new Error(GITHUB_ORGS_UNSET);
  return parseGithubOrgs(named);
}

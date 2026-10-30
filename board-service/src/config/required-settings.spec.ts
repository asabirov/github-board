import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { configValidationSchema } from './config.schema';
import * as settings from './github-orgs';
import { feedbackRepo, githubOrgs, parseGithubOrgs } from './github-orgs';
import { feedbackScopeFrom } from '../auth/feedback-visibility';

/**
 * Nothing here names an organisation or a repository when nobody has (#1175).
 *
 * A default is a promise that being silent is safe, and this repository cannot
 * keep that promise: it was not told when the organisation was renamed on
 * 2026-09-16, and it was not told when two
 * repositories were renamed on 2026-09-17. Both renames were invisible, and for
 * the same reason twice — Github REDIRECTS a repository path, so every read
 * addressed as `owner/name` carried on working while the defaults went stale
 * underneath. The organisation half surfaced a day late as three boot errors
 * (#1166). The repository half surfaced as `422 Validation Failed` on every
 * load of a search-backed surface, because the Github SEARCH API follows no
 * rename, and it was corrected by hand in the deployment.
 *
 * The severe case has not happened, and is why this is worth a boot refusal
 * rather than a warning: an organisation login is free the moment a rename
 * completes, and `FEEDBACK_REPO` decides which repository a person's words are
 * written into under the board's shared write token.
 *
 * So the three settings carry no default, and a deployment that needs one and
 * does not name it is refused at boot, by name. The refusal sentences are
 * pinned here rather than described, because a sentence that names the setting
 * to add is the whole of what an operator gets.
 */

/** A ConfigService built straight from an object, the way specs across this tree
 *  build one — never through the schema, so no Joi rule stands between the value
 *  and the reader. Joi is the first door; these readers are the second. */
const raw = (env: Record<string, unknown> = {}) => new ConfigService(env);

/** The keys a deployment must now name for the schema to validate at all, so a
 *  case about ONE of them is not answered by another's absence. */
const NAMED = { GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board' };

/** Everything `GITHUB_WRITE_ENABLED=true` already drags in with it (#774): the
 *  audit trail is Postgres, and a stamped-by-one-fake-person trail is refused. */
const WRITES_ON = {
  GITHUB_WRITE_ENABLED: 'true',
  BOOT_ALERT_ASSIGNEE: 'on-call',
  IDENTITY_SOURCE: 'db',
  AUTH_DISABLED: 'false',
  DATABASE_URL: 'postgresql://board:board@localhost:5432/board',
};

/** Validate an env, with every other required key filled in — and on a fixture
 *  board, so the stream's own rule is asked about only where it is the
 *  subject. An env of its own always wins. */
const validate = (env: Record<string, unknown>) =>
  configValidationSchema.validate({ ...NAMED, ISSUES_SOURCE: 'fixture', ...env }, { allowUnknown: true });

/** The message Joi reports for one key, or `''` when it reported nothing. */
const failure = (env: Record<string, unknown>): string =>
  configValidationSchema.validate(env, { allowUnknown: true, abortEarly: false }).error?.message ?? '';

describe('a board that names no organisation refuses to boot (#1175)', () => {
  it('the schema refuses an absent GITHUB_ORGS and names the setting to add', () => {
    const message = failure({ FEEDBACK_REPO: NAMED.FEEDBACK_REPO });
    expect(message).toContain('GITHUB_ORGS');
    expect(message).toContain('GITHUB_ORGS is not set');
    // The remedy, not just the complaint: an operator reading this has to know
    // what to type. No example org login appears in it — an example that names a
    // real organisation is the same stale promise one layer down.
    expect(message).toMatch(/comma-separated/);
  });

  it('the reader refuses it too, so a ConfigService that never met the schema fails the same way', () => {
    // Every spec in this tree builds a ConfigService from a plain object, so a
    // rule that lived only in Joi would be absent from every test that matters.
    expect(() => githubOrgs(raw({}))).toThrow(/GITHUB_ORGS is not set/);
  });

  it('absent and empty are different sentences, because they are different mistakes', () => {
    // A key nobody set is a deployment that never mentioned the setting. A key
    // set to whitespace is somebody's value, and `parseGithubOrgs` has refused
    // that since #647 on exactly this reasoning. Both refuse; they say different
    // things, because "add this setting" and "this value names no org" are
    // different things to do next.
    expect(() => githubOrgs(raw({}))).toThrow(/GITHUB_ORGS is not set/);
    expect(() => githubOrgs(raw({ GITHUB_ORGS: '  ' }))).toThrow(/names no org/);
    expect(() => parseGithubOrgs('  ')).toThrow(/names no org/);
  });

  it('no refusal offers an organisation or a repository as an example', () => {
    // The refusal is what an operator copies from. A worked example naming a
    // real organisation would be a default in prose: silent, stale after the
    // next rename, and this time typed in by hand.
    //
    // The sentences are taken off the MODULE rather than listed here, because a
    // list is one sentence behind the moment a fifth is written. Until #1175
    // round 2 this test read three messages the schema and the parser happened
    // to raise, and neither `FEEDBACK_REPO_UNSET` nor `BOOT_ALERT_REPO_UNSET`
    // was among them: an example could be put in either and the whole of
    // `src/config` stayed green. Those two are the ones that decide where a
    // person's words are written and where the board reports on itself.
    for (const [name, sentence] of refusalSentences()) {
      expect(sentence, `${name}: ${sentence}`).not.toMatch(
        /acme|globex|octocat|example\.com/,
      );
    }
  });

  it('the ban reaches every refusal this module exports, not a list of them', () => {
    // Without this the check above could go quiet: an export renamed out of the
    // `_UNSET` shape, or a module that stopped exporting, would ban nothing and
    // report a clean tree. The three are the three settings #1175 took the
    // defaults off.
    const covered = refusalSentences().map(([name]) => name);
    expect(covered).toEqual([
      'BOOT_ALERT_REPO_UNSET',
      'FEEDBACK_REPO_UNSET',
      'GITHUB_ORGS_UNSET',
      'githubOrgs on an absent key',
      'parseGithubOrgs on a list that names none',
      'parseGithubOrgs on a login that is not one',
      'the schema, every refusal it raises at once',
    ]);
  });

  it('a board that names one still boots, and serves exactly it', () => {
    const { error, value } = validate({ GITHUB_ORGS: 'globex' });
    expect(error).toBeUndefined();
    expect(githubOrgs(new ConfigService(value))).toEqual(['globex']);
  });
});

/**
 * Every sentence this board can refuse a boot with, named.
 *
 * The three exported constants are read off the module by their shape rather
 * than listed, so a fourth refusal is covered the day it is written. The three
 * thrown ones are not constants — they are built at the throw — so they are
 * named here, and the schema's own message is included whole because it is what
 * an operator meets in the deploy log.
 */
function refusalSentences(): [string, string][] {
  const exported = Object.entries(settings)
    .filter((entry): entry is [string, string] => entry[0].endsWith('_UNSET') && typeof entry[1] === 'string')
    .sort(([a], [b]) => a.localeCompare(b));
  return [
    ...exported,
    ['githubOrgs on an absent key', catchMessage(() => githubOrgs(raw({})))],
    ['parseGithubOrgs on a list that names none', catchMessage(() => parseGithubOrgs('  '))],
    ['parseGithubOrgs on a login that is not one', catchMessage(() => parseGithubOrgs('not a login'))],
    ['the schema, every refusal it raises at once', failure({})],
  ];
}

/** The message a thrown call carried, for a check that reads the words rather
 *  than only that it threw. */
function catchMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected a refusal, and the call returned');
}

/**
 * `FEEDBACK_REPO` is required with no condition on it.
 *
 * The old feedback form filed submissions into this repository. The form is
 * removed (#1450), but its issues stay on Github, and no flag gates these reads:
 *
 *  - `feedbackScopeFrom` is called in the constructors of `ProjectsService`,
 *    `ReposService`, `IssuesCacheService`, `IssuesMetricsService` and
 *    `IssueDetailService`, on every boot, whatever any flag says. It is the
 *    rule that decides which issue is somebody's feedback submission, and a
 *    static agent token reads `HIDDEN_FEEDBACK_TITLE` instead of their sentence
 *    because of it.
 *  - `GithubDestinationBootstrap` resolves its repository ID.
 *
 * So there is no state of this board in which the key is unread, and an absent
 * one cannot mean "no feedback repository": it would mean the visibility rule
 * matches no issue, and every submission's first line — which is the person's
 * own sentence — becomes an ordinary title on the queues. That is the widening
 * direction, and it is the direction #497 and #516 exist to close.
 */
describe('a board that names no feedback repository refuses to boot (#1175)', () => {
  it('the schema requires it', () => {
    expect(failure({ GITHUB_ORGS: NAMED.GITHUB_ORGS })).toContain('FEEDBACK_REPO is not set');
  });

  it('the scope reader refuses it, and says what would go wrong', () => {
    expect(() => feedbackScopeFrom(raw({}))).toThrow(/FEEDBACK_REPO is not set/);
    // The value-shaped refusal that predates this one still stands: a key set to
    // something that is not `owner/name` is somebody's value, not an omission.
    expect(() => feedbackScopeFrom(raw({ FEEDBACK_REPO: 'board' }))).toThrow(
      /must be "owner\/name"/,
    );
  });

  it('one reader answers for every surface that asks', () => {
    // Five sources read this key. They read it through one function, so a board
    // cannot file feedback into one repository and hide submissions from
    // another.
    expect(feedbackRepo(raw({ FEEDBACK_REPO: 'globex/board' }))).toBe('globex/board');
    expect(() => feedbackRepo(raw({}))).toThrow(/FEEDBACK_REPO is not set/);
  });

  it('a board that names one boots', () => {
    expect(validate({}).error).toBeUndefined();
    expect(feedbackScopeFrom(raw(NAMED))).toEqual({
      owner: 'acme',
      repo: 'board',
      labels: ['feedback'],
    });
  });
});

/**
 * `BOOT_ALERT_REPO` is required when the board can write to Github.
 *
 * The switch is `GITHUB_WRITE_ENABLED`, not a flag of its own:
 * `reportBootErrors` returns before anything else unless writes are on and a
 * credential exists. There is no `BOOT_ALERT_ENABLED`, and the notifier's own
 * comment used to say the feature needed no environment key because it
 * defaulted to this board's repository — which is the promise #1175 is here to
 * withdraw.
 */
describe('a board that can write names where a bad boot reports (#1175)', () => {
  it('is required when GITHUB_WRITE_ENABLED is true', () => {
    const writesOn = { ...NAMED, ...WRITES_ON };
    expect(failure(writesOn)).toContain('BOOT_ALERT_REPO is not set');
  });

  it('is absent-and-fine when writes are off, which is the default', () => {
    const off = validate({ GITHUB_WRITE_ENABLED: 'false' });
    expect(off.error).toBeUndefined();
    expect(off.value.BOOT_ALERT_REPO).toBeUndefined();
    expect(validate({}).value.BOOT_ALERT_REPO).toBeUndefined();
  });

  it('a writing board that names one boots', () => {
    const { error } = validate({ ...WRITES_ON, BOOT_ALERT_REPO: 'globex/board' });
    expect(error).toBeUndefined();
  });
});

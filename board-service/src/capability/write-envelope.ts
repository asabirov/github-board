import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Capability } from './capability';
import type { CapabilityRegistry } from './capability.registry';
import type { RefusalBody } from './github-refusal';
import type { OwnerWritability } from '../repos/repo.types';

const logger = new Logger('WriteEnvelope');

/** What Github lets a repository be called: letters, digits, dot, dash,
 *  underscore. This write addresses the repo as a URL PATH SEGMENT rather than
 *  a JSON value, so the rung has to reject anything a path resolver would read
 *  as structure — `/`, `\\`, `%2e%2e`, `?`, `#` — and `.`/`..` besides, which
 *  match the character class but name a directory rather than a repo.
 *
 *  ASCII-only is LOAD-BEARING for a second rung a reader would not guess at:
 *  `targetKey` in `capability.registry.ts` lowercases the target half, and
 *  U+212A KELVIN SIGN — the one code point above ASCII whose `toLowerCase()`
 *  lands in this charset — folds to `k`. Admit it here and `acme/{U+212A}it`
 *  and `acme/kit` become one capability key, so a refusal on one darkens
 *  the other. Widening this class means fixing that fold first. */
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

/** The rung itself, in one place, because all three subjects run it — the repo
 *  subject on `name`, both issue subjects on `repo`. Copies of a character class
 *  are a thing to keep in sync, and the branch that drifted would be the soft
 *  one. `guardWrite` reads the name into `repoName` once and calls this once, so
 *  a fourth subject cannot arrive holding a name nothing checked. */
const isRepoName = (s: string): boolean => REPO_NAME.test(s) && s !== '.' && s !== '..';

/**
 * What is being written to, and it is a discriminated union rather than an
 * options bag so the compiler holds the pairing the capability rung depends on.
 *
 * An issue subject MUST carry its `repo`: `name` is the issue NUMBER there, and
 * a target built out of the number would address a string no producer has ever
 * recorded. That failure is invisible at runtime — a rung that matches nothing
 * throws nothing and every test still passes — so it is worth a type that makes
 * an issue subject without a repo fail to compile.
 */
export type IssueSubject = { kind: 'issue'; owner: string; repo: string; name: string; email?: string };
export type RepoSubject = {
  kind: 'repo';
  owner: string;
  name: string;
  login?: string | null;
  email?: string;
};
export type WriteSubject = IssueSubject | RepoSubject;

/**
 * The already-read config EVERY write is gated on, whatever it writes to. The
 * caller reads it; this file reads no config of its own, and that is what let one
 * envelope serve routes that deliberately pinned on DIFFERENT config keys — the
 * issue routes on `PROJECTS_OWNER`, the `dri` route on `ISSUES_METRICS_ORG`.
 * Both keys are retired (#1209 part 4) and every caller now resolves the same
 * owner scope, so there is nothing left for the envelope to pick between.
 * `allowedOwners` stays an argument: a file that read the scope itself would be
 * a second derivation of it, which is the shape #649 merged to remove.
 *
 * A LIST since #649, and membership replaced equality — a board serving two orgs
 * has two orgs a write may legitimately target. It is a plain required field
 * rather than a singular one with an optional plural beside it: two fields
 * holding one rule means the optional one can be forgotten, and the one that
 * gets forgotten is the one that fails open.
 *
 * An EMPTY list refuses everything, which is the only safe reading: #618's
 * constraint on this work is that an allow-list may only ever NARROW what the
 * credential already reaches, so a list naming nothing has to land on the
 * refusing side. The rung below is written so that falls out of `some()` rather
 * than out of a special case somebody could delete as redundant.
 */
interface WriteEnvCommon {
  allowedOwners: string[];
  writesEnabled: boolean;
  /** What the board has learned Github refuses it, and which capability this
   *  route is exercising. REQUIRED, both of them (#584, PR #609 review): while
   *  they were optional, a new write route could call `guardWrite` with just
   *  `{allowedOwners, writesEnabled}`, compile, typecheck, pass every spec in
   *  this repository and silently skip the capability rung — which is exactly
   *  the "a route omits a rung by forgetting" shape this issue's first
   *  Definition-of-Done item is written against. `writes-declared.spec.ts` gates
   *  the decorator half; the compiler gates this one. Every caller already
   *  passed both, so requiring them changed no behaviour. */
  registry: CapabilityRegistry;
  capability: Capability;
  /** `CAPABILITY_GUARD_ENFORCING`. Absent reads as `true`: an env this rung
   *  cannot read must not read as reporting mode. */
  enforcing?: boolean;
}

/** An issue route's env, and it carries the two repo-only fields NOT AT ALL
 *  rather than optionally. An issue subject has no `dri` schema to read, so a
 *  route that passed one would be describing a rung that cannot run. */
export type IssueWriteEnv = WriteEnvCommon;

/**
 * A repo route's env: the same fields plus the two the `dri` schema produces,
 * both REQUIRED (#584, PR #609 re-review).
 *
 * They were optional on one shared env until that re-review, and `writability`
 * fails OPEN when it is missing — an absent one is read as "no such schema
 * here" and skips every #577 rung. So a new repo write route written as
 * `guardWrite({kind:'repo', …}, {allowedOwners, writesEnabled, registry,
 * capability})` compiled clean and silently lost the two 403s and the two 502s.
 * That is the same omit-a-rung-by-forgetting shape the required
 * `registry`/`capability` above closed, left standing on the branch where it
 * fails open. The compiler holds it now, the way it already holds the subject
 * union: `guardWrite` is overloaded, and a repo subject demands this env.
 *
 * (Dated against the CHANGE — an issue, a PR, a branch — and never against
 * "this commit", which is what three of the sentences in this file used to say.
 * "This commit" is true only where the sentence sits in history: a rebase, a
 * commit split, or a fix round landing in between falsifies it while nobody
 * touches the words, and it reads exactly as fluently once it is false. A
 * change has a name that travels with it; a position does not.)
 */
export interface RepoWriteEnv extends WriteEnvCommon {
  /** The `dri` property's own allowed values, so an out-of-range owner is our
   *  400 and not Github's 422. */
  allowed: string[];
  /** What the `dri` schema said — including that it did not answer. Every state
   *  but `writable` refuses the write; `restricted` and `absent` are facts the
   *  board actually read, and only those two are permanent (#577, #649). */
  writability: OwnerWritability;
}

/** The implementation's view, and internal on purpose: it is the one place the
 *  two repo-only fields are optional, because the body has to ask whether a
 *  subject brought them. No caller can reach this shape — the overloads below
 *  are the whole public surface. */
type AnyWriteEnv = WriteEnvCommon & Partial<Pick<RepoWriteEnv, 'allowed' | 'writability'>>;

/**
 * Validate a write request against the fail-closed envelope every write route
 * on this board shares (#384, mirrored for repos at #558, merged to one at
 * #584). Returns the parsed positive issue number for an `issue` subject and
 * `null` for the two that have no number to parse, or throws the mapped Nest
 * exception. Pure but for the
 * registry it is handed — the caller passes already-read config and the acting
 * email, so it unit-tests directly, no DOM and no Nest required.
 *
 * OVERLOADED, one per subject, so the compiler pairs each subject with the env
 * its rungs need: a repo subject demands `allowed` and `writability`, and the
 * two issue envs cannot carry them at all. See `RepoWriteEnv` for what was open
 * while both were optional on one shared type.
 *
 * Order matters, and it is one order for all three subjects — each simply skips
 * the rungs it has no input for, rather than running a different ladder:
 *
 *   owner-pin (404) → repo name, then issue number (400) → writes-enabled (503) →
 *   `writability` (one exhaustive switch: `restricted` 403, `absent` 403,
 *   `unreadable` 502, `unknown` 502, anything unnamed 502) →
 *   login against `allowed` (400) → target capability (403) → session (401)
 *
 * The owner-pin is FIRST and answered with 404, never revealing the constraint,
 * so the shared token can only ever mutate things inside the orgs the board
 * mirrors — even for a malformed request. It is a membership test against
 * `allowedOwners` since #649, and an empty list admits nobody. Answering the
 * name first would tell an off-org caller that the name was the problem, which
 * says the org was not.
 *
 * The schema rungs sit BEFORE the login check on purpose: the allowed values
 * come out of the same read, so a schema that did not answer leaves an empty
 * list, and judging a login against it would refuse the login for a reason the
 * board invented.
 *
 * ## What the schema rung does and does not catch
 *
 * It reads the ORG'S SETTING on the `dri` property. It cannot see the token's
 * scopes, and it would NOT have caught #577: this org records
 * `org_and_repo_actors`, so the rung evaluates `writable` and passes. The
 * board's own permission is checked in two other places, and this rung is
 * neither of them — `CapabilityGuard` answers it credential-wide one layer up,
 * from the route alone, and the target-capability rung below answers it for
 * this owner and this repo, which is the half a guard cannot see. What fixed
 * #577 was the endpoint itself plus `classifyGithubError` mapping Github's
 * answer instead of letting an Octokit error become a 500, and the write path
 * has to stay able to fail well whatever these three rungs believe.
 *
 * What the schema rung is for is the case the board CAN answer from the org's
 * own settings: an org that restricts the property, where every write would be
 * refused and the surface should not be offering one at all.
 *
 * The four refusing states are kept apart all the way out to the person at the
 * control, because a status is a promise about whether to try again (#649):
 *
 * - `restricted` — the org's schema says a repo actor may not set the property.
 *   Read, permanent, 403.
 * - `absent` — the org's schema list was read and has no `dri` property at all.
 *   Read, permanent, 403, and its own message: a person told "Github does not
 *   allow this" goes looking for a permission, where the actual fix is to
 *   create the property. It answered 502 until this change — a retry-shaped
 *   status for a condition no retry alters.
 * - `unreadable` — the read never arrived, which says nothing about the org's
 *   settings and may well be a blip. 502, the status this board already uses
 *   for "Github could not be reached", and the one a retry is for.
 * - `unknown` — the schema was read and `values_editable_by` held a value this
 *   board does not recognise. Also nothing known, also 502.
 *
 * Collapsing any of them would have the board state a cause it never read, or
 * offer a retry that cannot work. And a state named by NONE of them refuses
 * too: the switch below passes only what it names, so the default is refuse.
 */
export function guardWrite(subject: IssueSubject, env: IssueWriteEnv): number;
export function guardWrite(subject: RepoSubject, env: RepoWriteEnv): null;
export function guardWrite(subject: WriteSubject, env: AnyWriteEnv): number | null {
  // Owner-pin FIRST and answer 404 (never reveal the constraint), so the shared
  // token can only ever mutate things inside the orgs the board mirrors.
  //
  // Case-insensitive on BOTH halves, because Github resolves owners that way and
  // a re-cased member of the list is the same org. An empty list matches nothing
  // and so refuses everything — see `WriteEnvCommon.allowedOwners` for why that
  // is the direction this has to fall.
  const owner = subject.owner.toLowerCase();
  if (!env.allowedOwners.some((o) => o.toLowerCase() === owner)) {
    throw new NotFoundException(missing(subject));
  }

  // WHERE THE REPO NAME LIVES is the one thing the two subjects disagree on:
  // a repo subject is named by `name`, and an issue subject carries the repo
  // beside a `name` that means something else. Read once,
  // here, and every rung below addresses the same string — the character rung,
  // the capability target key and the 404 body cannot drift apart because there
  // is nothing left to keep in sync (#584, PR #609 review). It was two copies of
  // the rung until that review, and the branch that would have drifted is
  // whichever one a new subject forgot to add itself to.
  //
  // BOTH SENTENCES BELOW REACH A SCREEN, which is why neither names a field any
  // more. Every write on this board comes through here, and the two that print
  // the service's own 400 word for word — the comment composer and the
  // new-project dialog — take their owner, repo and number straight out of the
  // address, so a mistyped or stale URL is exactly how a person meets one. They
  // read `repo name must be a Github repository name, not a path` and `issue
  // number must be a positive integer` until #1056: the shape of a schema
  // complaining about its input, in front of somebody who had just pressed Send
  // on a comment they had written.
  const repoName = subject.kind === 'repo' ? subject.name : subject.repo;
  if (!isRepoName(repoName)) {
    throw new BadRequestException('This page’s address does not name a repository on GitHub.');
  }

  let n: number | null = null;
  if (subject.kind === 'issue') {
    n = Number(subject.name);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BadRequestException('This page’s address does not name an issue.');
    }
  }

  if (!env.writesEnabled) {
    const what = subject.kind === 'repo' ? 'Repo' : 'Issue';
    throw new ServiceUnavailableException(`${what} writes are disabled (GITHUB_WRITE_ENABLED).`);
  }

  // The writability rung runs only where there IS a schema — the `dri` route.
  // A missing `writability` field is "no such schema here", never a state.
  //
  // A SWITCH, and not the chain of `if`s this was until the #649 security
  // review, because the chain's default was to WRITE: it named the states that
  // refuse and let anything it did not name fall through to Github. `writable`
  // passed by matching nothing, so a sixth member of `OwnerWritability` would
  // have been indistinguishable from it — refusing nothing, logging nothing,
  // sending the write. The union went from three states to five on this branch,
  // one commit before this switch, which is the exact motion that shape cannot
  // survive.
  //
  // Here the states that may pass are NAMED, everything else refuses, and the
  // `never` binding in `default` fails to compile the day the union grows —
  // so the choice is made at the keyboard rather than discovered in prod.
  switch (env.writability) {
    // No schema on this route at all: the issue subjects, which have no `dri`
    // to be gated on. Not a state, and not a refusal.
    case undefined:
    // The one state that lets a write out.
    case 'writable':
      break;
    case 'not-applicable':
      throw new ForbiddenException('Repository dri is not applicable to a personal owner.');
    case 'restricted':
      // One definitive answer now, not three: the org keeps the property to its
      // owners. The other two have their own cases here.
      throw new ForbiddenException(`GitHub does not allow this board to set a repo's dri.`);
    case 'absent':
      // Names the actual cause, because the actual fix is different: there is no
      // dri property in this org to set. Permanent — a retry changes nothing, and
      // creating the property is an org-owner's job, not this board's.
      //
      // Names the TARGET org — `subject.owner`, the org this write was aimed at
      // and the one whose schema was read. It interpolated the configured pin
      // instead until #649, which read the same only because the pin was a
      // single org the rung above had already forced `subject.owner` to equal.
      // The pin is a SET now: it has no single name to put in a sentence about
      // one org, and the target does.
      throw new ForbiddenException(`The ${subject.owner} org has no dri property, so there is nothing to set.`);
    case 'unreadable':
    case 'unknown':
      // Deliberately claims nothing about the org's settings — the board did not
      // read them. It says only what it knows: it could not check, so it did not
      // write.
      throw new BadGatewayException(
        `The dri property's settings could not be read from GitHub, so this write was not sent.`,
      );
    default: {
      // Unreachable while the union and the cases above agree, and `undecided`
      // is what makes the compiler prove they do. The throw is what happens if
      // one ever ships anyway: a state nobody decided about is a state the board
      // knows nothing by, so it refuses like any other non-answer.
      const undecided: never = env.writability;
      // Logged, not just refused: a state that reaches here is a state someone
      // added to the union and no rung claimed, and the log line is how that
      // gets found. It also keeps `undecided` load-bearing at runtime, so the
      // compile-time gate cannot be deleted as an unused binding.
      logger.warn(`Refusing a repo write: writability ${String(undecided)} matches no rung.`);
      throw new BadGatewayException(
        `The dri property's settings could not be read from GitHub, so this write was not sent.`,
      );
    }
  }

  // Runs for EVERY repo subject, never on the presence of `login`. An empty
  // body arrives as `undefined`, `undefined !== null`, and no allowed list
  // contains it — so an empty body 400s exactly as it does today. A rung
  // skipped when `login === undefined` would silently start accepting one.
  if (subject.kind === 'repo') {
    const login = subject.login;
    if (login !== null && !(env.allowed ?? []).some((a) => a === login)) {
      throw new BadRequestException(`login must be one of the dri property's allowed values`);
    }
  }

  // #584 — the half of the capability check the guard cannot do. CapabilityGuard
  // reads the ROUTE and refuses on a credential-wide verdict; here the owner and
  // the repo are arguments, so a refusal the board learned about THIS target can
  // finally be enforced. `unknown` refuses nothing, as everywhere else.
  //
  // `repoName` above is what makes this rung address the thing producers keyed
  // their refusals on, and reading it per-subject is the whole correctness here.
  // For a repo subject `name` IS the repo. For an issue subject `name` is the
  // issue NUMBER, so `${owner}/${name}` would be `acme/42` — a string no
  // producer has ever recorded — and every target-scoped refusal on the nine
  // issue routes would be a silent no-op.
  //
  // `CAPABILITY_GUARD_ENFORCING` is ONE switch, and reporting mode means the
  // same thing at both layers: when it is off this rung logs what it would have
  // refused and lets the write land, exactly as `CapabilityGuard.deny` does.
  // The rest of the envelope is untouched by it — none of those rungs is what
  // task 8 switched on.
  // Unconditional, and the `if (env.registry && env.capability)` that used to
  // wrap it is gone with the optionality: a rung a caller can skip by leaving a
  // field out is a rung that fails silently, and the compiler is a better guard
  // than a truthiness test that reads as deliberate.
  const target = `${subject.owner}/${repoName}`;
  const v = env.registry.state(env.capability, target);
  if (v.state === 'refused') {
    const enforcing = env.enforcing ?? true;
    if (!enforcing) {
      logger.warn(`Capability would have been refused: ${env.capability} on ${target}`);
    } else {
      const body: RefusalBody = {
        message: v.publicMessage ?? 'The board is not permitted to do this.',
        reason: v.reason ?? 'not-permitted',
      };
      if (v.authorizeUrl) body.authorizeUrl = v.authorizeUrl;
      throw new ForbiddenException(body);
    }
  }

  if (!subject.email) throw new UnauthorizedException('No session');
  return n;
}

/** The 404 an off-org request gets. It names what was asked for and nothing
 *  about why it was refused. */
function missing(subject: WriteSubject): string {
  if (subject.kind === 'issue') return `issue ${subject.owner}/${subject.repo}#${subject.name} not found`;
  return `repo ${subject.owner}/${subject.name} not found`;
}

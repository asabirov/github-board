/**
 * The signed-in user, resolved to a display name (#206). The session carries an
 * email and, since #520, the Github handle the roster maps it to (fetchMe →
 * {email, isAdmin, canWrite, githubLogin, capabilities}); this composes it with
 * the People table to get a real display name for the "Your work" greeting.
 * A miss degrades to the email's local part — never a blank or a guess.
 */

import { useIdentity } from './auth/identity-context';
import type { Me as Identity } from './auth/session-state';
import type { MeResponse, OrgReadState } from './api/types';
import type { Person } from './api/people';
import { resolvePerson, usePeople } from './people-ctx';

export interface Me {
  github?: MeResponse['github'];
  email: string;
  isAdmin: boolean;
  /** Display name — the resolved person's, else the email local part. */
  name: string;
  /** May write at all (#626): human session + writes enabled server-side. The
   *  half every surface composes with its own key in `capabilities`, which is
   *  what `mayWrite` below does — nothing reads this field directly. */
  writesEnabled: boolean;
  /**
   * The ISSUE editor's whole set, composed (#384, #626): `writesEnabled` AND no
   * capability that editor writes refused. Nothing reads it. Nothing should.
   *
   * It is kept because the server sends it and because it is the honest name for
   * that composition — not because a surface is meant to gate on it. Gating on it
   * IS #635: one refused `issue.labels` collapses the whole set to false, and any
   * control reading it goes dark over a refusal that was never about it. That took
   * the repos page's owner picker and the feedback form's send off the screen while
   * their own capabilities still read `available` and their writes would have landed;
   * inside the issue editor it darkened eight controls to withhold one.
   *
   * So a surface asks about the ONE write it makes: `mayWrite(me, capability)`, and
   * `issueControlVerdict` for a draw. A ninth editor control
   * added here asks `mayWrite` with its own `@Writes(...)` name, and adding it to
   * `ISSUE_CAP` is what puts it in this set — never the other way round.
   *
   * Reading this field is how #635 comes back, and a check stands over that now
   * rather than this sentence: `use-me.spec.ts`, "#635 — no surface reads
   * `canWrite` off the session". It scans every production source file and fails
   * naming the path, so a read added here is caught by `pnpm test` and not by a
   * reviewer's memory. `use-me.ts`, `api.ts`, `me-fixture.ts` and the specs are
   * its allowlist — this declaration, the wire narrowing, the fixture that
   * derives the field the way the server does, and the tests that assert the
   * composition.
   *
   * It is not exhaustive, and reading it as exhaustive is worse than assuming
   * there is nothing: it matches the SHAPES a session read takes — `me.canWrite`,
   * `me?.canWrite`, `me["canWrite"]`, a destructure annotated `Me` or taken off a
   * `me` expression — because a bare `canWrite` is also the name of a local prop
   * `src/repos/**` passes down four components, and a guard that fired on that
   * would earn a directory-wide exemption in the one place the collapse actually
   * happened. So a destructure off a differently-named, un-annotated variable
   * holding a `Me`, and a read through an index signature, both go through. The
   * spec lists its misses beside the shapes; that list is the honest edge of
   * this rule, and the sentences above it are still the reason.
   */
  canWrite: boolean;
  /** Who this account is on Github (#520), null when the roster maps nobody. */
  githubLogin: string | null;
  /** What the board's Github credential is known to be able to do (#584), per
   *  capability. `mayWrite` below is the only reader, and since task 8 the
   *  server reports real verdicts here rather than `unknown` for everything,
   *  so a `refused` can now reach the browser and withhold a control. */
  capabilities: Record<string, string>;
  /** Which Github orgs the board could read this ingest (#650), carried through
   *  from /me untouched. `[]` is "no claim", never "every org is fine" — see
   *  `MeResponse.orgs`, where that reading is argued. */
  orgs: OrgReadState[];
}

/**
 * May this session use the control that performs this named write (#635)? The
 * key is the one board-service's `@Writes(...)` decorator gives the write —
 * `repo.dri`, `issue.labels`, and so on. Both halves have to be true: a human
 * session on a deployment where writes are on (`writesEnabled`), and a board
 * credential that has not already been refused this capability (#584).
 *
 * The session half is `writesEnabled` and never `canWrite` (#626). The two are
 * one calculation read twice: `writesEnabled` is the session and the config,
 * `canWrite` is that AND no capability the ISSUE editor writes refused. So
 * `canWrite` carries all nine issue refusals, and reading it here would have
 * taken an unrelated control — the repos page's owner picker, the feedback
 * form's send — off the screen the moment a credential-wide `issue.labels`
 * refusal landed, while its own capability still read `available` and its write
 * would have gone through. That is the defect #635 exists to remove, and
 * reading `canWrite` here is how it comes back.
 *
 * It is the right half for the issue editor's own controls too, and strictly
 * better than what they had: composing `writesEnabled` with `issue.labels`
 * quiets the one facet that was refused, where `canWrite` quiets all nine.
 *
 * Nor is the session half redundant beside the capability. A `board:read` PAT
 * actor is refused at the guard and a switched-off GITHUB_WRITE_ENABLED at the
 * envelope — neither leaves a capability refusal behind, so a control gated on
 * the map alone would be drawn over a write that 403s.
 *
 * Everything that is not `refused` draws the control — `available`, `unknown`,
 * and a key the map does not carry. `unknown` draws it because an unattempted
 * capability is not a refusal, and withholding a control on one would be the
 * same lie as offering a control that cannot work, in the other direction.
 * Tightening this to `=== 'available'` is the tempting mistake: after a restart
 * every capability reads `unknown`, so it would empty the board of controls on
 * a credential that has been refused nothing.
 *
 * An old board-service sends no map at all, which `api.ts` reads as `{}` for
 * the reason it states there: the board knows nothing about what it may do, and
 * knowing nothing refuses nothing. Reading an absent key as a refusal would
 * withhold every control on such a deploy.
 *
 * Enforcement is the server's — the write envelope refuses regardless of what
 * the surface drew. This decides only whether offering the control is honest.
 */
export const mayWrite = (me: Me | null, capability: string): boolean =>
  (me?.writesEnabled ?? false) && me?.capabilities?.[capability] !== 'refused';

/**
 * The session response plus the People table, as the app reads it.
 *
 * `githubLogin` is the server's answer, carried through untouched. The People
 * table answers a different question — who is on the roster — and a card that
 * happens to share this address must not overrule what /me said about the
 * signed-in account.
 */
export function composeMe(raw: Identity, people: Person[]): Me {
  const person = resolvePerson(people, null, raw.email);
  return {
    email: raw.email,
    github: raw.github,
    isAdmin: raw.isAdmin,
    name: person?.displayName ?? raw.email.split('@')[0],
    writesEnabled: raw.writesEnabled ?? false,
    canWrite: raw.canWrite ?? false,
    githubLogin: raw.githubLogin ?? null,
    capabilities: raw.capabilities ?? {},
    orgs: raw.orgs ?? [],
  };
}

export function useMe(): { me: Me | null; loading: boolean } {
  const people = usePeople();
  const raw = useIdentity();
  return { me: raw ? composeMe(raw, people) : null, loading: raw === null };
}

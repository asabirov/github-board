import { githubPrincipal } from '../auth/github-principal';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PEOPLE_ALIASES, githubLoginFor } from '../people/people-aliases';
import { DerivedLoginsService } from './derived-logins.service';
import { IDENTITY_REPOSITORY, IdentityRecord, IdentityRepository } from './identity.repository';
import { TeamRoster, mergeRoster } from './team-roster';

/** Answers null for everybody. Lets the call sites that predate #535 construct
 *  the resolver with one argument, and makes "no derivation configured" a real
 *  state rather than an undefined check on every read. */
const NO_DERIVED_LOGINS: Pick<DerivedLoginsService, 'loginFor'> = { loginFor: () => null };

/** How long the reverse map may lag a change that arrives by neither an admin
 *  edit nor a "Sync now" — both of those drop it outright. */
const ROSTER_TTL_MS = 60_000;

/**
 * THE answer to "which Github handle belongs to this address" (#520).
 *
 * The board used to have two, and they were different stores. The roster cell an
 * admin edits on the Access page is the identity store; "Your work" resolved the
 * same fact from `PEOPLE_ALIASES`, the table compiled into the build. So
 * correcting somebody's handle in the admin screen changed the write gate and
 * changed nothing about the page that person opens — fixing attribution meant
 * editing a file and shipping a deploy.
 *
 * Precedence, the same shape member roles already use (#332: board-assigned
 * wins, static default underneath):
 *
 *   1. the roster — a handle stored against the address wins, no deploy needed
 *   2. the checked-in table — the answer when the roster has none
 *   3. commit authorship — derived, and reached only when neither store claims
 *      the address (#535), so nobody who resolved before it existed can change
 *      answer
 *
 * A roster ROW answers for the person it owns, cleared handle included (#540).
 * Only an absent row falls through to the file. The two used to be one null, so
 * an admin who cleared a handle got the file's answer straight back and the
 * board went on attributing work to a handle the Access page said was gone.
 * Somebody the roster has never heard of still resolves through the file, so
 * nobody loses attribution to this, and a fresh database — which seeds itself
 * from the same file — behaves identically before and after its seed.
 *
 * With no database (IDENTITY_SOURCE != db) the store IS the file, so every
 * answer here is the file's, exactly as before.
 */
@Injectable()
export class GithubLoginResolver {
  private readonly logger = new Logger(GithubLoginResolver.name);
  private roster: { at: number; roster: TeamRoster } | null = null;
  // Single-flight: concurrent callers share ONE table read rather than each
  // starting their own — the same shape PrismaIdentityRepository.seeding and
  // ReposService.inFlight already use.
  private inFlight: Promise<TeamRoster> | null = null;
  /** Moves on every invalidation — see `rosterGeneration()`. */
  private generation = 0;

  constructor(
    // Explicit token — tsx/esbuild emit no design:paramtypes metadata, so an
    // undecorated param crashes the compiled boot.
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    // Defaulted, so the call sites that predate #535 keep constructing this with
    // one argument. Safe ONLY because this class is `useFactory`-provided
    // (identity.module.ts), so Nest never reads its paramtypes; @Optional() keeps
    // the default honest if it is ever listed in a plain `providers` array.
    @Optional()
    @Inject(DerivedLoginsService)
    private readonly derived: Pick<DerivedLoginsService, 'loginFor'> = NO_DERIVED_LOGINS,
  ) {}

  /** The Github handle for `email` across all three tiers, or null. */
  async forEmail(email: string): Promise<string | null> {
    const person = githubPrincipal();
    if (person && person.email === email.toLowerCase()) return person.login;
    return (await this.resolve(email)).login;
  }

  /**
   * The handle somebody actually TYPED — roster row, then checked-in table, and
   * nothing else.
   *
   * `board_whoami` reports this rather than `forEmail`, so the MCP surface is
   * never told an identity the board inferred (#535), and `AdminAccessService`
   * computes `derivedRole` from it so a guess cannot move a person from reader
   * to writer on a field the Access panel presents as their effective role.
   */
  async typedLoginFor(email: string): Promise<string | null> {
    const { login, source } = await this.resolve(email);
    return source === 'derived' ? null : login;
  }

  private async resolve(
    email: string,
  ): Promise<{ login: string | null; source: 'roster' | 'table' | 'derived' | null }> {
    if (!email?.trim()) return { login: null, source: null };
    // Presence, not `??`. A row with a null handle is the roster answering
    // "this person has none", and `??` would have read it as silence (#540).
    // That is also what stops derivation from re-asserting a handle an admin
    // deliberately cleared.
    const row = await this.fromRoster(email);
    if (row) return { login: row.githubLogin, source: row.githubLogin ? 'roster' : null };

    const fromTable = githubLoginFor(email);
    if (fromTable) return { login: fromTable, source: 'table' };

    // Third tier (#535). A pure memory read — see DerivedLoginsService on why it
    // is not async and must never become so.
    const derived = this.derived.loginFor(email);
    return derived ? { login: derived, source: 'derived' } : { login: null, source: null };
  }

  /**
   * The reverse direction: login → name, plus the logins the board claims as its
   * team (#541). Same two sources as `forEmail`, merged under the two precedence
   * rules in `team-roster.ts`.
   *
   * Memoised, and ONLY this direction is. `forEmail` answers "who am I" on the
   * app's mount probe and is the path an admin's correction has to show up on
   * immediately — #520's whole point was taking the deploy out of that loop, and
   * a TTL would put a delay back in. This one is a chart legend, and the TTL is
   * only its floor: an admin edit and a "Sync now" both drop the memo, so the
   * minute is what a background change costs, never what an admin's own edit does.
   *
   * The memo makes this class stateful. Two calls on one instance share a read by
   * design; a caller wanting a fresh read builds a fresh resolver.
   */
  async teamRoster(): Promise<TeamRoster> {
    const cached = this.roster;
    if (cached && Date.now() - cached.at < ROSTER_TTL_MS) return cached.roster;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.readRoster().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Drop the memo. An admin edit and an explicit sync must not be waited out. */
  invalidateRoster(): void {
    this.roster = null;
    // Bumping the generation is not bookkeeping — it is the other half of the
    // drop. Clearing the field alone loses an invalidation that lands while a
    // read is in flight, because that read writes the field again on its way
    // out with records that predate the write. See `readRoster`.
    this.generation += 1;
  }

  /**
   * A counter that moves on every invalidation.
   *
   * Anything that caches a value DERIVED from the roster — the Repos map holds
   * an owner's display name inside a view on its own ten-minute TTL — cannot
   * observe `invalidateRoster()` by holding a fresh roster, because it is not
   * holding a roster at all. It compares this number against the one it built
   * at, and rebuilds when they differ. That keeps the dependency one-way: the
   * resolver knows nothing about its consumers, and no listener has to be
   * registered or torn down.
   */
  rosterGeneration(): number {
    return this.generation;
  }

  private async readRoster(): Promise<TeamRoster> {
    const startedAt = this.generation;
    try {
      const roster = mergeRoster(await this.identities.list(), PEOPLE_ALIASES);
      // Success path only. Caching inside the catch would pin the degraded,
      // file-only answer for a whole minute — the opposite of what the fallback
      // is for. Leaving the memo untouched makes the next caller retry.
      //
      // And only if no invalidation arrived while we were reading. An admin's
      // PUT can land mid-read; these records predate it, so caching them would
      // re-pin for the full TTL exactly the answer the admin just changed. The
      // current caller still gets them — a read that started before a write may
      // legitimately not see it — but the next one goes back to the store.
      if (this.generation === startedAt) this.roster = { at: Date.now(), roster };
      return roster;
    } catch (err) {
      this.logger.warn(`roster merge skipped: ${(err as Error).message}`);
      return mergeRoster([], PEOPLE_ALIASES);
    }
  }

  /**
   * Best-effort on purpose. This runs on the app's mount auth probe (/me) and on
   * every "Your work" load; a store hiccup must cost the caller nothing it could
   * otherwise have had. So a failure falls through to the checked-in table
   * rather than propagating — the person still sees their own work.
   *
   * That makes an unreachable store indistinguishable from an unknown person,
   * and deliberately so: both mean "the roster has no answer for me right now,
   * use the file". Do not separate them.
   */
  private async fromRoster(email: string): Promise<IdentityRecord | null> {
    try {
      return await this.identities.identityForEmail(email);
    } catch (err) {
      this.logger.warn(`roster identity lookup skipped: ${(err as Error).message}`);
      return null;
    }
  }
}

import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminEmailCache } from './group-admins/admin-email-cache';
import { PEOPLE_SOURCE, type IPeopleSource } from '../people/people-source';
import { isStaticAgent, type AuthenticatedActor } from './static-agent';

const norm = (s: string) => s.trim().toLowerCase();

const parseAdminEmails = (raw: string): string[] =>
  (raw ?? '')
    .split(',')
    .map(norm)
    .filter(Boolean);

/**
 * The ADDRESS question alone, as a type — implemented by AdminAuthority.
 *
 * Deliberately NOT widened to `isAdminActor` when the gates moved to it (#551).
 * The actor question is personhood composed with this one, so a second
 * implementer would have to compose it a second time — which is precisely the
 * duplication #551 removed. The composition lives in the authority, once.
 *
 * The consequence is that this type is a narrow view, never a gate's dependency.
 * Everything deciding whether a caller may ACT as an admin — `AdminGuard`,
 * `/api/auth/me` — depends on the concrete `AdminAuthority`, so TypeScript
 * refuses a bare `AdminCheck` there and the half-answer cannot be substituted in.
 * Nothing declares `AdminCheck` at such a seam today; declaring one would be the
 * way to reopen that, and is the reason to reach for the concrete class instead.
 */
export interface AdminCheck {
  isAdmin(email: string): boolean;
}

/**
 * Why an email is an admin: an assigned board role, or the env break-glass
 * bootstrap. 'assigned' is the durable path (a board-assigned `admin` role);
 * 'bootstrap' is admin only via BOARD_ADMIN_EMAILS, which the Access panel flags
 * as something to make durable by assigning the Admin role.
 */
export type AdminSourceKind = 'assigned' | 'bootstrap';

/**
 * Why a caller is being refused the admin surface (#811) — two different facts
 * that were one `403` until now.
 *
 * 'not-admin' is a decision: the board read its admin roster and this caller is
 * not on it. 'admins-unread' is the absence of one: the roster read has never
 * succeeded, so nobody resolves as admin, this caller included, and the board
 * has no idea whether they belong. The break-glass does not arm on the second
 * (#588) and must not, so the caller is refused either way — but telling them
 * they are not an admin is a claim the board cannot support, and it is the claim
 * that sends an operator looking for the wrong problem.
 *
 * It costs a cold-booted board with an unreachable Postgres the one page that
 * would name the outage: `/api/admin/audit` carries the lost-record count (#781)
 * and answered `403 admin access required`, because the admin roster lives in
 * the same Postgres that is down.
 */
export type AdminRefusal = 'not-admin' | 'admins-unread';

/** The machine half of that refusal, so a client can tell board's 503 from an
 *  ingress's. Travels in the body beside the sentence. */
export const ADMINS_UNREAD_CODE = 'admins_unread';

/**
 * What the guard answers a caller refused for 'admins-unread' with. Public so
 * the spec asserts the exact sentence rather than a phrase inside it, the way
 * every boot message above is asserted.
 *
 * A SCREEN DRAWS THIS WORD FOR WORD (#1104 review, S1). `AdminGuard` sits on
 * `PUT /api/admin/identity`, and the Admin Access dialog prints this sentence
 * when it arrives — so an admin who presses Save while the roster is unreadable
 * reads this line. It is the `ADMINS_UNREAD_CODE` above that carries it there:
 * board-frontend's `auth/write-failure.ts` repeats a 503's body only where it
 * can PLACE it, by that code or by the roster fixture's own sentence, and
 * answers every other 503 with the surface's own words. This is the only
 * sentence in this file a screen draws.
 * It was written for an operator reading a log: it named the identity store,
 * pointed at the service log and ran to three sentences, none of which is a
 * thing the person in the dialog has or can act on. The operator's half is
 * said where an operator is: the boot postures above, and `AdminsUnreadNotice`
 * at the top of the hub, which still names the store and the log.
 *
 * What survives is the half that stops the board making a claim it cannot
 * support — that this reader is not an admin — plus the retry, which is true:
 * the refusal clears on the first roster read that succeeds and needs nothing
 * from the reader.
 */
export const ADMINS_UNREAD_REFUSAL =
  'The board cannot read who its admins are right now, so it cannot tell whether you are one. ' +
  'Try again in a moment.';

/**
 * Every posture the board can be in, as constants so the spec can assert the
 * exact message rather than a phrase inside it (#588). Each one is a claim an
 * operator will act on, so a reword has to be a deliberate edit here — a regex
 * over a fragment lets a rewrite that reintroduces the old bad advice slide past.
 *
 * Boot prints one of them, and since #591 so does the first request that finds
 * the board in a new posture. None of them may therefore say "at boot": the same
 * words have to be true at 11am, said to somebody reading a running service.
 */

/** Break-glass active: env granting admin, roster read and genuinely empty. */
export const BOOT_BREAK_GLASS_ACTIVE =
  'Break-glass admin active: no board-assigned admins exist, so BOARD_ADMIN_EMAILS is granting admin. ' +
  'Assign the Admin role in Admin › Access, starting with your own account so you keep access, ' +
  'and the env var goes dormant.';

/** Nothing at all: roster read, genuinely empty, and no break-glass to activate. */
export const BOOT_NO_ADMINS_RESOLVE =
  'No board admins resolve, so nobody can administer the board. Admin › Access cannot repair this, ' +
  'because opening that panel needs an admin. Set BOARD_ADMIN_EMAILS to a GitHub login that is in the ' +
  'allow list and redeploy; it grants admin until a stored Admin role exists.';

/**
 * Stored admins exist, none of their addresses is on the team roster, and the
 * break-glass has taken over (#591). Deliberately not BOOT_BREAK_GLASS_ACTIVE:
 * that one says no board-assigned admins exist, which is false here — they
 * exist, they just cannot arrive.
 */
export const BOOT_ADMINS_UNREACHABLE_BREAK_GLASS =
  'Break-glass admin active: every board-assigned admin is outside the GitHub allow list, so none of them can ' +
  'sign in and BOARD_ADMIN_EMAILS is granting admin instead. Assign the Admin role in Admin › Access to ' +
  'an account that is in the allow list — your own, so you keep access — and the env var goes dormant.';

/**
 * The same stranded stored admins, with no break-glass that can take over
 * (#591). "Cannot take over" is unset OR set to an address the team group does
 * not have — one branch, because the reader is locked out either way and the
 * recovery is the same address change.
 */
export const BOOT_ADMINS_UNREACHABLE_NO_BREAK_GLASS =
  'No board admins resolve: every board-assigned admin is outside the GitHub allow list, so none of them can ' +
  'sign in, and BOARD_ADMIN_EMAILS names nobody who can either — it is unset, or set to a GitHub login ' +
  'outside the list. Admin › Access cannot repair this, because opening that panel needs an admin. Set ' +
  'BOARD_ADMIN_EMAILS to a GitHub login that is in the allow list and redeploy; it grants admin until a ' +
  'stored Admin role exists that can sign in.';

/** No answer at all: the roster read never succeeded, so neither claim above is one we can make. */
export const BOOT_ADMIN_ROSTER_UNREAD =
  'The admin roster has not been read successfully, so nobody resolves as admin until the next refresh ' +
  'that does. The cache error above says why the read failed. Break-glass stays disarmed, because an ' +
  'unread roster is not evidence that the board has no admins.';

/**
 * The board's admin posture, as the boot guard and the runtime line both read
 * it: 'ok' is silence, everything else carries the one message that says so.
 *
 * 'empty' is a roster read that found no stored admins; 'stranded' is stored
 * admins none of whom can sign in (#591). Kept apart because they are different
 * claims about the same data, and #588 was about a message making the wrong one.
 */
type AdminPosture =
  | { state: 'ok' }
  | { state: 'unread' | 'empty' | 'stranded'; level: 'warn' | 'error'; message: string };

/**
 * The roster a two-argument construction gets: one that answers "nobody", which
 * `teamRoster` reads as "not known" and so arms nothing on. Every spec that
 * builds an authority without a people source lands here, and lands on the
 * pre-#591 rule — which is exactly the state the board is in before its first
 * roster read.
 *
 * Nest never uses it: `@Inject(PEOPLE_SOURCE)` makes the parameter a declared
 * dependency, so a graph that forgot to import PeopleModule fails to boot rather
 * than quietly falling back to this.
 */
const UNREAD_ROSTER: IPeopleSource = { listMemberEmails: async () => [] };

/**
 * THE single source of truth for "is this email a board admin" (#143, #332). An
 * admin is a person with a board-assigned `admin` role — the durable path, edited
 * in the person editor.
 *
 * BOARD_ADMIN_EMAILS is a DORMANT break-glass (#371): it grants admin ONLY when
 * no board-assigned admin can sign in, so it is inert in normal operation (not a
 * standing admin source) but auto-activates to recover an admin set nobody can
 * use — demoting every admin self-heals, a fresh DB comes up administrable, and
 * so does a board whose last stored admin has left the team group.
 *
 * "No board-assigned admin can sign in" is two facts, and both are read, never
 * assumed. A roster read that SUCCEEDED and came back empty is the first (#588):
 * a read that failed says nothing about how many admins exist, and the
 * break-glass stays disarmed on it — see `listAdminEmails`. The second is that
 * an admin the team roster does not contain is refused by `TeamAccessGuard` long
 * before `AdminGuard` is consulted, so a stored role held by an ex-employee is
 * not an administrable board (#591) — see `usableAdmins`.
 *
 * Recovery needs no script, but it does need that env var to be set. With no
 * stored admin AND no BOARD_ADMIN_EMAILS there is nothing to activate and the
 * board is genuinely unadministrable — the state production came up in (#588),
 * which is what the boot guard below is for.
 *
 * Roles are decoupled from Google-group ownership (#332) — the group is used only
 * for membership. Every gate — the AdminGuard, /api/me, token minting — resolves
 * admin through this one authority, so a board-assigned Admin role grants admin
 * everywhere, consistently.
 *
 * Two methods, two different questions (#551). `isAdmin` takes an ADDRESS and
 * says whether it is in the admin set. `isAdminActor` takes the CALLER and says
 * whether it may act as an admin — the address question plus personhood, since a
 * static agent token has nobody behind it and cannot hold a person's role
 * (#546). Anywhere a request's actor is in hand, the second is the one to ask.
 */
@Injectable()
export class AdminAuthority implements AdminCheck, OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(AdminAuthority.name);
  private readonly envAdmins: string[];
  private readonly rosterTtlMs: number;
  /** The team roster, or `null` for "not known" — see `teamRoster`. */
  private roster: string[] | null = null;
  private rosterAt = 0;
  /** Single-flight: a burst of gate calls shares ONE roster read. */
  private rosterRead: Promise<void> | null = null;
  /** The posture the log has already been told about, so each one is said on
   *  the change into it and not once per refresh. `null` is "nothing said yet",
   *  which is what a request arriving before the boot guard lands in. */
  private said: AdminPosture['state'] | null = null;
  /** Whether the log has already been told that a KNOWN roster was refused, so
   *  it is said on the change into that state and not once per read. Cleared by
   *  a read that answers, so a group emptied again tomorrow is reported again. */
  private saidRosterEmpty = false;
  /** The failure the log has already been told about, as its message. A DIFFERENT
   *  message is a different thing going wrong and is said; the same one repeated
   *  is not. Cleared by a read that answers. */
  private saidRosterFailure: string | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(AdminEmailCache) private readonly assigned: Pick<AdminEmailCache, 'emails'>,
    @Inject(PEOPLE_SOURCE) private readonly people: IPeopleSource = UNREAD_ROSTER,
  ) {
    this.envAdmins = parseAdminEmails(config.get<string>('BOARD_ADMIN_EMAILS', '') ?? '');
    this.rosterTtlMs = config.get<number>('ADMIN_CACHE_TTL_MS', 300000);
  }

  /**
   * Read the roster before the first request — and before the boot guard, which
   * is the reason this is `onModuleInit` and not `onApplicationBootstrap`: Nest
   * settles every `onModuleInit` before it runs any `onApplicationBootstrap`, so
   * awaiting here is what lets the guard below judge a roster that has been read
   * rather than one that has not. `AdminEmailCache` awaits its own read for
   * exactly the same reason.
   */
  async onModuleInit(): Promise<void> {
    await this.refreshRoster();
  }

  /**
   * Surface the admin posture once, after the admin cache and the roster have
   * both warmed (#371) — `posture` below is what decides which of the states it
   * is, and every message names only the recovery that is reachable from where
   * its reader is standing (#588).
   *
   * With the break-glass active the Access panel is open to them, so that is the
   * route to make admin durable. With nothing at all it is not: the panel is
   * behind `AdminGuard`, so pointing at it would be pointing at a door locked
   * from the inside, and the env var is the only way back in. It is not
   * sufficient on its own either — a stored admin outside the GitHub allow list
   * resolves as admin here and is still refused at sign-in by
   * `GithubAdmissionGuard`. That refusal is #591's whole subject, and it is why
   * a stored admin outside the allow list no longer holds the break-glass
   * dormant — the 'stranded' state below.
   *
   * The unread state is the only one that is not a claim about the roster. Every
   * other message says what the stored admin set contains; with the read failed
   * we have not looked, and saying any of them would be inventing an answer.
   * `AdminEmailCache` has already logged the underlying failure, which is what
   * that message points back at.
   */
  onApplicationBootstrap(): void {
    const posture = this.posture(this.assignedEmails());
    // Remembered so the first request does not repeat what boot has just said.
    this.said = posture.state;
    if (posture.state !== 'ok') this.say(posture);
  }

  /**
   * Is this ADDRESS in the admin set? An address alone, with no caller attached
   * — so this assumes the caller behind it is a person, and cannot check it.
   *
   * Call this only where personhood is already settled by something else. Two
   * places do: `consent.controller.ts` and `account.controller.ts` both carry a
   * class-level `HumanOnlyGuard`, so no token of any kind reaches the
   * expressions that ask this, and asking about the address is exactly right
   * there (#545). Anywhere a request's own actor is in hand, ask `isAdminActor`
   * instead — a synthetic `agent:<name>` address passes straight through here,
   * from `BOARD_ADMIN_EMAILS` (no format validation) or from a roster row
   * carrying it, and this method has no way to know that (#551).
   */
  isAdmin(email: string): boolean {
    const e = norm(email);
    return !!e && this.listAdminEmails().includes(e);
  }

  /**
   * May this CALLER act as an admin (#551)? THE one decision behind both the
   * reported answer (`/api/auth/me`'s `isAdmin` field) and the enforced one
   * (`AdminGuard`). They used to be computed separately — the surface composed
   * personhood at its call site after #546, the gate asked about the address
   * alone — so the board reported one thing and enforced another, by
   * construction rather than by accident. One method, two call sites, no drift.
   *
   * Two questions, in this order:
   *
   *  1. Is there a person behind this caller? A static `BOARD_AGENT_TOKENS`
   *     actor is the only caller for which there is not (#546). It is read from
   *     the flag `jwt-auth.guard` writes, through `isStaticAgent`, and never
   *     from the shape of the address — a token named `claude@ci` authenticates
   *     as `agent:claude@ci`, and every address-shaped test inverts on it (#525).
   *  2. Is that person's address in the admin set? `isAdmin` above, unchanged,
   *     break-glass included.
   *
   * Everything else passes the first question and is judged on the second alone:
   * a personal access token carries its owner's real address, and an MCP
   * agent-scoped session is a Google identity that passed the group check. The
   * scope layer does its own separate job on top of this one, and this does not
   * look at scopes — `HumanOnlyGuard`'s predicate (`!user?.scopes`) would refuse
   * both of those callers, which is why it is not the rule here.
   */
  isAdminActor(user?: AuthenticatedActor): boolean {
    if (isStaticAgent(user)) return false;
    return this.isAdmin(user?.email ?? '');
  }

  /**
   * THE break-glass rule, over whichever assigned-admin set you hand it: those
   * addresses, or — only when there are none at all — the BOARD_ADMIN_EMAILS
   * bootstrap. Normalized and deduped. Everything on the board that needs to
   * know who the admins are applies this, so there is one rule and no second
   * copy to drift.
   *
   * It takes the set rather than reading one because its two callers legitimately
   * read different data, and forcing them onto one source would break the panel
   * (#551 follow-up). `listAdminEmails` below applies it to the `AdminEmailCache`
   * snapshot, which is what the gates judge a caller against.
   * `AdminAccessService` applies it to the identity records it has just loaded,
   * because the cache is stale-while-revalidate and `identity.controller` calls
   * `invalidate()` without awaiting it — so on the request right after a role
   * write the snapshot is still the pre-write one, and a panel reading it would
   * show the admin you just made as not an admin. Same rule, each caller's own
   * freshest data.
   *
   * That is also why the "was this set actually read" question is NOT asked here
   * (#588). This method's argument is a set that its caller has in hand and
   * knows to be complete — `AdminAccessService` has just awaited the records it
   * passes — so an empty one here means an empty roster and the break-glass is
   * right to arm. Only `listAdminEmails` reads a source that can fail, so only it
   * has to tell "empty" from "unknown", and it does that before calling in here.
   *
   * What the caller does NOT hand over is whether those addresses can sign in;
   * that is the board's own state and this reads it itself (#591). It changes
   * one thing only — WHETHER THE BREAK-GLASS ARMS — and never the set:
   *
   *     effective = the stored rows ∪ (the env admins, only when no stored row
   *                                    is on the team roster)
   *
   * A stranded row stays in, for two reasons. It is not access: `TeamAccessGuard`
   * refuses a non-member at sign-in, on every request, ahead of `AdminGuard` —
   * so the row is unreachable whether or not this set names it, and naming it is
   * not what locks the board out. The break-glass staying dormant is. And the
   * roster is read with `members.list`, which does not resolve the nested groups
   * that the sign-in gate's `hasMember` does: dropping a row on that answer would
   * strip a real admin of admin and hand the board to BOARD_ADMIN_EMAILS on an
   * incomplete read. Under the union an under-inclusive roster never costs
   * anybody their access.
   *
   * It is not free, though, and the cost lands on this panel. When the only
   * working admins belong through a nested group and no break-glass address can
   * arrive, the board reads as unadministrable to everything that asks — so
   * every admin-REMOVING write is refused (#590), including clearing the very
   * ex-employee row described below. What still lands is the add-only path: give
   * the Admin role to somebody the roster does have, and the removal is
   * refusable no longer. Closing the gap underneath means widening the roster
   * read to resolve nested groups, which is `people/`'s to do, not this file's.
   *
   * It also keeps the Access panel whole. `AdminAccessService` draws its admin
   * list from this, and the stranded row is precisely the one an operator opens
   * that panel to remove — a set that dropped it would hide the stale role from
   * the only surface that can clear it.
   */
  effectiveAdminEmails(assigned: Iterable<string>): string[] {
    const rows = [...assigned].map(norm);
    // Dormant break-glass: env admins count only when no stored admin can
    // ARRIVE (#591) — which is a question about the rows, not a filter on them.
    const bootstrap = this.usableAdmins(rows).length === 0 ? this.envAdmins : [];
    return [...new Set([...rows, ...bootstrap])];
  }

  /**
   * Could ANYBODY administer a board whose stored admin set is this one (#590)?
   * The question a caller asks when it is about to CHANGE that set: hand over
   * the set the write would leave, and this says what the board would be left
   * with — somebody who can arrive, or nobody.
   *
   * Deliberately not `effectiveAdminEmails(...).length > 0`, which is a
   * different question with a different answer. That set keeps the stranded rows
   * (#591), for good reasons of its own, so it stays non-empty for a board whose
   * every admin is outside the team group and whose break-glass is unset — the
   * one state where nobody at all can administer and the set says otherwise. A
   * write that clears the last admin who CAN sign in, next to a row belonging to
   * someone who left, lands exactly there.
   *
   * Both halves get the SAME roster question, through one call to
   * `usableAdmins` (#591). `TeamAccessGuard` asks it of everybody, so an env
   * address the team group does not have cannot arrive any more than a stored
   * role can — and BOARD_ADMIN_EMAILS naming somebody outside the group is not a
   * typo case: it is an address that was right when it was set and drifted when
   * that person left. Reading it as a standing safety net is what let the last
   * admin who COULD sign in step down behind one.
   *
   * Union rather than a disjunction of two filtered lists, because that is the
   * same answer in one expression: while a stored admin is usable the
   * break-glass is dormant and contributes nothing, and once none is, it is the
   * only thing left that can contribute. It also inherits the fail-safe whole —
   * with the roster unknown `usableAdmins` filters nothing, so an outage leaves
   * both halves exactly as they were.
   */
  isAdministrable(assigned: Iterable<string>): boolean {
    return this.usableAdmins([...assigned, ...this.envAdmins]).length > 0;
  }

  /**
   * Which of the stored admins could actually reach the board (#591) — the whole
   * of this issue, in one question. Read it as a COUNT, not as a set: the only
   * caller asks whether it is empty, and both callers of `effectiveAdminEmails`
   * keep every stored row either way.
   *
   * A stored `admin` role is not access on its own. `TeamAccessGuard` refuses
   * anyone outside the team group at sign-in, before `AdminGuard` is ever
   * consulted, so a row belonging to an ex-employee counts for nothing while
   * still making the set look non-empty. That kept the break-glass dormant and
   * the boot guard quiet, and left recovery to a direct database write.
   *
   * The roster comes from the exported `PEOPLE_SOURCE`: the plain-login portion
   * of BOARD_ALLOWED_GITHUB. Close to the gate's own question, one call, rather
   * than a second idea of who belongs —
   * but not identical to it, which is why the answer only ever arms the
   * break-glass: `members.list` lists direct members, while the gate's
   * `hasMember` resolves nested groups too.
   *
   * With the roster not known this answers "every row" — see `teamRoster`. Only
   * half of that is free (#623). An unknown roster can never ARM the
   * break-glass, which is the fail-safe half: a Google outage cannot hand the
   * board to an env var. It can DISARM one, though. In the 'stranded' posture
   * the roster IS known, no stored row is on it, and the break-glass is the only
   * thing holding the board open — and the moment that roster goes back to
   * unknown every row counts again, the bootstrap empties, and the door shuts on
   * the reader the posture exists to let in.
   *
   * So the safety of this line rests entirely on a known roster never becoming
   * an unknown one. `refreshRoster` is what holds that: neither a failed read
   * nor an empty one touches a roster already read.
   */
  private usableAdmins(assigned: Iterable<string>): string[] {
    const rows = [...assigned].map(norm);
    const roster = this.teamRoster();
    return roster === null ? rows : rows.filter((email) => roster.includes(email));
  }

  /**
   * Which of the boot states the board is in, and the one line that says so
   * (#588, #591) — over a stored set the caller has already read, so `null`
   * stays "unread" rather than being re-asked and answered differently.
   *
   * 'stranded' is #591's state: stored admins exist and none of them can sign
   * in. It gets its own two messages because the recovery differs from the empty
   * case and from each other — with the break-glass armed the reader can open
   * Admin › Access, without it that door is locked from the inside.
   *
   * The warn/error split is `isAdministrable` (#590) rather than a second read
   * of the env var: warn is a board somebody can still get into, error is one
   * nobody can. Same expression, so the line boot prints and the write the panel
   * refuses cannot come to different conclusions about the same board.
   *
   * That is also what keeps the two warn messages honest (#591). Both send
   * their reader to Admin › Access, and both now fire only when a break-glass
   * address is on the team roster — so the reader they are addressing can
   * actually get through the front door to reach that panel. A set-but-unusable
   * break-glass lands in the error branch, whose messages name the env var and a
   * redeploy instead, which is the only door left.
   */
  private posture(assigned: string[] | null): AdminPosture {
    if (assigned === null) return { state: 'unread', level: 'error', message: BOOT_ADMIN_ROSTER_UNREAD };
    if (this.usableAdmins(assigned).length > 0) return { state: 'ok' };
    const stranded = assigned.length > 0;
    if (this.isAdministrable(assigned)) {
      return stranded
        ? { state: 'stranded', level: 'warn', message: BOOT_ADMINS_UNREACHABLE_BREAK_GLASS }
        : { state: 'empty', level: 'warn', message: BOOT_BREAK_GLASS_ACTIVE };
    }
    return stranded
      ? { state: 'stranded', level: 'error', message: BOOT_ADMINS_UNREACHABLE_NO_BREAK_GLASS }
      : { state: 'empty', level: 'error', message: BOOT_NO_ADMINS_RESOLVE };
  }

  private say(posture: Exclude<AdminPosture, { state: 'ok' }>): void {
    if (posture.level === 'warn') this.logger.warn(posture.message);
    else this.logger.error(posture.message);
  }

  /**
   * The board's own effective admin set: the rule above over the admin cache.
   * This is the set the gates judge a caller against, so it is the one that can
   * lag a role write by a refresh — see `effectiveAdminEmails`.
   *
   * With the cache unread it is EMPTY, break-glass included (#588). The
   * break-glass arms on evidence that the board has no admins, and an unread
   * roster is not that evidence — it is the absence of it. Arming here would
   * have a Postgres outage during a rollout hand admin to BOARD_ADMIN_EMAILS
   * while the real admins sat unread in the database. Refusing everyone until
   * the next successful refresh fails the safe way round: an outage costs the
   * board its admin panel for the length of the outage, it does not hand the
   * panel to whoever is named in an env var.
   */
  listAdminEmails(): string[] {
    const assigned = this.assignedEmails();
    const posture = this.posture(assigned);
    // Say it when it happens, not only at boot (#591). Both sets this reads
    // refresh in the background, so a board that came up healthy can go bad by
    // 11am — an admin leaving the group, the last stored role revoked, the admin
    // source going unreachable — and none of those may wait for the next rollout
    // to become visible. EVERY posture that is not 'ok' says its own line, since
    // each is a different thing being wrong with a different way back.
    //
    // On the CHANGE into a posture, though, not on every refresh: repeating it
    // every TTL would bury it. Keyed on the state rather than a flag, so a board
    // that moves from one bad posture to another says the new one instead of
    // staying quiet on the strength of having already said something.
    if (posture.state !== this.said) {
      if (posture.state !== 'ok') this.say(posture);
      this.said = posture.state;
    }
    return assigned === null ? [] : this.effectiveAdminEmails(assigned);
  }

  /**
   * Why this CALLER is not being let in, or `null` when they are (#811). The one
   * place that difference is decided, so `AdminGuard` and `/api/auth/me` cannot
   * come to different conclusions about the same request — the reason `#551`
   * put `isAdminActor` here rather than at two call sites.
   *
   * A caller with no person behind it is 'not-admin' whatever the roster says.
   * `BOARD_AGENT_TOKENS` is refused because nothing human is there (#546), which
   * is a settled decision and not an outage; reporting it as one would hand a
   * static agent a false story about the board's health.
   *
   * Nothing here widens who gets in. The unread roster still admits nobody, and
   * `BOARD_ADMIN_EMAILS` still does not arm on it (#588) — `listAdminEmails`
   * turns an unread roster into `[]` before the break-glass is consulted, and
   * this method reads that same decision rather than a second copy of it.
   */
  adminRefusal(user?: AuthenticatedActor): AdminRefusal | null {
    if (this.isAdminActor(user)) return null;
    if (isStaticAgent(user)) return 'not-admin';
    return this.adminsUnread() ? 'admins-unread' : 'not-admin';
  }

  /**
   * Has the board ever successfully read its admin roster (#811)? `false` is the
   * ordinary answer; `true` is a board whose admin source has failed every read
   * since it started, which on `IDENTITY_SOURCE=db` means Postgres.
   *
   * This is the `posture` 'unread' state as a question a caller can ask, not a
   * second reading of it — both go through `assignedEmails`, whose `null` is the
   * one definition of "no answer at all".
   */
  adminsUnread(): boolean {
    return this.assignedEmails() === null;
  }

  /**
   * Why `email` is an admin: 'assigned' if a board-assigned `admin` role covers
   * it (the durable path), else 'bootstrap' — admin only via the break-glass env
   * var, which the Access panel flags for making durable via a role assignment.
   */
  sourceOf(email: string): AdminSourceKind {
    return (this.assignedEmails() ?? []).includes(norm(email)) ? 'assigned' : 'bootstrap';
  }

  /**
   * The board-assigned admin addresses, or `null` when the cache has never read
   * them successfully — "nobody" and "no answer", kept apart (#588). Callers
   * must handle `null` deliberately; that is the point of the type.
   *
   * The real sources already lowercase, but normalize defensively so admin
   * resolution can never hinge on a source that forgot to.
   */
  private assignedEmails(): string[] | null {
    return this.assigned.emails()?.map(norm) ?? null;
  }

  /**
   * The addresses that could pass sign-in, or `null` for "not known" (#591).
   * Refreshes in the background once the snapshot is older than the TTL every
   * other group read uses; the getter never blocks, because `isAdmin` is sync.
   *
   * Two different things read as `null`, on purpose. A read that FAILED is the
   * absence of evidence, and so is a read that came back EMPTY: a team group
   * that lists nobody is a misconfigured group far more often than it is a
   * company with no employees, and the fixture source answers `[]` whenever
   * BOARD_ALLOWED_GITHUB is unset. Either one, treated as "nobody is a member",
   * would strand every stored admin and hand the board to an env var — #588's
   * defect one level down. Unknown is not nobody.
   */
  private teamRoster(): string[] | null {
    if (Date.now() - this.rosterAt >= this.rosterTtlMs) void this.refreshRoster();
    return this.roster;
  }

  private refreshRoster(): Promise<void> {
    if (this.rosterRead) return this.rosterRead;
    this.rosterRead = this.people
      .listMemberEmails()
      .then((emails) => {
        const read = emails.map(norm).filter(Boolean);
        // An empty read is not an answer either, so it takes the `.catch`'s
        // path rather than this one (#623). `DirectoryPeopleSource` throws on
        // the body that used to produce most of these, but it is the only
        // source holding a body to inspect — the fixture answers `[]` whenever
        // BOARD_ALLOWED_GITHUB is unset — so this end refuses an empty read on
        // its own account, for whatever source hands one over.
        //
        // `roster` is therefore left alone, `null` included: a first-ever empty
        // read still leaves it unknown, which is the right answer already. `at`
        // is left alone too, so the next call retries instead of holding
        // "unknown" for a full TTL on the strength of a non-answer.
        if (read.length === 0) {
          // Only when a KNOWN roster was refused, and only on the CHANGE into
          // that state (#623). Both halves matter. A fixture source answers `[]`
          // whenever BOARD_ALLOWED_GITHUB is unset, which is normal operation
          // and has nothing to report — and a first-ever empty read cannot be
          // told apart from it HERE, which is why the line for that one belongs
          // to `DirectoryPeopleSource`, the only end that knows it walked a real
          // members page and found nobody on it. What is left is a roster that
          // was read yesterday and reads empty today, which is worth a line.
          //
          // Said on the change because this end deliberately stamps no clock on
          // a non-answer, so every gate call re-reads it: one line per read is
          // one line per gate call, which is the same as no line at all. The
          // same reasoning `listAdminEmails` gives for a posture, and the same
          // keying — on the state, so the next real answer re-arms it.
          if (this.roster && !this.saidRosterEmpty) {
            this.saidRosterEmpty = true;
            this.logger.warn('team roster read came back empty, keeping the roster already known');
          }
          return;
        }
        this.saidRosterEmpty = false;
        this.saidRosterFailure = null;
        this.roster = read;
        this.rosterAt = Date.now();
      })
      .catch((err: unknown) => {
        // Deliberately does NOT touch `roster`: a failed read keeps the last-good
        // one, and leaves it `null` — unknown — if there has never been one. `at`
        // is left alone too, so the next call retries rather than waiting a TTL.
        const message = err instanceof Error ? err.message : String(err);
        // Said on the CHANGE, like the empty read above and for a sharper reason
        // (#623). Not stamping the clock means a read per gate call, and since
        // `DirectoryPeopleSource` gained its failure floor most of those reads
        // are the REMEMBERED failure handed back without a request — so a line
        // each time reports 30 failed reads where three were issued, measured.
        // Keyed on the message rather than a flag, so a second thing going wrong
        // is not swallowed by the first, and a read that answers re-arms it.
        if (this.saidRosterFailure !== message) {
          this.saidRosterFailure = message;
          this.logger.error(`team roster read failed, admin usability unchecked: ${message}`);
        }
      })
      .finally(() => {
        this.rosterRead = null;
      });
    return this.rosterRead;
  }
}

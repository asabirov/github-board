import { Body, ConflictException, Controller, Header, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { RequiredScopes } from '../auth/required-scopes.decorator';
import { Writes } from '../capability/writes.decorator';
import { BOARD_ADMIN } from '../auth/scopes';
import { AuditService } from '../audit/audit.service';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { AdminAuthority } from '../auth/admin-authority';
import { AdminEmailCache } from '../auth/group-admins/admin-email-cache';
import { IDENTITY_REPOSITORY, IdentityData, IdentityRecord, IdentityRepository } from './identity.repository';
import { GithubLoginResolver } from './github-login.resolver';
import { MemberRole } from './role';
import { validateUpsert } from './identity.validation';

interface AuthedRequest {
  user?: { email?: string };
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The two writes this surface refuses (#590), as constants so the spec asserts
 * the message rather than a phrase inside it — each one is the only instruction
 * its reader gets, and a reword that loses the recovery must be a deliberate
 * edit here (the #588 pattern).
 */

/** Nobody would be left who can sign in and administer the board. */
export const WRITE_LEAVES_NO_USABLE_ADMIN =
  'This would leave the board with no administrator who can sign in — an Admin role only counts while its ' +
  'address is on the team roster. Give the Admin role to somebody on the roster first, then take this one away.';

/** The actor holds admin through the break-glass, and this write ends it. */
export const WRITE_DROPS_ACTOR_BREAK_GLASS_ADMIN =
  'This would take your own admin away: it comes from BOARD_ADMIN_EMAILS, which goes dormant the moment a ' +
  'board-assigned admin can sign in. Give the Admin role to your own account first, then theirs.';

/**
 * Admin edit surface for the identity store (#11). Global prefix 'api' →
 * /api/admin/identity. Runs under the global chain (JwtAuthGuard → TeamAccessGuard)
 * then AdminGuard, so only an admin reaches the handler. A single upsert keyed by
 * the person's roster email handles both editing an existing identity and
 * creating one for a rostered person who has none yet. Payloads are validated
 * (email/handle charset, array caps) before hitting the DB. In fixture mode the
 * repository throws 503 (editing requires IDENTITY_SOURCE=db).
 *
 * Human-only (#332): identity edits — which now include the authoritative role
 * that grants admin — are gated to signed-in humans, never a token. A leaked
 * admin-scoped agent token therefore cannot durably promote anyone to admin.
 *
 * The one thing it will not do is hand over the board (#590): a write that would
 * leave nobody able to administer it, or take the writer's own admin away
 * because they held it through the break-glass, is refused before it lands.
 */
@Controller('admin/identity')
@UseGuards(AdminGuard, HumanOnlyGuard)
export class IdentityController {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly repo: IdentityRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AdminEmailCache) private readonly adminCache: AdminEmailCache,
    @Inject(GithubLoginResolver) private readonly githubLogins: GithubLoginResolver,
    @Inject(AdminAuthority) private readonly authority: AdminAuthority,
  ) {}

  // Writes the people store, not Github.
  @Writes()
  @Put()
  @Header('Cache-Control', 'no-store')
  @RequiredScopes(BOARD_ADMIN)
  async upsert(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest): Promise<IdentityRecord> {
    const { keyEmail, data } = validateUpsert(body ?? {});
    const actorEmail = req.user?.email ?? 'unknown';
    // The row this write will land on, read through the same per-email lookup the
    // upsert targets. Scanning `list()` for it instead would order by displayName
    // while the write orders by updatedAt, so if two rows ever shared an address
    // the audit's "was X" — and the admin set computed below — would describe a
    // different row from the one being written.
    const target = await this.repo.identityForEmail(keyEmail);
    // A role change (#332) is a governance action — capture the prior role so we
    // can audit it distinctly and skip a no-op. `'role' in body` distinguishes an
    // explicit role edit from a payload that just omits it (leave role unchanged
    // is impossible via a full upsert, so the editor always sends the role).
    const roleProvided = !!body && Object.prototype.hasOwnProperty.call(body, 'role');
    const prior = roleProvided ? target?.role ?? null : undefined;

    await this.refuseIfItLocksTheBoard(keyEmail, data, target, actorEmail);

    const record = await this.repo.upsert(keyEmail, data);
    // Unconditional, unlike the role-gated admin-cache drop below: ANY upsert can
    // change a handle, and an admin who corrects one must not wait out a TTL to
    // see the chart agree with the panel they are looking at.
    this.githubLogins.invalidateRoster();

    await this.audit.record({
      actorEmail,
      action: 'identity.upsert',
      summary: `Updated identity mapping for ${keyEmail}`,
      targetType: 'identity',
      targetId: keyEmail,
    });

    const next = data.role ?? null;
    if (roleProvided && next !== (prior ?? null)) {
      await this.audit.record({
        actorEmail,
        action: 'identity.role',
        summary: next
          ? `Set ${keyEmail} role to ${next}${prior ? ` (was ${prior})` : ''}`
          : `Cleared ${keyEmail} role override${prior ? ` (was ${prior})` : ''} → default`,
        targetType: 'identity',
        targetId: keyEmail,
      });
      // An added/removed admin must take effect now, not on the cache TTL.
      this.adminCache.invalidate();
    }
    return record;
  }

  /**
   * The two refusals of #590, both computed BEFORE anything is written and both
   * from the records this request has just read — never from `AdminEmailCache`,
   * which is stale-while-revalidate and lags a role write by a refresh, so a
   * refusal judged on it would refuse or allow the wrong write.
   *
   * "Could anybody administer this" is `AdminAuthority.isAdministrable`, not the
   * emptiness of the admin set. The set keeps a stored admin who has left the
   * team group (#591), so it stays non-empty for a board nobody can get into —
   * and clearing the last admin who CAN sign in, beside a row like that, is
   * precisely the write this exists to stop.
   *
   * It is the TRANSITION that is refused, never the state, and the transition is
   * two things: the write leaves nobody able to administer the board, AND it
   * takes a stored admin address away. A write that removes nothing cannot be
   * the write that broke anything, so assigning somebody the Admin role on a
   * board already in trouble still lands — the surface an operator climbs out on
   * stays open.
   *
   * Deliberately not "was the board administrable before". That question is
   * answered by the roster, and the roster is NARROWER than the gate a person
   * actually signs in through: `members.list` lists direct members, while
   * `TeamAccessGuard`'s `hasMember` resolves nested groups too. An admin who
   * belongs through a nested group therefore reads as unusable here while
   * signing in perfectly well — and a guard that stood aside on that answer
   * would switch itself off for exactly the board it is protecting, letting that
   * admin demote themself into a locked board. Asking what the write REMOVES
   * needs no roster at all, so the narrow read can no longer disable anything.
   *
   * Runs on every upsert rather than only on a role edit, because a role is not
   * the only field that decides who can administer: moving an admin's addresses
   * off the team roster strands them exactly as thoroughly, and the editor sends
   * both in one payload.
   */
  private async refuseIfItLocksTheBoard(
    keyEmail: string,
    data: IdentityData,
    target: IdentityRecord | null,
    actorEmail: string,
  ): Promise<void> {
    const records = await this.repo.list();
    const before = adminEmails(records);
    const after = adminEmailsAfter(records, target, keyEmail, data);

    const takesAdminAway = before.some((email) => !after.includes(email));
    if (takesAdminAway && !this.authority.isAdministrable(after)) {
      throw new ConflictException(WRITE_LEAVES_NO_USABLE_ADMIN);
    }

    // The README's trap, refused rather than warned about: the break-glass is
    // dormant the moment a board-assigned admin can sign in (#371, #591), so
    // giving a colleague the Admin role takes the env admin's own admin away in
    // the same instant. Asked through the authority's own rule, so what counts
    // as "still an admin afterwards" is the arming rule and not a second reading
    // of it — a promotion that leaves the break-glass armed takes nothing away.
    const actor = norm(actorEmail);
    const heldOnlyByBreakGlass =
      !before.includes(actor) && this.authority.effectiveAdminEmails(before).includes(actor);
    if (heldOnlyByBreakGlass && !this.authority.effectiveAdminEmails(after).includes(actor)) {
      throw new ConflictException(WRITE_DROPS_ACTOR_BREAK_GLASS_ADMIN);
    }
  }
}

/** Every address a stored `admin` role covers, normalized and deduped. */
function adminEmails(records: IdentityRecord[]): string[] {
  return [...new Set(records.filter((r) => r.role === 'admin').flatMap((r) => r.emails.map(norm)))];
}

/**
 * The same set, as this write would leave it.
 *
 * Three things the repository does that this has to do identically, or the
 * refusal describes a board the write does not produce. The target row is
 * REPLACED, not merged — its stored addresses go with it, so an edit that keeps
 * the Admin role while moving an admin off the roster reads as what it is. An
 * absent `role` key leaves the stored role alone (#332), so the row's own role
 * is what carries. And the key email is always kept in the row that is written,
 * so it counts even when the payload's `emails` omits it.
 */
function adminEmailsAfter(
  records: IdentityRecord[],
  target: IdentityRecord | null,
  keyEmail: string,
  data: IdentityData,
): string[] {
  const role: MemberRole | null = data.role === undefined ? target?.role ?? null : data.role;
  const written = role === 'admin' ? [keyEmail, ...data.emails].map(norm) : [];
  return [...new Set([...adminEmails(records.filter((r) => r.id !== target?.id)), ...written])];
}

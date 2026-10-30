import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { IDENTITY_REPOSITORY, IdentityRepository } from './identity.repository';

/**
 * Records the identity-seed audit trail (#264). The DB identity store seeds
 * itself from PEOPLE_ALIASES on a fresh DB, but that seed isn't an audited HTTP
 * action — so a board whose only write was the seed showed an *empty* audit log
 * (verified in prod: 0 events, 0 tokens, 3 seeded identities). On boot we
 * reconcile: every seeded identity that has no `identity.seed` event gets one
 * (actor `system`). This backfills already-seeded environments the first time
 * they run this code, and self-documents fresh deploys — both from the same pass.
 *
 * Idempotent: once an identity has its event, later boots record nothing. Only
 * runs with IDENTITY_SOURCE=db; fixture/no-DB has no persistent audit to fill.
 */
@Injectable()
export class IdentitySeedAudit implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdentitySeedAudit.name);

  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('IDENTITY_SOURCE') !== 'db') return;
    try {
      // `list()` seeds a fresh DB before returning, so identities always exist
      // here; the seed events may not yet (fresh deploy, or a DB seeded before
      // this code shipped — the prod case #264 is fixing).
      const [people, seedEvents] = await Promise.all([
        this.identities.list(),
        this.audit.list({ action: 'identity.seed', limit: 500 }),
      ]);
      const recorded = new Set(seedEvents.map((e) => e.targetId));
      let filled = 0;
      for (const p of people) {
        if (recorded.has(p.id)) continue;
        await this.audit.record({
          actorEmail: 'system',
          action: 'identity.seed',
          summary: `Seeded identity for ${p.displayName}`,
          targetType: 'identity',
          targetId: p.id,
        });
        filled += 1;
      }
      if (filled > 0) this.logger.log(`recorded ${filled} identity-seed audit event(s)`);
    } catch (err) {
      // Best-effort, exactly like AuditService.record: a reconcile failure must
      // never wedge boot.
      this.logger.warn(`identity-seed audit reconcile failed: ${(err as Error).message}`);
    }
  }
}

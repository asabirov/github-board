import { createPrismaClient } from '../prisma';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import { ADMIN_SOURCE } from './group-admins/admin-source';
import { StoredRoleAdminSource } from './group-admins/stored-role.admin.source';
import { FixtureAdminSource } from './group-admins/fixture.admin.source';
import { AdminEmailCache } from './group-admins/admin-email-cache';
import { AdminAuthority } from './admin-authority';
import { PeopleModule } from '../people/people.module';

/**
 * Board admin resolution (#143, #332). @Global so every gate (AdminGuard,
 * /api/me, token minting) shares ONE AdminEmailCache — a single warm-up and a
 * single admin-email snapshot, resolved through AdminAuthority.
 *
 * The admin source follows the identity-store switch: IDENTITY_SOURCE=db reads
 * board-assigned `admin` roles from Postgres (StoredRoleAdminSource, its own
 * PrismaClient — mirroring the identity/audit/account modules); otherwise a
 * fixture backed by BOARD_FIXTURE_ADMINS for dev/test.
 *
 * PeopleModule comes in for the other half of that (#591): a stored admin role
 * only counts if its address is on the team roster, because `TeamAccessGuard`
 * refuses everyone else at sign-in. The roster arrives through the exported
 * PEOPLE_SOURCE — the same provider the Access panel reuses — so admin
 * usability is judged against the gate's own membership data rather than a
 * second Directory client with its own config to drift.
 */
@Global()
@Module({
  imports: [PeopleModule],
  providers: [
    {
      provide: ADMIN_SOURCE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>('IDENTITY_SOURCE') === 'db') {
          return new StoredRoleAdminSource(createPrismaClient());
        }
        return new FixtureAdminSource(config.get<string>('BOARD_FIXTURE_ADMINS', '').split(','));
      },
    },
    AdminEmailCache,
    AdminAuthority,
  ],
  exports: [AdminAuthority, AdminEmailCache],
})
export class AdminAuthorityModule {}

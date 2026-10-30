import { createPrismaClient } from '../prisma';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAuthorityModule } from '../auth/admin-authority.module';
import { AccountController } from './account.controller';
import { HumanOnlyGuard } from './human-only.guard';
import { PersonalTokenService } from './personal-token.service';
import {
  DisabledPersonalTokenRepository,
  PERSONAL_TOKEN_REPOSITORY,
  PrismaPersonalTokenRepository,
} from './personal-token.repository';

/**
 * Personal access tokens (#210). Mirrors IdentityModule's DB gating: the Prisma
 * store is constructed only when IDENTITY_SOURCE=db (DATABASE_URL present), so
 * dev/test run without a database and the feature reports itself unavailable.
 * PersonalTokenService is exported so the global JwtAuthGuard can verify a
 * `board_pat_` bearer against the same store.
 */
@Module({
  imports: [AdminAuthorityModule],
  controllers: [AccountController],
  providers: [
    PersonalTokenService,
    HumanOnlyGuard,
    {
      provide: PERSONAL_TOKEN_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('IDENTITY_SOURCE') === 'db'
          ? new PrismaPersonalTokenRepository(createPrismaClient())
          : new DisabledPersonalTokenRepository(),
    },
  ],
  // PERSONAL_TOKEN_REPOSITORY is exported so the admin hub's Agents roster (#211)
  // can list/revoke tokens org-wide off the same store.
  exports: [PersonalTokenService, PERSONAL_TOKEN_REPOSITORY],
})
export class AccountModule {}

import { createPrismaClient } from '../prisma';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import {
  DERIVED_LOGINS_SOURCE,
  DerivedLoginsSource,
  EmptyDerivedLoginsSource,
} from './derived-logins.source';
import { DerivedLoginsService } from './derived-logins.service';
import { GithubDerivedLoginsSource } from './github-derived-logins.source';
import { IDENTITY_REPOSITORY, IdentityRepository } from './identity.repository';
import { PrismaIdentityRepository } from './prisma-identity.repository';
import { FixtureIdentityRepository } from './fixture-identity.repository';
import { IdentitySeedAudit } from './identity-seed-audit';
import { GithubLoginResolver } from './github-login.resolver';

/**
 * The cross-system identity store (#11 follow-up). IDENTITY_SOURCE selects the
 * backend: `db` uses Postgres via Prisma (editable, seeds from PEOPLE_ALIASES on
 * a fresh DB); anything else uses the read-only fixture (PEOPLE_ALIASES, writes
 * 503) so dev/test run without a database. PrismaClient is constructed only in
 * db mode — it reads DATABASE_URL at construction and would throw without it.
 *
 * GithubLoginResolver rides along and is exported (#520): every surface that
 * needs "which Github handle belongs to this address" — /me, "Your work" — asks
 * it rather than reading either store on its own, so the two can never diverge.
 */
@Module({
  providers: [
    {
      provide: IDENTITY_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>('IDENTITY_SOURCE') === 'db') {
          return new PrismaIdentityRepository(createPrismaClient());
        }
        return new FixtureIdentityRepository();
      },
    },
    // Backfills + records the identity-seed audit trail on boot (#264). AuditService
    // comes from the @Global AuditModule; ConfigService is available via inject above.
    IdentitySeedAudit,
    {
      // The same toggle every other Github-reading surface uses
      // (repos.module.ts): `fixture` derives nothing, so a board with no token
      // answers exactly as it did before #535.
      provide: DERIVED_LOGINS_SOURCE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('ISSUES_SOURCE') === 'fixture'
          ? new EmptyDerivedLoginsSource()
          : new GithubDerivedLoginsSource(config),
    },
    {
      provide: DerivedLoginsService,
      inject: [DERIVED_LOGINS_SOURCE, ConfigService],
      useFactory: (source: DerivedLoginsSource, config: ConfigService) =>
        new DerivedLoginsService(source, config),
    },
    {
      provide: GithubLoginResolver,
      inject: [IDENTITY_REPOSITORY, DerivedLoginsService],
      useFactory: (identities: IdentityRepository, derived: DerivedLoginsService) =>
        new GithubLoginResolver(identities, derived),
    },
  ],
  exports: [IDENTITY_REPOSITORY, GithubLoginResolver, DerivedLoginsService],
})
export class IdentityModule {}

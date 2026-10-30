import { createPrismaClient } from '../prisma';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUDIT_REPOSITORY, DisabledAuditRepository, PrismaAuditRepository } from './audit.types';
import { AuditService } from './audit.service';

/**
 * @Global so AuditService can be injected at every write path (#212) without each
 * feature module importing this one. The Prisma store is wired only when
 * IDENTITY_SOURCE=db (same gate as identity/tokens); dev/test record into the
 * no-op store and the log is empty.
 *
 * That gate is why `config.schema.ts` refuses GITHUB_WRITE_ENABLED=true on any
 * other value (#774): a factory can choose a store, it cannot refuse to boot.
 * The ternary below is the whole guarantee, so `audit.module.spec.ts` asserts
 * the concrete class each value resolves to — rename the key and every schema
 * test stays green.
 */
@Global()
@Module({
  providers: [
    {
      provide: AUDIT_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('IDENTITY_SOURCE') === 'db'
          ? new PrismaAuditRepository(createPrismaClient())
          : new DisabledAuditRepository(),
    },
    AuditService,
  ],
  exports: [AuditService],
})
export class AuditModule {}

import { createPrismaClient } from '../prisma';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionRevocationService } from './session-revocation.service';
import {
  MemorySessionRevocationStore,
  PrismaSessionRevocationStore,
  SESSION_REVOCATION_STORE,
} from './session-revocation.repository';

/**
 * The sign-out denylist (#112), promoted out of AppModule's bare provider list so
 * more than one module can reach it (#456), and durable since #679.
 *
 * @Global rather than an import list, because three modules now need the one
 * instance — the guard checks it, the logout controller writes to it, and the MCP
 * surface both reads and writes it — and a missed import is invisible until
 * revocation quietly stops working. Declaring the service in a second module's
 * `providers` instead would hand out a second instance and split the list, with
 * every unit test still green. That is the failure
 * `mcp-signout-revocation.integration.spec.ts` was written to catch for the
 * sibling registry, and `mcp.module.spec.ts` now catches it here.
 *
 * The store behind it is chosen here and nowhere else, the same way
 * `account.module.ts` chooses the personal-token store: Postgres when
 * IDENTITY_SOURCE=db, memory otherwise, because board still boots with no
 * database. There is no third mechanism and no fallback between the two — the
 * memory store announces at ERROR level what it costs, and a Prisma store that
 * cannot reach Postgres reports the failure to the caller instead of degrading
 * into it.
 */
@Global()
@Module({
  providers: [
    SessionRevocationService,
    {
      provide: SESSION_REVOCATION_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('IDENTITY_SOURCE') === 'db'
          ? new PrismaSessionRevocationStore(createPrismaClient())
          : new MemorySessionRevocationStore(),
    },
  ],
  exports: [SessionRevocationService, SESSION_REVOCATION_STORE],
})
export class SessionRevocationModule {}

import { createPrismaClient } from '../prisma';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import { McpOAuthProvider } from './mcp-oauth.provider';
import { ConsentController } from './consent.controller';
import { ConnectedClientsController } from './connected-clients.controller';
import { SessionService } from '../auth/session.service';
import { HumanOnlyGuard } from '../account/human-only.guard';
import {
  InMemoryMcpGrantRepository,
  MCP_GRANT_REPOSITORY,
  type McpGrantRepository,
  PrismaMcpGrantRepository,
} from './mcp-grant.repository';
import {
  CodeStore,
  InMemoryClientsStore,
  MCP_CLIENTS_STORE,
  MCP_CODE_STORE,
  MCP_PENDING_STORE,
  type McpClientsStore,
  type McpCodeStore,
  type McpPendingAuthStore,
  PendingAuthStore,
  PrismaClientsStore,
  PrismaCodeStore,
  PrismaPendingAuthStore,
} from './oauth-store';

/**
 * MCP OAuth surface: provider + consent screen. The /mcp transport controller
 * lives in AppModule (it injects AppModule-scoped services); main.ts skips the
 * auth-router mount when BOARD_MCP_ENABLED is off.
 *
 * MCP_GRANT_REPOSITORY is exported because the global auth guard and the
 * (AppModule-scoped) logout controller both bind to the one store the provider
 * writes grants into — the guard to check a token's row, the controller to
 * revoke every grant of a signing-out subject (#127/#456). The process-local
 * McpGrantRegistry that used to serve the second of those is gone: it could
 * only reach grants this process had minted itself, so a restart forgot them
 * all while their tokens stayed valid.
 *
 * This module holds the fifth PrismaClient in the application, and so the fifth
 * connection pool. identity, admin-authority, audit and account each construct
 * their own already — following that convention rather than introducing it. One
 * for the whole module rather than one per store: four stores landed here in
 * #456 and four pools for one module would be introducing something new.
 */

/** The module's own client, or null when nothing here is database-backed. */
const MCP_PRISMA_CLIENT = 'MCP_PRISMA_CLIENT';

const MCP_NEEDS_DB = 'BOARD_MCP_ENABLED=true requires IDENTITY_SOURCE=db';

/**
 * A provider that is the Postgres implementation when there is a database and
 * the in-memory seam when there is not — and neither when MCP is on without one.
 *
 * That last clause is the second lock. `config.schema.ts` refuses the pairing at
 * boot, so reaching the throw means the schema was bypassed; an MCP server
 * running on the in-memory seam would invalidate every token it minted on every
 * restart, and answer `invalid_client` to every client that had registered
 * before it. One helper rather than the same `if` written out four times, so the
 * four stores cannot drift into disagreeing about it.
 */
function storeProvider<T>(store: (prisma: PrismaClient) => T, seam: () => T) {
  return {
    inject: [ConfigService, MCP_PRISMA_CLIENT],
    useFactory: (config: ConfigService, prisma: PrismaClient | null): T => {
      if (prisma) return store(prisma);
      if (config.get<boolean>('BOARD_MCP_ENABLED')) throw new Error(MCP_NEEDS_DB);
      return seam();
    },
  };
}

@Module({
  imports: [ConfigModule],
  providers: [
    McpOAuthProvider,
    SessionService,
    HumanOnlyGuard,
    {
      provide: MCP_PRISMA_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('IDENTITY_SOURCE') === 'db' ? createPrismaClient() : null,
    },
    {
      provide: MCP_GRANT_REPOSITORY,
      ...storeProvider<McpGrantRepository>(
        (prisma) => new PrismaMcpGrantRepository(prisma),
        () => new InMemoryMcpGrantRepository(),
      ),
    },
    {
      provide: MCP_CLIENTS_STORE,
      ...storeProvider<McpClientsStore>(
        (prisma) => new PrismaClientsStore(prisma),
        () => new InMemoryClientsStore(),
      ),
    },
    {
      provide: MCP_PENDING_STORE,
      ...storeProvider<McpPendingAuthStore>(
        (prisma) => new PrismaPendingAuthStore(prisma),
        () => new PendingAuthStore(),
      ),
    },
    {
      provide: MCP_CODE_STORE,
      ...storeProvider<McpCodeStore>(
        (prisma) => new PrismaCodeStore(prisma),
        () => new CodeStore(),
      ),
    },
  ],
  controllers: [ConsentController, ConnectedClientsController],
  exports: [McpOAuthProvider, MCP_GRANT_REPOSITORY],
})
export class McpModule {}

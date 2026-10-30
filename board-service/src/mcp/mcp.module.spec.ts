import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { McpModule } from './mcp.module';
import { MCP_GRANT_REPOSITORY, InMemoryMcpGrantRepository, PrismaMcpGrantRepository } from './mcp-grant.repository';
import { AdminAuthorityModule } from '../auth/admin-authority.module';
import { AuditModule } from '../audit/audit.module';
import { SessionRevocationModule } from '../auth/session-revocation.module';
import { SessionRevocationService } from '../auth/session-revocation.service';

/**
 * The module graph around the grant store (#456). Two properties live here that
 * no unit test of the repository itself can reach.
 *
 * AdminAuthorityModule is imported explicitly because these graphs are McpModule
 * on its own rather than AppModule: ConsentController injects AdminAuthority, and
 * a @Global module still has to be somewhere in the graph to export anything.
 */
const envFor = (env: Record<string, unknown>) =>
  ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    // `GITHUB_ORGS` and `FEEDBACK_REPO` carry no defaults since #1175, and these
    // graphs build services that read both at construction.
    load: [() => ({ BOARD_SESSION_SECRET: 'module-spec-secret-0123456789', BOARD_BASE_URL: 'http://localhost', GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board', ...env })],
  });

describe('McpModule — the grant store it binds (#456)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('binds the Prisma store when IDENTITY_SOURCE=db', async () => {
    // PrismaClient reads this at construction. It does not connect here.
    process.env.DATABASE_URL = 'postgresql://board:board@localhost:5432/board';
    const mod = await Test.createTestingModule({
      imports: [envFor({ IDENTITY_SOURCE: 'db', BOARD_MCP_ENABLED: true }), AdminAuthorityModule, AuditModule, SessionRevocationModule, McpModule],
    }).compile();

    expect(mod.get(MCP_GRANT_REPOSITORY)).toBeInstanceOf(PrismaMcpGrantRepository);
    await mod.close();
  });

  it('binds the in-memory seam when MCP is off', async () => {
    const mod = await Test.createTestingModule({
      imports: [envFor({ IDENTITY_SOURCE: 'fixture', BOARD_MCP_ENABLED: false }), AdminAuthorityModule, AuditModule, SessionRevocationModule, McpModule],
    }).compile();

    expect(mod.get(MCP_GRANT_REPOSITORY)).toBeInstanceOf(InMemoryMcpGrantRepository);
    await mod.close();
  });

  // The second lock. config.schema.ts should already have refused this at boot;
  // making it a module invariant too costs one `if` and means the in-memory seam
  // can never be reached by a running MCP server, however the config got there.
  it('refuses to construct an MCP server on the in-memory seam', async () => {
    await expect(
      Test.createTestingModule({
        imports: [envFor({ IDENTITY_SOURCE: 'fixture', BOARD_MCP_ENABLED: true }), AdminAuthorityModule, AuditModule, SessionRevocationModule, McpModule],
      }).compile(),
    ).rejects.toThrow('BOARD_MCP_ENABLED=true requires IDENTITY_SOURCE=db');
  });
});

/**
 * The denylist has to be ONE instance. Task 7 injects SessionRevocationService
 * into McpOAuthProvider and Task 9 into a controller in this directory, and the
 * fix a builder reaches for — adding it to McpModule's own providers — hands out
 * a second instance and silently splits the list, with every unit test still
 * green. That is the same failure `mcp-signout-revocation.integration.spec.ts`
 * was written to catch for the grant store.
 */
describe('SessionRevocationModule — one denylist across module boundaries (#456)', () => {
  it('hands McpModule the same instance the root graph holds', async () => {
    const mod = await Test.createTestingModule({
      imports: [envFor({ IDENTITY_SOURCE: 'fixture', BOARD_MCP_ENABLED: false }), AdminAuthorityModule, AuditModule, SessionRevocationModule, McpModule],
    }).compile();

    // McpModule must declare none of its own, so a strict lookup inside it finds
    // nothing: Nest's strict mode searches a module's own providers and does not
    // follow @Global exports. Stated this way round because it is the property
    // that matters — a second declaration here is what splits the denylist.
    expect(() => mod.select(McpModule).get(SessionRevocationService, { strict: true })).toThrow(
      /does not exist in the current context/,
    );

    // And the instance everyone else resolves is the one the owning module holds.
    // The comparison has to be against THAT rather than between two consumers:
    // re-declaring the service in McpModule makes the duplicate win even at the
    // root, so consumer-to-consumer identity holds while the list is split in
    // two. Measured against a deliberately broken graph, not assumed.
    const owned = mod.select(SessionRevocationModule).get(SessionRevocationService, { strict: true });
    const fromRoot = mod.get(SessionRevocationService);
    expect(fromRoot).toBe(owned);

    // Shared state, not merely a shared reference.
    owned.revoke('jti-under-test', Date.now() + 60_000);
    expect(fromRoot.isRevoked('jti-under-test')).toBe(true);

    await mod.close();
  });
});

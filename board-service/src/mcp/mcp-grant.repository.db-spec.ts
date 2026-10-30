import { createPrismaClient } from '../prisma';
import { PrismaMcpGrantRepository } from './mcp-grant.repository';
import { describeMcpGrantRepository } from './mcp-grant.repository.contract';

/**
 * The Prisma store under the shared contract, against a real Postgres (#456).
 * Run with `pnpm run test:db`; `pnpm test` does not collect `.db-spec.ts`.
 *
 * Two things only this lane can prove, which is why it exists at all. That
 * Prisma's SQL is right and the migration applies — `pnpm test` runs against
 * neither Github nor Postgres and would pass over a broken where-clause. And
 * that `rotateRefreshPointer` really does let one of two concurrent callers win:
 * in the in-memory seam that holds because JavaScript is single-threaded, which
 * proves nothing about the compare-and-swap the deployment depends on.
 */

const prisma = createPrismaClient();

// Namespaced per run, so a leftover row from an interrupted run is never mistaken
// for this one's and two runs against the same database cannot collide.
const subPrefix = `db-spec-${process.pid}-${Date.now()}`;

describeMcpGrantRepository('PrismaMcpGrantRepository', async () => ({
  repo: new PrismaMcpGrantRepository(prisma),
  subPrefix,
  cleanup: async () => {
    // Routed through the grant: McpAccessToken and McpRefreshToken have no `sub`
    // column, so the grants this run created are found by their prefix and the
    // child rows deleted by `grantId`.
    const grants = await prisma.mcpGrant.findMany({
      where: { sub: { startsWith: subPrefix } },
      select: { id: true },
    });
    const grantIds = grants.map((g) => g.id);
    if (grantIds.length > 0) {
      await prisma.mcpAccessToken.deleteMany({ where: { grantId: { in: grantIds } } });
      await prisma.mcpRefreshToken.deleteMany({ where: { grantId: { in: grantIds } } });
      await prisma.mcpGrant.deleteMany({ where: { id: { in: grantIds } } });
    }
    await prisma.$disconnect();
  },
}));

import { InMemoryMcpGrantRepository } from './mcp-grant.repository';
import { describeMcpGrantRepository } from './mcp-grant.repository.contract';

/**
 * The in-memory seam under the shared contract (#456). The same suite runs
 * against Postgres in `mcp-grant.repository.db-spec.ts`; running it here too is
 * what keeps the seam honest, since every provider spec above it exchanges codes
 * with no database in sight and would otherwise be proving something about a
 * store that never runs in production.
 */
describeMcpGrantRepository('InMemoryMcpGrantRepository', async () => ({
  repo: new InMemoryMcpGrantRepository(),
  subPrefix: 'mem',
  // A fresh instance per run holds nothing anyone else can see.
  cleanup: async () => {},
}));

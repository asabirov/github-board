import { describe, expect, it } from 'vitest';
import { STORE_CONNECTIONS } from './github-store/concurrency';
import { createPrismaClient } from './prisma';

describe('Prisma pg URL compatibility', () => {
  it('runs concurrent queries with a pool limited to the store minimum', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', String(STORE_CONNECTIONS));
    const client = createPrismaClient(url.toString());
    try {
      const queries = await Promise.all(Array.from({ length: STORE_CONNECTIONS * 2 }, () =>
        client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM pg_sleep(0.1)`,
      ));
      expect(new Set(queries.map((rows) => rows[0].pid)).size).toBe(STORE_CONNECTIONS);
    } finally {
      await client.$disconnect();
    }
  });

  it('bounds a stalled query from URL settings', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', String(STORE_CONNECTIONS));
    url.searchParams.set('socket_timeout', '0.1');
    const client = createPrismaClient(url.toString());
    try {
      await expect(client.$queryRaw`SELECT pg_sleep(1)::text`).rejects.toThrow(/timeout/i);
    } finally {
      await client.$disconnect();
    }
  });
});

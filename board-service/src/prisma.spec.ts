import { expect, it } from 'vitest';
import { createPrismaClient } from './prisma';

it('accepts an identity database pool of two connections', async () => {
  const client = createPrismaClient('postgresql://u:p@localhost/db?connection_limit=2');
  await client.$disconnect();
  expect(client).toBeDefined();
});

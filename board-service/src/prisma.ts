import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

/** Prisma URL settings must be passed to pg explicitly with the driver adapter. */
export function createPrismaClient(
  connectionString = process.env.DATABASE_URL,
  { minimumConnections = 1, urlName = 'DATABASE_URL' }: { minimumConnections?: number; urlName?: string } = {},
): PrismaClient {
  const url = connectionString ? new URL(connectionString) : undefined;
  // Prisma 5 ignored trailing database slashes; pg treats them as part of its name.
  if (url) url.pathname = url.pathname.replace(/\/+$/, '');
  const params = url?.searchParams ?? new URLSearchParams();
  const limit = params.get('connection_limit');
  const max = limit === null ? undefined : Number(limit);
  if (max !== undefined && (!Number.isInteger(max) || max < minimumConnections)) {
    throw new Error(`${urlName} connection_limit=${limit} must be an integer at least ${minimumConnections}.`);
  }
  const seconds = (key: string, fallback: number) => Number(params.get(key) ?? fallback) * 1000;
  const schema = params.get('schema') ?? 'public';
  const identifier = `"${schema.replaceAll('"', '""')}"`;
  const adapter = new PrismaPg({
    connectionString: url?.toString(),
    max,
    connectionTimeoutMillis: seconds('pool_timeout', 10),
    query_timeout: seconds('socket_timeout', 0),
    // Raw SQL and ORM queries must resolve the same schema, including db tests.
    options: `-c search_path=${identifier.replace(/[\\\s]/g, '\\$&')}`,
  }, { schema });
  return new PrismaClient({ adapter });
}

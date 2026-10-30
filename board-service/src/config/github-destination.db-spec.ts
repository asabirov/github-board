import { ConfigService } from '@nestjs/config';
import { afterEach, expect, it, vi } from 'vitest';
import { GithubDestinationBootstrap } from './github-destination-bootstrap';
import { initializeDestinations } from './github-destination';
import { createPrismaClient } from '../prisma';

afterEach(() => vi.unstubAllEnvs());
it('persists the first id across service instances and refuses name reuse after restart', async () => {
  vi.stubEnv('FEEDBACK_REPO_ID', undefined);
  const database = createPrismaClient(process.env.BOARD_DB_TEST_STORE_URL);
  const config = () => new ConfigService({ GITHUB_STORE_DATABASE_URL: process.env.BOARD_DB_TEST_STORE_URL, FEEDBACK_REPO: 'o/feedback' });
  const first = new GithubDestinationBootstrap(config());
  let second: GithubDestinationBootstrap | undefined;
  try {
    const winners = await Promise.all([first.bind('FEEDBACK_REPO', 42), first.bind('FEEDBACK_REPO', 99)]);
    expect(winners[0]).toBe(winners[1]);
    const originalId = winners[0];
    await first.onModuleDestroy();
    const nextConfig = config();
    second = new GithubDestinationBootstrap(nextConfig);
    expect(await second.read('FEEDBACK_REPO')).toBe(originalId);
    const logger = { log: vi.fn(), error: vi.fn() };
    await initializeDestinations(nextConfig, { request: async () => ({ data: { id: 100, full_name: 'o/feedback' } }) }, logger, second);
    expect(nextConfig.get('FEEDBACK_REPO_ID')).toBe(originalId);
    expect((await database.githubDestination.findUniqueOrThrow({ where: { key: 'FEEDBACK_REPO' } })).repositoryId).toBe(BigInt(originalId));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('identity mismatch'));
  } finally {
    await database.githubDestination.deleteMany({ where: { key: 'FEEDBACK_REPO' } });
    await first.onModuleDestroy();
    await second?.onModuleDestroy();
    await database.$disconnect();
  }
});

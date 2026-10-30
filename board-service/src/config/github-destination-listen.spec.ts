import { expect, it, vi } from 'vitest';
const { events, app } = vi.hoisted(() => {
  const events: string[] = [];
  return { events, app: {
    get: (token: { name: string }) => token.name === 'ConfigService'
      ? { get: (key: string, fallback?: unknown) => key === 'ISSUES_SOURCE' ? 'github' : fallback }
      : token.name === 'GithubDestinationBootstrap' ? { start: () => { events.push('destinations'); } } : {},
    setGlobalPrefix: vi.fn(), useBodyParser: vi.fn(), enableCors: vi.fn(),
    listen: async () => { events.push('listening'); },
  } };
});
vi.mock('@nestjs/core', () => ({ NestFactory: { create: async () => app } }));
vi.mock('../app.module', () => ({ AppModule: class {} }));
vi.mock('./body-limits', () => ({ applyBodyParsers: vi.fn() }));
vi.mock('../sources/github-client', () => ({ buildOctokitClient: () => ({ request: () => new Promise(() => {}) }) }));
it('listens before starting background GitHub resolution', async () => {
  await import('../main.js');
  await vi.waitFor(() => expect(events).toEqual(['listening', 'destinations']));
});

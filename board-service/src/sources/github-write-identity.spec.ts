import { ConfigService } from '@nestjs/config';
import { afterEach, expect, it, vi } from 'vitest';
import { buildOctokitClient } from './github-client';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
const person: GithubPrincipal = {
  key: 'stable-write', email: 'alice@example.test', login: 'alice', token: 'token', cache: new WeakMap(),
  owners: [{ id: 7, login: 'old', type: 'Organization' }],
  repositories: [{ id: 42, full_name: 'old/widgets', name: 'widgets', owner: { login: 'old' } }],
};
afterEach(() => vi.unstubAllGlobals());
it('refuses name reuse between discovery and the write without dispatching the mutation', async () => {
  const wire: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    wire.push(init.method);
    return new Response(JSON.stringify({ id: 99, full_name: 'old/widgets' }), { headers: { 'content-type': 'application/json' } });
  }));
  await githubContext.run({ principal: person }, async () => {
    const client = buildOctokitClient(new ConfigService({}), 'write');
    await expect(client.issues.create({ owner: 'old', repo: 'widgets', title: 'private words' })).rejects.toThrow(/identity/);
  });
  expect(wire).toEqual(['GET']);
});
it('refuses a write whose personal authorization expired in flight', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await githubContext.run({ principal: { ...person, expiresAt: Date.now() - 1 } }, async () => {
    const client = buildOctokitClient(new ConfigService({}), 'write');
    await expect(client.issues.create({ owner: 'old', repo: 'widgets', title: 'private words' })).rejects.toThrow(/access/);
  });
  expect(fetch).not.toHaveBeenCalled();
});

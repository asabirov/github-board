import type { ConfigService } from '@nestjs/config';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Octokit } from '@octokit/rest';
import { githubPrincipal } from '../auth/github-principal';

const bindings = new WeakMap<object, Map<string, number>>();
export function bindWriteRepository(client: object, fullName: string, id: number): void {
  let held = bindings.get(client);
  if (!held) { held = new Map(); bindings.set(client, held); }
  held.set(fullName.toLowerCase(), id);
}

export function withGithubWriteIdentity(client: Octokit, config: ConfigService): Octokit {
  const person = githubPrincipal();
  if (!person) {
    // The boot alert is the one repository the service writes to as itself.
    const name = config.get<string>('BOOT_ALERT_REPO');
    const id = Number(config.get<number>('BOOT_ALERT_REPO_ID'));
    if (name && Number.isSafeInteger(id) && id > 0) bindWriteRepository(client, name, id);
  }
  client.hook.wrap('request', async (request, options) => {
    if (String(options.method).toUpperCase() === 'GET') return request(options);
    const current = githubPrincipal();
    if (person && (current !== person || (person.expiresAt !== undefined && person.expiresAt <= Date.now()))) {
      throw new ForbiddenException('Your GitHub access changed. Reload before writing.');
    }
    const { endpoint } = client.request;
    const parsed = endpoint.parse(options);
    const target = /^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(new URL(parsed.url).pathname);
    // GraphQL writes address global node IDs, not owner/repository names.
    if (!target) return request(options);
    const fullName = `${decodeURIComponent(target[1])}/${decodeURIComponent(target[2])}`;
    const expected = bindings.get(client)?.get(fullName.toLowerCase())
      ?? person?.repositories.find(repo => repo.full_name.toLowerCase() === fullName.toLowerCase())?.id;
    if (!expected) throw new ConflictException('The GitHub destination has no verified identity. Select the destination again.');
    const check = await client.request('GET /repos/{owner}/{repo}', {
      owner: target[1], repo: target[2], request: { redirect: 'error' },
    });
    if ((check.data as { id?: unknown }).id !== expected) {
      throw new ConflictException('The GitHub destination identity changed. Select the destination again.');
    }
    if (person && person.expiresAt !== undefined && person.expiresAt <= Date.now()) {
      throw new ForbiddenException('Your GitHub access changed. Reload before writing.');
    }
    options.request = { ...options.request, redirect: 'error' };
    return request(options);
  });
  return client;
}

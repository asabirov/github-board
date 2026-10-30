import { bindWriteRepository } from '../sources/github-write-identity';
import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { githubPrincipal } from '../auth/github-principal';
import { resolveRepository, targetId } from '../auth/github-target';

export type DestinationKey = 'FEEDBACK_REPO' | 'BOOT_ALERT_REPO';
interface RepositoryReader {
  request: (route: 'GET /repositories/{repository_id}', parameters: { repository_id: number }) => Promise<{ data: { id: number; full_name: string } }>;
}
export function destinationId(config: ConfigService, key: DestinationKey): number {
  const id = config.get<number>(`${key}_ID`);
  if (id === undefined) throw new ConflictException('This destination is being set up. Try again shortly.');
  return targetId(id);
}

/** The name setting is retained as migration evidence, never rebound on a read. */
export async function configuredRepository(config: ConfigService, key: DestinationKey, client: RepositoryReader): Promise<{ owner: string; repo: string; id: number }> {
  const id = destinationId(config, key);
  const person = githubPrincipal();
  if (person) resolveRepository(person, id);
  const { data } = await client.request('GET /repositories/{repository_id}', { repository_id: id });
  if (data.id !== id) throw new ConflictException('The GitHub destination identity changed. Select the destination again.');
  const [owner, repo, extra] = data.full_name.split('/');
  if (!owner || !repo || extra) throw new ConflictException('The GitHub destination identity could not be verified.');
  bindWriteRepository(client, data.full_name, id);
  return { owner, repo, id };
}

export interface RepositoryNameReader {
  request: (route: 'GET /repos/{owner}/{repo}' | 'GET /repositories/{repository_id}', parameters: { owner?: string; repo?: string; repository_id?: number; request: { redirect: 'manual'; signal?: AbortSignal } }) => Promise<{ status?: number; headers?: { location?: string }; data: { id?: number; full_name?: string; url?: string } }>;
}

export async function repositoryAtName(client: RepositoryNameReader, fullName: string): Promise<number> {
  const [owner, repo, extra] = fullName.split('/');
  if (!owner || !repo || extra) throw new ConflictException('The GitHub repository name is ambiguous.');
  const response = await client.request('GET /repos/{owner}/{repo}', { owner, repo, request: { redirect: 'manual', signal: AbortSignal.timeout(10_000) } });
  if (response.status === 301 || response.status === 302) {
    const location = response.headers?.location ?? response.data.url;
    const match = location?.match(/^https:\/\/api\.github\.com\/repositories\/([1-9][0-9]*)$/);
    if (!match) throw new ConflictException('The GitHub repository redirect could not be verified.');
    const id = targetId(match[1]);
    const redirected = await client.request('GET /repositories/{repository_id}', { repository_id: id, request: { redirect: 'manual', signal: AbortSignal.timeout(10_000) } });
    if (redirected.data.id !== id || !redirected.data.full_name || (redirected.status && redirected.status !== 200)) {
      throw new ConflictException('The GitHub repository redirect could not be verified.');
    }
    if (redirected.data.full_name.split('/')[0].toLowerCase() !== owner.toLowerCase()) {
      throw new ConflictException('The GitHub repository redirect changed owner and was refused.');
    }
    return id;
  }
  if (response.data.full_name?.toLowerCase() !== fullName.toLowerCase()) throw new ConflictException('The GitHub repository name is ambiguous.');
  return targetId(response.data.id);
}

export interface DestinationBindings {
  readonly persisted?: boolean;
  read(key: DestinationKey): Promise<number | undefined>;
  bind(key: DestinationKey, id: number): Promise<number>;
}
const states = new WeakMap<ConfigService, Map<DestinationKey, { name: string; settled: boolean; failure?: string }>>();
const overrides = new WeakMap<ConfigService, Map<DestinationKey, number>>();

/** Returns true when no destinations need retry, including stopped 404s. */
export async function initializeDestinations(config: ConfigService, client: RepositoryNameReader, logger: { log(message: string): void; error(message: string): void }, store: DestinationBindings): Promise<boolean> {
  const keys = ['FEEDBACK_REPO', 'BOOT_ALERT_REPO'] as const;
  if (!overrides.has(config)) overrides.set(config, new Map(keys.flatMap(key => {
    const id = config.get<number>(`${key}_ID`);
    return id === undefined ? [] : [[key, targetId(id)]];
  })));
  if (!states.has(config)) states.set(config, new Map());
  const state = states.get(config)!;
  const results = await Promise.all(keys.map(async key => {
    const name = config.get<string>(key);
    if (!name) return true;
    const previous = state.get(key);
    if (previous?.name === name && previous.settled) return true;
    try {
      const override = overrides.get(config)!.get(key);
      if (override !== undefined) {
        config.set(`${key}_ID`, override);
        return true;
      }
      const stored = await store.read(key);
      // Restore before GitHub: an outage must not discard an established identity.
      if (stored !== undefined) config.set(`${key}_ID`, stored);
      const current = await repositoryAtName(client, name);
      const id = stored ?? await store.bind(key, current);
      config.set(`${key}_ID`, id);
      if (id !== current) logger.error(`${key}=${name} identity mismatch: keeping stored repository ${id}; name now resolves to ${current}. Set ${key}_ID only after verifying an intentional change.`);
      else logger.log(`${key}=${name} -> ${id} (${store.persisted === false ? 'not persisted; pinned for this process only' : 'persisted'})`);
      state.set(key, { name, settled: true });
      return true;
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      const stopped = status === 404;
      const failure = `${status ?? 'unknown'}:${error instanceof Error ? error.message : ''}`;
      if (previous?.name !== name || previous.failure !== failure) {
        logger.error(`Cannot resolve ${key}=${name}: ${failure}. Keeping any stored ID. ${stopped ? '404: retry stopped until restart or setting change.' : 'Retrying in the background.'}`);
      }
      state.set(key, { name, settled: stopped, failure });
      return stopped;
    }
  }));
  return results.every(Boolean);
}

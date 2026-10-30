import { channel } from 'node:diagnostics_channel';
import { createHmac, randomBytes } from 'node:crypto';
import type { Octokit } from '@octokit/rest';

const requests = channel('board.github.request');
const salt = randomBytes(32);
export interface GithubRequestMeasurement {
  identity: string;
  actor: 'person' | 'machine';
  source: 'discovery' | 'surface';
  resource: 'core' | 'search' | 'graphql';
  status: number;
  elapsedMs: number;
  remaining?: number;
  used?: number;
  reset?: number;
  graphqlCost?: number;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Install inside the ETag and quota wrappers: observe the upstream 304, not
 * its replayed 200, and never count a request refused locally by the cooldown.
 * No subscriber means no events or retained counters. Identity is comparable
 * only within this process; tokens, paths, queries and payloads never leave it. */
export function withGithubRequestMetrics(client: Octokit, identity: string, source: GithubRequestMeasurement['source']): Octokit {
  let pseudonym: string | undefined;
  client.hook.wrap('request', async (request, options) => {
    if (!requests.hasSubscribers) return request(options);
    const started = performance.now();
    const pathname = new URL(options.url, 'https://api.github.com').pathname;
    const resource = pathname.endsWith('/graphql') ? 'graphql' : pathname.startsWith('/search/') ? 'search' : 'core';
    const observe = (value: unknown) => {
      const response = record(value);
      const headers = record(response.headers);
      const data = record(record(response.data).data);
      pseudonym ??= createHmac('sha256', salt).update(identity).digest('hex');
      requests.publish({
        identity: pseudonym, actor: identity.startsWith('user:') ? 'person' : 'machine', source, resource, status: number(response.status) ?? 0,
        elapsedMs: performance.now() - started,
        remaining: number(headers['x-ratelimit-remaining']), used: number(headers['x-ratelimit-used']), reset: number(headers['x-ratelimit-reset']),
        graphqlCost: resource === 'graphql' ? number(record(data.rateLimit).cost) : undefined,
      } satisfies GithubRequestMeasurement);
    };
    try {
      const response = await request(options);
      observe(response);
      return response;
    } catch (error) {
      observe(record(error).response);
      throw error;
    }
  });
  return client;
}

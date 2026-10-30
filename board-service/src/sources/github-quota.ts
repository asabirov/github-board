import { ServiceUnavailableException, type LoggerService } from '@nestjs/common';
import type { Octokit } from '@octokit/rest';

const MAX_COOLDOWNS = 4096;
const CLOCK_MARGIN_MS = 1000;

export class GithubQuotaCooldownError extends ServiceUnavailableException {
  constructor(readonly retryAt: number) {
    super('GitHub GraphQL quota is cooling down; retry after ' + new Date(retryAt).toISOString());
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function nonnegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** When a Github response says the quota is spent, the moment it lifts, and
 *  `undefined` for every other response. `response` is Octokit's shape: status,
 *  headers, and the body at `data`.
 *
 *  `refusal` asks the stricter question a failed call needs (#986 review): was
 *  the refusal ABOUT quota? A spent budget in the headers is enough to stop
 *  sending (the cooldown below) but not to call a failure a cooldown: a 401, a
 *  permission 403 or a 500 that happened to use the last point is still that
 *  failure. So a refusal counts only when it says rate limit itself, is a 429,
 *  or carries Github's Retry-After. */
function quotaDeadline(response: unknown, now: number, refusal = false): number | undefined {
  const raw = record(response);
  const headers = Object.fromEntries(Object.entries(record(raw.headers)).map(([k, v]) => [k.toLowerCase(), v]));
  const data = record(raw.data);
  const errors = Array.isArray(data.errors) ? data.errors.map(record) : [];
  // `RATE_LIMIT` is what Github sends; `RATE_LIMITED` is the schema's own
  // spelling of the same refusal.
  const limited = errors.some((e) => e.type === 'RATE_LIMIT' || e.type === 'RATE_LIMITED') ||
    /(?:secondary rate limit|api rate limit|rate limit (?:already )?exceeded)/i.test(String(data.message ?? '')) ||
    errors.some((e) => /(?:secondary rate limit|api rate limit|rate limit (?:already )?exceeded)/i.test(String(e.message ?? '')));
  const exhausted = headers['x-ratelimit-remaining'] === '0' || headers['x-ratelimit-remaining'] === 0;
  const reset = nonnegativeNumber(headers['x-ratelimit-reset']);
  const retry = nonnegativeNumber(headers['retry-after']);
  // A permission 403 alone is never a quota verdict. An explicit Retry-After
  // on 403/429 is Github's secondary-limit instruction.
  const secondary = limited || ((raw.status === 403 || raw.status === 429) && retry !== undefined);
  if (refusal && !secondary && raw.status !== 429) return undefined;
  if (!exhausted && !secondary) return undefined;
  const deadlines = [
    exhausted && reset !== undefined ? reset * 1000 + CLOCK_MARGIN_MS : 0,
    secondary && retry !== undefined ? now + retry * 1000 + CLOCK_MARGIN_MS : 0,
  ].filter((deadline) => Number.isFinite(deadline) && deadline > now && deadline <= 8.64e15);
  return deadlines.length ? Math.max(...deadlines) : now + 60_000;
}

/**
 * When a failed Github call was a quota refusal, the moment it lifts; for any
 * other failure, `undefined` (#986).
 *
 * The same verdict the cooldown below reaches, read off the thrown error rather
 * than off the response, so a caller can tell "not now, and here is when" from a
 * failure somebody has to act on. `@octokit/request` puts the whole response on
 * the error; `@octokit/graphql` puts the body at `response` and its headers
 * beside it, so both are read. A refusal that says nothing about quota, a
 * permission 403 or a `FORBIDDEN` included, answers `undefined`. An error that
 * wraps the refusal as its `cause`, as the issue ingest's org read does, is read
 * through to it.
 */
export function quotaRetryAt(err: unknown, now = Date.now()): number | undefined {
  for (let at = err, depth = 0; at !== null && typeof at === 'object' && depth < 4; at = record(at).cause, depth += 1) {
    if (at instanceof GithubQuotaCooldownError) return at.retryAt;
    const held = record(at);
    const retryAt = quotaDeadline(held.response, now, true) ?? quotaDeadline({ headers: held.headers, data: held.response }, now, true);
    if (retryAt !== undefined) return retryAt;
  }
  return undefined;
}

/**
 * Logs a failed Github call at the level it deserves, and answers when the quota
 * lifts for a quota refusal, `undefined` for any other failure (#986).
 *
 * A spent quota is hourly, expected and lifts on its own, so nobody can act on
 * it: it is a warning that says when. At `error`, `BootErrorRecorder` files it as
 * a boot alert, which is how a rate limit became a production issue. Every other
 * failure is still logged as `failed` at `error`, and still files. Every call site
 * a boot reaches uses this, so the rule cannot drift between them.
 */
export function logGithubFailure(
  logger: Pick<LoggerService, 'warn' | 'error'>,
  err: unknown,
  failed: string,
  deferred: string,
): number | undefined {
  const retryAt = quotaRetryAt(err);
  if (retryAt === undefined) logger.error(failed);
  else logger.warn(`${deferred}: ${quotaCooldownNote(retryAt)}`);
  return retryAt;
}

/** How a quota refusal reads in the log: when it lifts. */
export function quotaCooldownNote(retryAt: number): string {
  return `Github quota is cooling down until ${new Date(retryAt).toISOString()}`;
}

/** Negative admission only: this holds no Github data or permission verdicts.
 * New clients and renewed permission caches share the same process budget. */
export class GithubQuotaCooldown {
  private readonly until = new Map<string, number>();

  private expire(now: number): void {
    for (const [key, deadline] of this.until) if (deadline <= now) this.until.delete(key);
  }

  admit(identity: string): void {
    this.expire(Date.now());
    const deadline = this.until.get(identity);
    if (deadline !== undefined) throw new GithubQuotaCooldownError(deadline);
  }

  observe(identity: string, response: unknown): void {
    const now = Date.now();
    this.expire(now);
    const deadline = quotaDeadline(response, now);
    if (deadline === undefined) return;
    if (!this.until.has(identity) && this.until.size >= MAX_COOLDOWNS) {
      // Expired entries have already gone. Under unusual identity churn, evict
      // the soonest deadline rather than retaining credentials without a bound.
      let earliest: string | undefined;
      let nearest = Infinity;
      for (const [key, value] of this.until) if (value < nearest) { earliest = key; nearest = value; }
      if (earliest !== undefined) this.until.delete(earliest);
    }
    this.until.set(identity, Math.max(this.until.get(identity) ?? 0, deadline));
  }
}

const cooldown = new GithubQuotaCooldown();

export function withGithubQuota(client: Octokit, identity: string): Octokit {
  client.hook.wrap('request', async (request, options) => {
    const pathname = new URL(options.url, 'https://api.github.com').pathname;
    if (pathname !== '/graphql' && pathname !== '/api/graphql') return request(options);
    cooldown.admit(identity);
    try {
      const response = await request(options);
      // GraphQL errors arrive in an HTTP 200 body. Octokit's graphql helper
      // throws them only after this request hook returns.
      cooldown.observe(identity, response);
      return response;
    } catch (error) {
      cooldown.observe(identity, record(error).response);
      throw error;
    }
  });
  return client;
}

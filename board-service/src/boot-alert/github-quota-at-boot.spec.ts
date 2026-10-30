import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, type LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { BootErrorRecorder } from './boot-error-recorder';
import { reportBootErrors } from './boot-alert.notifier';
import { GithubDeliverySource } from '../delivery/github-delivery.source';
import { GithubIssuesSource } from '../issues-metrics/github-issues.source';
import { CapabilityRegistry } from '../capability/capability.registry';
import { GithubQuotaCooldownError } from '../sources/github-quota';

/**
 * A Github quota cooldown while the service starts is not a boot alert (#986).
 *
 * #986 is a production issue board filed about itself: the boot warm's delivery
 * read met "API rate limit already exceeded", logged it at `error`, and
 * `BootErrorRecorder`, which files every `error` a boot logs without reading its
 * words, turned an hourly, expected and unactionable condition into an issue.
 * The recorder is right to key on severity alone, so the fix is the severity:
 * a quota refusal is a warning that says when it lifts, and every other failure
 * is still an error that files.
 *
 * Every boot path that reads Github on the deployment token and logs its own
 * failure is driven here, each through both halves of a real boot on one
 * Octokit stub: the path's read, and the boot notifier's issue writes after it.
 * The warms above the first two already log at `warn`.
 */
const { graphql, paginate, request, create, createComment, listForRepo } = vi.hoisted(() => ({
  graphql: vi.fn(),
  paginate: vi.fn(),
  request: vi.fn(),
  create: vi.fn(),
  createComment: vi.fn(),
  listForRepo: vi.fn(),
}));
vi.mock('../sources/github-client', () => ({
  buildOctokitClient: () => ({ graphql, paginate, request: (...args: unknown[]) => args[0] === 'GET /repositories/{repository_id}' ? Promise.resolve({ data: { id: 42, full_name: 'acme/board' } }) : request(...args), repos: { listForOrg: vi.fn() }, issues: { create, createComment, listForRepo } }),
  tokenFor: () => 'stub-credential',
}));

const config = {
  get: (key: string, fallback?: unknown) =>
    ({
      GITHUB_WRITE_ENABLED: true,
      GITHUB_TOKEN: 'stub-credential',
      GITHUB_ORGS: 'acme',
      // No default since #1175: a board that can write names where a bad boot
      // reports, and the notifier logs and returns without one.
      BOOT_ALERT_REPO: 'acme/board',
      BOOT_ALERT_REPO_ID: 42,
      BOOT_ALERT_ASSIGNEE: 'on-call',
      FEEDBACK_REPO: 'acme/board',
    } as Record<string, unknown>)[key] ?? fallback,
} as unknown as ConfigService;

const RESET_S = 1_900_000_000;
const retryAt = new Date(RESET_S * 1000 + 1000).toISOString();

/** Github's REST-shaped refusal, the one #986 logged: a 403 whose headers say
 *  the budget is spent, as `@octokit/request` puts it on the error. */
const restRateLimit = () =>
  Object.assign(new Error('API rate limit already exceeded for user ID 733858.'), {
    status: 403,
    response: {
      status: 403,
      url: 'https://api.github.com/graphql',
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_S) },
      data: { message: 'API rate limit already exceeded for user ID 733858.' },
    },
  });

/** The GraphQL-shaped one: a 200 carrying `RATE_LIMITED`, as `@octokit/graphql`
 *  throws it, with the body at `response` and the headers beside it. */
const graphqlRateLimit = () => {
  const errors = [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 733858.' }];
  return Object.assign(new Error('Request failed due to following response errors:\n - API rate limit exceeded for user ID 733858.'), {
    name: 'GraphqlResponseError',
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_S) },
    response: { data: null, errors },
    errors,
  });
};

/** The cooldown board keeps for itself, which only a GraphQL call can meet. */
const cooldown = () => new GithubQuotaCooldownError(RESET_S * 1000 + 1000);

/** A 403 that is not a spent budget: remaining is not 0 and there is no
 *  Retry-After, so it is a permission answer and somebody has to act on it. */
const forbidden = () =>
  Object.assign(new Error('Resource not accessible by integration'), {
    status: 403,
    response: { status: 403, headers: { 'x-ratelimit-remaining': '4999' }, data: { message: 'Resource not accessible by integration' } },
  });

/** A refusal about the reader that happened to spend the last point (#986 review). */
const spentOnAFailure = () =>
  Object.assign(new Error('Bad credentials'), {
    status: 401,
    response: { status: 401, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_S) }, data: { message: 'Bad credentials' } },
  });

/** Each path: how it meets a failure on its one Github call, the refusals that
 *  call can actually get, what it files for a genuine failure, and how its read
 *  says it did not get an answer. */
const PATHS = [
  {
    name: 'the delivery warm',
    meet: (failure: unknown) => {
      graphql.mockRejectedValueOnce(failure);
      return new GithubDeliverySource(config).load('acme').then(() => 'served', (e: Error) => `failed: ${e.message}`);
    },
    refusals: [['the cooldown board keeps for itself', cooldown], ['Github`s REST-shaped refusal', restRateLimit], ['Github`s GraphQL-shaped refusal', graphqlRateLimit]],
    filed: 'delivery fetch failed for acme: Bad credentials',
    notAnswered: /^failed: .*cooling down/,
  },
  {
    name: 'the issue ingest`s org read',
    meet: (failure: unknown) => {
      paginate.mockRejectedValueOnce(failure);
      return new GithubIssuesSource(config).listIssues().then(() => 'served', (e: Error) => `failed: ${e.message}`);
    },
    refusals: [['Github`s REST-shaped refusal', restRateLimit]],
    filed: 'the repo list for acme could not be read (Bad credentials)',
    notAnswered: /^failed: /,
  },
  {
    name: 'the capability probe`s org read',
    meet: (failure: unknown) => {
      request.mockRejectedValueOnce(failure);
      return new CapabilityRegistry(config).orgProbe().then((out) => out.map((o) => o.state).join());
    },
    refusals: [['Github`s REST-shaped refusal', restRateLimit]],
    filed: 'org read: acme — unreadable (Bad credentials)',
    notAnswered: /^unreadable$/,
  },
] as const;

const heldLogger = (Logger as unknown as { staticInstanceRef?: LoggerService }).staticInstanceRef;
afterEach(() => {
  if (heldLogger) Logger.overrideLogger(heldLogger);
  vi.clearAllMocks();
});

/** One boot whose Github read meets `failure`: the recorder installed the way
 *  `main.ts` installs it, the read, then what `main.ts` does after `listen`. */
async function bootMeeting(meet: (failure: unknown) => Promise<string>, failure: unknown) {
  const console = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn(), fatal: vi.fn() };
  const recorder = new BootErrorRecorder(console as unknown as LoggerService);
  Logger.overrideLogger(recorder);
  listForRepo.mockResolvedValue({ data: [] });
  create.mockResolvedValue({ data: { number: 1, html_url: 'https://github.com/x/y/issues/1' } });
  const read = await meet(failure);
  await reportBootErrors(config, recorder.drain());
  return { console, read };
}

for (const path of PATHS) {
  describe(`a quota cooldown at boot, in ${path.name} (#986)`, () => {
    for (const [name, failure] of path.refusals) {
      it(`files nothing for ${name}, and says when it lifts`, async () => {
        const { console, read } = await bootMeeting(path.meet, failure());
        expect(create, 'no boot alert').not.toHaveBeenCalled();
        expect(listForRepo, 'Github not even asked about one').not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(console.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(retryAt);
        // The read still says it got no answer: nothing is served empty over a refusal.
        expect(read).toMatch(path.notAnswered);
      });
    }

    it('still files a genuine failure, which is what the recorder is for', async () => {
      const { console, read } = await bootMeeting(path.meet, new Error('Bad credentials'));
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(create, 'one boot alert').toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].body).toContain(path.filed);
      expect(read).not.toBe('served');
    });

    it('still files a refusal that is about the reader, even one carrying a quota header', async () => {
      await bootMeeting(path.meet, forbidden());
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('still files a refusal about the reader that happened to spend the last point (#986 review)', async () => {
      const { console } = await bootMeeting(path.meet, spentOnAFailure());
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
    });
  });
}

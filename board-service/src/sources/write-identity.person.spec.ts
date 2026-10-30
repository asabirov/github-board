import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { WriteIdentityService } from './write-identity.service';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';

/**
 * Write identity is a DEPLOYMENT diagnostic (#892 review, F1).
 *
 * `held` and `inFlight` are process-wide and a `resolved` answer is never
 * retaken, so a single read that picks up the request's person pins that
 * person's Github login as the board's answer for the life of the process —
 * and serves it to every other admin. These are the four ways in, and every
 * one of them must arrive at the deployment credential.
 */
const person = (name: string, token: string | null): GithubPrincipal => ({
  key: name,
  email: `${name}@example.test`,
  login: name,
  token,
  owners: [],
  repositories: [],
  cache: new WeakMap(),
});

const config = () =>
  new ConfigService({
    GITHUB_TOKEN: 'deployment-read',
    GITHUB_WRITE_TOKEN: 'deployment-write',
    GITHUB_WRITE_ENABLED: true,
  });

describe('write identity never reports the acting person (#892)', () => {
  it('asks under the deployment credential for Alice, for Bob and at boot', async () => {
    const asked: string[] = [];
    const service = new WriteIdentityService(config(), async (token) => {
      asked.push(token);
      return `login-of-${token}`;
    });

    const alice = await githubContext.run({ principal: person('alice', 'ghu_alice') }, () =>
      service.resolve(),
    );
    const bob = await githubContext.run({ principal: person('bob', 'ghu_bob') }, () =>
      service.resolve(),
    );
    const boot = await service.resolve();

    expect(asked, 'only the deployment write token is ever spent').toEqual(['deployment-write']);
    for (const [who, answer] of [['alice', alice], ['bob', bob], ['boot', boot]] as const) {
      expect(answer.state, who).toBe('resolved');
      expect(answer.login, who).toBe('login-of-deployment-write');
    }
  });

  it('answers an unconnected admin rather than throwing at them', async () => {
    const service = new WriteIdentityService(config(), async () => 'deployment-bot');
    // `tokenFor` throws ForbiddenException for a person with no token, and
    // `resolve` is documented never to reject.
    const answer = await githubContext.run({ principal: person('carol', null) }, () =>
      service.resolve(),
    );
    expect(answer.state).toBe('resolved');
    expect(answer.login).toBe('deployment-bot');
  });

  it('retries a transient failure under the deployment credential, not the next caller', async () => {
    const asked: string[] = [];
    let clock = 1_000_000;
    let fail = true;
    const service = new WriteIdentityService(
      config(),
      async (token) => {
        asked.push(token);
        if (fail) throw new Error('Github is unreachable');
        return `login-of-${token}`;
      },
      () => clock,
    );

    const first = await service.resolve();
    expect(first.state).toBe('unknown');

    // Past the failure TTL, so the next caller retakes it — and that caller is
    // a person. The retake must not become their identity.
    clock += 61_000;
    fail = false;
    const retried = await githubContext.run({ principal: person('alice', 'ghu_alice') }, () =>
      service.resolve(),
    );
    expect(retried.login).toBe('login-of-deployment-write');
    expect(asked).toEqual(['deployment-write', 'deployment-write']);
  });

  it('shares one in-flight answer between two people without contaminating it', async () => {
    const asked: string[] = [];
    let release!: (login: string) => void;
    const service = new WriteIdentityService(config(), (token) => {
      asked.push(token);
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });

    const alice = githubContext.run({ principal: person('alice', 'ghu_alice') }, () =>
      service.resolve(),
    );
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    const bob = githubContext.run({ principal: person('bob', 'ghu_bob') }, () => service.resolve());
    release('login-of-deployment-write');

    expect((await alice).login).toBe('login-of-deployment-write');
    expect((await bob).login).toBe('login-of-deployment-write');
    expect(asked, 'one shared call, and it was the deployment one').toEqual(['deployment-write']);
  });
});

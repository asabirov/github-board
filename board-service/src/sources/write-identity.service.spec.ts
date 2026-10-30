import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { defaultAsk, WriteIdentityService } from './write-identity.service';

/** A ConfigService over a plain record, the shape the sibling specs in this
 *  folder use. `get(key, fallback)` is the only method reached. */
function cfg(values: Record<string, string | boolean>): ConfigService {
  return {
    get: <T>(key: string, fallback?: T): T | undefined =>
      (values[key] as unknown as T) ?? fallback,
  } as unknown as ConfigService;
}

const WRITES_ON = { GITHUB_TOKEN: 'ghp_read', GITHUB_WRITE_TOKEN: 'ghp_write', GITHUB_WRITE_ENABLED: true };

describe('WriteIdentityService — which account the board writes as (#756)', () => {
  it('names the account Github answers with', async () => {
    const svc = new WriteIdentityService(cfg(WRITES_ON), async () => 'board-bot');
    const identity = await svc.resolve();
    expect(identity.state).toBe('resolved');
    expect(identity.login).toBe('board-bot');
    expect(identity.reason).toBeNull();
    expect(identity.writesEnabled).toBe(true);
    expect(identity.separateWriteToken).toBe(true);
  });

  it('asks Github exactly once and serves the same answer after that', async () => {
    let calls = 0;
    const svc = new WriteIdentityService(cfg(WRITES_ON), async () => {
      calls += 1;
      return 'board-bot';
    });
    await svc.resolve();
    await svc.resolve();
    await svc.resolve();
    expect(calls).toBe(1);
  });

  it('never re-reads a resolved login, however long the process runs', async () => {
    // DECIDED, not defaulted (#756 review): a resolved answer is held for the
    // life of the process and has no TTL. The credential comes from the
    // environment, so changing which account this board writes as is a
    // redeploy, and a redeploy is a new process — there is no state of the
    // world in which re-asking would learn something a restart had not already
    // told us. The cost of the other choice is a Github call on a schedule
    // nobody asked for, on a read that only an admin page and a boot line
    // consume.
    //
    // The spec above makes three back-to-back calls under the real clock, all
    // inside the 60s FAILURE hold, so it would pass just the same if somebody
    // gave the resolved branch a TTL. This one moves the clock a day.
    let calls = 0;
    let now = 1_000_000;
    const svc = new WriteIdentityService(
      cfg(WRITES_ON),
      async () => {
        calls += 1;
        return 'board-bot';
      },
      () => now,
    );
    const first = await svc.resolve();
    now += 24 * 60 * 60 * 1000;
    const later = await svc.resolve();
    expect(calls).toBe(1);
    expect(later).toBe(first);
    expect(later.checkedAt).toBe(first.checkedAt);
  });

  it('costs one call when several readers arrive together, not one each', async () => {
    let calls = 0;
    let release: (login: string) => void = () => {};
    const svc = new WriteIdentityService(cfg(WRITES_ON), () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const three = Promise.all([svc.resolve(), svc.resolve(), svc.resolve()]);
    release('board-bot');
    const answers = await three;
    expect(calls).toBe(1);
    expect(answers.map((a) => a.login)).toEqual(['board-bot', 'board-bot', 'board-bot']);
  });

  it('answers `unknown` when Github is unreachable, and does not throw', async () => {
    const svc = new WriteIdentityService(cfg(WRITES_ON), async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    });
    const identity = await svc.resolve();
    expect(identity.state).toBe('unknown');
    expect(identity.login).toBeNull();
    expect(identity.reason).toContain('ENOTFOUND');
  });

  it('never puts the credential in the reason, however the error was written', async () => {
    // The failure mode this guards: an error type that quotes the request it
    // made. Github's own 401 says "Bad credentials" and carries nothing, so a
    // spec that only drove the real message would pass while proving nothing.
    //
    // TWICE in the one message, deliberately: a message quoting the credential
    // once cannot tell `split().join()` from `replace()`, which removes the
    // first occurrence and leaves every other one standing. The comment on
    // `redact` promises "whatever put it there", and that is the promise a
    // single occurrence fails to test.
    const svc = new WriteIdentityService(cfg(WRITES_ON), async () => {
      throw new Error(
        '401 on GET /user with authorization: token ghp_write ' +
          '(retrying GET /user with authorization: token ghp_write)',
      );
    });
    const identity = await svc.resolve();
    expect(identity.reason).not.toContain('ghp_write');
    expect(identity.reason?.match(/\[redacted\]/g)).toHaveLength(2);
  });

  it('retries after a failure once the hold has lapsed, and not before', async () => {
    let calls = 0;
    let now = 1_000_000;
    const svc = new WriteIdentityService(
      cfg(WRITES_ON),
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('502 Bad Gateway');
        return 'board-bot';
      },
      () => now,
    );
    expect((await svc.resolve()).state).toBe('unknown');
    now += 30_000;
    expect((await svc.resolve()).state).toBe('unknown');
    expect(calls).toBe(1);
    now += 40_000; // past the 60s hold
    expect((await svc.resolve()).login).toBe('board-bot');
    expect(calls).toBe(2);
  });

  it('does not spend a call on a Github App deployment, and says why it cannot name it', async () => {
    let calls = 0;
    const svc = new WriteIdentityService(
      cfg({ GITHUB_APP_ID: '123', GITHUB_INSTALLATION_ID: '456', GITHUB_WRITE_ENABLED: true }),
      async () => {
        calls += 1;
        return 'never';
      },
    );
    const identity = await svc.resolve();
    expect(calls).toBe(0);
    expect(identity.state).toBe('unknown');
    expect(identity.reason).toContain('Github App installation');
  });

  it('says so plainly when nothing is configured at all', async () => {
    const svc = new WriteIdentityService(cfg({}), async () => 'never');
    const identity = await svc.resolve();
    expect(identity.state).toBe('unknown');
    expect(identity.reason).toContain('No Github credential is configured');
    expect(identity.writesEnabled).toBe(false);
  });

  it('asks under the WRITE token, so the login is the account the mutations carry (#625)', async () => {
    // The whole point of the route: with the two tokens different, an answer
    // taken off GITHUB_TOKEN would name the read account and tell the operator
    // the swap had not landed when it had — or the reverse.
    let seen: string | null = null;
    const svc = new WriteIdentityService(cfg(WRITES_ON), async (token) => {
      seen = token;
      return 'board-bot';
    });
    await svc.resolve();
    expect(seen).toBe('ghp_write');
  });

  it('falls back to GITHUB_TOKEN, and says the login is the read credential too', async () => {
    const svc = new WriteIdentityService(
      cfg({ GITHUB_TOKEN: 'ghp_shared', GITHUB_WRITE_ENABLED: true }),
      async () => 'octocat',
    );
    const identity = await svc.resolve();
    expect(identity.state).toBe('resolved');
    expect(identity.login).toBe('octocat');
    expect(identity.separateWriteToken).toBe(false);
  });

  it('announce() never rejects and never returns a promise a boot could await', () => {
    const svc = new WriteIdentityService(cfg(WRITES_ON), async () => {
      throw new Error('boom');
    });
    expect(svc.announce()).toBeUndefined();
  });

  it('does not warn a board that is not writing, and does warn one that is', async () => {
    // A local dev boot on fixtures has no credential and needs none. A warning
    // nobody can act on is a warning people learn to skip past, which is how the
    // boot ERROR in docs/ops/production-alerting.md ran unread for a month.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    // `announce()` returns void and logs from a `.then`, so awaiting the same
    // answer is not enough — the callback runs a microtask later.
    const settled = () => new Promise((r) => setImmediate(r));
    try {
      const quiet = new WriteIdentityService(cfg({}), async () => 'never');
      quiet.announce();
      await settled();
      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();

      warn.mockClear();
      const loud = new WriteIdentityService(cfg({ GITHUB_WRITE_ENABLED: true }), async () => 'never');
      loud.announce();
      await settled();
      expect(warn).toHaveBeenCalledTimes(1);
      // The sentence says whose writes it is about (#892): the board's OWN,
      // not a person's, because a person's go out under their own credential.
      expect(String(warn.mock.calls[0][0])).toContain(
        'the board’s own no-person writes go out under an account it cannot name',
      );
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

/**
 * The one function in this file that talks to Github (#756 review).
 *
 * Every spec above injects the seam, so until this block `defaultAsk` was the
 * only unexercised code in the module: not the route it asks for, not where it
 * reads the login from, not the guard for a body that carries none. Octokit
 * builds on the platform `fetch`, so a stub on `globalThis.fetch` is the whole
 * wire — no network, and the request the board would really have made is the
 * object being asserted.
 */
describe('defaultAsk — the call to Github itself', () => {
  /** Swap in a fetch, restore whatever was there. Returns the requests seen. */
  function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, init });
      return Promise.resolve(handler(url, init));
    }) as typeof globalThis.fetch;
    return { seen, restore: () => { globalThis.fetch = original; } };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  it('asks GET /user under the token it was given, and returns the login', async () => {
    const stub = stubFetch(() => json({ login: 'board-bot', id: 42 }));
    try {
      const login = await defaultAsk('ghp_machine_user');
      expect(login).toBe('board-bot');
      expect(stub.seen).toHaveLength(1);
      expect(stub.seen[0].url).toBe('https://api.github.com/user');
      expect(stub.seen[0].init.method).toBe('GET');
      const headers = new Headers(stub.seen[0].init.headers as Record<string, string>);
      expect(headers.get('authorization')).toBe('token ghp_machine_user');
    } finally {
      stub.restore();
    }
  });

  it('throws rather than reporting a login of `undefined` when the body has none', async () => {
    // Without the guard this resolves `state: 'resolved', login: undefined`, and
    // the boot line prints `Github writes go out as @undefined`.
    const stub = stubFetch(() => json({ id: 42 }));
    try {
      await expect(defaultAsk('ghp_machine_user')).rejects.toThrow(/no login/);
    } finally {
      stub.restore();
    }
  });

  it('a refused credential becomes a rejection, which `take()` turns into `unknown`', async () => {
    const stub = stubFetch(() => json({ message: 'Bad credentials' }, 401));
    try {
      await expect(defaultAsk('ghp_wrong')).rejects.toThrow(/Bad credentials/);
    } finally {
      stub.restore();
    }
  });

  it('gives up on a socket that hangs, instead of wedging every later reader', async () => {
    // The failure this bounds: with no signal, a hung socket leaves the promise
    // in `inFlight` unsettled, `.finally()` never clears it, and `resolve()`
    // hands that same pending promise to every admin read for as long as undici
    // allows — 300s. The timeout is a parameter here only so this test need not
    // wait 20s for the real one.
    const stub = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        }),
    );
    try {
      const started = Date.now();
      await expect(defaultAsk('ghp_machine_user', 25)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(stub.seen[0].init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      stub.restore();
    }
  });

  it('the hung call still settles the service, so the next reader is not stuck behind it', async () => {
    const stub = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        }),
    );
    try {
      const svc = new WriteIdentityService(cfg(WRITES_ON), (token) => defaultAsk(token, 25));
      const identity = await svc.resolve();
      expect(identity.state).toBe('unknown');
      expect(identity.reason).toContain('aborted');
    } finally {
      stub.restore();
    }
  });
});

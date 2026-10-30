import { describe, it, expect } from 'vitest';
import { classifyGithubError, refusalToHttp } from './github-refusal';
import type { RefusalBody } from './github-refusal';
import { gh } from './capability-testing.contract';

describe('how widely a refusal may be believed', () => {
  it('a 403 naming the permission it wanted AND saying so is about the CREDENTIAL', () => {
    const r = classifyGithubError(
      gh(
        403,
        { 'x-accepted-github-permissions': 'organization_custom_properties=write' },
        'Resource not accessible by personal access token',
      ),
      { capability: 'repo.dri', target: 'acme/board' },
    );
    expect(r.reason).toBe('not-permitted');
    expect(r.scope).toBe('credential');
    expect(r.missingPermission).toBe('organization_custom_properties=write');
  });

  it('that same header WITHOUT that message stays about the target', () => {
    // The header is an endpoint describing ITSELF, and it rides along on 403s
    // that are purely about one target — an archived repo, an IP allow list, an
    // organization ruleset. Widening on the header alone takes a capability dark
    // for every user and every repo on the strength of one bad target, which is
    // the outage the scope rule exists to prevent.
    const r = classifyGithubError(
      gh(
        403,
        { 'x-accepted-github-permissions': 'organization_custom_properties=write' },
        'Repository was archived so is read-only',
      ),
      { capability: 'repo.dri', target: 'acme/board' },
    );
    expect(r.reason).toBe('not-permitted');
    expect(r.scope).toBe('target');
    // Still carried, because it is still true and the log still wants it. What
    // it does NOT do any more is widen the refusal on its own.
    expect(r.missingPermission).toBe('organization_custom_properties=write');
  });

  it('a 403 carrying BOTH headers keeps the link and stays narrow', () => {
    // The worst available pair, and the one reading the permissions header first
    // produced: the person loses the URL that would have fixed it, and the
    // refusal is widened to every target at the same time.
    const r = classifyGithubError(
      gh(
        403,
        {
          'x-accepted-github-permissions': 'issues=write',
          'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=abc',
        },
        'Resource not accessible by integration',
      ),
      { capability: 'issue.state', target: 'acme/board' },
    );
    expect(r.reason).toBe('not-permitted-yet');
    expect(r.authorizeUrl).toBe(
      'https://github.com/orgs/acme/sso?authorization_request=abc',
    );
    expect(r.scope).toBe('target');
  });

  it('the SAME 403 without that header is a statement about the TARGET only', () => {
    const r = classifyGithubError(gh(403), {
      capability: 'repo.dri',
      target: 'acme/board',
    });
    expect(r.reason).toBe('not-permitted');
    expect(r.scope).toBe('target');
    expect(r.missingPermission).toBeUndefined();
  });

  it('a bare 404 is not-found and is believed NOWHERE — the re-read has not run yet', () => {
    const r = classifyGithubError(gh(404), {
      capability: 'repo.dri',
      target: 'acme/does-not-exist',
    });
    expect(r.reason).toBe('not-found');
    expect(r.scope).toBe('none');
  });

  it('a 401 is about the credential and nothing else', () => {
    const r = classifyGithubError(gh(401), { capability: 'issue.labels' });
    expect(r.reason).toBe('unauthenticated');
    expect(r.scope).toBe('credential');
  });
});

describe('403 is spent on four meanings', () => {
  it('a retry-after 403 is try-again, not a permission statement', () => {
    const r = classifyGithubError(gh(403, { 'retry-after': '60' }), { capability: 'repo.dri' });
    expect(r.reason).toBe('try-again');
    expect(r.retryable).toBe(true);
    expect(r.scope).toBe('none');
  });

  it('an exhausted-quota 403 is try-again', () => {
    const r = classifyGithubError(gh(403, { 'x-ratelimit-remaining': '0' }), {
      capability: 'repo.dri',
    });
    expect(r.reason).toBe('try-again');
  });

  it('a SECONDARY rate limit is try-again, and it has NO throttle headers at all', () => {
    // Github answers a secondary limit with 403, no `retry-after`, and a
    // non-zero remaining quota. Only the body says so. Filing it as a permanent
    // refusal withdraws the Retry that would have worked, for fifteen minutes.
    const r = classifyGithubError(
      gh(403, { 'x-ratelimit-remaining': '4988' }, 'You have exceeded a secondary rate limit'),
      { capability: 'issue.labels' },
    );
    expect(r.reason).toBe('try-again');
    expect(r.retryable).toBe(true);
  });

  it('an SSO 403 is not-permitted-YET and carries the URL a person can act on', () => {
    const r = classifyGithubError(
      gh(403, {
        'x-github-sso':
          'required; url=https://github.com/orgs/acme/sso?authorization_request=abc',
      }),
      { capability: 'issue.state' },
    );
    expect(r.reason).toBe('not-permitted-yet');
    expect(r.authorizeUrl).toBe(
      'https://github.com/orgs/acme/sso?authorization_request=abc',
    );
    expect(r.retryable).toBe(false);
  });
});

describe('GraphQL fails at HTTP 200, so it needs its own rung', () => {
  const gqlErr = (type: string) =>
    Object.assign(new Error('graphql'), { status: 200, errors: [{ type }] });

  it('FORBIDDEN is not-permitted about the target', () => {
    const r = classifyGithubError(gqlErr('FORBIDDEN'), {
      capability: 'issue.project.add',
      target: 'acme/board',
    });
    expect(r.reason).toBe('not-permitted');
    expect(r.scope).toBe('target');
  });
  it('INSUFFICIENT_SCOPES is not-permitted about the credential', () => {
    const r = classifyGithubError(gqlErr('INSUFFICIENT_SCOPES'), { capability: 'issue.field' });
    expect(r.reason).toBe('not-permitted');
    expect(r.scope).toBe('credential');
  });
  it('RATE_LIMITED is try-again', () => {
    expect(classifyGithubError(gqlErr('RATE_LIMITED'), { capability: 'issue.field' }).reason).toBe(
      'try-again',
    );
  });
  it('NOT_FOUND is not-found', () => {
    expect(classifyGithubError(gqlErr('NOT_FOUND'), { capability: 'issue.state' }).reason).toBe(
      'not-found',
    );
  });
  it('a GraphQL type nobody has seen before is try-again, EXPLICITLY', () => {
    // Not by falling through to the bottom rung. A new error type must not be
    // able to become a permanent refusal by accident.
    const r = classifyGithubError(gqlErr('SERVICE_UNAVAILABLE'), { capability: 'issue.field' });
    expect(r.reason).toBe('try-again');
    expect(r.scope).toBe('none');
  });

  it('EVERY branch carries whatever status arrived, so no log line says “no status”', () => {
    // One branch is not the rung. Asserting only `FORBIDDEN` left the other four
    // free to drop the status silently, and an operator reading "no status" for
    // an error that carried one is being told something untrue.
    for (const type of [
      'INSUFFICIENT_SCOPES',
      'FORBIDDEN',
      'NOT_FOUND',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
    ]) {
      expect(classifyGithubError(gqlErr(type), { capability: 'issue.field' }).status).toBe(200);
    }
  });
});

describe('a GraphQL errors array can hold more than one type', () => {
  const gqlErrs = (...types: string[]) =>
    Object.assign(new Error('graphql'), { status: 200, errors: types.map((type) => ({ type })) });

  /**
   * Both orders of every pair, because the defect being pinned was ORDER
   * SENSITIVITY: reading whichever type came first meant the same two facts
   * classified two ways depending on how Github happened to serialise them.
   * A partial failure really can carry two — the issue query selects
   * `projectItems` and a cross-repo fragment on one round trip.
   */
  const pairs: { name: string; types: [string, string]; reason: string; scope: string }[] = [
    {
      name: 'a scope problem outranks an absence',
      types: ['INSUFFICIENT_SCOPES', 'NOT_FOUND'],
      reason: 'not-permitted',
      scope: 'credential',
    },
    {
      name: 'a refusal outranks an absence',
      types: ['FORBIDDEN', 'NOT_FOUND'],
      reason: 'not-permitted',
      scope: 'target',
    },
    {
      name: 'a scope problem outranks a refusal',
      types: ['INSUFFICIENT_SCOPES', 'FORBIDDEN'],
      reason: 'not-permitted',
      scope: 'credential',
    },
    {
      name: 'a throttle outranks an absence',
      types: ['RATE_LIMITED', 'NOT_FOUND'],
      reason: 'try-again',
      scope: 'none',
    },
    {
      name: 'a refusal outranks a throttle',
      types: ['FORBIDDEN', 'RATE_LIMITED'],
      reason: 'not-permitted',
      scope: 'target',
    },
    {
      name: 'a known type outranks one nobody has seen',
      types: ['NOT_FOUND', 'SERVICE_UNAVAILABLE'],
      reason: 'not-found',
      scope: 'none',
    },
  ];

  for (const { name, types, reason, scope } of pairs) {
    it(`${name}, whichever order it arrives in`, () => {
      const forwards = classifyGithubError(gqlErrs(...types), { capability: 'issue.state' });
      const backwards = classifyGithubError(gqlErrs(...[...types].reverse()), {
        capability: 'issue.state',
      });
      expect(forwards.reason).toBe(reason);
      expect(backwards.reason).toBe(reason);
      expect(forwards.scope).toBe(scope);
      expect(backwards.scope).toBe(scope);
    });
  }

  it('an absence beside a refusal is NOT an absence — the issue page keeps its 500 honest', () => {
    // The live regression, stated as itself. `isNotFound` used to be any-wins,
    // so `[FORBIDDEN, NOT_FOUND]` answered "absent" and `fetch()` returned null.
    // First-wins made it "refused" in one order and "absent" in the other.
    // Precedence settles it, and the answer is "refused": a refusal is the
    // opposite of an absence, and answering 404 to one hides it.
    for (const order of [['FORBIDDEN', 'NOT_FOUND'], ['NOT_FOUND', 'FORBIDDEN']]) {
      expect(classifyGithubError(gqlErrs(...order), { capability: 'issue.state' }).reason).not.toBe(
        'not-found',
      );
    }
  });

  it('a missing scope beside an absence never reads as a plain absence', () => {
    // #577's shape arriving by the GraphQL door. Read as `not-found` with scope
    // `none` it teaches the registry nothing and tells the person the issue is
    // gone, when the truth is the board's credential is short a scope.
    const r = classifyGithubError(gqlErrs('NOT_FOUND', 'INSUFFICIENT_SCOPES'), {
      capability: 'issue.field',
    });
    expect(r.reason).toBe('not-permitted');
    expect(r.scope).toBe('credential');
  });
});

describe('what arrives in `errors` is checked, not trusted', () => {
  // Every one of these threw a TypeError inside a catch block, which replaced
  // the real Github error with "e.errors.map is not a function" and answered
  // 500. This file is the universal interpreter — it is the last place that may
  // assume a shape.
  const malformed: [string, unknown][] = [
    ['a string where an array belongs', 'NOT_FOUND'],
    ['an object where an array belongs', {}],
    ['an array of nulls', [null]],
    ['an array of entries with no type', [{ message: 'boom' }]],
    ['a non-string type', [{ type: 42 }]],
    ['an empty array', []],
  ];

  for (const [name, errors] of malformed) {
    it(`${name} classifies rather than throwing`, () => {
      const err = Object.assign(new Error('graphql'), { status: 502, errors });
      expect(() => classifyGithubError(err, { capability: 'issue.state' })).not.toThrow();
      // 502 with nothing readable in `errors` is the bottom rung, as it should be.
      expect(classifyGithubError(err, { capability: 'issue.state' }).reason).toBe('try-again');
    });
  }

  it('a readable entry beside an unreadable one is still read', () => {
    const err = Object.assign(new Error('graphql'), {
      status: 200,
      errors: [null, { type: 'NOT_FOUND' }],
    });
    expect(classifyGithubError(err, { capability: 'issue.state' }).reason).toBe('not-found');
  });
});

describe('the SSO link is a link the board vouches for', () => {
  const sso = (raw: string) =>
    classifyGithubError(gh(403, { 'x-github-sso': raw }), { capability: 'issue.state' });

  it('takes the url parameter and stops at the next delimiter', () => {
    const r = sso('required; url=https://github.com/orgs/x/sso?request=abc; expires=soon');
    expect(r.authorizeUrl).toBe('https://github.com/orgs/x/sso?request=abc');
  });

  it('does not match a parameter that merely ENDS in url', () => {
    // `/url=(\S+)/` matched at the substring, so a header that grows a
    // `fallback_url=` later would have handed a person the wrong link.
    const r = sso('required; fallback_url=https://github.com/somewhere-else');
    expect(r.reason).toBe('not-permitted');
    expect(r.authorizeUrl).toBeUndefined();
  });

  it('drops a url that is not on github.com, and still states the refusal', () => {
    for (const raw of [
      'required; url=https://github.com.evil.example/orgs/x/sso',
      'required; url=http://github.com/orgs/x/sso',
      'required; url=https://evil.example/orgs/x/sso',
    ]) {
      const r = sso(raw);
      expect(r.authorizeUrl).toBeUndefined();
      expect(r.reason).toBe('not-permitted');
    }
  });
});

describe('the rest of the vocabulary', () => {
  it('422 is the value being wrong, not the permission', () => {
    expect(
      classifyGithubError(gh(422, {}, 'Validation Failed'), { capability: 'issue.assignees' })
        .reason,
    ).toBe('wrong-value');
  });
  it('429 is try-again with no headers at all, and SAYS it is a rate limit', () => {
    // The sentence is the assertion that earns its keep. A headerless 429 and an
    // unreachable Github share a reason and a status, and differ only in what a
    // person reads — so without pinning the words, deleting the bare-429 rung
    // entirely leaves every test in this file green while the board starts
    // telling someone it could not reach Github when Github answered.
    const r = classifyGithubError(gh(429), { capability: 'issue.labels' });
    expect(r.reason).toBe('try-again');
    expect(r.message).toMatch(/rate limiting/);
  });

  it('a throttled 403 says the same thing a 429 does', () => {
    const r = classifyGithubError(gh(403, { 'retry-after': '60' }), { capability: 'issue.labels' });
    expect(r.message).toMatch(/rate limiting/);
  });
  it('a 5xx is try-again', () => {
    expect(classifyGithubError(gh(502), { capability: 'issue.labels' }).reason).toBe('try-again');
  });
  it('a dropped socket — no status at all — is try-again', () => {
    expect(
      classifyGithubError(new Error('socket hang up'), { capability: 'issue.labels' }).reason,
    ).toBe('try-again');
  });
});

describe('refusalToHttp', () => {
  it('maps not-permitted to 403 and not-found to 404', () => {
    // Read the status, not the class. `refusalToHttp` returns an
    // `HttpException` carrying a structured body, and Nest's `HttpException`
    // with status 403 is NOT an instance of `ForbiddenException` — those
    // subclasses only set the status their name says. Asserting the class here
    // would be asserting a construction detail rather than what the client gets.
    const permitted = classifyGithubError(gh(403), { capability: 'repo.dri' });
    const found = classifyGithubError(gh(404), { capability: 'repo.dri' });
    expect(refusalToHttp(permitted).getStatus()).toBe(403);
    expect(refusalToHttp(found).getStatus()).toBe(404);
  });

  it('answers a dead CREDENTIAL with 403, never 401', () => {
    // A 401 on the wire reaches `apiFetch` (board-frontend/src/api.ts:40-44),
    // which calls notifySessionExpired() and signs the person out of the board.
    // The dead credential is the BOARD'S; their session is fine.
    const r = classifyGithubError(gh(401), { capability: 'issue.state' });
    const http = refusalToHttp(r);
    expect(http.getStatus()).toBe(403);
    expect((http.getResponse() as RefusalBody).reason).toBe('unauthenticated');
  });

  it('carries the reason and the authorize URL in the body, and never the missing permission', () => {
    const r = classifyGithubError(gh(403, { 'x-accepted-github-permissions': 'issues=write' }), {
      capability: 'issue.state',
    });
    const body = refusalToHttp(r).getResponse() as Record<string, unknown>;
    expect(body.reason).toBe('not-permitted');
    expect(body.missingPermission).toBeUndefined();
  });
});

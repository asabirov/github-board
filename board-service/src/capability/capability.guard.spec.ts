import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigModule, type ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { CapabilityGuard } from './capability.guard';
import { CapabilityRegistry } from './capability.registry';
import { configValidationSchema } from '../config/config.schema';
import type { Refusal, RefusalBody } from './github-refusal';
import { cfg } from './capability-testing.contract';

/**
 * The capability gate (#584), which since task 8 refuses in production:
 * `CAPABILITY_GUARD_ENFORCING` defaults to true, so the `enforcing: true` cases
 * below are the deployed behaviour and no longer a rehearsal of it. They were
 * written a task ahead of the flip, which is why turning it on was a one-line
 * diff rather than a new guard.
 *
 * `enforcing` stays an argument here rather than becoming a constant: the flag
 * is still the switch an operator has, and the last test is what proves the off
 * position still only logs.
 */

const ctxFor = (method: string, user?: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ method, url: '/api/repos/x/y/dri', user }) }),
    getHandler: () => () => {},
    getClass: () => class {},
  }) as unknown as ExecutionContext;

const guardWith = (registry: CapabilityRegistry, declared: string[] | undefined, enforcing: boolean) =>
  new CapabilityGuard(
    { getAllAndOverride: () => declared } as unknown as Reflector,
    registry,
    {
      get: (k: string, d?: unknown) => (k === 'CAPABILITY_GUARD_ENFORCING' ? enforcing : d),
    } as unknown as ConfigService,
  );

const permanent: Refusal = {
  reason: 'not-permitted',
  message: 'no',
  status: 403,
  retryable: false,
  scope: 'credential',
};

const quiet = () => vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

/**
 * Run `fn` and give `process.env` back exactly as it was found.
 *
 * ConfigModule.forRoot does not only READ the environment: it writes every
 * default the schema applied back into `process.env`, about sixty keys here for
 * a bare shell. Restoring the one key a test meant to control leaves the rest
 * behind, and one of them is `DEV_USER_EMAIL=''`, which the NEXT build in the
 * same process rejects with `"DEV_USER_EMAIL" must be a valid email`. vitest
 * isolates each spec file in its own process today, so nothing sees it; the day
 * anyone sets `isolate: false` it becomes a failure in whichever file ran
 * second. Restoring the whole environment costs a shallow copy.
 */
const withRestoredEnv = async <T>(fn: () => Promise<T>): Promise<T> => {
  const before = { ...process.env };
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
};

/** The guard as Nest itself builds it: the REAL ConfigModule over the REAL
 *  schema, so the whole wiring — schema default → validated env →
 *  ConfigService.get → this.enforcing — is under the assertion. `ignoreEnvFile`
 *  keeps a developer `.env` from deciding the answer. */
const guardFromRealConfig = async () => {
  // The settings #1175 requires of every deployment, written into the
  // environment because that is what the schema validates — a `load` runs after
  // validation and would not be seen. They carried defaults until then, which is
  // why nothing here named them: two named an organisation and a repository that
  // were renamed without this tree being told. `withRestoredEnv` takes them back
  // off, along with everything ConfigModule writes.
  Object.assign(process.env, {
    GITHUB_ORGS: 'acme',
    FEEDBACK_REPO: 'acme/board',
    ISSUES_SOURCE: 'fixture',
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        validationSchema: configValidationSchema,
        validationOptions: { libraryOptions: { abortEarly: false } },
        ignoreEnvFile: true,
      }),
    ],
    providers: [
      { provide: CapabilityRegistry, useValue: new CapabilityRegistry(cfg()) },
      CapabilityGuard,
    ],
  }).compile();
  return moduleRef.get(CapabilityGuard);
};

/** The refusal body a call produces, and a failure when it produces none. The
 *  `try { …; throw new Error('expected a refusal') } catch` shape this replaces
 *  catches its own throw, so a guard that refused nothing read as a refusal
 *  whose every field was `undefined` — and `undefined` satisfied the assertions
 *  that followed. */
const refusalFrom = (call: () => unknown): RefusalBody => {
  let thrown: unknown;
  try {
    call();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected a refusal, and nothing was thrown').toBeInstanceOf(ForbiddenException);
  return (thrown as ForbiddenException).getResponse() as RefusalBody;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CapabilityGuard', () => {
  it('lets a GET through whatever the registry says', () => {
    const r = new CapabilityRegistry(cfg());
    r.recordRefusal('repo.dri', permanent);
    expect(guardWith(r, undefined, true).canActivate(ctxFor('GET'))).toBe(true);
  });

  it('denies an undecorated write route', () => {
    // The fail-closed default, mirroring required-scopes.guard.ts:53-62 — absent
    // metadata is not an answer, and a route that forgot to declare is refused.
    quiet();
    expect(() =>
      guardWith(new CapabilityRegistry(cfg()), undefined, true).canActivate(ctxFor('PATCH')),
    ).toThrow(ForbiddenException);
  });

  it('lets an explicitly empty declaration through, on a registry that refuses', () => {
    // `undefined` ≠ `[]`. @Writes() is a real answer — this route writes no
    // Github — and nine of the twenty give it, including the sign-out button.
    //
    // The refusal in the registry is what makes this a test. Against an empty
    // registry, `[]` passes exactly as a DELETED `for (const cap of declared)`
    // loop would, and the two are indistinguishable; with `repo.dri` refused,
    // only a guard that still reads the declaration lets `[]` through while
    // refusing `['repo.dri']`.
    quiet();
    const r = new CapabilityRegistry(cfg());
    r.recordRefusal('repo.dri', permanent);
    expect(guardWith(r, [], true).canActivate(ctxFor('POST'))).toBe(true);
    expect(() => guardWith(r, ['repo.dri'], true).canActivate(ctxFor('POST'))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses a credential-wide refusal the board has learned', () => {
    quiet();
    const r = new CapabilityRegistry(cfg());
    expect(guardWith(r, ['repo.dri'], true).canActivate(ctxFor('PATCH'))).toBe(true); // before
    r.recordRefusal('repo.dri', permanent);
    // The refusal that reaches the client is the one the registry LEARNED, not a
    // sentence this guard composed: the message is the refusal's own.
    //
    // EXACT, not a partial match. The whole why/publicMessage split rests on
    // deny() building a fresh literal, and `toMatchObject` cannot see an extra
    // key — a body that also carried `why` would satisfy it while putting the
    // credential's shape on the wire, which is the one thing `why` exists to
    // keep off it. github-refusal.spec.ts:395 asserts the same absence from the
    // source side of the rule.
    const body = refusalFrom(() => guardWith(r, ['repo.dri'], true).canActivate(ctxFor('PATCH'))); // after
    // The key SET, spelled out — `toEqual` alone still ignores a key whose value
    // is `undefined`, and this asserts what the body is made of.
    expect(Object.keys(body).sort()).toEqual(['message', 'reason']);
    expect(body).toEqual({ message: permanent.message, reason: 'not-permitted' });
  });

  it('refuses the same refusal at credential scope and not at target scope', () => {
    // The boundary, as a test, and it has to be a PAIR: the guard has the route
    // and nothing else, so the owner and repo are path parameters the handler
    // binds. Asserting only that the target-scoped case passes proves nothing —
    // it passes equally with the guard's whole loop deleted. One fixture, one
    // field of difference, both directions asserted.
    quiet();
    const wide = new CapabilityRegistry(cfg());
    wide.recordRefusal('repo.dri', { ...permanent, scope: 'credential' });
    const narrow = new CapabilityRegistry(cfg());
    narrow.recordRefusal('repo.dri', { ...permanent, scope: 'target' }, 'acme/locked');
    expect(() => guardWith(wide, ['repo.dri'], true).canActivate(ctxFor('PATCH'))).toThrow(
      ForbiddenException,
    );
    // …and the target-scoped one reaches task 9's envelope untouched, which is
    // the only thing that holds the owner and the repo.
    expect(guardWith(narrow, ['repo.dri'], true).canActivate(ctxFor('PATCH'))).toBe(true);
  });

  it('refuses a human exactly as it refuses an agent', () => {
    // The one deliberate difference from RequiredScopesGuard, whose first line
    // (required-scopes.guard.ts:46) returns true for anyone without scopes. Those
    // scopes are the CALLER'S. This credential is the BOARD'S, so a person's
    // authority cannot make it able to do something it cannot do.
    quiet();
    const r = new CapabilityRegistry(cfg());
    r.recordRefusal('repo.dri', permanent);
    const human = { sub: 'u1', email: 'a@example.com' }; // no `scopes` key at all
    expect(() => guardWith(r, ['repo.dri'], true).canActivate(ctxFor('PATCH', human))).toThrow(
      ForbiddenException,
    );
  });

  it('serves the verdict’s own reason and link, not a hardcoded not-permitted', () => {
    // A refusal a person can fix has to arrive fixable. The registry carries the
    // reason and the SSO link for exactly the minute the entry lives, and the
    // guard is the only thing between them and the browser.
    quiet();
    const r = new CapabilityRegistry(cfg());
    r.recordRefusal('issue.state', {
      reason: 'not-permitted-yet',
      message: 'needs SSO',
      status: 403,
      retryable: false,
      scope: 'credential',
      authorizeUrl: 'https://github.com/orgs/acme/sso?authorization_request=abc',
    });
    // `refusalFrom`, not a try/catch with a `throw` inside the `try` — that
    // throw lands in the catch below it, `getResponse` is undefined on it, and
    // every assertion in the block reads `undefined` and passes. A guard that
    // refused nothing would have satisfied both halves of this test.
    const link = refusalFrom(() => guardWith(r, ['issue.state'], true).canActivate(ctxFor('PATCH')));
    // Exact: three keys and no fourth. `authorizeUrl` is here because the
    // refusal carried one, not because deny() always attaches one.
    expect(Object.keys(link).sort()).toEqual(['authorizeUrl', 'message', 'reason']);
    expect(link).toEqual({
      message: 'needs SSO',
      reason: 'not-permitted-yet',
      authorizeUrl: 'https://github.com/orgs/acme/sso?authorization_request=abc',
    });

    // …and a plain refusal carries no link, so this asserts a carry and not a constant.
    r.recordRefusal('repo.dri', permanent);
    const plain = refusalFrom(() => guardWith(r, ['repo.dri'], true).canActivate(ctxFor('PATCH')));
    // Two keys and no third: the link is ABSENT, not present and empty.
    expect(plain).toEqual({ message: permanent.message, reason: 'not-permitted' });
    expect(Object.keys(plain)).not.toContain('authorizeUrl');
  });

  it('enforces on a real ConfigModule with nothing set, through the schema default', async () => {
    // The one test that does NOT stub the config. Every other case here hands
    // `enforcing` in directly, so the whole wiring is invisible to them and
    // reverting the default to false kills nothing in this file. This asserts
    // the guard REFUSES, which is only true if the schema default arrived.
    //
    // Deleting the key is what makes it hermetic: an exported shell variable
    // would otherwise decide the answer. `withRestoredEnv` puts it back — along
    // with everything ConfigModule wrote.
    quiet();
    await withRestoredEnv(async () => {
      delete process.env.CAPABILITY_GUARD_ENFORCING;
      const guard = await guardFromRealConfig();
      expect(() => guard.canActivate(ctxFor('PATCH'))).toThrow(ForbiddenException);
    });
  });

  it('gives process.env back untouched, so a second ConfigModule still builds', async () => {
    // Building the real config is a WRITE (see `withRestoredEnv`). Two
    // assertions, and both were checked against a helper mutated back to the
    // one-key restore: the equality catches it when this test runs alone, and
    // the second build catches it in a full-file run, where the test above has
    // already leaked the same keys and there is no delta left to see.
    quiet();
    const before = { ...process.env };
    await withRestoredEnv(async () => {
      delete process.env.CAPABILITY_GUARD_ENFORCING;
      await guardFromRealConfig();
    });
    expect({ ...process.env }).toEqual(before);

    const second = await withRestoredEnv(() => guardFromRealConfig());
    expect(second).toBeInstanceOf(CapabilityGuard);
    expect({ ...process.env }).toEqual(before);
  });

  it('reports instead of refusing when enforcing is off', () => {
    const warn = quiet();
    const r = new CapabilityRegistry(cfg());
    r.recordRefusal('repo.dri', permanent);
    warn.mockClear();
    expect(guardWith(r, ['repo.dri'], false).canActivate(ctxFor('PATCH'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('repo.dri'));
    // …and the undecorated branch logs too, rather than being silently allowed.
    warn.mockClear();
    expect(guardWith(r, undefined, false).canActivate(ctxFor('PATCH'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('would have been refused'));
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { relative } from 'node:path';
import ts from 'typescript-api';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, of } from 'rxjs';
import { ForbiddenException, HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { GithubCredential, PrismaClient } from '../generated/prisma/client';
import { ACCESS_NOT_NOW_CODE } from './access-not-now';
import { buildWriteProgram, SRC_DIR } from '../capability/write-reachability.contract';
import { CredentialCipher } from './github-credential-cipher';
import { githubContext, type GithubPrincipal } from './github-principal';
import { GithubExpiryInterceptor } from './github-expiry.interceptor';
import { GithubPrincipalGuard } from './github-principal.guard';
import { FINGERPRINT_TTL_MS, GithubUserService } from './github-user.service';
import { SessionRevocationService } from './session-revocation.service';

/**
 * Only the five transient auth-layer 503s may carry ACCESS_NOT_NOW_CODE
 * (#1066), and each of them really puts it on the wire.
 *
 * The browser draws its saved Projects copy over a 503 only when the body
 * carries a code it knows (`board-frontend/src/projects/projects-last-good.ts`).
 * Board-api answers 503 for five withdrawals on the same reads: the expiry
 * interceptor withholding an answer its access check has outlived, that same
 * interceptor finding the access key moved under a read, a board with no Github
 * connection configured, a disconnect that could not reach Github to revoke the
 * grant, and the credential path's lost claim on a refresh lease. Give any of
 * those the code and the copy comes back over a board the reader may have lost.
 * That is what `projects-not-now-code.spec.ts` found a verifier doing to the
 * interceptor and the principal guard with every auth and projects spec still
 * green, because each asserts its own status and message and none asks what else
 * rides in the body. The guard refuses with a 403, which that copy never reads,
 * so it is driven below for the narrower reason: a code meaning "keep what you
 * have" is wrong on a refusal that is not transient, wherever it lands.
 *
 * THE BODY IS WHAT THIS PINS, at both ends, because the version of this file it
 * replaced pinned the SPELLING of the throwing line — a scan for the two names —
 * and #1073's review walked past it twice in a minute. `import
 * { ACCESS_NOT_NOW_CODE as KEEP }` and `'access_' + 'not' + '_now'` each put the
 * code on the expiry interceptor's withdrawal with that scan 7/7 green and, the
 * review measured, 843 auth and projects tests green behind it. Three describes
 * now, and either evasion is red in at least two of them:
 *
 * - the five sites are DRIVEN, and each one's `getResponse()` is compared to the
 *   body it is supposed to send;
 * - all nine refusals this layer can send that are not one of those five are
 *   driven too, and must arrive with no `code` at all — that is the half a name
 *   scan can never have, because it is about what a body IS rather than about
 *   how a line is written;
 * - and the source is read through TypeScript's own checker rather than as
 *   text, so an expression REACHING the code is what is counted. An alias, a
 *   re-export and a `const` all resolve to the same literal type, and `+` is
 *   folded, so neither evasion is invisible to it.
 *
 * The scan is what covers the next 503 source, which is the one nobody has
 * written a spec for yet, and #1073's second review got two past the first
 * version of it with all fourteen green: an opaque `code` in a
 * `Record<string, unknown>` body, and a private refusal helper carrying one
 * site's message, called from a withdrawal nothing drove. Its final
 * verification got two more past the version after that: a code attached to the
 * response after the exception was built, and a refusal class the name test
 * could not see — a shape `sources/github-quota.ts` already ships. The class
 * test below closes the second, and the aliased import that retires any name
 * test with it; the first is in the list at the end. So what the scan
 * guarantees, exactly:
 *
 * - a `code` written AT the throw is READ — alias, re-export, `const`, `+` and
 *   a template all resolve — and one it cannot fold is REPORTED rather than
 *   skipped, which is the difference between "there is none" and "I cannot
 *   tell". Reported where it LOOKS, which is the body handed to a refusal's
 *   constructor and nowhere else;
 * - a body NOT written at the throw is reported too, unless it is a primitive,
 *   which has no properties for a `code` to be one of, or one of the named
 *   types below, which declare no `code`. A type whose `code` would come from
 *   an index signature or from `any` is reported: that is the first evasion,
 *   and `getPropertyOfType` answering nothing for it is what let it through;
 * - which `new` builds a refusal at all is asked of the CLASS rather than of
 *   the name the line spells. `GithubQuotaCooldownError` in `sources/` is a
 *   `ServiceUnavailableException` called `…Error`, and an aliased import makes
 *   any of them one; both went past the name test this replaced;
 * - a refusal is counted where it can be RAISED, not where it is written. A
 *   function whose body IS the throw is counted once per caller, so a shared
 *   helper reached from a second path is a sixth site. That is the second
 *   evasion.
 *
 * What it still does not settle — every shape below staged against this file
 * and watched stay green, rather than reasoned about:
 *
 * - a helper that throws the code down a BRANCH is counted at that throw rather
 *   than at its callers, so one of the five moved into such a helper and then
 *   reached from a second path still reads as five lines;
 * - a body reaching an exception through a type this file names is trusted to
 *   be what that type says. `RefusalBody` is the only one, and its declared
 *   properties are re-read rather than its name, so a `code` added to it turns
 *   all three of its sites red;
 * - a code this cannot fold reaches the wire unseen anywhere but that one body.
 *   Three shapes do: attached to the response AFTER the exception is built
 *   (`(err.getResponse() as Record<string, unknown>).code = …`), assembled
 *   inside a subclass's own `super(…)`, which is a call rather than a `new` and
 *   is read nowhere, and written on a body no exception carries at all, which a
 *   handler holding `@Res()` can send with a 503 itself. A code it CAN fold is
 *   red in all three.
 *
 * The driven half is what stands behind all of those, which is why all nine
 * refusals are driven there — the four that used to rest on this scan alone
 * included, `disconnect` among them, since that is where both of the evasions
 * above actually shipped. It stands behind them only where it drives, and that
 * is the honest bound on this whole file: on a refusal this layer already
 * sends, either half is enough; on the sixth 503 source, written somewhere
 * nobody has driven yet, the scan is the only reader and the shapes above are
 * what it cannot read.
 */

const cipher = new CredentialCipher({ key: () => Buffer.alloc(32, 7) });
const config = new ConfigService({
  GITHUB_USER_APP_CLIENT_ID: 'test-id', GITHUB_USER_APP_CLIENT_SECRET: 'test-secret',
  BOARD_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
});
const EMAIL = 'a@example.test';
const SUB = 'sub-a@example.test';

/**
 * The five sites, each named by the body it sends and by the file it sends it
 * from. Both halves read this one list: the first drives the site and compares
 * `getResponse()`, the third compares what the source can put in a `code`. Line
 * numbers are left out on purpose — they move under an edit two functions above,
 * and the throw itself is what an accidental sixth site would add. The two
 * identical `leaseHeld` throws are both here, so a site removed is as red as one
 * gained.
 */
const SITES = [
  { file: 'auth/github-user.service.ts', message: 'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.' },
  { file: 'auth/github-user.service.ts', message: 'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.' },
  { file: 'auth/github-user.service.ts', message: 'GitHub access check has too little left to start this read; retry' },
  { file: 'auth/github-user.service.ts', message: 'Checking your GitHub access took too long. Try again.' },
  { file: 'auth/session-revocation.service.ts', message: 'The board cannot confirm your sign-in right now. Try again in a moment.' },
];
/** The whole body one of the five sends, which is the message and the code and
 *  nothing else. Nest serialises `getResponse()` verbatim, so this is the wire. */
const sent = (message: string) => ({ message, code: ACCESS_NOT_NOW_CODE });

function row(over: Partial<GithubCredential> = {}): GithubCredential {
  return {
    ownerEmail: EMAIL, boardSub: SUB, githubUserId: SUB, githubLogin: 'a',
    accessCipher: cipher.encrypt('access', `${SUB}:access`), refreshCipher: cipher.encrypt('refresh', `${SUB}:refresh`),
    version: 'v1', accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000),
    scopes: '', refreshLeaseUntil: null, signInAdmittedAt: null, revokedAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  };
}

const db = (githubCredential: unknown) => ({ githubCredential }) as unknown as PrismaClient;

/** Github answering a discovery, after advancing the clock by `costMs` — which
 *  is how a discovery is made to run past its own window without the spec
 *  waiting a minute for it. Zero is an ordinary fast check. */
function githubAnswers(costMs: number): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (costMs > 0) await vi.advanceTimersByTimeAsync(costMs);
    const data = String(url).includes('/repositories')
      ? { total_count: 0, repositories: [] }
      : { total_count: 1, installations: [{ id: 10, account: { id: 10, login: 'acme', type: 'Organization' }, suspended_at: null, app_slug: 'acme-board', permissions: {}, repository_selection: 'all' }] };
    const res = new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(res, 'url', { value: String(url) });
    return res;
  }));
}

/** The body Nest would write. `getResponse` is the object the exception filter
 *  serialises, so this is the wire rather than an internal field. */
async function bodyOf(attempt: Promise<unknown>, kind: unknown = ServiceUnavailableException): Promise<unknown> {
  try {
    await attempt;
  } catch (err) {
    expect(err, 'the site must still refuse, and with the status it always had')
      .toBeInstanceOf(kind as never);
    return (err as HttpException).getResponse();
  }
  throw new Error('the read resolved; this spec needs its refusal');
}

describe('each of the five transient sites puts the code in the body it sends (#1066)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('a refresh in flight on another instance', async () => {
    const leased = row({ refreshLeaseUntil: new Date(Date.now() + 60_000), accessExpiresAt: new Date(Date.now() - 1_000) });
    const service = new GithubUserService(config, db({ findUnique: vi.fn(async () => leased) }));
    expect(await bodyOf(service.principal(EMAIL, SUB))).toEqual(sent(SITES[0].message));
  });

  it('a lease this request lost the race to retire, whose winner left a fresh one', async () => {
    // The row moved between the read and the compare-and-swap: `updateMany`
    // matching nothing is the loss, and the re-read is what the winner left.
    const abandoned = row({ refreshLeaseUntil: new Date(Date.now() - 1_000), accessExpiresAt: new Date(Date.now() - 1_000) });
    const won = row({ refreshLeaseUntil: new Date(Date.now() + 60_000), accessExpiresAt: new Date(Date.now() - 1_000), version: 'v2' });
    const service = new GithubUserService(config, db({
      findUnique: vi.fn().mockResolvedValueOnce(abandoned).mockResolvedValue(won),
      updateMany: vi.fn(async () => ({ count: 0 })),
    }));
    expect(await bodyOf(service.principal(EMAIL, SUB))).toEqual(sent(SITES[1].message));
  });

  it('an access check with too little of its window left to start a read on', async () => {
    githubAnswers(0);
    const service = new GithubUserService(config, db({ findUnique: vi.fn(async () => row()) }));
    // More headroom than a brand-new check can ever have, so the one attempt
    // this makes is the whole ladder.
    expect(await bodyOf(service.principal(EMAIL, SUB, false, FINGERPRINT_TTL_MS * 2))).toEqual(sent(SITES[2].message));
  });

  it('a discovery that ran past its own window', async () => {
    vi.useFakeTimers();
    githubAnswers(FINGERPRINT_TTL_MS);
    const service = new GithubUserService(config, db({ findUnique: vi.fn(async () => row()) }));
    expect(await bodyOf(service.principal(EMAIL, SUB))).toEqual(sent(SITES[3].message));
  });

  it('a session store that could not be read', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const unreadable = {
      durable: true,
      revoke: async () => {},
      bumpEpoch: async () => {},
      isRevoked: async () => { throw new Error('connection refused'); },
      epochOf: async () => { throw new Error('connection refused'); },
    };
    const service = new SessionRevocationService(unreadable);
    expect(await bodyOf(service.check('jti-z', 'u1', Math.floor(Date.now() / 1000)))).toEqual(sent(SITES[4].message));
  });
});

/** The request the interceptor and the guard read: a method, a path, and a
 *  response they can mark. */
const ctx = (method: string, path = '/api/projects', user?: unknown) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ method, path, user }),
      getResponse: () => ({ setHeader: () => {} }),
    }),
  }) as never;

/** A principal whose check has already expired, which is the state both of the
 *  interceptor's refusals are reached from. */
const spent = (): GithubPrincipal => ({
  key: 'k', email: EMAIL, login: 'a', token: 'ghu_x', owners: [], repositories: [],
  cache: new WeakMap(), expiresAt: Date.now() - 1,
});

describe('no withdrawal out of the auth layer carries the code (#1066)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  /**
   * Driven rather than read, and this is the describe an evasion cannot walk
   * past. However the code is spelled at the throw — aliased, concatenated,
   * fetched from somewhere else — it arrives in this body or it does not, and
   * these five say it does not.
   */
  const uncoded = (what: string, refusal: () => Promise<unknown>, kind: unknown = ServiceUnavailableException) =>
    it(what, async () => {
      const body = await bodyOf(refusal(), kind);
      expect(body, 'a withdrawal carrying the code is a saved copy drawn over a board the reader may have lost')
        .not.toHaveProperty('code');
      expect(JSON.stringify(body), 'nor anywhere else in the body').not.toContain(ACCESS_NOT_NOW_CODE);
    });

  uncoded('the expiry interceptor withholding a sensitive answer its check outlived', () => {
    const interceptor = new GithubExpiryInterceptor({ clientVisibilityKey: () => 'synthetic-visibility' } as never);
    return githubContext.run({ principal: spent(), boardSub: SUB, sensitive: true }, () =>
      firstValueFrom(interceptor.intercept(ctx('GET'), { handle: () => of({ rows: 1 }) })),
    );
  });

  uncoded('the expiry interceptor finding the access key moved under a read', () => {
    const moved = { principal: async () => ({ ...spent(), key: 'somewhere-else' }) };
    const interceptor = new GithubExpiryInterceptor(moved as never);
    return githubContext.run({ principal: spent(), boardSub: SUB }, () =>
      firstValueFrom(interceptor.intercept(ctx('GET'), { handle: () => of({ rows: 1 }) })),
    );
  });

  uncoded('a claim on the refresh lease that matched nothing', () => {
    // The row moved between the read and the claim. Transient in the common
    // case and NOT only transient — `disconnect` writes `revokedAt` and a new
    // version in one statement, so a disconnect landing here produces this.
    // That is why it stays uncoded; see `docs/ops/per-user-github-credentials.md`.
    const service = new GithubUserService(config, db({
      findUnique: vi.fn(async () => row({ accessExpiresAt: new Date(Date.now() - 1_000) })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    }));
    return service.principal(EMAIL, SUB);
  });

  uncoded('the principal guard refusing a reader it cannot vouch for', () => {
    const unconnected = { principal: async () => ({ ...spent(), token: null }) };
    const guard = new GithubPrincipalGuard(unconnected as never, config);
    return githubContext.run({ principal: null }, () =>
      guard.canActivate(ctx('GET', '/api/projects', { email: EMAIL, boardSub: SUB })),
    );
  }, ForbiddenException);

  uncoded('a board with no Github connection configured at all', () => {
    const service = new GithubUserService(new ConfigService({}), db({}));
    return Promise.resolve().then(() => service.requireEnabled());
  });

  /**
   * The four below are the ones the source scan used to stand alone over, and
   * standing alone is what #1073's review got past twice: both of its surviving
   * evasions shipped the code on `disconnect`'s 503, which nothing here drove.
   * A driven withdrawal does not care how the code was spelled or which helper
   * assembled it, so these are the half that cannot be walked past.
   */
  uncoded('a disconnect that could not reach Github to revoke the grant', () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const service = new GithubUserService(config, db({
      findUnique: vi.fn(async () => row()),
      updateMany: vi.fn(async () => ({ count: 1 })),
    }));
    return service.disconnect(SUB);
  });

  uncoded('a token exchange Github refused', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })));
    return new GithubUserService(config, db({})).exchange({ code: 'c' });
  }, ForbiddenException);

  uncoded('a token exchange that came back without an expiring pair', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'a' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    return new GithubUserService(config, db({})).exchange({ code: 'c' });
  }, ForbiddenException);

  uncoded('a connection whose seal had already been spent', () => {
    // Octokit reads the Github user over the same global `fetch`, so one stub
    // answers it and the write below is what refuses.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 77, login: 'a' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const service = new GithubUserService(config, db({ updateMany: vi.fn(async () => ({ count: 0 })) }));
    return service.connect(SUB, 'a', {
      access_token: 'a', refresh_token: 'r', expires_in: 3600, refresh_token_expires_in: 7200, scope: '',
    } as never, 'v1');
  }, ForbiddenException);
});

/**
 * What an expression IS, as a string, or undefined where it is not statically
 * one.
 *
 * The checker answers most of it: a `const`, an import, an aliased import and a
 * re-export all carry the same string literal TYPE, so none of them can hide a
 * name. `+` is folded here rather than there because TypeScript types
 * `'a' + 'b'` as `string` and would lose it.
 */
function textOf(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  const type = checker.getTypeAtLocation(node);
  if (type.isStringLiteral()) return type.value;
  if (ts.isParenthesizedExpression(node)) return textOf(checker, node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = textOf(checker, node.left);
    const right = textOf(checker, node.right);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const value = textOf(checker, span.expression);
      if (value === undefined) return undefined;
      out += value + span.literal.text;
    }
    return out;
  }
  return undefined;
}

/** The name a declaration gives something, which is not a use of it. Without
 *  this the declaration itself reads as two reaches rather than one. A
 *  shorthand `{ code }` is excluded: there the name IS the value. */
const isDeclarationName = (node: ts.Node): boolean =>
  ts.isIdentifier(node) && !ts.isShorthandPropertyAssignment(node.parent)
  && (node.parent as { name?: ts.Node }).name === node;

/** A reach is a NODE, because where it counts from is not settled until the
 *  walk below has asked who can raise it. */
interface Reach { node: ts.Node; declaration: boolean; message?: string }

/** Where the enclosing `new …Exception({ … })` is, if this node is the value of
 *  a `code` in one. That is the only shape in this tree that puts a code on the
 *  wire, and `carries a code it cannot read` below is what keeps it so. */
function bodyAround(node: ts.Node, checker: ts.TypeChecker): string | undefined {
  const property = node.parent;
  const named = property
    && (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    && property.name.getText() === 'code';
  if (!named) return undefined;
  const literal = property.parent;
  if (!ts.isObjectLiteralExpression(literal) || !ts.isNewExpression(literal.parent)) return undefined;
  if (literal.parent.arguments?.[0] !== literal) return undefined;
  const message = literal.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'message');
  return message && ts.isPropertyAssignment(message) ? textOf(checker, message.initializer) : undefined;
}

/** A value with no properties for a `code` to be one of. Every message in the
 *  tree is a string; `sources/github-quota.ts` hands its refusal a number and
 *  builds the body itself, which is the branch the header's last paragraph
 *  names. */
const PRIMITIVE = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike
  | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined;

const isPrimitive = (type: ts.Type): boolean =>
  (type.isUnion() ? type.types : [type]).every((part) => (part.flags & PRIMITIVE) !== 0);

/**
 * Whether a `code` could be in a value of this type at all.
 *
 * Three ways, and the first version of this file asked about one of them.
 * `getPropertyOfType` answers `undefined` for `Record<string, unknown>`, whose
 * `code` comes from a string INDEX SIGNATURE rather than a declared property,
 * and for `any`, which has every property there is. #1073's review shipped
 * `access_not_now` on a disconnect's 503 through the first of those with this
 * file 14/14 green.
 */
function mayCarryCode(checker: ts.TypeChecker, type: ts.Type): boolean {
  return (type.isUnion() ? type.types : [type]).some((part) =>
    (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
    || checker.getPropertyOfType(part, 'code') !== undefined
    || checker.getIndexInfoOfType(part, ts.IndexKind.String) !== undefined);
}

/** The property this is, by name, or undefined where the name itself is
 *  computed from something this cannot fold — which is a `code` under another
 *  spelling and is reported as unreadable rather than skipped. */
function propertyNamed(checker: ts.TypeChecker, name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isComputedPropertyName(name)) return textOf(checker, name.expression);
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** The body types this tree hands an exception without writing them at the
 *  throw. `RefusalBody` is the only one — `capability/write-envelope.ts`,
 *  `capability/capability.guard.ts` and `capability/github-refusal.ts` — and it
 *  declares no `code`. The check re-reads that rather than trusting the name, so
 *  a `code` added to `RefusalBody` makes all three unreadable and this red. */
const BODIES_WRITTEN_AWAY_FROM_THE_THROW = ['RefusalBody'];

/**
 * Whether this file can decide what `code`, if any, the body reaches the wire
 * with.
 *
 * A message is not a body: a string carries no properties, so every
 * `new …Exception('…')` in the tree is decided here and none of them is
 * reported. An object literal written at the throw is decided by reading its
 * own `code`. Anything else is a value assembled somewhere this walk is not
 * standing, and is reported unless its type is one of the two above.
 */
function readableBody(checker: ts.TypeChecker, argument: ts.Expression | undefined): boolean {
  if (!argument) return true;
  const type = checker.getTypeAtLocation(argument);
  if (isPrimitive(type)) return true;
  if (ts.isObjectLiteralExpression(argument)) {
    // In WRITTEN ORDER, because the last `code` in a literal is the one that
    // ships: a spread that could carry one loses the argument again, and an
    // explicit `code` after it settles it. `code: undefined` settles it too —
    // that is a body saying it has none, and `JSON.stringify` drops the key.
    let decided = true;
    for (const property of argument.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (mayCarryCode(checker, checker.getTypeAtLocation(property.expression))) decided = false;
        continue;
      }
      const name = propertyNamed(checker, property.name);
      if (name === undefined) { decided = false; continue; }
      if (name !== 'code') continue;
      const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      decided = textOf(checker, value) !== undefined
        || (checker.getTypeAtLocation(value).flags & ts.TypeFlags.Undefined) !== 0;
    }
    return decided;
  }
  return BODIES_WRITTEN_AWAY_FROM_THE_THROW.includes(checker.typeToString(type)) && !mayCarryCode(checker, type);
}

/**
 * Whether `new X(…)` builds an HTTP refusal, asked of the CLASS rather than of
 * the name the line spells it with.
 *
 * The version of this file before it tested `/Exception$/` against the written
 * callee, which is a spelling gate inside the check whose whole point is that
 * spelling is not what pins a body. `import { ServiceUnavailableException as
 * Refusal }` retires such a gate in one line, and a refusal class need not be
 * called one at all: `sources/github-quota.ts` already ships
 * `GithubQuotaCooldownError extends ServiceUnavailableException`, and both of
 * those went past the name test with everything here green.
 *
 * The name test is kept alongside this rather than replaced by it, because a
 * class the checker cannot resolve has no base types to walk and would fall out
 * of both otherwise.
 */
function isHttpRefusal(checker: ts.TypeChecker, node: ts.NewExpression): boolean {
  const seen = new Set<ts.Type>();
  const derives = (type: ts.Type): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (checker.typeToString(type) === 'HttpException') return true;
    return (type.isClassOrInterface() ? checker.getBaseTypes(type) : []).some(derives);
  };
  return derives(checker.getTypeAtLocation(node));
}

/** The function a node is written inside, which is the unit the walk below asks
 *  who calls. */
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isFunctionExpression(at)
      || ts.isArrowFunction(at) || ts.isConstructorDeclaration(at)
      || ts.isGetAccessorDeclaration(at) || ts.isSetAccessorDeclaration(at)) return at;
  }
  return undefined;
}

/**
 * Whether this function EXISTS to raise the exception, rather than raising it
 * down one of its branches.
 *
 * The test is where the `throw` or the `return` stands: a statement of the
 * function's own body is on every path through it, so every caller reaches it
 * and each of those callers is a site. A `throw` under an `if`, a `try` or a
 * loop is one branch of a function that does something else, and the throw
 * itself is the site — which is all five of the real ones. A concise arrow body
 * is the whole function and counts the same as an unbranched statement.
 */
function raisesForItsCallers(fn: ts.FunctionLikeDeclaration, node: ts.Node): boolean {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return true;
  for (let at: ts.Node | undefined = node; at && at !== fn; at = at.parent) {
    if (at.parent === fn.body) return ts.isThrowStatement(at) || ts.isReturnStatement(at);
  }
  return false;
}

describe('and nothing else in this tree can reach the code (#1066)', () => {
  const program = buildWriteProgram();
  const checker = program.getTypeChecker();
  const shipped = program.getSourceFiles().filter((f) => !f.isDeclarationFile && !relative(SRC_DIR, f.fileName).startsWith('..'));
  const found: Reach[] = [];
  const unreadable: string[] = [];

  const where = (node: ts.Node) => {
    const file = node.getSourceFile();
    return {
      file: relative(SRC_DIR, file.fileName),
      line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    };
  };

  for (const file of shipped) {
    const visit = (node: ts.Node) => {
      // An import binds a name; what it is worth is settled where it is USED,
      // and the checker is what carries it there.
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
      if (isDeclarationName(node)) return;
      // Every body in this tree that carries a code is an object literal
      // written at the throw, which is what lets the walk below see the value.
      // One that is not is reported rather than skipped: a code this cannot
      // read is a code this cannot pin.
      if (ts.isNewExpression(node) && !readableBody(checker, node.arguments?.[0])
        && (/Exception$/.test(node.expression.getText()) || isHttpRefusal(checker, node))) {
        unreadable.push(`${where(node).file}:${where(node).line}  ${node.expression.getText()}`);
      }
      if (ts.isExpression(node) && textOf(checker, node) === ACCESS_NOT_NOW_CODE) {
        const declaration = ts.isVariableDeclaration(node.parent) && node.parent.name.getText() === 'ACCESS_NOT_NOW_CODE';
        found.push({ node, declaration, message: bodyAround(node, checker) });
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }

  /**
   * Every identifier in the tree, under the thing it names.
   *
   * Built once, and only if something above is raised for its callers — which
   * nothing in the tree is, so an ordinary run never pays for it. An import
   * binds an alias to the same declaration, so the alias is resolved rather
   * than counted: `import { refuse }` is not a call of `refuse`.
   */
  let uses: Map<ts.Symbol, ts.Node[]> | undefined;
  const usesOf = (fn: ts.FunctionLikeDeclaration): ts.Node[] => {
    if (!uses) {
      const index = new Map<ts.Symbol, ts.Node[]>();
      for (const file of shipped) {
        const collect = (node: ts.Node) => {
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
          if (ts.isIdentifier(node)) {
            const symbol = checker.getSymbolAtLocation(node);
            const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
            if (resolved) index.set(resolved, [...(index.get(resolved) ?? []), node]);
          }
          ts.forEachChild(node, collect);
        };
        ts.forEachChild(file, collect);
      }
      uses = index;
    }
    const name = fn.name ?? (ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined);
    const symbol = name && checker.getSymbolAtLocation(name);
    return symbol ? (uses.get(symbol) ?? []).filter((node) => node !== name) : [];
  };

  /**
   * Who can raise this reach, which is the throw itself unless a function was
   * written to raise it on somebody's behalf — then it is each of that
   * function's callers, and each of theirs. Counting throws instead is how one
   * shared refusal helper called from a withdrawal path stayed invisible to
   * #1073's review while it shipped the code on the wire.
   */
  const raisedAt = (reach: Reach, seen: Set<ts.Node>): Reach[] => {
    const fn = enclosingFunction(reach.node);
    if (!fn || seen.has(fn) || !raisesForItsCallers(fn, reach.node)) return [reach];
    seen.add(fn);
    const callers = usesOf(fn);
    // A helper nothing calls is still a reach, and reporting it where it is
    // written is better than losing it.
    return callers.length ? callers.flatMap((node) => raisedAt({ ...reach, node }, seen)) : [reach];
  };

  const reaches = found.flatMap((reach) => (reach.declaration ? [reach] : raisedAt(reach, new Set())));
  const named = (r: Reach) =>
    `${where(r.node).file}  ${r.message ?? `reaches the code outside an exception body, line ${where(r.node).line}`}`;

  it('reads the files a sixth site would be written in', () => {
    // The scan standing on somebody else's file list is worth a check of its
    // own: both of #1073's evasions were written in the interceptor, and a
    // narrowing that dropped it would leave every assertion below green.
    const files = shipped.map((f) => relative(SRC_DIR, f.fileName));
    for (const file of ['auth/github-expiry.interceptor.ts', 'auth/github-principal.guard.ts', ...SITES.map((s) => s.file)]) {
      expect(files, 'a file this cannot see is a file the code can be added in').toContain(file);
    }
  });

  it('puts no code in an exception body this cannot read', () => {
    expect(unreadable, 'a body this cannot read is a body that can carry the code past every assertion here').toEqual([]);
  });

  it('is declared once, in auth/access-not-now.ts', () => {
    expect(reaches.filter((r) => r.declaration).map((r) => where(r.node).file)).toEqual(['auth/access-not-now.ts']);
  });

  it('is raised at exactly the five transient sites, and each sends the body it is supposed to', () => {
    const emitted = reaches.filter((r) => !r.declaration).map(named).sort();
    expect(emitted, 'a withdrawal path must not gain the code the browser draws its saved copy over')
      .toEqual(SITES.map((s) => `${s.file}  ${s.message}`).sort());
  });
});

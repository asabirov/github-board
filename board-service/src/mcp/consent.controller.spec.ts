import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { ConsentController } from './consent.controller';
import { INITIATOR_COOKIE, McpOAuthProvider } from './mcp-oauth.provider';
import { InMemoryMcpGrantRepository } from './mcp-grant.repository';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { CodeStore, InMemoryClientsStore, PendingAuthStore } from './oauth-store';
import { AdminAuthority } from '../auth/admin-authority';
import type { AuditService } from '../audit/audit.service';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { BOARD_ADMIN, BOARD_READ } from '../auth/scopes';

const CSRF = 'csrf-token';
/** The initiator secret this suite's browser holds, and its records carry (#554). */
const INIT = 'initiator-secret-for-this-browser-abcdefgh';

/**
 * The same lengths, different values. Every other wrong-secret fixture in this
 * file happens to differ in length as well as in value — `'wrong'` against
 * `'csrf-token'`, a 32-character initiator against a 42-character one — so
 * replacing the whole of `secretsMatch` with `a.length === b.length` left the
 * suite green. Both controls were pinned by nothing but a length. These two
 * fixtures are what make the comparison itself load-bearing, and they are
 * derived from the real ones so they cannot drift out of length with them.
 */
const CSRF_SAME_LENGTH = `${CSRF.slice(0, -1)}X`;
const INIT_SAME_LENGTH = `${INIT.slice(0, -1)}X`;
const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;

/** AdminAuthority over a break-glass env list and an assigned-role snapshot. */
function authority(opts: { env?: string; assigned?: string[] } = {}): AdminAuthority {
  const cfg = {
    get: (key: string, def?: unknown) => (key === 'BOARD_ADMIN_EMAILS' ? (opts.env ?? '') : def),
  } as unknown as ConfigService;
  return new AdminAuthority(cfg, { emails: () => opts.assigned ?? [] });
}

/** A real provider over stub Google. Real on purpose: the assertions below read
 *  the scopes off the issued authorization code, so a stub would test itself. */
function provider(): McpOAuthProvider {
  const google = {
    // Echoes `opts.jti`, like every other double of this method (#456). The
    // caller mints the jti and keys the access-token row on it; a double that
    // signs anything else pairs a row with a token that is not the one it names.
    issueMcpToken: async (u: { sub: string }, scopes: string[], opts: { jti: string }) =>
      `tok:${u.sub}:${scopes.join(',')}:${opts.jti}`,
    verifySession: async () => ({ sub: 'u1', email: 'a@example.com' }),
  } as never;
  return new McpOAuthProvider(
    google,
    config,
    new InMemoryMcpGrantRepository(),
    authority({ env: 'a@example.com' }),
    { record: async () => {} } as unknown as AuditService,
    new SessionRevocationService(),
    new InMemoryClientsStore(),
    new PendingAuthStore(),
    new CodeStore(),
  );
}

function pend(p: McpOAuthProvider): Promise<string> {
  return p.pendingStore.create({
    clientId: 'c1',
    redirectUri: 'http://localhost:1234/cb',
    codeChallenge: 'ch',
    requestedScopes: [BOARD_READ, BOARD_ADMIN],
    initiator: INIT,
  });
}

/** Minimal express doubles — only the members the controller touches. */
function res() {
  const out = {
    redirectedTo: null as string | null,
    status_: 200,
    body: '' as string,
    cookies: {} as Record<string, string>,
    cookieOpts: {} as Record<string, Record<string, unknown>>,
    cookie: (n: string, v: string, o: Record<string, unknown> = {}) => (
      (out.cookies[n] = v), (out.cookieOpts[n] = o), out
    ),
    clearCookie: () => out,
    type: () => out,
    send: (b: string) => ((out.body = b), out),
    status: (c: number) => ((out.status_ = c), out),
    redirect: (u: string) => ((out.redirectedTo = u), out),
  };
  return out as typeof out & Response;
}

/** A signed-in browser carrying both the CSRF token and the initiator secret. */
const req = (user: Record<string, unknown>) =>
  ({
    headers: { cookie: `atlas_consent_csrf=${CSRF}; ${INITIATOR_COOKIE}=${INIT}` },
    user,
  }) as unknown as Request & { user?: { sub?: string; email?: string } };

/** The same browser, minus the initiator secret — a pre-seeded consent link. */
const reqUnbound = (user: Record<string, unknown>) =>
  ({ headers: { cookie: `atlas_consent_csrf=${CSRF}` }, user }) as unknown as Request & {
    user?: { sub?: string; email?: string };
  };

/** A browser carrying somebody else's initiator secret. */
const reqOtherBrowser = (user: Record<string, unknown>) =>
  ({
    headers: { cookie: `atlas_consent_csrf=${CSRF}; ${INITIATOR_COOKIE}=some-other-browsers-secret-value` },
    user,
  }) as unknown as Request & { user?: { sub?: string; email?: string } };

/** Somebody else's initiator secret, of exactly the right length. */
const reqSameLengthOtherBrowser = (user: Record<string, unknown>) =>
  ({
    headers: { cookie: `atlas_consent_csrf=${CSRF}; ${INITIATOR_COOKIE}=${INIT_SAME_LENGTH}` },
    user,
  }) as unknown as Request & { user?: { sub?: string; email?: string } };

/** The scopes actually written onto the grant, read back off the issued code. */
async function grantedScopes(
  p: McpOAuthProvider,
  redirectTo: string | null,
): Promise<string[] | null> {
  if (!redirectTo) return null;
  const code = new URL(redirectTo).searchParams.get('code');
  return code ? ((await p.codeStore.consume(code))?.scopes ?? null) : null;
}

afterEach(() => vi.restoreAllMocks());

describe('ConsentController — who may reach the route at all (#545)', () => {
  it('the whole controller is human-only: a token never reaches consent', async () => {
    // Structural, so a later @RequiredScopes edit on decide() cannot re-open it.
    // Class-level @UseGuards writes its metadata onto the constructor.
    const guards = Reflect.getMetadata('__guards__', ConsentController) as unknown[] | undefined;
    // The isArray line is load-bearing, not defensive noise. With no @UseGuards
    // at all the metadata is `undefined`, and in this vitest
    // `expect(undefined).toContain(x)` PASSES silently — so the toContain below
    // on its own would be green against a controller carrying no guard.
    expect(Array.isArray(guards)).toBe(true);
    expect(guards).toContain(HumanOnlyGuard);
  });
});

describe('ConsentController — who may consent to admin scope (#545)', () => {
  it('a non-admin choosing Full is granted read alone', async () => {
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: await pend(p), scope: 'full', csrf: CSRF },
      r,
    );
    // Asserted on the GRANT, not on a downstream refusal: a 403 here would pin
    // AdminGuard, which refuses this person today with or without the fix.
    expect(await grantedScopes(p, r.redirectedTo)).toEqual([BOARD_READ]);
  });

  it('an admin choosing Full is granted read and admin', async () => {
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.decide(
      req({ sub: 'u2', email: 'boss@example.com' }),
      { req: await pend(p), scope: 'full', csrf: CSRF },
      r,
    );
    expect(await grantedScopes(p, r.redirectedTo)).toEqual([BOARD_READ, BOARD_ADMIN]);
  });

  it('the break-glass admin recovering an empty board still gets Full (#371)', async () => {
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ env: 'boss@example.com' }));
    const r = res();
    await ctl.decide(
      req({ sub: 'u3', email: 'boss@example.com' }),
      { req: await pend(p), scope: 'full', csrf: CSRF },
      r,
    );
    expect(await grantedScopes(p, r.redirectedTo)).toEqual([BOARD_READ, BOARD_ADMIN]);
  });

  it('the break-glass stays dormant while an assigned admin exists', async () => {
    const p = provider();
    const ctl = new ConsentController(
      p, config, authority({ env: 'boss@example.com', assigned: ['owner@example.com'] }),
    );
    const r = res();
    await ctl.decide(
      req({ sub: 'u4', email: 'boss@example.com' }),
      { req: await pend(p), scope: 'full', csrf: CSRF },
      r,
    );
    expect(await grantedScopes(p, r.redirectedTo)).toEqual([BOARD_READ]);
  });

  it('choosing Agent is read-only for everybody, admin included', async () => {
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.decide(
      req({ sub: 'u2', email: 'boss@example.com' }),
      { req: await pend(p), scope: 'agent', csrf: CSRF },
      r,
    );
    expect(await grantedScopes(p, r.redirectedTo)).toEqual([BOARD_READ]);
  });

  it('a mismatched CSRF token grants nothing and consumes nothing', async () => {
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    const id = await pend(p);
    await ctl.decide(
      req({ sub: 'u2', email: 'boss@example.com' }),
      { req: id, scope: 'full', csrf: 'wrong' },
      r,
    );
    expect(r.redirectedTo).toBeNull();
    expect(r.status_).toBe(400);
    // The pending request survives a CSRF failure — nothing was consumed.
    expect((await p.pendingStore.peek(id))).not.toBeNull();
  });

  it('answers a request it cannot finish with a page, not a bare paragraph (#555)', async () => {
    // Three paths land here and one of them is somebody who has just pressed a
    // button on a credential screen. An unstyled `<p>` is not an answer.
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.decide(req({ sub: 'u2', email: 'boss@example.com' }), { req: 'gone', scope: 'agent', csrf: CSRF }, r);
    expect(r.status_).toBe(400);
    expect(r.body).toContain('<!doctype html>');
    expect(r.body).toContain('<style>');
    expect(r.body).not.toContain('value="agent"');
  });

  it('a capped grant leaves an audit line naming the actor and what was dropped', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    await ctl.decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: await pend(p), scope: 'full', csrf: CSRF },
      res(),
    );
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('dev@example.com');
    expect(line).toContain(BOARD_ADMIN);
  });

  it('an uncapped grant leaves no such line, so the audit signal means something', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    await ctl.decide(
      req({ sub: 'u2', email: 'boss@example.com' }),
      { req: await pend(p), scope: 'full', csrf: CSRF },
      res(),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * One browser, one cookie jar: `res.cookie` writes into it, `res.clearCookie`
 * deletes from it, and every request built from it carries what it holds. The
 * plain `res()` double above throws each response's cookies away, which is
 * exactly why a jar-shaped defect — a second tab overwriting the first tab's
 * token — could not be seen from any row in this file.
 */
function jarBrowser(user: Record<string, unknown>) {
  const jar: Record<string, string> = { [INITIATOR_COOKIE]: INIT };
  const header = () =>
    Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  const res = () => {
    const out = {
      redirectedTo: null as string | null,
      status_: 200,
      body: '' as string,
      cookie: (n: string, v: string) => ((jar[n] = v), out),
      clearCookie: (n: string) => (delete jar[n], out),
      type: () => out,
      send: (b: string) => ((out.body = b), out),
      status: (c: number) => ((out.status_ = c), out),
      redirect: (u: string) => ((out.redirectedTo = u), out),
    };
    return out as typeof out & Response;
  };
  const request = () =>
    ({ headers: { cookie: header() }, user }) as unknown as Request & {
      user?: { sub?: string; email?: string };
    };
  return { jar, res, request };
}

/**
 * D1b, on the control that actually broke it. The binding cookie was designed
 * for concurrency — one name, one reused value — and then the CSRF token beside
 * it was minted fresh on every GET into a single cookie name, so opening a
 * second consent tab silently invalidated the first. The person got the page
 * that says the request timed out, when it had not: it was live, it was theirs,
 * and the board had thrown its own token away.
 */
describe('ConsentController — two consent tabs in one browser (#554 D1b)', () => {
  function ctlWith(p: McpOAuthProvider) {
    return new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
  }

  /** The token the rendered page puts in its forms. */
  const tokenOf = (body: string) => body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';

  it('both tabs answer, and neither is told its live request expired', async () => {
    const p = provider();
    const ctl = ctlWith(p);
    const b = jarBrowser({ sub: 'u2', email: 'boss@example.com' });
    const ids = [await pend(p), await pend(p)];

    // Both tabs open, tab 1 first — the order that loses tab 1's token.
    const tokens = [];
    for (const id of ids) {
      const r = b.res();
      await ctl.page(b.request(), id, r);
      tokens.push(tokenOf(r.body));
    }
    expect(tokens[0]).not.toBe('');

    // Then the person answers them, in the order they were opened.
    for (const [i, id] of ids.entries()) {
      const r = b.res();
      await ctl.decide(b.request(), { req: id, scope: 'agent', csrf: tokens[i] }, r);
      expect(await grantedScopes(p, r.redirectedTo)).toEqual([BOARD_READ]);
    }
  });

  it('answering one tab does not disarm the other', async () => {
    // The second half of the same defect: clearing the token cookie on the POST
    // is a jar-wide edit, so the tab that has not been answered yet loses the
    // cookie half of its synchronizer and fails the check it was going to pass.
    const p = provider();
    const ctl = ctlWith(p);
    const b = jarBrowser({ sub: 'u2', email: 'boss@example.com' });
    const first = await pend(p);
    const second = await pend(p);
    const r1 = b.res();
    await ctl.page(b.request(), first, r1);
    const r2 = b.res();
    await ctl.page(b.request(), second, r2);

    await ctl.decide(b.request(), { req: first, scope: 'agent', csrf: tokenOf(r1.body) }, b.res());
    const r = b.res();
    await ctl.decide(b.request(), { req: second, scope: 'agent', csrf: tokenOf(r2.body) }, r);
    expect(await grantedScopes(p, r.redirectedTo)).toEqual([BOARD_READ]);
  });

  it('a GET for a request that is not live writes no cookie at all', async () => {
    // `/api/oauth/consent?req=<anything>` used to mint and set a token before it
    // knew whether the request existed, which made an unauthenticated-shaped URL
    // a cookie-rotation endpoint: hand somebody a link and their in-flight token
    // is replaced. Nothing is set until the request is known live and known to
    // be this browser's.
    const p = provider();
    const r = res();
    await ctlWith(p).page(req({ sub: 'u2', email: 'boss@example.com' }), 'no-such-request', r);
    expect(Object.keys(r.cookies)).toEqual([]);
  });

  it('a GET whose binding fails writes no cookie either', async () => {
    const p = provider();
    const r = res();
    await ctlWith(p).page(reqUnbound({ sub: 'u1', email: 'dev@example.com' }), await pend(p), r);
    expect(Object.keys(r.cookies)).toEqual([]);
  });
});

/**
 * Both secrets this controller compares are compared by VALUE. Every other row
 * in this file offers a wrong secret that also has a wrong length, so a
 * `secretsMatch` reduced to `a.length === b.length` — no `timingSafeEqual`, no
 * value comparison at all — passed the entire suite. These rows are the ones
 * that go red for it, and they are why the comparison may not be weakened back
 * into a length check.
 */
describe('ConsentController — a secret of the right length is still the wrong secret', () => {
  function ctlWith(p: McpOAuthProvider) {
    return new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
  }

  it('refuses a POST whose CSRF token is the right length and the wrong value', async () => {
    const p = provider();
    const id = await pend(p);
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u2', email: 'boss@example.com' }),
      { req: id, scope: 'full', csrf: CSRF_SAME_LENGTH },
      r,
    );
    expect(CSRF_SAME_LENGTH.length).toBe(CSRF.length);
    expect(CSRF_SAME_LENGTH).not.toBe(CSRF);
    expect(r.redirectedTo).toBeNull();
    expect(r.status_).toBe(400);
    expect((await p.pendingStore.peek(id))).not.toBeNull();
  });

  it('refuses a refusal whose CSRF token is the right length and the wrong value', async () => {
    const p = provider();
    const id = await pend(p);
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u2', email: 'boss@example.com' }),
      { req: id, decision: 'deny', csrf: CSRF_SAME_LENGTH },
      r,
    );
    expect(r.redirectedTo).toBeNull();
    expect(r.status_).toBe(400);
    expect((await p.pendingStore.peek(id))).not.toBeNull();
  });

  it('refuses a GET whose initiator secret is the right length and the wrong value', async () => {
    const p = provider();
    const r = res();
    expect(INIT_SAME_LENGTH.length).toBe(INIT.length);
    expect(INIT_SAME_LENGTH).not.toBe(INIT);
    await ctlWith(p).page(reqSameLengthOtherBrowser({ sub: 'u1', email: 'dev@example.com' }), await pend(p), r);
    expect(r.body).not.toContain('value="agent"');
    expect(r.status_).toBe(403);
  });

  it('refuses a POST whose initiator secret is the right length and the wrong value', async () => {
    const p = provider();
    const id = await pend(p);
    const r = res();
    await ctlWith(p).decide(
      reqSameLengthOtherBrowser({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, scope: 'full', csrf: CSRF },
      r,
    );
    expect(r.redirectedTo).toBeNull();
    expect(r.status_).toBe(403);
    expect((await p.pendingStore.peek(id))).not.toBeNull();
  });
});

/**
 * The cookie names both halves of this flow agree on are deployment-dependent:
 * `__Host-` prefixed where the browser will enforce it, bare where the browser
 * would reject it. The controller has to read exactly the name the provider
 * writes, or every consent page on a secure deployment is refused as unbound.
 */
describe('ConsentController — the cookie names follow the deployment (#554)', () => {
  const secureConfig = {
    get: (k: string, d?: unknown) => (k === 'BOARD_BASE_URL' ? 'https://board' : d),
  } as unknown as ConfigService;

  const withCookies = (cookie: string) =>
    ({ headers: { cookie }, user: { sub: 'u1', email: 'dev@example.com' } }) as unknown as Request & {
      user?: { sub?: string; email?: string };
    };

  it('reads the prefixed binding cookie, and only that one, when secure', async () => {
    const p = provider();
    const ctl = new ConsentController(p, secureConfig, authority({ assigned: ['boss@example.com'] }));

    const prefixed = res();
    await ctl.page(withCookies(`__Host-${INITIATOR_COOKIE}=${INIT}`), await pend(p), prefixed);
    expect(prefixed.body).toContain('value="agent"');

    // The bare name is the one a sibling host can write. It is not the board's.
    const bare = res();
    await ctl.page(withCookies(`${INITIATOR_COOKIE}=${INIT}`), await pend(p), bare);
    expect(bare.body).not.toContain('value="agent"');
    expect(bare.status_).toBe(403);
  });

  it('writes the token cookie under the prefixed name too, at the path the prefix requires', async () => {
    const p = provider();
    const ctl = new ConsentController(p, secureConfig, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.page(withCookies(`__Host-${INITIATOR_COOKIE}=${INIT}`), await pend(p), r);
    const [name] = Object.keys(r.cookies);
    expect(name).toBe('__Host-atlas_consent_csrf');
    expect(r.cookieOpts[name]).toMatchObject({ secure: true, path: '/' });
    expect(r.cookieOpts[name].domain).toBeUndefined();
  });
});

describe('ConsentController.page — the screen offers only what the person may hold (#545)', () => {
  it("a non-admin's page has no Full button", async () => {
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.page(req({ sub: 'u1', email: 'dev@example.com' }), await pend(p), r);
    expect(r.body).toContain('value="agent"');
    expect(r.body).not.toContain('value="full"');
  });

  it("an admin's page has both", async () => {
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.page(req({ sub: 'u2', email: 'boss@example.com' }), await pend(p), r);
    expect(r.body).toContain('value="agent"');
    expect(r.body).toContain('value="full"');
  });

  it('puts the token it just set in the cookie into the form, and nothing else', async () => {
    // The synchronizer only works if the two halves are the same value. Every
    // other assertion in this suite reads the page through `value="agent"` and
    // friends, so until this one existed a call site that handed the client's
    // name to `csrf` and the token to `clientName` rendered a page that looked
    // right, typechecked, and left the POST unprotected — with the whole suite
    // green. That is the swap the options object exists to make unwritable, and
    // this is what proves it stayed unwritten.
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.page(req({ sub: 'u2', email: 'boss@example.com' }), await pend(p), r);
    const token = r.cookies['atlas_consent_csrf'];
    expect(token).toMatch(/^[\w-]{20,}$/);
    expect(r.body).toContain(`name="csrf" value="${token}"`);
  });

  it('answers a duplicated ?req=a&req=b with the dead-request page, not a 500 (#545)', async () => {
    // express hands a repeated query parameter over as an array, which every
    // string operation downstream of @Query used to throw on. Since the GET
    // started consulting the pending store, the array no longer reaches `esc()`
    // at all: it matches no record and the request is refused as dead before
    // anything renders it. So this row now covers the CONTROLLER half — an array
    // is answered rather than thrown on — and the render half, that `esc` itself
    // survives an array, is covered in `consent-html.spec.ts`.
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.page(
      req({ sub: 'u2', email: 'boss@example.com' }),
      ['a', 'b'] as unknown as string,
      r,
    );
    expect(r.body).toContain('<!doctype html>');
    expect(r.status_).toBe(400);
    expect(r.body).not.toContain('value="agent"');
  });
});

describe('ConsentController.page — the screen names who is asking (#554)', () => {
  /** A registered client, a pending request for it, and the page it renders. */
  async function pageFor(opts: {
    clientName?: string;
    registered?: boolean;
    redirectUri?: string;
    pendingTo?: string;
  }) {
    const p = provider();
    const redirectUri = opts.redirectUri ?? 'http://localhost:1234/cb';
    if (opts.registered !== false) {
      await p.clientsStore.registerClient({
        client_id: 'c1',
        ...(opts.clientName === undefined ? {} : { client_name: opts.clientName }),
        redirect_uris: [redirectUri],
      } as never);
    }
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    const id = await p.pendingStore.create({
      clientId: 'c1',
      redirectUri: opts.pendingTo ?? redirectUri,
      codeChallenge: 'ch',
      initiator: INIT,
    });
    await ctl.page(req({ sub: 'u1', email: 'dev@example.com' }), id, r);
    return r.body;
  }

  it('names the registered client, and the placeholder is gone from the code', async () => {
    // The whole of #554 in one row: before this, every client on earth rendered
    // as the same two words.
    const body = await pageFor({ clientName: 'Claude Desktop' });
    expect(body).toContain('Authorize Claude Desktop');
    expect(body).not.toContain('MCP client');
  });

  it('carries each registration its own name, and only its own', async () => {
    // This row used to assert only that two pages were not byte-identical, which
    // `pageFor` guarantees on its own: it builds a fresh provider per call, so
    // the csrf token and the request id differ whatever the name is. Two calls
    // with the SAME name passed it too. What is worth pinning is that the name
    // reaching the page is the one on THIS registration.
    expect(await pageFor({ clientName: 'Claude Desktop' })).toContain('Authorize Claude Desktop');
    const cursor = await pageFor({ clientName: 'Cursor' });
    expect(cursor).toContain('Authorize Cursor');
    expect(cursor).not.toContain('Claude Desktop');
  });

  it("shows the address on the pending record, not the registration's first entry", async () => {
    // A registration may list several and the code goes to the one on the
    // record. Showing the list would show a place the code is not going.
    const body = await pageFor({
      clientName: 'Claude Desktop',
      redirectUri: 'http://localhost:1111/first',
      pendingTo: 'http://localhost:1111/second',
    });
    expect(body).toContain('http://localhost:1111/second');
    expect(body).not.toContain('http://localhost:1111/first');
  });

  it('says a client gave no name rather than writing the word undefined', async () => {
    const body = await pageFor({ clientName: undefined });
    expect(body).toContain('Authorize an unnamed client');
    expect(body).not.toContain('undefined');
  });

  it('still offers the grant to a client the registry has forgotten', async () => {
    const body = await pageFor({ registered: false });
    expect(body).toContain('value="agent"');
    expect(body).toContain('http://localhost:1234/cb');
  });

  it('refuses a dead request with the terminal page and nothing to press', async () => {
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.page(req({ sub: 'u1', email: 'dev@example.com' }), 'no-such-request', r);
    expect(r.body).toContain('<!doctype html>');
    expect(r.body).not.toContain('value="agent"');
    expect(r.body).not.toContain('value="full"');
    expect(r.status_).toBe(400);
  });
});

describe('ConsentController.page — where the code is going leaves a trace (#554)', () => {
  /**
   * Every variant of the pre-seeded-consent attack needs a destination the
   * attacker can read, and none of them can be loopback. So a consent page
   * pointing somewhere remote is the one signal the board gets for free, and it
   * is classified by HOST rather than by scheme: a `vscode:` URL has no
   * loopback host and warns too. That noise is accepted (Decision 2e); if it
   * ever becomes unusable the fix is a third classification, not deletion.
   */
  async function renderTo(redirectUri: string, clientName?: string) {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const p = provider();
    if (clientName !== undefined) {
      await p.clientsStore.registerClient({
        client_id: 'c1',
        client_name: clientName,
        redirect_uris: [redirectUri],
      } as never);
    }
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    // Bound, so the only line these rows can produce is the destination one. An
    // unbound record refuses before the destination is ever classified, and
    // every "stays quiet" row below would then be green for the wrong reason.
    const id = await p.pendingStore.create({
      clientId: 'c1',
      redirectUri,
      codeChallenge: 'ch',
      initiator: INIT,
    });
    await ctl.page(req({ sub: 'u1', email: 'dev@example.com' }), id, res());
    return warn.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('warns when the code is headed somewhere remote, naming the actor and the client id', async () => {
    const line = await renderTo('https://evil.example/cb');
    expect(line).toContain('dev@example.com');
    expect(line).toContain('c1');
  });

  it.each([
    ['http://localhost:1234/cb'],
    ['http://127.0.0.1:5000/cb'],
    ['http://127.5.5.5:5000/cb'],
    ['http://[::1]:5000/cb'],
  ])('stays quiet for the ordinary local client at %s', async (uri) => {
    // If every destination warned, the signal would mean nothing — RFC 8252
    // loopback port relaxation makes `http://localhost:<any port>/cb` the
    // normal case for a local MCP client.
    expect(await renderTo(uri)).toBe('');
  });

  it.each([['vscode://ms-vscode/cb'], ['cursor:cb']])('warns for a custom-scheme destination with no loopback host: %s', async (uri) => {
      expect(await renderTo(uri)).toContain('c1');
    },
  );

  it("never puts the client's self-chosen name in the line", async () => {
    // `client_id` is the board's own identifier; `client_name` is a stranger's
    // text, and a log line is a place it must never reach.
    const line = await renderTo('https://evil.example/cb', 'Sneaky Client');
    expect(line).toContain('c1');
    expect(line).not.toContain('Sneaky Client');
  });

  /**
   * The same classification the log line above is drawn from also decides what
   * the page says out loud, so the two cannot disagree — and it is computed
   * from the RAW registered address, not from the normalised string the page
   * prints, because where those differ the raw one is where the code goes.
   */
  describe('and the page says only what that classification supports (#554)', () => {
    async function pageFor(redirectUri: string) {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const p = provider();
      const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
      const id = await p.pendingStore.create({
        clientId: 'c1',
        redirectUri,
        codeChallenge: 'ch',
        initiator: INIT,
      });
      const r = res();
      await ctl.page(req({ sub: 'u1', email: 'dev@example.com' }), id, r);
      return r.body;
    }

    it.each([['http://localhost:1234/cb'], ['http://127.0.0.1:5000/cb'], ['http://[::1]:5000/cb']])('tells the ordinary local client the code stays here: %s', async (uri) => {
        expect(await pageFor(uri)).toContain('The code stays on this computer, at');
      },
    );

    it('tells a hosted client the code leaves', async () => {
      expect(await pageFor('https://claude.ai/api/mcp/auth_callback')).toContain(
        'The code leaves this computer, to',
      );
    });

    it.each([
      // Reads as remote to a host-based test, but reaches a program on this
      // machine. The board must not say it leaves.
      ['cursor://anysphere.cursor-retrieval/cb'],
      // The mirror image, and the reason the scheme is consulted as well as the
      // host: a loopback HOST under a custom scheme is not an http request to
      // this machine either, so "stays on this computer" is not the board's to
      // say. A page deriving its wording from the loopback test alone says it.
      ['myapp://localhost/cb'],
      ['cursor:cb'],
    ])('claims nothing about where a custom scheme goes: %s', async (uri) => {
      expect(await pageFor(uri)).not.toContain('this computer');
    });
  });
});

describe('the capped grant reaches the client (#545)', () => {
  it("a non-admin's token exchange reports board:read as the granted scope", async () => {
    const p = provider();
    const ctl = new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
    const r = res();
    await ctl.decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: await pend(p), scope: 'full', csrf: CSRF },
      r,
    );
    const code = new URL(r.redirectedTo!).searchParams.get('code')!;
    const tokens = await p.exchangeAuthorizationCode(
      { client_id: 'c1', redirect_uris: ['http://localhost:1234/cb'] } as never,
      code,
    );
    expect(tokens.scope).toBe(BOARD_READ);
    // The double appends the jti the caller minted, so the token is matched on
    // its scope segment rather than on the whole string.
    expect(tokens.access_token).toMatch(new RegExp(`^tok:u1:${BOARD_READ}:`));
  });
});

/**
 * A failed binding check means a signed-in board member is looking at a consent
 * page for a request their browser did not start. That is the signature of the
 * pre-seeded-link attack and of essentially nothing else — so it refuses, it
 * offers nothing to press, and it is the one place the board ever learns it was
 * probed. An earlier draft of this control rendered a page and recorded nothing.
 */
describe('ConsentController — a request can only be answered in the browser that started it (#554)', async () => {
  function ctlWith(p: McpOAuthProvider) {
    return new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
  }

  it('refuses a GET carrying no initiator cookie, and offers nothing that grants', async () => {
    const p = provider();
    const r = res();
    await ctlWith(p).page(reqUnbound({ sub: 'u1', email: 'dev@example.com' }), await pend(p), r);
    expect(r.body).not.toContain('value="agent"');
    expect(r.body).not.toContain('value="full"');
    expect(r.body).toContain('<!doctype html>');
    // The status is part of the refusal and nothing asserted it: dropping it
    // left the suite green on a 200 that carries a refusal page.
    expect(r.status_).toBe(403);
  });

  it('refuses a GET carrying another browser\'s initiator cookie', async () => {
    const p = provider();
    const r = res();
    await ctlWith(p).page(reqOtherBrowser({ sub: 'u1', email: 'dev@example.com' }), await pend(p), r);
    expect(r.body).not.toContain('value="agent"');
    expect(r.status_).toBe(403);
  });

  it('does not tell the refused person their request expired', async () => {
    // The honest case is an MCP client that opened the system default browser
    // while the person is signed in to another one. "Expired" would send them
    // to redo the thing that just failed.
    const p = provider();
    const r = res();
    await ctlWith(p).page(reqUnbound({ sub: 'u1', email: 'dev@example.com' }), await pend(p), r);
    expect(r.body).toContain('another browser');
    expect(r.body).not.toContain('timed out');
  });

  it('renders normally when the cookie matches the record', async () => {
    const p = provider();
    const r = res();
    await ctlWith(p).page(req({ sub: 'u1', email: 'dev@example.com' }), await pend(p), r);
    expect(r.body).toContain('value="agent"');
  });

  it('refuses a record that carries no initiator at all, rather than admitting it', async () => {
    // The field is optional on `PendingAuth` for a typing reason — a required
    // one is a compile error in a spec file outside this lane. Optionality in
    // the type must not become optionality in the control.
    const p = provider();
    const id = await p.pendingStore.create({
      clientId: 'c1',
      redirectUri: 'http://localhost:1234/cb',
      codeChallenge: 'ch',
    });
    const r = res();
    await ctlWith(p).page(req({ sub: 'u1', email: 'dev@example.com' }), id, r);
    expect(r.body).not.toContain('value="agent"');
  });

  it('writes one warn line on the GET, naming the actor and the client id', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const p = provider();
    await ctlWith(p).page(reqUnbound({ sub: 'u1', email: 'dev@example.com' }), await pend(p), res());
    // "One" was in the name and in nothing else: the row passed just as happily
    // when two lines were written, which is how a refused GET could start
    // classifying the destination as well and nothing would notice.
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('dev@example.com');
    expect(line).toContain('c1');
  });

  it("never puts the client's self-chosen name in either warn line", async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const p = provider();
    await p.clientsStore.registerClient({
      client_id: 'c1',
      client_name: 'Sneaky Client',
      redirect_uris: ['http://localhost:1234/cb'],
    } as never);
    const id = await pend(p);
    await ctlWith(p).page(reqUnbound({ sub: 'u1', email: 'dev@example.com' }), id, res());
    await ctlWith(p).decide(
      reqUnbound({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, scope: 'agent', csrf: CSRF },
      res(),
    );
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('c1');
    expect(line).not.toContain('Sneaky Client');
  });

  it('a POST from an unbound browser grants nothing, issues no code and consumes nothing', async () => {
    const p = provider();
    const id = await pend(p);
    const r = res();
    await ctlWith(p).decide(
      reqUnbound({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, scope: 'full', csrf: CSRF },
      r,
    );
    expect(r.redirectedTo).toBeNull();
    expect(await grantedScopes(p, r.redirectedTo)).toBeNull();
    expect(r.status_).toBe(403);
    // The record survives: it is not this browser's to cancel, and consuming it
    // would let anyone who learns a request id kill it from a cross-site form.
    expect((await p.pendingStore.peek(id))).not.toBeNull();
  });

  it('a POST from an unbound browser writes its own warn line', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const p = provider();
    await ctlWith(p).decide(
      reqUnbound({ sub: 'u1', email: 'dev@example.com' }),
      { req: await pend(p), scope: 'full', csrf: CSRF },
      res(),
    );
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('dev@example.com');
    expect(line).toContain('c1');
  });

  it('a POST from an unbound browser writes no capped-grant line either', async () => {
    // The binding check sits above `capToGrantable`, so a refused POST never
    // reaches the ceiling and never writes the audit line that means a real
    // grant was narrowed.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const p = provider();
    await ctlWith(p).decide(
      reqUnbound({ sub: 'u1', email: 'dev@example.com' }),
      { req: await pend(p), scope: 'full', csrf: CSRF },
      res(),
    );
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).not.toContain('capped');
  });
});

/**
 * Decision 2b-iv: a refusal reaches the client as an RFC 6749 error redirect
 * ONLY when the binding check confirms this browser started the flow. Otherwise
 * the board answers locally and navigates nowhere — because a redirect on a
 * pre-seeded link would confirm to a stranger that a live board member opened
 * their page, which is a liveness oracle today's silence does not give them.
 */
describe('ConsentController — the screen can be told no (#555)', () => {
  function ctlWith(p: McpOAuthProvider) {
    return new ConsentController(p, config, authority({ assigned: ['boss@example.com'] }));
  }

  it('a refusal reaches the client as error=access_denied', async () => {
    const p = provider();
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: await pend(p), decision: 'deny', csrf: CSRF },
      r,
    );
    const url = new URL(r.redirectedTo!);
    expect(url.searchParams.get('error')).toBe('access_denied');
    // The handler answers ONCE and stops. Without the `return` after the
    // redirect, execution falls into the grant path and writes a second body on
    // a response that has already been sent — which express answers with
    // "cannot set headers after they are sent" rather than with a page.
    expect(r.body).toBe('');
    expect(r.status_).toBe(200);
  });

  it('a refusal that also carries a scope is still a refusal, and still mints nothing', async () => {
    // The board's own page never sends both. A hand-crafted POST can, and the
    // decision is read first, so the scope is never looked at.
    const p = provider();
    const id = await pend(p);
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, decision: 'deny', scope: 'agent', csrf: CSRF },
      r,
    );
    expect(new URL(r.redirectedTo!).searchParams.get('error')).toBe('access_denied');
    expect(await grantedScopes(p, r.redirectedTo)).toBeNull();
    expect((await p.pendingStore.peek(id))).toBeNull();
    expect(r.body).toBe('');
  });

  it('a refusal mints no authorization code', async () => {
    // Read off the redirect the same way every grant row reads its scopes: a
    // deny redirect carries no code, so this comes back null.
    const p = provider();
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: await pend(p), decision: 'deny', csrf: CSRF },
      r,
    );
    // Not vacuous through a null redirect: the refusal DID navigate, and what
    // it navigated to carries no code.
    expect(r.redirectedTo).not.toBeNull();
    expect(await grantedScopes(p, r.redirectedTo)).toBeNull();
  });

  it('a refusal consumes the pending record', async () => {
    const p = provider();
    const id = await pend(p);
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, decision: 'deny', csrf: CSRF },
      res(),
    );
    expect((await p.pendingStore.peek(id))).toBeNull();
  });

  it('a refusal whose binding fails navigates nowhere and consumes nothing', async () => {
    // The row that proves the refusal is not a liveness oracle. Moving the
    // binding check below the decision branch fires the redirect and hands the
    // signal back.
    const p = provider();
    const id = await pend(p);
    const r = res();
    await ctlWith(p).decide(
      reqUnbound({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, decision: 'deny', csrf: CSRF },
      r,
    );
    expect(r.redirectedTo).toBeNull();
    expect((await p.pendingStore.peek(id))).not.toBeNull();
    expect(r.body).toContain('another browser');
  });

  it('a refusal with a mismatched CSRF token denies nothing and leaves the record alive', async () => {
    const p = provider();
    const id = await pend(p);
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, decision: 'deny', csrf: 'wrong' },
      r,
    );
    expect(r.redirectedTo).toBeNull();
    expect(r.status_).toBe(400);
    expect((await p.pendingStore.peek(id))).not.toBeNull();
  });

  it('a refusal on a record that is already gone ends on the refused page', async () => {
    // There is no redirect available: the address lived on the record that is
    // gone. And the copy must not tell somebody who just refused to restart the
    // connection they refused.
    const p = provider();
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: 'already-gone', decision: 'deny', csrf: CSRF },
      r,
    );
    expect(r.redirectedTo).toBeNull();
    expect(r.body).toContain('Access refused');
    expect(r.body).not.toContain('restart');
  });

  it.each([
    ['vscode://ms-vscode/cb'],
    ['cursor://anysphere/cb'],
    ['ms-word:ofe|u|https://evil.example/x.docx'],
  ])('never navigates a refusal to %s — it answers locally instead', async (redirectUri) => {
    // `consent-html.ts` argues the refusal must be a form and never an anchor
    // precisely so that refusing cannot be one click away from launching a
    // custom protocol handler — and then this handler 302'd to exactly that.
    // The person who correctly recognises a request they did not start, and
    // presses the control whose entire purpose is a safe exit, had an
    // application opened for them. Only http and https are navigated to.
    const p = provider();
    const id = await p.pendingStore.create({
      clientId: 'c1',
      redirectUri,
      codeChallenge: 'ch',
      initiator: INIT,
    });
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, decision: 'deny', csrf: CSRF },
      r,
    );
    expect(r.redirectedTo).toBeNull();
    expect(r.body).toContain('Access refused');
    // Still a refusal: the record dies here, it is simply not carried anywhere.
    expect((await p.pendingStore.peek(id))).toBeNull();
  });

  it('still reaches an https client, so the RFC path is not collateral', async () => {
    const p = provider();
    const id = await p.pendingStore.create({
      clientId: 'c1',
      redirectUri: 'https://client.example/cb',
      codeChallenge: 'ch',
      initiator: INIT,
    });
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, decision: 'deny', csrf: CSRF },
      r,
    );
    expect(new URL(r.redirectedTo!).searchParams.get('error')).toBe('access_denied');
  });

  it('a malformed decision is not read as a refusal', async () => {
    const p = provider();
    const id = await pend(p);
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, decision: 'denied', csrf: CSRF },
      r,
    );
    expect(r.redirectedTo).toBeNull();
    expect(r.status_).toBe(400);
    expect((await p.pendingStore.peek(id))).not.toBeNull();
  });

  it('a repeated form field arriving as an array is not read as a refusal', async () => {
    // express hands a repeated field over as an array. `=== 'deny'` is safely
    // false for one; `String(body.decision).includes('deny')` would not be.
    const p = provider();
    const id = await pend(p);
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: id, decision: ['deny', 'deny'] as unknown as string, csrf: CSRF },
      r,
    );
    expect(r.redirectedTo).toBeNull();
    expect((await p.pendingStore.peek(id))).not.toBeNull();
  });

  it('a refusal writes no capped-grant warning', async () => {
    // The decision branch sits above `capToGrantable`, so a refusal never
    // reaches the ceiling and the capped-grant signal keeps meaning what it
    // means: a real grant was narrowed.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const p = provider();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: await pend(p), decision: 'deny', scope: 'full', csrf: CSRF },
      res(),
    );
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('capped');
  });

  it('a grant still grants — the refusal did not disturb the path beside it', async () => {
    const p = provider();
    const r = res();
    await ctlWith(p).decide(
      req({ sub: 'u1', email: 'dev@example.com' }),
      { req: await pend(p), scope: 'agent', csrf: CSRF },
      r,
    );
    expect(await grantedScopes(p, r.redirectedTo)).toEqual([BOARD_READ]);
  });
});

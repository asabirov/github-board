import { Body, Controller, Get, Inject, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { consentCookieName, INITIATOR_COOKIE, McpOAuthProvider } from './mcp-oauth.provider';
import { hashSecret } from './oauth-store';
import { renderConsentPage, renderTerminalPage } from './consent-html';
import { parseCookies } from '../auth/cookies';
import { AdminAuthority } from '../auth/admin-authority';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { Writes } from '../capability/writes.decorator';
import type { AuthenticatedActor } from '../auth/static-agent';
import { capToGrantable, expandPreset, ungrantableScopes, type Preset } from '../auth/scopes';

const CSRF_COOKIE = 'atlas_consent_csrf';

/**
 * The shape this controller mints. A value under the cookie name that does not
 * match it is ignored and replaced, so a held token is only ever reused when it
 * is one this server could have written.
 */
const WELL_FORMED_CSRF = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Constant-time equality for the two secrets this controller compares: the CSRF
 * synchronizer token, and the initiator secret that says which browser started
 * the flow. Absent on either side is a mismatch — which is what makes a pending
 * record carrying NO initiator unanswerable rather than answerable by everyone.
 */
function secretsMatch(held: string | undefined, offered: string | undefined): boolean {
  if (!held || !offered) return false;
  const a = Buffer.from(held);
  const b = Buffer.from(offered);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether an authorization code sent here would stay on this machine.
 *
 * Classified by HOST, not by scheme. `localhost`, anything in `127.0.0.0/8` and
 * `[::1]` are the ordinary local MCP client — under RFC 8252 §7.3 loopback port
 * relaxation, `http://localhost:<any port>/cb` is legitimate and common, so a
 * rule that treated every destination as notable would teach people to ignore
 * it. Everything else is remote, and so is every custom scheme (`vscode:`,
 * `cursor:`), which has no loopback host to check. An address that will not
 * parse is not loopback either.
 */
function isLoopbackDestination(redirectUri: string): boolean {
  let host: string;
  try {
    host = new URL(redirectUri).hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Whether the board is willing to send a browser to this address.
 *
 * Scheme safety does not live anywhere else in this path. The SDK's zod
 * `SafeUrlSchema` rejects `javascript:`, `data:` and `vbscript:` and nothing
 * else, so `vscode:`, `cursor:` and `ms-word:` are all legal registered
 * destinations — and a 302 to one of those launches a local application. That
 * matters most on the refusal, which is the one control on the page whose whole
 * purpose is a safe exit for somebody who did not start the flow: `consent-html`
 * already keeps it a form rather than an anchor so refusing cannot be one click
 * from a protocol handler, and a redirect would hand back exactly what that
 * bought. Anything that is not http or https is answered locally instead.
 */
function isRedirectableDestination(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

/**
 * Consent screen for the MCP OAuth flow. Session-cookie authenticated (the
 * global guard chain runs first). The POST is protected by a synchronizer
 * CSRF token: minted on GET into an httpOnly cookie and echoed in the form,
 * so a cross-site auto-POST cannot mint an authorization code as the victim.
 *
 * HUMAN-ONLY, structurally (#545). Consenting mints a refreshable credential, and
 * a credential must never be reachable by a credential — the same rule, and the
 * same guard, as `account.controller.ts:44`, which mints the other kind. Without
 * it the only thing keeping a scoped actor off the POST is
 * `RequiredScopesGuard`'s fail-closed default for an undecorated write, which
 * one `@RequiredScopes(BOARD_READ)` on `decide` would remove — the exact
 * decorator `mcp.controller.ts:30-35` had to add for its own handler.
 *
 * The grant this issues is capped to the consenting person's own authority
 * (#545) — the same ceiling `PersonalTokenService` holds a minted token to.
 */
@Controller('oauth/consent')
@UseGuards(HumanOnlyGuard)
export class ConsentController {
  private readonly logger = new Logger(ConsentController.name);

  constructor(
    @Inject(McpOAuthProvider) private readonly provider: McpOAuthProvider,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AdminAuthority) private readonly admin: AdminAuthority,
  ) {}

  /**
   * Whether the person consenting may put `board:admin` on the grant (#545).
   * The board answers "is this an admin" in one place, `AdminAuthority`, and
   * this asks it rather than restating it — which is why the #371 break-glass
   * keeps working here: with zero assigned admins, the recovering person is an
   * admin by that authority and still gets Full.
   *
   * There is deliberately no personhood test in this expression. `isStaticAgent`
   * would exclude one shape and admit a personal access token, which is
   * `staticAgent === false`; personhood is answered once, structurally, by the
   * class-level `HumanOnlyGuard` above. One question per control.
   */
  private granterMayGrantAdmin(user?: AuthenticatedActor): boolean {
    return this.admin.isAdmin(user?.email ?? '');
  }

  /**
   * The synchronizer token for this browser: read back if the browser already
   * holds one this server could have written, minted if it does not.
   *
   * REUSED, not re-minted per GET, and that is the whole point. One cookie name
   * holds one value, so a token minted fresh on every GET meant that opening a
   * second consent tab overwrote the first tab's cookie — and the first tab's
   * POST then failed the check and was answered with the page that says the
   * request timed out, on a request that was live, was theirs, and had simply
   * had its token thrown away by the board. The same mechanism `initiatorFor`
   * uses for the same reason (D1b): bind to the BROWSER, not to the request, so
   * there is no cap to evict past and no per-request cookie name to pressure the
   * jar with. The POST no longer clears it either — clearing is a jar-wide edit
   * and it disarmed every tab that had not been answered yet.
   *
   * It stays a separate secret from the initiator rather than being derived from
   * it. The two answer different questions — the initiator says which browser
   * started the FLOW, this says the POST came from a page the board rendered —
   * and folding one into the other would leave one control where there are two.
   */
  private csrfFor(req: Request, res: Response): string {
    const held = parseCookies(req.headers.cookie)[this.cookieName(CSRF_COOKIE)];
    const csrf = held && WELL_FORMED_CSRF.test(held) ? held : randomBytes(24).toString('base64url');
    res.cookie(this.cookieName(CSRF_COOKIE), csrf, {
      httpOnly: true,
      secure: this.isSecure(),
      sameSite: 'lax',
      // `Path=/` is a `__Host-` requirement, not a preference. The cookie was
      // scoped to the consent path before the prefix, and the prefix is worth
      // more than the narrower scope: a name a sibling host can write is a name
      // an attacker can choose the value of.
      path: '/',
      maxAge: 600_000,
    });
    return csrf;
  }

  private isSecure(): boolean {
    return this.config.get<string>('BOARD_BASE_URL', '').startsWith('https');
  }

  /** The one name this deployment writes, and therefore the only one it reads. */
  private cookieName(base: string): string {
    return consentCookieName(base, this.isSecure());
  }

  /**
   * The browser's initiator secret in the form the store holds it: hashed.
   *
   * Since #456 a pending record keeps the sha256 of the secret rather than the
   * secret, so the comparison has to hash this side too. Both are then 64 hex
   * characters and `secretsMatch` reaches `timingSafeEqual` instead of falling
   * out on its length check — which is what a 32-character cookie compared
   * against a 64-character hash would do, silently, for every consent.
   *
   * Absent stays absent rather than becoming the hash of an empty string, so a
   * browser holding no cookie is refused the same way it always was.
   */
  private heldInitiator(cookies: Record<string, string>): string | undefined {
    const raw = cookies[this.cookieName(INITIATOR_COOKIE)];
    return raw ? hashSecret(raw) : undefined;
  }

  @Get()
  async page(
    @Req() req: Request & { user?: AuthenticatedActor },
    @Query('req') reqId: string,
    @Res() res: Response,
  ) {
    const context = await this.provider.consentContextFor(reqId ?? '');
    if (!context) {
      // Expired, already spent, or never existed — and until now the GET
      // rendered a full set of grant buttons for it regardless, because the
      // page was built from the query string alone. A dead request is refused
      // HERE and not inside `renderConsentPage`: a client that requested no
      // scopes is a live, grantable request, and the render function has a
      // #545 guard pinning that it still renders buttons for one.
      res.status(400).type('html').send(renderTerminalPage('expired'));
      return;
    }
    if (!secretsMatch(context.initiator, this.heldInitiator(parseCookies(req.headers.cookie)))) {
      // A signed-in board member looking at a consent page for a request their
      // browser did not start. That is the signature of the pre-seeded-link
      // attack and of almost nothing else, and it is the only moment the board
      // ever learns it was probed — so it is recorded, not merely refused.
      // Actor and client id only; `client_name` is a stranger's text.
      this.logger.warn(
        `mcp consent binding refused actor=${req.user?.email ?? ''} client=${context.clientId}`,
      );
      res.status(403).type('html').send(renderTerminalPage('unbound'));
      return;
    }
    // Below both refusals, deliberately. Minted above them, a GET was a cookie
    // edit anybody could trigger: `/api/oauth/consent?req=<anything>` rotated
    // the token of whatever flow the person had open, from a link. Nothing is
    // written until the request is known live and known to be this browser's.
    const csrf = this.csrfFor(req, res);
    const loopback = isLoopbackDestination(context.redirectUri);
    if (!loopback) {
      // Every variant of the pre-seeded-consent attack needs a destination the
      // attacker can read, and none of them can be loopback — so this is the
      // one place the board learns, for free, that a code was about to leave
      // the machine. Actor and client id only: `client_name` is a stranger's
      // text and never reaches a log line (Decision 2e).
      this.logger.warn(
        `mcp consent remote destination actor=${req.user?.email ?? ''} client=${context.clientId}`,
      );
    }
    res
      .type('html')
      .send(
        renderConsentPage({
          reqId: reqId ?? '',
          // The client's own name, absent when it registered none or when the
          // registry has evicted it. Never substituted with the client id: an
          // opaque UUID reads as a name to nobody.
          clientName: context.clientName,
          email: req.user?.email ?? '',
          csrf,
          requestedScopes: context.requestedScopes,
          canGrantAdmin: this.granterMayGrantAdmin(req.user),
          redirectUri: context.redirectUri,
          // Composed from the two classifications above rather than a third
          // one, so the sentence on the page is drawn from the same reading of
          // the address as the warning in the log.
          //
          // The scheme is consulted as well as the host because the host test
          // alone is wrong in BOTH directions for a custom scheme: it reads
          // `cursor://anysphere.cursor-retrieval/cb` as remote when the thing
          // it reaches is a program on this machine, and it reads
          // `myapp://localhost/cb` as local when nothing http is going to this
          // machine at all. Neither is the board's to state, so it states
          // nothing and shows the address.
          reach: !isRedirectableDestination(context.redirectUri)
            ? 'unstated'
            : loopback
              ? 'local'
              : 'remote',
        }),
      );
  }

  // Writes the OAuth consent record, not Github.
  @Writes()
  @Post()
  async decide(
    @Req() req: Request & { user?: AuthenticatedActor & { sub?: string } },
    @Body() body: { req?: string; scope?: string; csrf?: string; decision?: string },
    @Res() res: Response,
  ) {
    const cookies = parseCookies(req.headers.cookie);
    const cookie = cookies[this.cookieName(CSRF_COOKIE)];

    // Binding is checked FIRST, above CSRF, above the preset mapping and above
    // `capToGrantable`. A POST that fails it does nothing at all: no grant, no
    // deny, no consume, no capped-grant warning, and no navigation. Not
    // consuming is the deliberate part — the intuitive answer is "they pressed
    // a button, kill the record", and it is wrong here. A record that failed
    // binding is not this browser's; consuming it would let a cross-site form
    // cancel any pending request whose id an attacker knows, and it would buy
    // nothing, because binding already makes that record unspendable by anyone
    // but the browser that created it. It dies on the TTL.
    const context = await this.provider.consentContextFor(body.req ?? '');
    if (context && !secretsMatch(context.initiator, this.heldInitiator(cookies))) {
      this.logger.warn(
        `mcp consent binding refused actor=${req.user?.email ?? ''} client=${context.clientId}`,
      );
      res.status(403).type('html').send(renderTerminalPage('unbound'));
      return;
    }

    // CSRF next, on both branches. A refusal consumes the pending record, so
    // skipping the check here would let a cross-site auto-POST cancel any
    // request whose id an attacker knows — a nuisance denial of service that is
    // free to prevent, since the token is already in the page.
    if (!secretsMatch(cookie, body.csrf)) {
      res.status(400).type('html').send(renderTerminalPage('expired'));
      return;
    }

    // The decision is read BEFORE the scope vocabulary and before
    // `capToGrantable`, so a refusal never touches the ceiling and never writes
    // the capped-grant audit line. Compared with `===` against the literal:
    // express hands a repeated form field over as an array, and `===` against a
    // string is safely false for one — the same property `body.scope === 'full'`
    // already relies on. Never `String(body.decision)`, never `.includes`.
    if (body.decision === 'deny') {
      const refused = await this.provider.denyConsent(body.req ?? '', {
        email: req.user?.email ?? '',
      });
      if (!refused || !isRedirectableDestination(refused.redirectTo)) {
        // Two arrivals, one answer. Either there is no redirect available — the
        // address lived on the record that is gone — or there is one the board
        // will not send a browser to, because it is not http or https and
        // following it would launch a local application off the safe-exit
        // control. The refusal itself already happened: `denyConsent` consumed
        // the record above, and the page must not tell somebody who has just
        // refused to restart what they refused.
        res.type('html').send(renderTerminalPage('refused'));
        return;
      }
      res.redirect(refused.redirectTo);
      return;
    }

    const preset: Preset | null =
      body.scope === 'full' ? 'full' : body.scope === 'agent' ? 'agent' : null;
    const mayGrantAdmin = this.granterMayGrantAdmin(req.user);
    // The form is not a gate. Whatever the page offered, the grant is narrowed
    // here to what this person's own authority may hold — the same ceiling their
    // personal token would be held to (#545). A non-admin choosing Full gets the
    // read-only set, which is what Full has always meant: act as the user.
    const requested = preset ? expandPreset(preset) : [];
    const granted = capToGrantable(requested, mayGrantAdmin);
    // `granted.length > 0` refuses rather than issuing a credential that
    // authenticates and can do nothing. Unreachable while every preset leaves a
    // non-admin something — scopes.spec.ts pins that, and goes red the day a
    // preset expands to admin-only, which is the day this line starts mattering.
    const out =
      preset && granted.length > 0 && body.req
        ? await this.provider.finishConsent(body.req, granted, {
            sub: req.user?.sub ?? '',
            email: req.user?.email ?? '',
          })
        : null;
    if (!out) {
      res.status(400).type('html').send(renderTerminalPage('expired'));
      return;
    }
    const dropped = ungrantableScopes(requested, mayGrantAdmin);
    if (dropped.length > 0) {
      // `finishConsent` logs the granted set, so without this line a capped Full
      // and a genuine Agent are byte-identical in the log and nobody can tell
      // afterwards whether the gate has ever fired. Logged only once a grant has
      // actually been issued, so a forged cross-site POST cannot write noise here.
      this.logger.warn(
        `mcp consent capped actor=${req.user?.email ?? ''} preset=${preset} dropped=[${dropped.join(' ')}]`,
      );
    }
    res.redirect(out.redirectTo);
  }
}

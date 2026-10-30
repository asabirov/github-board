import { sessionHintId, setSessionHint } from './session-hint';
import type { Response } from 'express';
import { githubPrincipal, type GithubInstallation, type GithubOwner } from './github-principal';
import { appInstallUrl, GITHUB_AUTHORIZATIONS_URL } from './github-app-links';
import { clientVisibilityKey } from './client-fingerprint';
import {
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  Optional,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISSUE_EDITOR_CAPABILITIES } from '../capability/capability';
import { CapabilityRegistry } from '../capability/capability.registry';
import { capabilityGuardEnforcing } from '../capability/guard-enforcing';
import { GithubLoginResolver } from '../identity/github-login.resolver';
import {
  ORG_READ_STATE,
  type OrgReadReport,
  type OrgReadState,
} from '../issues-metrics/org-read-state';
import { AdminAuthority } from './admin-authority';
import { isHumanSession } from './human-session';
import { isStaticAgent, type AuthenticatedActor } from './static-agent';

/**
 * Who am I (#107): the sidebar account block shows the signed-in user.
 * Identity comes from the session JWT the global guard verified — the
 * controller only reflects it back. A request that somehow reaches here
 * without a user is a guard regression (@Public added, APP_GUARD reorder),
 * and must fail loudly as 401, not answer 200 with an empty identity.
 * no-store: a cookie-authenticated identity response has no business in
 * any shared cache.
 *
 * `isAdmin` (#11) is the single signal the frontend uses to decide whether to
 * show the admin-only Access link. It is a hint, not the gate — the admin API
 * enforces its own check server-side, so a spoofed client flag reveals nothing.
 * Hint and gate read one decision, `AdminAuthority.isAdminActor` (#551), so what
 * this reports is what `AdminGuard` will do rather than a second opinion.
 *
 * `writesEnabled` and `canWrite` (#384, #626) are the analogous hints for
 * in-board edits, and they are two readings of one calculation rather than two
 * calculations.
 *
 * `writesEnabled` is the half that belongs to the session and the config: a
 * human session (never a scoped/PAT actor — see isHumanSession) on a deployment
 * where GitHub writes are turned on. Neither half shows up as a capability
 * refusal — a `board:read` PAT is refused at the guard and a switched-off
 * GITHUB_WRITE_ENABLED is refused at the envelope, before any capability is
 * consulted — so a surface that skipped this field would draw a control over a
 * write that 403s.
 *
 * `canWrite` is that same half AND no capability the in-board ISSUE editor
 * writes being refused. It gates the issue editor, and nothing else: a surface
 * that writes some OTHER capability composes `writesEnabled` with its own key
 * from the map below (ReposPage.tsx does this for `repo.dri`), never with
 * `canWrite` — reading `canWrite` would hide its control whenever an unrelated
 * issue capability was refused.
 *
 * The write endpoints re-enforce every part of this server-side, so a spoofed
 * flag just shows editable controls that then fail closed.
 *
 * `githubLogin` (#520) is who the signed-in person is on GitHub, read from the
 * roster by their session address. Both ends of that link already existed — the
 * board just never joined them, so a client had the email and no way to reach
 * the work filed under the handle. null is an ordinary answer: an address
 * nothing maps yet.
 *
 * It goes through GithubLoginResolver rather than reading a store directly, and
 * so does "Your work". That is the point of the resolver: one answer to "which
 * handle belongs to this address", or the two surfaces drift and the person is
 * told one thing while being shown another.
 *
 * A static agent is the one caller that address does not describe (#546). The
 * handle lookup short-circuits on it below; the admin field is answered by the
 * authority, which asks the same question of the same flag (#551).
 */
@Controller('auth')
export class MeController {
  constructor(
    @Inject(AdminAuthority) private readonly access: AdminAuthority,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(GithubLoginResolver) private readonly githubLogins: GithubLoginResolver,
    // Optional-with-a-default (#584), the shape `github-derived-logins.source.ts`
    // already uses: this controller is constructed 21 times in its spec, and a
    // required fourth parameter is 21 edits and a red `main` if one is missed.
    @Optional() @Inject(CapabilityRegistry) private readonly capabilities?: CapabilityRegistry,
    // One question, never the service (#650). `IssuesCacheService` would put the
    // whole ~70-repo scan, its TTL clock and its submission index behind a field
    // that reports which orgs answered; this token carries `orgsRead()` and
    // nothing else. Optional for the reason the registry above is: absent, the
    // handler answers exactly what it answered before this parameter existed.
    @Optional() @Inject(ORG_READ_STATE) private readonly orgReads?: OrgReadState,
  ) {}

  private readonly logger = new Logger(MeController.name);
  /** Said ONCE per process. Every human session hits the branch below, so an
   *  unlatched warning would be one line per `/api/auth/me` on every board. */
  private warnedAboutSessionHint = false;

  /**
   * What the board will ACT on, per capability (#584) — not what the registry
   * remembers. The two are the same reading only while `CapabilityGuard` is
   * enforcing, which since task 8 is the default. With the flag turned off the
   * guard's deny branches log the refusal and return true, so every write still
   * goes through, and a `refused` reported here would describe a refusal that is
   * not happening.
   *
   * NOTHING is hidden and the registry is untouched. It still learns, still
   * expires, still ranks declared over learned over probed, and the guard still
   * reads `state(cap)` from it directly — this handler is the one place that
   * declines to REPORT a verdict the board is not acting on. Task 8 turned the
   * flag on and the same line started carrying real verdicts, with no change
   * here and none in the frontend.
   *
   * `unknown` is the honest word for that, and it is the word the whole layer
   * already uses for "no refusal is in force": the guard's `unknown` never
   * refuses, and the frontend draws a control on it. So the reporting-mode map
   * says exactly what reporting mode means.
   *
   * Derived from the snapshot rather than from `CAPABILITIES`, so both answers
   * carry the SAME key set by construction — a client cannot tell the two modes
   * apart by which capabilities are named, only by what they say. An absent
   * registry answers `{}` in both, which is what it answered before this.
   */
  private reportedCapabilities(): Record<string, string> {
    const snapshot: Record<string, string> = this.capabilities?.snapshot() ?? {};
    // The same reading the guard takes, through the one accessor that owns the
    // fallback (#626). It used to be a second `config.get` here defaulting
    // `false` against the guard's `true`, argued for as the reporting half being
    // allowed to disagree — which is what it would have done: refuse the write
    // and report that nothing was refused.
    if (capabilityGuardEnforcing(this.config)) return snapshot;
    return Object.fromEntries(Object.keys(snapshot).map((cap) => [cap, 'unknown']));
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  // Typed as the shared actor rather than an inline literal listing the fields
  // this handler happens to read (the shape mcp.controller.ts settled on): what
  // the guards leave on `req.user` is defined in one place, so the next field
  // they add arrives here without an edit.
  async me(@Req() req: {
    user?: AuthenticatedActor & { scopes?: string[]; sessionExpiresAt?: number };
  }, @Res({ passthrough: true }) res?: Response): Promise<{
    sessionHintId?: string;
    email: string;
    /**
     * This person's Github connection, and since #892 also the CONSENTS behind
     * it.
     *
     * The first five fields answer what they always did. The rest describe
     * consent rather than access: `installations` is the management list and is
     * WIDER than `owners` by design, a suspended installation appearing there
     * and granting nothing. The board writes no consent itself — the two URLs
     * are Github's own screens, where an org install may still need an owner's
     * approval.
     */
    github?: {
      configured: boolean;
      connected: boolean;
      owners: GithubOwner[];
      repositories: { id: number; full_name: string }[];
      visibilityKey: string;
      expiresAt?: number;
      responseDeadlines: boolean;
      /** This person's Github handle. `null` while unconnected. */
      login: string | null;
      /** `null` when the board knows no slug of its own — a guess would link to
       *  somebody else's App. */
      installUrl: string | null;
      /** Fixed and public, so it is always answered. */
      authorizationsUrl: string;
      /** `[]` is a real answer: no installation this token can see. */
      installations: GithubInstallation[];
    };
    isAdmin: boolean;
    /** #811 — the board has never read its admin roster, so `isAdmin` above is
     *  `false` for everybody and says nothing about this caller. */
    adminsUnread: boolean;
    writesEnabled: boolean;
    canWrite: boolean;
    githubLogin: string | null;
    /** Absent for a static agent (#584) — see below. A human session always
     *  carries it, `{}` included, because the frontend reads it. */
    capabilities?: Record<string, string>;
    /** Which configured orgs the last ingest could read (#650). Absent only when
     *  no read-state accessor is wired; `[]` is a real answer and means the
     *  board makes NO CLAIM about any org, never that every org is fine. */
    orgs?: OrgReadReport[];
  }> {
    const email = req.user?.email;
    if (!email) throw new UnauthorizedException('No session');
    const writesConfigured = this.config.get<boolean>('GITHUB_WRITE_ENABLED', false);
    // Read once, from the one definition of the fact (#525), and never re-derived
    // from the shape of the address — a token named `claude@ci` produced
    // `agent:claude@ci`, and the address test that predated this flag read it as
    // an ordinary person. The handle lookup below hangs off this.
    const staticAgent = isStaticAgent(req.user);
    // ONCE per request (#626). Both the field below and the `canWrite` flag read
    // this one value.
    const capabilities = this.reportedCapabilities();
    // The session-and-config half, computed once and reported as its own field
    // below (#626). It is the whole of what `canWrite` was before the flag
    // became issue-scoped, and it is what a non-issue surface composes with its
    // own capability.
    const person = githubPrincipal();
    const writesEnabled = isHumanSession(req.user) && writesConfigured && (!person || !!person.token);
    const hintId = isHumanSession(req.user) && req.user?.boardSub
      ? sessionHintId(this.config.get<string>('BOARD_SESSION_SECRET'), req.user.boardSub) : undefined;
    // SAY SO (#1395). Without a hint id the browser may not persist a
    // permission-sensitive read at all (`read-cache.ts`, `persistableRead`), so
    // every open of My work, Overview, Repos and the boards starts on loading
    // placeholders — and until this line, the board said nothing about it. The
    // operator saw a slow board, not a missing setting.
    //
    // THE REASON HAS TO BE THE REAL ONE. Two different things leave a human
    // session without a hint id, and only one of them is the operator's to fix:
    // the secret is unset or still the shipped dev default, which
    // `sessionHintId` refuses because a pseudonym under a published key is not
    // one; or this session carries no `boardSub`, which is a sign-in that
    // predates the claim and which the next sign-in settles. Naming the secret
    // for the second case sends the operator to a setting that is already right.
    if (!hintId && isHumanSession(req.user) && !this.warnedAboutSessionHint) {
      this.warnedAboutSessionHint = true;
      const secret = this.config.get<string>('BOARD_SESSION_SECRET');
      this.logger.warn(
        (req.user?.boardSub
          ? `BOARD_SESSION_SECRET is ${secret ? 'the insecure default' : 'unset'}, so no session hint is issued`
          : 'this session carries no boardSub, so no session hint is issued; it is reissued when the person signs in again')
        + ': browsers cannot keep permission-sensitive reads and every board opens cold.',
      );
    }
    if (res && hintId && req.user?.sessionExpiresAt) {
      setSessionHint(res, this.config.get<string>('BOARD_BASE_URL')!, hintId, person ? clientVisibilityKey(this.config.get<string>('BOARD_SESSION_SECRET'), person.key) : null,
        req.user.sessionExpiresAt - Math.floor(Date.now() / 1000));
    }
    return {
      ...(hintId ? { sessionHintId: hintId } : {}),
      email,
      ...(person ? { github: {
        configured: !!this.config.get<string>('GITHUB_USER_APP_CLIENT_ID'),
        connected: !!person.token,
        owners: person.owners,
        repositories: person.repositories.map(({ id, full_name }) => ({ id, full_name })),
        visibilityKey: clientVisibilityKey(this.config.get<string>('BOARD_SESSION_SECRET'), person.key),
        expiresAt: person.expiresAt,
        responseDeadlines: person.expiresAt !== undefined,
        login: person.login,
        // Configuration first, then what Github said on an installation this
        // person holds: on a renamed App the operator's setting is the current
        // slug and the observed one may be an older payload. Answered even while
        // unconnected — the person with no installation is the one who needs it.
        installUrl: appInstallUrl(this.config.get<string>('GITHUB_USER_APP_SLUG') ?? person.appSlug),
        authorizationsUrl: GITHUB_AUTHORIZATIONS_URL,
        // Absent metadata answers `[]`, not `undefined`: the field is declared
        // non-optional so every reader gets an array rather than a branch.
        installations: person.installations ?? [],
      } } : {}),
      // A static agent is not a person, so it cannot hold a person's role (#546).
      // The admin lookup meets the roster the same way the handle lookup does:
      // `AdminAuthority` tests the address against the admin snapshot, which
      // `StoredRoleAdminSource` builds by flattening the `emails` array of every
      // row stored with the `admin` role — the same array `identityForEmail`
      // matches on. One colliding row therefore answers both questions, and
      // withholding the handle while reporting `isAdmin: true` off that row
      // would close half the door. No row is needed either: `BOARD_ADMIN_EMAILS`
      // is comma-split with no format validation, so `agent:<name>` set there is
      // admin wherever the break-glass is live (no stored admin exists).
      //
      // The composition is NOT done here (#551). It used to be — this line read
      // `staticAgent ? false : this.access.isAdmin(email)`, which fixed the
      // report and left `AdminGuard` asking about the address alone, so the
      // board reported one thing and enforced another. `isAdminActor` is now the
      // single decision and the guard reads it too, which is what keeps this
      // field a faithful preview of what the admin API will actually do rather
      // than a second opinion that happens to agree.
      //
      // Nothing is taken from anyone else: the personhood test is keyed on the
      // caller, not on the snapshot. It removes a false claim rather than
      // authority, and the caller this field describes was already refused by
      // the scope layer — the admin reads and the identity write declare
      // `@RequiredScopes(BOARD_ADMIN)`, which a `board:read` token does not
      // carry; `DELETE /api/admin/agents/:id` declares no scope on purpose (at
      // class level it would WIDEN, see admin.controller.ts) and is refused by
      // the fail-closed default for an undecorated write, which denies every
      // scoped actor.
      isAdmin: this.access.isAdminActor(req.user),
      // Why that `false` is `false` (#811). It is `false` for every caller on a
      // board whose admin source has not answered since boot — a `db` board with
      // Postgres down before it started — and the frontend read it as "you are
      // not an admin", which is the one reading the board cannot support.
      //
      // A hint, exactly like `isAdmin` is: `AdminGuard` re-decides it per request
      // through the same `AdminAuthority`, and answers 503 rather than 403 for
      // this state. Nothing is granted by it — the admin hub opens on it and
      // every section behind the hub still refuses — and it is what lets the
      // account menu keep the door visible, so the pane that names the outage is
      // reachable at all.
      //
      // Not composed with personhood, unlike `isAdmin`. A static agent gets a
      // settled `403` whatever the roster says (#546), so this field would be
      // describing an outage that has no bearing on its refusal.
      adminsUnread: this.access.adminsUnread(),
      // May this session write AT ALL (#626) — the two conditions no capability
      // can speak for. A scoped/PAT actor is stopped by the write guard and a
      // switched-off GITHUB_WRITE_ENABLED is stopped by the write envelope, and
      // neither refusal ever reaches the capability registry, so a surface that
      // gated on its own capability alone would draw a control over a 403.
      //
      // This is the gate for a surface that writes something OTHER than the
      // issue editor: compose it with that surface's own key from the map below
      // (ReposPage.tsx: `writesEnabled && capabilities['repo.dri'] !== 'refused'`).
      // Never `canWrite` — that carries the issue set's refusals, which have
      // nothing to say about another surface's capability.
      writesEnabled,
      // #626 — one reading, two readers. `canWrite` is the field above AND the
      // issue set's verdicts, taken from the SAME `capabilities` map this
      // response ships rather than assembled a second time: `snapshot()` reads a
      // TTL clock, so two calls inside one request can disagree, and a flag that
      // said `true` beside a map saying `refused` would be the board
      // contradicting itself in a single payload.
      //
      // The aggregation is over the ISSUE-EDITOR set and not all twelve because
      // this flag gates the whole in-board issue editor (IssuePage.tsx,
      // PropertiesPanel.tsx, facet-editors.tsx) and only that. A refused
      // `repo.dri` must not darken it, and a refused `issue.labels` must not
      // darken the repos page's owner picker — which is why that page reads
      // `writesEnabled`, not this.
      //
      // In reporting mode the map is all `unknown`, so nothing here is refused
      // and the flag equals `writesEnabled` — which is the point: it tracks what
      // the guard will do, in both modes, off one reading.
      //
      // A static agent is already `false` at `isHumanSession` and has
      // `capabilities` omitted below; the map is computed for it and not shipped.
      canWrite:
        writesEnabled &&
        !ISSUE_EDITOR_CAPABILITIES.some((cap) => capabilities[cap] === 'refused'),
      // The per-capability truth, and it is what the GUARD would do rather than
      // what the registry holds — see `reportedCapabilities` above. The flag
      // above is an aggregate of this same object, so the two cannot disagree
      // about a capability they both describe. Task 7 is where a control stops
      // being drawn.
      //
      // OMITTED for a static agent, the way the handle lookup below is
      // short-circuited for one, and off the same flag. This controller declares
      // no `@RequiredScopes`, so a `board:read` token reaches the route — and the
      // snapshot is the whole shape of what the board's credential has been
      // refused, which is the credential's business rather than a token's. The
      // key is absent, not empty: `{}` would read as "nothing is refused", and
      // an agent should be told nothing here, not told something false. Only a
      // human session reads it (`useMe` → the editor controls), so nothing on
      // screen changes.
      ...(staticAgent ? {} : { capabilities }),
      // Which configured orgs the board could actually read on the run that
      // produced the numbers beside this (#650). Before it, an org whose repo
      // enumeration failed contributed no rows to a union that cannot say which
      // orgs it covers, so its members' throughput read zero and its aging tiles
      // drew empty — indistinguishable, on screen, from a quiet week.
      //
      // `[]` is not "all fine". It is "no claim", and a reader must draw exactly
      // what it drew before this field existed. Nothing here is ever
      // synthesised: an org the board did not measure gets no entry, because a
      // fabricated `read` is the precise reassurance an unreadable org must not
      // produce.
      //
      // SHIPPED TO A STATIC AGENT, unlike `capabilities` above, and the two are
      // different kinds of fact. `capabilities` is the complete map of what the
      // board's CREDENTIAL has been refused — the credential's business, and
      // enumerable nowhere else, so handing it to a `board:read` token tells a
      // token about the deployment. This says which orgs the DATA THIS RESPONSE
      // SITS BESIDE actually covers. An agent reads that same holed union
      // through /api/issues/mine and the metrics routes; withholding the hole
      // does not protect anything, it just moves the silent wrong answer from a
      // human's screen to an agent's context, which is the failure this field
      // exists to end. `reason` travels with it for the same reason: an agent
      // told `unreadable` with no cause has nothing to report and will re-ask
      // forever.
      //
      // Absent, not empty, when no accessor is wired — `{}` and `[]` both read
      // as claims, and a deployment that wired nothing has not measured anything.
      ...(this.orgReads ? { orgs: this.orgReads.orgsRead() } : {}),
      // The resolver owns the best-effort: /me is also the app's mount auth
      // probe (#197) — the frontend renders no chrome until it answers — and
      // before #520 it touched no store at all, so a database hiccup could not
      // blank the board. It still can't: an unreachable roster falls through to
      // the checked-in table, and worst case costs the handle, not the session.
      //
      // A static agent is asked for nothing (#546). Its address is `agent:<name>`,
      // built from a name in an environment variable; no person is behind it, so
      // there is no handle to find and no lookup worth making. Both legs of the
      // resolver would take the address: the roster leg (`identityForEmail`)
      // matches it against each row's `emails`, and the checked-in fallback
      // (`aliasOfIdentity`) is the fuzzy one — it matches display names, imported
      // ClickUp names and handles as well, case-insensitively. So a row carrying
      // that name in any of those fields would hand a token somebody's handle.
      // `board_whoami` short-circuits on the same flag, so both surfaces
      // answering "who am I" give one answer, and so does `/api/issues/mine`.
      githubLogin: person ? person.login : staticAgent ? null : await this.githubLogins.forEmail(email),
    };
  }
}

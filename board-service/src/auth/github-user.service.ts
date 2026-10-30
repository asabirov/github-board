import { githubScopeIds, isPersonalScopeOwner } from './github-scope';
import { withGithubRequestMetrics } from '../sources/github-request-metrics';
import { clientVisibilityKey } from './client-fingerprint';
import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ACCESS_NOT_NOW_CODE } from './access-not-now';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, type GithubCredential } from '../generated/prisma/client';
import { Octokit } from '@octokit/rest';
import { createHash, randomUUID } from 'node:crypto';
import { CredentialCipher, EnvironmentCredentialKey } from './github-credential-cipher';
import { installationManageUrl, isGithubAppSlug } from './github-app-links';
import { personIdentity } from '../sources/github-client';
import { withGithubEtags } from '../sources/github-etag';
import type { GithubInstallation, GithubOwner, GithubPrincipal, GithubRepository } from './github-principal';

export const GITHUB_DB = Symbol('GITHUB_DB');
export const FINGERPRINT_TTL_MS = 60_000;
const INSTALLATIONS_AT_ONCE = 3;
/**
 * How long a person's retained snapshot outlives their last check (#892).
 *
 * Each retained principal holds that person's whole repository-bound state — an
 * issue snapshot of every issue they can see, a repository view, per-repo pages.
 * The count ceiling below bounds how MANY, and this bounds how long a person who
 * has gone home keeps one. Ten minutes because that is the repository caches'
 * own TTL: past it every entry behind the principal would be re-read anyway, so
 * the retention buys nothing and costs the whole snapshot.
 */
export const VISIBILITY_RETENTION_MS = 600_000;
/** A hard ceiling on retained people, for the case where a great many are
 *  active at once rather than idle. */
export const VISIBILITY_MAX = 128;
/**
 * The authorization headroom a read is ADMITTED with (#892 review, C3).
 *
 * Not a maximum duration. A check is good for `FINGERPRINT_TTL_MS`, and a read
 * that starts the instant a fresh one lands may legitimately run the whole sixty
 * seconds. What this is, is the floor: a read is not started against a check
 * with less than this left, because a permission-sensitive answer landing past
 * its check is REFUSED — see `github-expiry.interceptor.ts` — and refusing a
 * cold read after it has already cost thirty seconds of Github is the worst of
 * both. Below this the guard takes a genuinely fresh check first, and a read
 * that overruns even that is still refused.
 *
 * Forty seconds, from what the reads in this tree actually cost. Measured, and
 * written down where each was measured: the repo listing ~1.3 s
 * (`repos.service.ts`), the health read ~18 s (same), a cold repo page ~29 s
 * (same), one person's whole issue ingest 20-25 s at concurrency 8 (#892, and
 * `ReposService.core` awaits it). Thirty would not cover the repo page.
 *
 * What it costs, so the cadence is a number rather than an assumption. A cached
 * principal is reused while more than this is left of its window, so an ACTIVE
 * person's discovery cadence goes from one per `FINGERPRINT_TTL_MS` to one per
 * `FINGERPRINT_TTL_MS - MIN_READ_HEADROOM_MS` — 60 s to 20 s, three times as
 * many. A discovery is `GET /user/installations` plus one repository page per
 * installation: measured at 4 REST requests for a person in two orgs plus their
 * own namespace, so ~720 requests an active hour; no reads means no discovery.
 *
 * It costs a second thing on the same clock, and this docstring used to say that
 * second thing was free (#892 review). `discover` installs a FRESH
 * `permissionCache` at every check, so every permission-sensitive state goes
 * cold with it, and only the repository-bound caches on the `cache` map beside
 * it survive. Measured before #1007, against a synthetic Github answering empty
 * lists and therefore a FLOOR: a repo-map read after a check cost 4 REST beyond
 * the discovery, where the same read inside one check cost 0. Since #1007 the
 * Projects state and the repo map are the two exceptions: a check that found
 * nothing changed carries them on, for no longer than their own TTLs (see
 * `PrincipalState`). The map's alerts, billing and pages still go cold.
 *
 * The Projects re-read is NOT on this budget and must not be added to it:
 * measured, it is 0 REST and 3 GraphQL REQUESTS. Not 3 points — Github meters
 * GraphQL per query rather than per call, and nothing here measured points, so
 * no share of that allowance is claimed. `docs/ops/per-user-github-credentials.md`
 * holds the one authoritative table, with the two budgets separated and every row
 * marked measured or derived; this comment is not a second copy of it.
 *
 * None of that is a defect — a fingerprint that cannot observe a private
 * Projects grant must not be allowed to reauthorize one, which is the whole of
 * C2. What is worth knowing is that this constant multiplies the discovery bill
 * by three and can multiply the re-read bill by three, which makes it the one
 * cheap lever if the REST ceiling ever needs lowering. Lowering it trades
 * against the cold-read admission it exists to guarantee.
 */
export const MIN_READ_HEADROOM_MS = 40_000;
/**
 * How long one instance may hold the refresh lease before it is abandoned
 * (#892 review, F1).
 *
 * A number that is now READ as well as written — see `leaseHeld`, where it is
 * what tells a refresh in flight from a process that died holding one. Sixty
 * seconds because the exchange behind the lease carries a 15 s timeout, so the
 * longest legitimate hold is comfortably inside it and anything past it is not
 * a slow refresh but an absent one.
 */
export const REFRESH_LEASE_MS = 60_000;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface TokenPair { access_token: string; refresh_token: string; expires_in: number; refresh_token_expires_in: number; scope?: string }

@Injectable()
export class GithubUserService {
  private readonly cipher: CredentialCipher;
  private readonly visibility = new Map<string, { until: number; version: string; fingerprint: string; principal: GithubPrincipal }>();
  private readonly discovering = new Map<string, Promise<GithubPrincipal>>();
  constructor(@Inject(ConfigService) private readonly config: ConfigService, @Inject(GITHUB_DB) readonly db: PrismaClient) {
    this.cipher = new CredentialCipher(new EnvironmentCredentialKey(config.get<string>('BOARD_CREDENTIAL_KEY', '')));
  }
  clientVisibilityKey(key: string): string {
    return clientVisibilityKey(this.config.get<string>('BOARD_SESSION_SECRET'), key);
  }
  get enabled(): boolean { return !!this.config.get<string>('GITHUB_USER_APP_CLIENT_ID'); }
  get callback(): string { return `${this.config.get<string>('BOARD_BASE_URL')}/api/auth/github/callback`; }
  get clientId(): string { return this.config.get<string>('GITHUB_USER_APP_CLIENT_ID', ''); }
  private get clientSecret(): string { return this.config.get<string>('GITHUB_USER_APP_CLIENT_SECRET', ''); }
  requireEnabled(): void { if (!this.enabled) throw new ServiceUnavailableException('GitHub connection is not configured'); }
  authorizeUrl(state: string): string {
    this.requireEnabled();
    return `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: this.clientId, redirect_uri: this.callback, state })}`;
  }
  async exchange(params: Record<string, string>): Promise<TokenPair> {
    this.requireEnabled();
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ForbiddenException('GitHub authorization failed; reconnect your account');
    const pair = await response.json() as TokenPair;
    if (!pair.access_token || !pair.refresh_token || !Number.isFinite(pair.expires_in) || pair.expires_in <= 0 || !Number.isFinite(pair.refresh_token_expires_in) || pair.refresh_token_expires_in <= 0) {
      throw new ForbiddenException('GitHub authorization failed; expiring user tokens are required');
    }
    return pair;
  }
  private encrypted(githubUserId: string, pair: TokenPair) {
    return {
      accessCipher: this.cipher.encrypt(pair.access_token, `${githubUserId}:access`),
      refreshCipher: this.cipher.encrypt(pair.refresh_token, `${githubUserId}:refresh`),
      accessExpiresAt: new Date(Date.now() + pair.expires_in * 1000),
      refreshExpiresAt: new Date(Date.now() + pair.refresh_token_expires_in * 1000),
      scopes: pair.scope ?? '', version: randomUUID(), refreshLeaseUntil: null,
    };
  }
  /** The GitHub account behind a fresh user token, read once before admission. */
  async fetchUser(pair: TokenPair): Promise<{ githubUserId: string; githubLogin: string }> {
    const { data: user } = await new Octokit({ auth: pair.access_token }).users.getAuthenticated();
    if (!user.id || !user.login) throw new ForbiddenException('GitHub authorization failed; no account');
    return { githubUserId: String(user.id), githubLogin: user.login };
  }
  /**
   * Write the credential once per sign-in, comparing the version captured at its
   * start. Sign-in is the connection: the row is keyed on the stable GitHub user
   * id and the login is recorded beside it for display and roster matching.
   */
  async connect(githubUserId: string, githubLogin: string, pair: TokenPair, expectedVersion: string | null): Promise<void> {
    const login = githubLogin.toLowerCase();
    const data = { ...this.encrypted(githubUserId, pair), boardSub: githubUserId, githubUserId, githubLogin, revokedAt: null, signInAdmittedAt: new Date() };
    if (expectedVersion === null) {
      await this.db.githubCredential.create({ data: { ownerEmail: login, ...data } });
    } else {
      const changed = await this.db.githubCredential.updateMany({ where: { githubUserId, version: expectedVersion }, data });
      if (changed.count !== 1) throw new ForbiddenException('Connection changed; start again');
    }
    this.forget(githubUserId);
  }
  /** Drop every cached visibility under one GitHub user id — a connect or a
   *  disconnect changes the answer for all of them. */
  private forget(githubUserId: string): void {
    for (const key of [...this.visibility.keys()]) {
      if (key === githubUserId) this.visibility.delete(key);
    }
  }
  /**
   * Re-check this person against Github on their next read (#892).
   *
   * A BARRIER, and that is the whole subtlety. A discovery already in flight for
   * this address resolves after the button is pressed and caches the snapshot
   * the person just asked the board to drop; the `/api/auth/me` that follows the
   * press joins it and paints the stale consents for a further
   * `FINGERPRINT_TTL_MS`. So this awaits those discoveries — both outcomes, a
   * failed one still has to be out of `discovering` — and only then forgets. The
   * caller awaits this before answering, so the next read is genuinely fresh.
   *
   * Nothing is written and no Github request is made here; the next read takes
   * the cost, as it would when the check expired on its own. Nothing in flight
   * is cancelled either, so a request that predates the press keeps the answer
   * it asked for. Scoped to the address given — a caller passes its own
   * session's, so a person can only invalidate themselves — and to every Board
   * subject under it, which is the same person's consent. Another address's
   * in-flight discovery is neither awaited nor kept out of the cache.
   */
  async refreshAccess(githubUserId: string): Promise<void> {
    const prefix = `${githubUserId}:`;
    await Promise.allSettled([...this.discovering].filter(([key]) => key.startsWith(prefix)).map(([, read]) => read));
    this.forget(githubUserId);
  }
  async disconnect(githubUserId: string): Promise<void> {
    const row = await this.db.githubCredential.findUnique({ where: { githubUserId } });
    // Persist denial first; refresh completion cannot resurrect the old version.
    await this.db.githubCredential.updateMany({ where: { githubUserId }, data: {
      revokedAt: new Date(), version: randomUUID(), accessCipher: '', refreshCipher: '', refreshLeaseUntil: null,
    } });
    this.forget(githubUserId);
    if (row && !row.revokedAt) {
      try {
        const response = await fetch(`https://api.github.com/applications/${this.clientId}/grant`, {
          method: 'DELETE', headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: this.cipher.decrypt(row.accessCipher, `${githubUserId}:access`) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok && response.status !== 404) throw new Error('revoke');
      } catch { throw new ServiceUnavailableException('Disconnected from Board; revoke the app in GitHub settings to finish remote revocation'); }
    }
  }
  /**
   * The live credential for a GitHub user id — the stable Board identity a
   * sign-in establishes. The row is keyed on `githubUserId`, never on the login
   * beside it, which a rename can move.
   */
  async credential(boardSub: string | undefined): Promise<{ row: GithubCredential; token: string } | null> {
    if (!boardSub) return null;
    let row = await this.db.githubCredential.findUnique({ where: { githubUserId: boardSub } });
    if (!row || row.revokedAt) return null;
    try {
      if (row.accessExpiresAt.getTime() > Date.now() + 30_000) return { row, token: this.cipher.decrypt(row.accessCipher, `${boardSub}:access`) };
      if (row.refreshExpiresAt.getTime() <= Date.now()) return null;
      // Acquire a database lease before spending the rotating refresh secret.
      // An abandoned lease is uncertain, so it requires reconnection, not reuse.
      // `return await`, deliberately: a bare `return` of a promise inside a
      // `try` settles the function before the catch below can see a rejection,
      // and this call decrypts — so a rotated key would escape as a 500 instead
      // of the unconnected state that block exists to produce.
      if (row.refreshLeaseUntil) return await this.leaseHeld(boardSub, row, row.refreshLeaseUntil);
      const version = randomUUID();
      const claimed = await this.db.githubCredential.updateMany({ where: { githubUserId: boardSub, version: row.version, revokedAt: null, refreshLeaseUntil: null }, data: { version, refreshLeaseUntil: new Date(Date.now() + REFRESH_LEASE_MS) } });
      if (claimed.count !== 1) throw new ServiceUnavailableException('Your GitHub connection changed while this was running. Try again.');
      try {
        const pair = await this.exchange({ grant_type: 'refresh_token', refresh_token: this.cipher.decrypt(row.refreshCipher, `${boardSub}:refresh`) });
        const data = this.encrypted(boardSub, pair);
        const replaced = await this.db.githubCredential.updateMany({ where: { githubUserId: boardSub, version, revokedAt: null }, data });
        if (replaced.count !== 1) return null;
        row = { ...row, ...data };
        return { row, token: pair.access_token };
      } catch {
        await this.db.githubCredential.updateMany({ where: { githubUserId: boardSub, version }, data: { revokedAt: new Date(), accessCipher: '', refreshCipher: '', version: randomUUID() } });
        return null;
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      return null; // Wrong/rotated encryption key requires a fresh sign-in.
    }
  }
  /**
   * What to do about a refresh lease somebody else is holding (#892 review, F1).
   *
   * The lease exists so that only one instance ever spends a rotating refresh
   * secret, and that part is unchanged: this method never retries the refresh,
   * whatever it finds. What it decides is which of two very different things a
   * lease means, and the deadline the lease already carries is what tells them
   * apart. Before this the test was PRESENCE, the deadline was written and never
   * read, and nothing anywhere cleared a lease — so a process that died between
   * claiming one and writing the replacement stranded the row, and every
   * authenticated request for that person answered 503 for ever, `/api/auth/me`
   * included. That is the read the browser asks in order to offer a reconnect,
   * so the one honest way out was refusing to draw itself.
   *
   * - A lease still inside its deadline is a refresh genuinely in flight on
   *   another instance. Bounded, self-clearing, and worth a retry: 503.
   * - A lease past its deadline is abandoned. It fails CLOSED — the credential is
   *   revoked and both ciphers blanked, so the person lands on the ordinary
   *   unconnected state and can connect Github again. Refusing reuse of an
   *   uncertain refresh token is still the rule; the row is retired rather than
   *   retried.
   *
   * The retirement is a compare-and-swap on the version AND the lease this read
   * saw, so it does two jobs at once. It FENCES a late refresh completion: that
   * write matches on the version it leased under, which this one has already
   * moved, so a reply arriving after the deadline cannot resurrect access. And
   * it cannot overwrite a WINNER — a refresh that landed in time, or a
   * reconnect, moved the version too, so the swap finds nothing and this read
   * defers to whatever now stands. One re-read decides what that is. No loop:
   * every branch below returns.
   */
  private async leaseHeld(
    boardSub: string,
    row: GithubCredential,
    leaseUntil: Date,
  ): Promise<{ row: GithubCredential; token: string } | null> {
    if (leaseUntil.getTime() > Date.now()) {
      throw new ServiceUnavailableException({ message: 'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.', code: ACCESS_NOT_NOW_CODE });
    }
    const retired = await this.db.githubCredential.updateMany({
      where: { githubUserId: boardSub, version: row.version, revokedAt: null, refreshLeaseUntil: leaseUntil },
      data: { revokedAt: new Date(), accessCipher: '', refreshCipher: '', refreshLeaseUntil: null, version: randomUUID() },
    });
    if (retired.count === 1) { this.forget(boardSub); return null; }
    // The row moved between the read above and the swap. Whoever moved it is the
    // winner; read once to find out what they left, and answer that.
    const now = await this.db.githubCredential.findUnique({ where: { githubUserId: boardSub } });
    if (!now || now.revokedAt) return null;
    if (now.refreshLeaseUntil && now.refreshLeaseUntil.getTime() > Date.now()) {
      throw new ServiceUnavailableException({ message: 'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.', code: ACCESS_NOT_NOW_CODE });
    }
    if (now.accessExpiresAt.getTime() > Date.now() + 30_000) {
      return { row: now, token: this.cipher.decrypt(now.accessCipher, `${boardSub}:access`) };
    }
    // A row that still wants refreshing, left by somebody who did not finish
    // one. This request draws unconnected rather than starting a second attempt
    // inside a request that has already made two writes; the next request takes
    // the ordinary path and refreshes it.
    return null;
  }
  /**
   * This person's visibility, with at least `minHeadroomMs` of the check left.
   *
   * `minHeadroomMs` is what the guard asks for before a read that may run long.
   * A held check with less than that remaining is not extended — it is replaced
   * by a genuinely fresh discovery, which is a real check and so keeps the
   * access-loss bound at one `FINGERPRINT_TTL_MS`. ONE attempt: if the fresh
   * check itself took so long that the headroom is still short, the request is
   * refused rather than discovered again, because a loop here is a loop against
   * Github.
   */
  async principal(email: string, boardSub: string | undefined, machine = false, minHeadroomMs = 0): Promise<GithubPrincipal> {
    email = email.toLowerCase();
    // The visibility cache is keyed on the stable GitHub user id.
    const who = boardSub ?? '';
    const empty = (): GithubPrincipal => ({ key: `unconnected:${who}`, email, login: null, token: null, owners: [], repositories: [], cache: new WeakMap() });
    if (machine || !this.enabled || !who) return empty();
    const credential = await this.credential(boardSub);
    if (!credential) { this.visibility.delete(who); return empty(); }
    const { row, token } = credential;
    const previous = this.visibility.get(who);
    if (previous && previous.version === row.version && previous.until > Date.now() + minHeadroomMs) return { ...previous.principal, token };
    const key = `${who}:${row.version}`;
    const pending = this.discovering.get(key);
    const read = pending ?? this.discover(who, email, row, token).catch((err: unknown) => {
      // GitHub refused the token itself (revoked at github.com, #1411): answer
      // unconnected so the guard refuses 403 and the browser drops its saved copy.
      if ((err as { status?: unknown })?.status !== 401) throw err;
      this.visibility.delete(who);
      return empty();
    }).finally(() => this.discovering.delete(key));
    if (!pending) this.discovering.set(key, read);
    if (minHeadroomMs <= 0) return read;
    // A discovery this request JOINED may have started long enough ago that the
    // window it opened is nearly spent, and its own may have been slow. Either
    // way this is the one place that can say so, and it says it rather than
    // asking Github a second time.
    const fresh = await read;
    // The unconnected state carries no window, because no check was made: the
    // credential was revoked under this discovery (#1411). The headroom floor
    // below would answer a coded "not now", which tells the browser to KEEP its
    // saved copy. The guard refuses their Github surfaces instead.
    if (!fresh.token) return fresh;
    if ((fresh.expiresAt ?? 0) - Date.now() < minHeadroomMs) {
      throw new ServiceUnavailableException({ message: 'GitHub access check has too little left to start this read; retry', code: ACCESS_NOT_NOW_CODE });
    }
    return fresh;
  }
  /** Drop what nothing will reuse: snapshots idle past their repository caches'
   *  own lifetime first, then the oldest, down to the ceiling. Work in flight
   *  holds its own reference to the principal, so eviction never cuts a read
   *  short — it only stops the map holding the snapshot after it. */
  private evict(now: number): void {
    for (const [key, held] of this.visibility) {
      if (now - held.until > VISIBILITY_RETENTION_MS) this.visibility.delete(key);
    }
    while (this.visibility.size > VISIBILITY_MAX) {
      this.visibility.delete(this.visibility.keys().next().value!);
    }
  }
  private async discover(who: string, email: string, row: GithubCredential, token: string): Promise<GithubPrincipal> {
    const started = Date.now();
    // Conditional, like every client `buildOctokitClient` makes (#1007): an
    // unchanged installation list comes back 304 and is not counted, and it is
    // the stored answer to this same Github user that the fingerprint reads.
    const identity = personIdentity(row.githubUserId, email);
    const client = withGithubEtags(withGithubRequestMetrics(new Octokit({ auth: token }), identity, 'discovery'), identity);
    const installations = await client.paginate('GET /user/installations', { per_page: 100 });
    const owners: GithubOwner[] = [];
    const repositories: GithubRepository[] = [];
    /**
     * Consent, read off the payload the access pass already fetched (#892), so
     * this list adds no Github call.
     *
     * `owners`/`repositories` are ACCESS: what this request may read. `held` is
     * CONSENT: a superset, because a SUSPENDED installation is a consent that
     * grants nothing. That is why the suspension test moved below the account
     * filter — and nowhere else: it still pushes no owner and no repository.
     */
    const held: GithubInstallation[] = [];
    let appSlug: string | null = null;
    const eligible = installations.filter(({ account }) => account && 'login' in account &&
      isPersonalScopeOwner(account, row.githubUserId));
    const repositoryLists = new Map<number, GithubRepository[]>();
    const active = eligible.filter((installation) => !installation.suspended_at);
    for (let offset = 0; offset < active.length; offset += INSTALLATIONS_AT_ONCE) {
      // Keep pagination sequential inside each installation, with at most three
      // installations reading at once. Drain failures before releasing the shared
      // discovery so refreshAccess remains a barrier to all its upstream reads.
      const results = await Promise.allSettled(active.slice(offset, offset + INSTALLATIONS_AT_ONCE).map(async (installation) => {
        const repos = await client.paginate('GET /user/installations/{installation_id}/repositories', { installation_id: installation.id, per_page: 100 });
        repositoryLists.set(installation.id, repos as GithubRepository[]);
      }));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    }
    // Assemble in installation order, independent of which request finished first:
    // owner order participates in the fingerprint and therefore session identity.
    for (const installation of eligible) {
      const account = installation.account!;
      if (!('login' in account)) continue;
      const owner: GithubOwner = { id: account.id, login: account.login, type: account.type as GithubOwner['type'] };
      const suspended = !!installation.suspended_at;
      let repositoryCount: number | null = null;
      if (!suspended) {
        const repos = repositoryLists.get(installation.id)!;
        owners.push(owner);
        repositories.push(...repos as GithubRepository[]);
        repositoryCount = repos.length;
      }
      // `GET /user/installations` answers only the board's own App for a
      // user-to-server token, so any installation names the slug.
      if (!appSlug && isGithubAppSlug(installation.app_slug)) appSlug = installation.app_slug;
      const manageUrl = installationManageUrl(installation.id, owner);
      // Dropped from the MANAGEMENT list rather than shipped with a fabricated
      // link. Access above is untouched: a provider anomaly must not silently
      // remove somebody's repositories.
      if (!manageUrl) continue;
      held.push({
        id: installation.id,
        account: owner,
        repositorySelection: installation.repository_selection === 'all' || installation.repository_selection === 'selected' ? installation.repository_selection : 'unknown',
        repositoryCount,
        permissions: Object.fromEntries(Object.entries(installation.permissions ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
        suspended,
        manageUrl,
      });
    }
    const fingerprint = digest(JSON.stringify({ owners, installationPermissions: installations.map((i) => [i.id, i.permissions]), repos: repositories.map((r) => [r.id, r.full_name, r.permissions]).sort((a, b) => Number(a[0]) - Number(b[0])) }));
    const previous = this.visibility.get(who);
    const principal: GithubPrincipal = {
      // WHAT this person can see, and nothing about when it was checked. The
      // browser keys its saved cache and its mounted tree on this, so a check
      // that finds nothing changed must produce the same string — otherwise the
      // board tears itself down once a minute for no reason. `expiresAt` below
      // carries the freshness, which is a separate question (#892 review, F2).
      //
      // `row.version` IS NOT IN IT, and that is #1395. It is a fresh UUID on
      // every credential refresh (see `refresh` above), and the board requires
      // expiring user tokens, which Github issues for eight hours. So the key
      // moved at least once a day while nothing about this person's access had
      // changed — and the browser, reading a moved key as somebody else, emptied
      // its cache and remounted the tree. The board opening on loading
      // placeholders every morning was this line. `fingerprint` is the whole of
      // what the key is for: the owners, the installation permissions and the
      // repositories, which is what a reader is allowed to see. A rotated
      // credential for the same Github account grants exactly the same things.
      //
      // The version still governs the two things it really bounds, both below:
      // which cached repository state may be reused, and which row a refresh
      // claims.
      key: `${who}:${row.githubUserId}:${fingerprint}`, githubUserId: row.githubUserId, email, login: row.githubLogin, token, owners, repositories,
      installations: held, appSlug, scope: githubScopeIds(owners, repositories),
      // The instant this check goes stale. Absolute, and taken from when the
      // check STARTED: reusing a principal must never push the deadline out, or
      // the access-loss bound quietly doubles.
      expiresAt: started + FINGERPRINT_TTL_MS,
      permissionCache: new WeakMap(),
      cache: previous?.version === row.version && previous.fingerprint === fingerprint ? previous.principal.cache : new WeakMap(),
    };
    if (Date.now() >= started + FINGERPRINT_TTL_MS) throw new ServiceUnavailableException({ message: 'Checking your GitHub access took too long. Try again.', code: ACCESS_NOT_NOW_CODE });
    this.visibility.set(who, { until: started + FINGERPRINT_TTL_MS, version: row.version, fingerprint, principal });
    this.evict(started);
    return principal;
  }
}

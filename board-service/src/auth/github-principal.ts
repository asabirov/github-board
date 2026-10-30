import type { GithubScopeIds } from './github-scope';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenException } from '@nestjs/common';

export interface GithubOwner {
  /** Stable GitHub account identity; absent on older or synthetic principals. */
  id?: number;
  login: string;
  type: 'Organization' | 'User';
}
export interface GithubRepository {
  id: number; full_name: string; name: string; owner: { login: string };
  archived?: boolean; fork?: boolean; has_issues?: boolean; default_branch?: string;
  permissions?: Record<string, boolean>;
}
/**
 * One installation of the board's Github App that this person's token can see
 * (#892).
 *
 * CONSENT, never an access grant. `owners`/`repositories` above are what this
 * person can reach; this list is wider, because a SUSPENDED installation is a
 * consent still held that grants nothing.
 *
 * `permissions` are the APP's grants on that account, not proof this person can
 * exercise any of them — their own role is `repositories[].permissions`.
 * `repositoryCount` counts what THIS person reaches through the installation,
 * not what it covers, and is `null` where nothing was counted: a suspended
 * installation is never enumerated.
 */
export interface GithubInstallation {
  id: number;
  account: GithubOwner;
  repositorySelection: 'all' | 'selected' | 'unknown';
  repositoryCount: number | null;
  permissions: Record<string, string>;
  suspended: boolean;
  /** Constructed from the id and account above by `github-app-links.ts`, never
   *  forwarded from the provider payload. */
  manageUrl: string;
}
export interface GithubPrincipal {
  key: string;
  /** Stable quota identity, independent of token and permission generations. */
  githubUserId?: string;
  expiresAt?: number;
  email: string;
  login: string | null;
  token: string | null;
  owners: GithubOwner[];
  repositories: GithubRepository[];
  /** Internal discovery identities, not a metric comparison or cache key. */
  scope?: GithubScopeIds | null;
  cache: WeakMap<object, object>;
  permissionCache?: WeakMap<object, object>;
  /** The consents this person holds (#892). OPTIONAL, and absent is not empty:
   *  a principal that predates this field claims nothing about installations,
   *  where `[]` says there are none. */
  installations?: GithubInstallation[];
  /** The board App's slug as Github reported it on an installation this person
   *  holds (#892) — the fallback for the install link. Never guessed. */
  appSlug?: string | null;
}

/**
 * A request starts unresolved; only the authenticated-person guard may fill it.
 * Absence of a context is reserved for deployment jobs such as boot warms.
 *
 * `sensitive` records whether this request read any PERMISSION-sensitive state —
 * Projects, security alerts, billing, capability verdicts, issue detail. It is
 * what `GithubExpiryInterceptor` needs and cannot get any other way: a repo-only
 * answer can be released once a fresh check finds the same visibility, and a
 * permission-sensitive one cannot, because the fingerprint does not observe
 * every grant behind it. Written where the state is consumed rather than
 * declared per route, so a new surface cannot forget to declare itself.
 */
export const githubContext = new AsyncLocalStorage<{
  principal: GithubPrincipal | null;
  /** The stable Board identity this request resolved under, so a re-check at
   *  response time asks the same question the guard asked. */
  boardSub?: string;
  sensitive?: boolean;
}>();
export function githubPrincipal(): GithubPrincipal | undefined {
  const context = githubContext.getStore();
  if (!context) return undefined;
  if (!context.principal) throw new ForbiddenException('GitHub identity has not been resolved');
  return context.principal;
}
export function personalOwner(login: string): boolean {
  return githubPrincipal()?.owners.some((o) => o.login.toLowerCase() === login.toLowerCase() && o.type === 'User') ?? false;
}
export function ownerQualifier(login: string): string {
  return `${personalOwner(login) ? 'user' : 'org'}:${login}`;
}

/** A permission-sensitive state an access re-check that found nothing changed
 *  may carry on with, for no longer than `maxAgeMs` (#1007). */
export interface KeptWhileUnchanged { maxAgeMs: () => number }

/** Each cache holder owns one deployment state and one state per visibility
 * generation of a person. Old asynchronous refills retain their original state.
 *
 * `repositoryOnly` (a `true` scope) says the state is derived from repository
 * identity alone, so it survives a fingerprint re-check that finds the same
 * repositories. Anything else is permission-sensitive: it restarts at every
 * re-check, and reading it marks the request, which is what stops its answer
 * being released after the check that authorized it has expired.
 *
 * A `KeptWhileUnchanged` scope is the one exception to that restart (#1007), and
 * the maintainer approved it for two holders only: `ProjectsService` and the
 * repository map in `ReposService`. The state is still permission-sensitive.
 * Reading it marks the request exactly as before, so a late answer is still
 * refused and the browser still drops it at the deadline. What changes is that a
 * re-check whose visibility is unchanged may go on with the state the check
 * before it left instead of starting cold, which is what made every re-check,
 * about every twenty seconds per open tab, re-read every owner's Projects.
 *
 * It is held on `cache`, which `discover` hands on ONLY while the credential
 * version and the fingerprint are both unchanged. So any change of visibility, a
 * reconnect, a refreshed credential, `refreshAccess` or a disconnect starts it
 * cold exactly as before, and two people never meet in it, because `cache` is
 * one person's. The price is the approved one: a Project or team grant withdrawn
 * without moving any repository, which the fingerprint cannot see, stays visible
 * for up to `maxAgeMs` instead of one `FINGERPRINT_TTL_MS`.
 *
 * `maxAgeMs` is the holder's own TTL, and it bounds the whole state rather than
 * only its entries: a check carries the state on only while that check's own
 * deadline falls inside the state's age limit. Every answer a check serves goes
 * out before its deadline, or the interceptor refuses it, and everything in the
 * state was read after the state was made, so nothing is served older than the
 * TTL. It stops the state being emptied early; it never keeps it for longer. */
export class PrincipalState<T extends object> {
  private readonly deployment: T;
  constructor(private readonly create: () => T, private readonly scope: boolean | KeptWhileUnchanged = false) { this.deployment = create(); }
  get current(): T {
    const principal = githubPrincipal();
    if (!principal) return this.deployment;
    const repositoryOnly = this.scope === true;
    if (!repositoryOnly) {
      const store = githubContext.getStore();
      if (store) store.sensitive = true;
    }
    const cache = repositoryOnly ? principal.cache : principal.permissionCache ?? principal.cache;
    let state = cache.get(this) as T | undefined;
    if (!state) { state = this.fresh(principal); cache.set(this, state); }
    return state;
  }

  /**
   * What this holder has for this person WITHOUT reading it: the state `current`
   * would find, or undefined where there is none yet (#1169).
   *
   * It does not mark the request permission-sensitive, and that is what it is
   * for. The one caller is `lastSyncedAt` on the two holders whose scope is
   * `KeptWhileUnchanged` — the Board sync panel's Projects and Repos rows, which
   * carry WHEN this person's state was built and no Github data whatever. Marked
   * for that, a two-minute poll running on every page would be refused outright
   * once the check behind it expired, and would carry the withdrawal headers
   * that can invalidate the whole board. `sync.controller.ts` makes the same
   * argument the progress route has made since #976.
   *
   * It MAKES nothing either. A panel asking how fresh a source is must not be
   * what starts that source's state, or the moment it reports is one it created
   * itself; and under a `KeptWhileUnchanged` scope a fresh state here would
   * anchor the carry window on the poll rather than on the read it reports on.
   */
  peek(): T | undefined {
    const principal = githubPrincipal();
    if (!principal) return this.deployment;
    const cache = this.scope === true ? principal.cache : principal.permissionCache ?? principal.cache;
    return (cache.get(this) as T | undefined) ?? this.carried(principal) ?? undefined;
  }

  /** The state an earlier check of the same visibility left, while it may still
   *  serve (#1007). Null where this holder carries nothing between checks, and
   *  where what it carried may no longer be served. */
  private carried(principal: GithubPrincipal): T | null {
    const kept = typeof this.scope === 'object' ? this.scope : null;
    // No per-check cache or no deadline means there is no earlier check to
    // carry on from: an unconnected person, or the auth routes' placeholder.
    const expiresAt = principal.expiresAt;
    if (!kept || !principal.permissionCache || expiresAt === undefined) return null;
    const held = principal.cache.get(this) as { state: T; since: number } | undefined;
    return held && expiresAt <= held.since + kept.maxAgeMs() ? held.state : null;
  }

  /** A new state for this check, or, under a `KeptWhileUnchanged` scope, the one
   *  an earlier check of the same visibility made, while it may still serve. */
  private fresh(principal: GithubPrincipal): T {
    const carried = this.carried(principal);
    if (carried) return carried;
    const state = this.create();
    // Only a holder that carries state between checks records when this one was
    // made; for every other scope the state lives and dies with the check.
    if (typeof this.scope === 'object' && principal.permissionCache && principal.expiresAt !== undefined) {
      principal.cache.set(this, { state, since: Date.now() });
    }
    return state;
  }
}

export function ownerQuery(document: string, owner: string): `query${string}` {
  // Alias preserves the existing response shape for org-or-user roots.
  const query = document.trim();
  if (!/^query\b/.test(query) || /\bmutation\b/.test(query)) throw new Error('Expected a read-only owner query');
  return (personalOwner(owner) ? query.replace(/organization\(login:/g, 'organization:user(login:') : query) as `query${string}`;
}

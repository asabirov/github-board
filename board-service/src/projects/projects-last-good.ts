import { githubContext } from '../auth/github-principal';
import { GithubQuotaCooldownError } from '../sources/github-quota';

/**
 * The last answer Github gave for one person's Projects, kept so a refused read
 * is not a blank board (#1003).
 *
 * WHY THIS EXISTS AT ALL. Since #892 every Projects read runs on the signed-in
 * person's own Github credential, and until #1007 `PrincipalState` gave that
 * person a fresh cache at every permission re-check — roughly every twenty
 * seconds — so the five-minute TTL almost never got to answer anything. Since
 * #1007 the Projects state survives a re-check that found nothing changed, up to
 * that TTL, and is still gone the moment the person's visibility changes; a
 * refused read after that has nothing in the cache to fall back on. `ProjectsService.retired`
 * is the fallback that was already there, and it refuses outright when a person
 * is acting (`if (githubPrincipal()) throw err`), because a retiree is written
 * only by a write-triggered drop and there was nowhere safe to keep one across
 * checks. The result was that a person's Projects had NO fallback: the first
 * Github refusal took the whole surface off the page. That is what happened on
 * 2026-09-10 — the GraphQL point budget ran out, `github-quota.ts` refused every
 * query for the identity until the hourly reset, and with nothing behind it
 * `perOrg` threw: `/api/projects` 500d and the issue→board join degraded to "on
 * no board", which silently took the Project grouping off both queues.
 *
 * WHAT IT KEEPS. One entry per (visibility, kind, org). The visibility is the
 * principal's own `key` — `who:githubUserId:version:fingerprint` — so an entry
 * can only ever be served back to the SAME person, on the same credential
 * generation, with the same repository access. That is the exact-match rule
 * `docs/ops/per-user-github-credentials.md` states: no prefix match, no "close
 * enough", no falling back to a wider snapshot.
 *
 * WHEN IT IS SERVED, and the two gates that keep the relaxation narrow.
 *
 * First, only from a `catch`, never as a fresh answer. The live read is still
 * attempted every time, so nothing about a working read changes.
 *
 * Second, only for a refusal that says NOT NOW — see `servableRefusal`. A
 * refusal that says NOT YOU is never fallen back on, which is the difference
 * between riding out a quota cooldown and serving a board somebody just lost
 * access to. Without that gate this store would answer a 403 with the copy the
 * 403 exists to withhold, which would be worse than the blank page it replaces.
 *
 * WHAT IT STILL CANNOT SEE, stated because the rest of this file is not allowed
 * to imply otherwise. The fingerprint in the key digests owners, installation
 * permissions and repository permissions — `github-user.service.ts` — and
 * `github-expiry.interceptor.ts` says in as many words that private Projects
 * grants turn on permissions it does not observe. So a PROJECT- or TEAM-level
 * grant withdrawn while nothing about repository access changes leaves the key
 * identical, and this store would serve that board for up to `maxAgeMs` if the
 * live read happened to be quota-refused in the same window. `docs/ops` promises
 * an access loss is visible within one `FINGERPRINT_TTL_MS`, and inside that
 * window this does not keep the promise. The gates above are what bound it: the
 * live read has to be failing, and failing in a way that is about the budget
 * rather than about the reader. It is a real residual, not a covered case.
 */
export interface LastGood<T> { at: number; data: T }

/** What may sit in the store at once. One person holds a handful of entries —
 *  three kinds times their owners — so this is a ceiling on identity churn, not
 *  on ordinary use. Oldest read goes first. */
const MAX_ENTRIES = 4096;

export type LastGoodKind = 'boards' | 'membership index' | 'catalog';

/** HTTP statuses that answer "not you". Any of them anywhere in a refusal
 *  disqualifies the whole refusal, whatever else is beside it: an authorization
 *  verdict is the one answer a held copy must never soften. */
const NOT_YOU = new Set([401, 403, 404, 410, 422]);

/** HTTP statuses that answer "not now" — Github's own back-pressure and its own
 *  outages. */
const NOT_NOW = new Set([408, 429, 500, 502, 503, 504]);

/**
 * GraphQL error types that answer "not you", and the reason this list has to
 * exist at all.
 *
 * THE PROJECTS PATH IS GRAPHQL-ONLY, AND GRAPHQL DOES NOT REFUSE WITH A STATUS.
 * Github answers a lost Projects grant with **HTTP 200** and
 * `errors: [{ type: 'FORBIDDEN' }]` in the body — `github-quota.ts` says the
 * same thing where it reads `RATE_LIMIT` off that shape. `@octokit/graphql`
 * turns that into a `GraphqlResponseError`, which carries `errors` and `data`
 * and NO `status` at all. So the HTTP sets above never see the refusal that
 * actually happens here: on this path a 403 means a dead token or an abuse
 * block, and the grant withdrawal this gate exists for arrives as a 200.
 */
const NOT_YOU_TYPES = new Set(['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED', 'INSUFFICIENT_SCOPES', 'ACTOR_SUSPENDED', 'UNPROCESSABLE']);

/** The GraphQL error types that answer "not now". `RATE_LIMIT` is the spelling
 *  `github-quota.ts` matches; `RATE_LIMITED` is the schema's own. `TIMEOUT` is
 *  Github giving up on a walk, which a Projects board large enough to be worth
 *  holding is exactly the shape of, and which says nothing about the reader.
 *
 *  `MAX_NODE_LIMIT_EXCEEDED` is deliberately NOT here: that is this board asking
 *  for too much in one query, which no amount of waiting fixes and which a held
 *  copy would hide until somebody happened to read the log. */
const NOT_NOW_TYPES = new Set(['RATE_LIMIT', 'RATE_LIMITED', 'TIMEOUT']);

function statusOf(err: unknown): number | undefined {
  const held = err as { status?: unknown; response?: { status?: unknown } } | null;
  if (typeof held?.status === 'number') return held.status;
  return typeof held?.response?.status === 'number' ? held.response.status : undefined;
}

/** The `type` of every GraphQL error on a `GraphqlResponseError`-shaped throw,
 *  read off both the flattened `errors` and the body it came from. */
function graphqlTypes(err: unknown): string[] {
  const held = err as { errors?: unknown; response?: { errors?: unknown; data?: { errors?: unknown } } } | null;
  // Three places one body can put them. `@octokit/graphql` flattens `errors`
  // onto the error and keeps the body at `response`; `@octokit/request` leaves
  // the whole body at `response.data`, which is where a layer between the two
  // would put a verdict this must not miss.
  const lists = [held?.errors, held?.response?.errors, held?.response?.data?.errors];
  return lists.flatMap((list) => (Array.isArray(list) ? list : []))
    .map((entry) => (entry as { type?: unknown } | null)?.type)
    .filter((type): type is string => typeof type === 'string');
}

/** One link of the cause chain, or `undefined`. Guarded because `cause` may be
 *  an accessor: a throw out of it here would replace the real refusal with a
 *  second one and skip the `retired` ladder underneath. */
function causeOf(err: unknown): unknown {
  try {
    return (err as { cause?: unknown } | null)?.cause;
  } catch {
    return undefined;
  }
}

/**
 * The code on the one 503 a browser's saved Projects copy may answer (#1035):
 * `ProjectsService.perOrg` found every org's read refused in a way
 * `servableRefusal` below accepts. It travels in the body beside the reasons,
 * the way `ADMINS_UNREAD_CODE` does, because a 503 alone says nothing about
 * which verdict it is. Board-api answers 503 for other reasons too: the expiry
 * interceptor withholding a sensitive answer its access check has outlived, the
 * Github principal guard, the session check. The first two exist to stop showing
 * a person what they may have lost, and a browser that drew its copy over them
 * would undo them (#1042 review). Must match `PROJECTS_NOT_NOW_CODE` in
 * board-frontend's `projects/projects-last-good.ts`.
 */
export const PROJECTS_NOT_NOW_CODE = 'projects_not_now';

/**
 * Whether a failed read is one a held copy may stand in for.
 *
 * AN ALLOW-LIST, and that direction is the whole of it (#1003 review). A
 * refusal is servable only when something in it SAYS "not now" — the quota
 * cooldown, a `RATE_LIMIT` GraphQL error, or one of the transient statuses
 * above. Anything this cannot read is refused: a `TypeError` off an unexpected
 * payload, a GraphQL type not on either list, a bare `Error`. The first draft
 * of this defaulted the other way, treating "no status" as transient, and that
 * made every `FORBIDDEN` — which arrives with no status, because it arrives on
 * a 200 — servable. A gate that opens on everything it does not recognise is
 * not a gate.
 *
 * NOT YOU WINS over everything, at any depth: a refusal carrying `FORBIDDEN` or
 * a 403 is refused even with a cooldown beside it. The direction of a mistake
 * here is not symmetric. Withholding a board somebody could have seen costs
 * them a reload; serving one they no longer may is the thing this file is not
 * allowed to do.
 *
 * The CHAIN is walked, and on this path it is almost always one link:
 * `GithubProjectsSource` re-throws bare and so does `github-quota.ts`. It is
 * `ProjectsService.perOrg` that wraps with `{ cause }`, above the callers of
 * this, and a future source that wraps would otherwise hide the type that
 * decides this. Cycles terminate on `seen`.
 */
export function servableRefusal(err: unknown): boolean {
  return refusalVerdict(err) === 'not now';
}

/**
 * Whether a failed read is Github telling this reader they may not see this
 * (#1395).
 *
 * The same walk, read for the other answer. It exists because the browser needs
 * the two apart: since #1395 only a 401, a 403 and a 404 withdraw a copy the
 * reader already has, and everything else keeps it. A withdrawn Projects grant
 * arrives from GraphQL as `FORBIDDEN` on a 200, with no HTTP status anywhere, so
 * it used to reach the browser as an uncoded 500 — and a 500 is now "not now".
 * The board would have stayed on screen for the rest of the copy's day.
 *
 * `ProjectsService.totalFailure` asks this and answers 403, which the browser
 * reads as the withdrawal it is.
 */
export function notYouRefusal(err: unknown): boolean {
  return refusalVerdict(err) === 'not you';
}

/** The one walk both questions above read. "Not you" wins over "not now" at any
 *  depth, which is the asymmetry the docblock argues for. */
function refusalVerdict(err: unknown): 'not you' | 'not now' | undefined {
  const seen = new Set<unknown>();
  let servable = false;
  for (let held: unknown = err; held !== null && held !== undefined && !seen.has(held); held = causeOf(held)) {
    seen.add(held);
    // EVERY read of the error is guarded, not just `cause` (#1003 review).
    // `errors`, `response` and `status` are all plain property reads on an
    // object this module did not construct, and a throwing accessor on any of
    // them would escape `rollupBoards`' catch, replace the refusal a reader is
    // owed with `boom`, and skip the `retired` ladder underneath. An error we
    // cannot inspect is one we cannot clear, so the allow-list simply does not
    // set `servable` for it.
    let verdict: 'not you' | 'not now' | undefined;
    try {
      const types = graphqlTypes(held);
      const status = statusOf(held);
      if (types.some((type) => NOT_YOU_TYPES.has(type))) verdict = 'not you';
      else if (status !== undefined && NOT_YOU.has(status)) verdict = 'not you';
      else if (held instanceof GithubQuotaCooldownError) verdict = 'not now';
      else if (types.some((type) => NOT_NOW_TYPES.has(type))) verdict = 'not now';
      else if (status !== undefined && NOT_NOW.has(status)) verdict = 'not now';
    } catch {
      verdict = undefined;
    }
    if (verdict === 'not you') return 'not you';
    if (verdict === 'not now') servable = true;
  }
  return servable ? 'not now' : undefined;
}

export class ProjectsLastGood {
  private readonly held = new Map<string, LastGood<unknown>>();
  /** Slots already announced in the log since the last answer landed in them.
   *  Without this, a reader sitting on a page through an hour-long cooldown
   *  writes a warn line per org per kind every ~20s — on the order of a thousand
   *  an hour, for one fact that has not changed. */
  private readonly announced = new Set<string>();

  constructor(private readonly maxAgeMs: number) {}

  /**
   * Which entry a read belongs to, or `undefined` for a read this store stays
   * out of entirely.
   *
   * A PERSON is the whole point: the principal's `key` is their identity,
   * credential generation and repository fingerprint at once, so an entry filed
   * under it can be served back to nobody else.
   *
   * NO CONTEXT is a deployment job — a boot warm, the trailing walks, the
   * detached login derivation. Those already have `ProjectsService.retired` and
   * its `RETIREE_MAX_TTLS` ceiling (#713), which decides deliberately that a
   * copy past that ceiling is refused rather than served. This store must not
   * quietly overrule that decision, so it declines the path.
   *
   * A CONTEXT WITH NO PRINCIPAL is a request whose Github identity never
   * resolved. `githubPrincipal()` refuses it everywhere else; nothing is kept
   * for it and nothing is served to it. Read off the store rather than through
   * `githubPrincipal()`, which THROWS on that case — and a throw from `keep`
   * would turn a read that worked into a failed one.
   */
  private static visibility(): string | undefined {
    return githubContext.getStore()?.principal?.key;
  }

  private static slot(visibility: string, kind: LastGoodKind, org: string): string {
    return `${visibility}\u0000${kind}\u0000${org.toLowerCase()}`;
  }

  /** Record what Github just answered. Called on every successful source read,
   *  not only on a drop — a fallback nothing ever writes to is the empty one
   *  this exists to replace. */
  keep<T>(kind: LastGoodKind, org: string, data: T): void {
    const visibility = ProjectsLastGood.visibility();
    if (visibility === undefined) return;
    const slot = ProjectsLastGood.slot(visibility, kind, org);
    // Re-insert so the map's own insertion order is least-recently-written
    // first, which is the order `evict` below walks.
    this.held.delete(slot);
    this.held.set(slot, { at: Date.now(), data });
    // A fresh answer is a fresh thing to say about, so the next outage over this
    // slot gets its own line.
    this.announced.delete(slot);
    this.evict();
  }

  /**
   * Forget what this person holds for one kind — every org, or one named org.
   *
   * The shape `ProjectsService.retire` has, and called from the same places, so
   * a write-triggered drop reaches this store too (#1003 review). Without it the
   * drop's whole point is lost for the person who made the write: `recall` is
   * asked before `retired`, so their next cold read during an outage would be
   * answered with the copy from BEFORE their own write, and for `maxAgeMs`
   * rather than the `RETIREE_MAX_TTLS` ceiling #713 chose for exactly that
   * payload.
   *
   * DROPPED, not retired. #713's retiree exists because a drop is followed by a
   * cold read that may fail; that ladder is still there, still behind this, and
   * still owns the pre-write copy on its own ceiling. This one only stops a
   * SECOND, longer-lived copy of the same payload outliving it.
   */
  forget(kind: LastGoodKind, org?: string): void {
    const visibility = ProjectsLastGood.visibility();
    if (visibility === undefined) return;
    if (org !== undefined) {
      const slot = ProjectsLastGood.slot(visibility, kind, org);
      this.held.delete(slot);
      this.announced.delete(slot);
      return;
    }
    const prefix = ProjectsLastGood.slot(visibility, kind, '');
    for (const slot of [...this.held.keys()]) {
      if (!slot.startsWith(prefix)) continue;
      this.held.delete(slot);
      this.announced.delete(slot);
    }
  }

  /**
   * The last answer for this person and org, if there is one inside the ceiling.
   * `undefined` when there is nothing to serve — the caller rethrows its own
   * error then, so a surface with no last-good copy fails exactly as it did.
   *
   * `announce` says whether this is the FIRST time this slot has stood in since
   * the last real answer landed in it, so the caller can log an outage once
   * instead of once per poll.
   */
  recall<T>(kind: LastGoodKind, org: string): (LastGood<T> & { announce: boolean }) | undefined {
    const visibility = ProjectsLastGood.visibility();
    if (visibility === undefined) return undefined;
    const slot = ProjectsLastGood.slot(visibility, kind, org);
    const held = this.held.get(slot);
    if (held === undefined) return undefined;
    if (Date.now() - held.at > this.maxAgeMs) {
      // Dropped rather than left to be re-refused on every read, matching how
      // `ProjectsService.retired` treats a retiree past its own ceiling.
      this.held.delete(slot);
      this.announced.delete(slot);
      return undefined;
    }
    const announce = !this.announced.has(slot);
    this.announced.add(slot);
    return { ...(held as LastGood<T>), announce };
  }

  private evict(): void {
    const now = Date.now();
    for (const [slot, held] of this.held) if (now - held.at > this.maxAgeMs) this.drop(slot);
    while (this.held.size > MAX_ENTRIES) {
      const oldest = this.held.keys().next();
      if (oldest.done) return;
      this.drop(oldest.value);
    }
  }

  private drop(slot: string): void {
    this.held.delete(slot);
    this.announced.delete(slot);
  }
}

import { hasStableTargets, targetHeaders } from '../auth/github-target';
import { rememberRead, forgetRead, markReadStale, readClient, readKey, readValue, currentReadRefusalEpoch, waitForReadRestoration } from '../cache/read-cache';
import { clearSessionHint, hintPreviewActive, UnverifiedSessionError, waitForHintProbe } from '../auth/session-hint';
/**
 * One transport and one set of in-flight reads for every API surface (#1149).
 * Adapters and the compatibility facade import this module; it imports neither.
 * The caller passes fetchMe's verification promise through fetchMyIssues into
 * apiFetch's optional `verified` argument. The transport waits for that promise
 * before releasing the response, without knowing the me adapter or its shape.
 * Keep the maps and counters here: re-exports share these bindings, and a second
 * copy would split joining, withdrawal order and response deadlines by surface.
 */
import { markSensitiveResponse, ACCESS_DEADLINE_HEADER, ACCESS_VISIBILITY_HEADER, currentResponseCheck, requiresResponseDeadline, tagResponse, validResponseDeadline } from '../auth/response-deadline';
import { beginSignOut, endSignOut, notifySessionExpired } from '../auth/session-expiry';
import { forgetPayloads, currentPayloadGeneration, currentSensitiveGeneration } from '../cache/payload-cache';
import { withdrawsRead } from '../projects/projects-last-good';
import { forgetSavedCopies } from '../cache/payload-cache';
import { isRefusalReason, type RefusalReason } from '../refusal';

// Same-origin only: the SPA is served by Caddy alongside /api in prod, and by
// the vite proxy in dev. A cross-origin API base was a broken escape hatch —
// credentialed CORS was never enabled, so cookies (fetchMe/logout) couldn't
// ride — so it's gone (#112).
export const API = '';

/**
 * `?org=<org>` for a narrowed read, `''` for the union (#714).
 *
 * The org arrives as an ARGUMENT on every read that can be narrowed, from the
 * page that knows what the address said. It used to be read out of
 * `window.location` inside these fetchers, which made the whole feature
 * untestable: the suite runs on node with no window (`docs/traps.md`), so the
 * org was always null under test and nothing proved a narrowed page asked for a
 * narrowed URL. `api-scoped-reads.spec.ts` proves it now.
 *
 * An empty string is the union, not an org named "": `scopedOrg` answers null
 * for the union, but a caller holding `''` from anywhere else must not turn it
 * into `?org=`, which the service reads as "none asked" anyway.
 */
export function scopeQuery(org?: string): string {
  return org ? `?${new URLSearchParams({ org })}` : '';
}

/**
 * A failed API call that knows what the server answered (#577).
 *
 * Every surface fetcher used to reject with a bare `Error` naming the status in
 * prose, which nothing downstream could read. A surface that cannot tell a 503
 * from a 500 can only ever offer one response to both — which is how a write
 * that could never succeed kept inviting people to retry it. `status` is the
 * HTTP status the server answered with.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** #584 — the refusal reason from the body, when the server sent one. The
     *  status is a lossy projection of it: three reasons answer 403. Older
     *  deploys and non-refusal failures send none, and the status table answers
     *  for those. */
    readonly reason?: RefusalReason,
    /** `not-permitted-yet` only: where the person goes to make it permitted.
     *  Only ever a github.com origin — see `safeAuthorizeUrl`. Carried and
     *  vouched for here; no surface draws it as a link yet, and the reason's own
     *  sentence is what a person reads today. */
    readonly authorizeUrl?: string,
    /** #714: the SERVER's own message for this failure, when the body carried
     *  one. Not for a person to read — `message` above is the board's wording —
     *  but for telling one 404 from another. The org gate answers `unknown org
     *  gtm` and the read below it answers `the repo listing for gtm could not be
     *  read`, both naming the org that was asked for; a reverse proxy with no
     *  upstream, a rolling deploy and a misrouted `/api/*` name nothing. That is
     *  the difference `scope-copy.ts` needs to tell the org gate's verdict from
     *  an outage, and it is the only place it is recorded. */
    readonly serverMessage?: string,
    /** The machine code the server put beside its message, when it sent one.
     *  A status is not enough where one status answers for several verdicts:
     *  board-api's Projects read answers 503 for a Github outage and for an
     *  access check it will not release, and only the first may be answered
     *  with a saved copy (#1035). */
    readonly code?: string,
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The board withdrawing its OWN read, rather than the server refusing anything
 * (#1061).
 *
 * `apiFetch` raises this when the cache generation, the withdrawal order or
 * the access check behind a request moved while it was in flight. Every one of
 * them sits on top of a request that ANSWERED, and answered 200; what went
 * stale is the browser's own bookkeeping around it. So a withdrawal is not a
 * claim about the session, and the mount gate's "couldn't verify your session"
 * is the wrong sentence for one — drawing it there was the whole of the #1061
 * report.
 *
 * A type and not `status === 409`, because 409 is not this board's alone:
 * `issue-detail.controller.ts` answers one when a project title is taken and
 * `identity.controller.ts` when a write would leave no admin, and
 * `new-project.tsx` reads both. It still IS a 409 — the subclass keeps the
 * status, the reason and the message every existing handler already matches on
 * (`projects-last-good.ts`, `sync-operation.ts`), so this narrows what can be
 * told apart without moving anything that was already told apart.
 */
export class WithdrawnReadError extends ApiError {
  constructor(message: string) {
    super(409, message);
    this.name = 'WithdrawnReadError';
  }
}

/** Whether this rejection is a withdrawal — see `WithdrawnReadError`. */
export const withdrawnRead = (e: unknown): boolean => e instanceof WithdrawnReadError;

/**
 * Only github.com. Anything else — another origin, a lookalike host, a
 * `javascript:` URL, an unparseable string — is dropped rather than rendered.
 *
 * The link arrives in a response body, from a server, on a failure path, and a
 * link the board renders is a link the board vouches for. Exported because the
 * rule is worth testing on its own.
 */
export function safeAuthorizeUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin === 'https://github.com' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * A refusal body, read defensively (#584): `{ message, reason, authorizeUrl? }`
 * is what the service answers a refused write with. This runs on every failed
 * write, though, and a non-JSON body — an ingress page, an empty 503 — must not
 * turn a refusal into a parse error. Anything it cannot read leaves the caller
 * with the status alone, which is what the caller had before.
 */
export async function refusalOf(res: Response): Promise<{ reason?: RefusalReason; authorizeUrl?: string }> {
  try {
    const body = (await res.clone().json()) as { reason?: string; authorizeUrl?: string };
    return {
      reason: isRefusalReason(body?.reason) ? body.reason : undefined,
      authorizeUrl: safeAuthorizeUrl(body?.authorizeUrl) ?? undefined,
    };
  } catch {
    return {};
  }
}

/**
 * The server's own message for a failed response, or undefined (#714).
 *
 * Nest sends `{ statusCode, message, error }` for every thrown HttpException,
 * and the two refusals a narrowed read can meet name the org in that message —
 * `unknown org gtm` from the org gate, `the repo listing for gtm could not be
 * read` from under it. Read defensively for `refusalOf`'s reason: this runs on
 * a failure path, where an ingress page or an empty 503 is a body that is not
 * JSON at all, and a parse error there must not become the failure the caller
 * reports. `message` is a string[] on a validation failure, which names no org
 * and is dropped.
 */
export async function serverMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.clone().json()) as { message?: unknown };
    return typeof body?.message === 'string' ? body.message : undefined;
  } catch {
    return undefined;
  }
}

/** The server's machine code for a failed response, or undefined. Read as
 *  defensively as `serverMessage`, for the same reason. */
export async function serverCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.clone().json()) as { code?: unknown };
    return typeof body?.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The one place a 401 is recognised (#512). Every surface fetcher goes through it,
 * so a dead session is heard once instead of being re-thrown from 28 places with
 * nobody listening. Deliberately thin: it sends the cookie, forwards `init`
 * untouched (fetchPeople's AbortSignal rides here), and hands back the raw
 * Response — every other status mapping stays where it was written.
 *
 * `logout()` is the one caller that stays outside: signing out on purpose is not
 * the session being lost.
 */
/** The header `github-expiry.interceptor.ts` marks a permission-sensitive
 *  answer with. Spelled once here; the server owns which answers carry it. */
export const SENSITIVE_HEADER = 'X-Board-Sensitive';

/** Join concurrent reads only while their identity and access generation agree.
 *  Entries leave on either outcome; a later visit or retry always asks again. */
const pendingReads = new Map<string, Promise<unknown>>();
export function joinRead<T>(request: string, read: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([request, currentPayloadGeneration(), currentSensitiveGeneration(), currentResponseCheck()]);
  const pending = pendingReads.get(key);
  if (pending) return pending as Promise<T>;
  const result = read().finally(() => { pendingReads.delete(key); });
  pendingReads.set(key, result);
  return result;
}

const latestResponseDeadlines = new Map<string, number>();
let latestResponseGeneration = '';
let readSequence = 0;
const withdrawalOrder = new Map<string, number>();

/**
 * Asked for when a sensitive answer arrives under a visibility key this app has
 * not installed (#1395). `App` answers it by re-reading `/api/auth/me`, and
 * NOTHING is wiped: the reader keeps their own last answer, marked stale, until
 * a live read settles it.
 *
 * Not `board-github-changed`, which means the reader pressed something on the
 * Account page and does clear the sensitive copies.
 */
export const IDENTITY_RECHECK_EVENT = 'board-identity-recheck';

/**
 * Re-arm the latch below, so a later answer under the same key asks again.
 *
 * `App` calls this when the re-probe it asked for FAILS. Without it the latch
 * holds the key of a probe that never landed, and a tab whose identity really
 * did move would never ask a second time: it would go quiet until a reload,
 * which is the half of #1395 this recovery exists to end.
 */
export function resetIdentityRecheck(): void {
  recheckAskedFor = null;
}

/** The visibility key the last recheck was asked for, so twelve reads landing
 *  under one new key ask once. */
let recheckAskedFor: string | null = null;

/**
 * A sensitive answer came back authorized under access that is not the access
 * this app has installed. The answer itself is withheld by the caller — that
 * fence is what stops a response granted under wider access from being drawn
 * after access narrowed, and it does not move.
 *
 * WHAT MOVES IS THE RECOVERY (#1395). The tab used to simply go quiet: every
 * sensitive read threw for as long as the tab stayed open, the two-minute
 * refresh stopped bringing anything back, and only a reload fixed it. The
 * server has just told us access changed, so ask for a fresh identity — the
 * same request the account page's recheck button makes (`GithubAccountView`),
 * handled in `App` by re-probing `/api/auth/me`. The probe installs the new key
 * and the next refresh lands.
 *
 * Most of what used to reach this line was not an access change at all: the key
 * carried `row.version`, a fresh UUID on every eight-hour token refresh. The
 * service's `person.key` no longer does, so this is now the rare, real case.
 */
function askForFreshIdentity(key: string): void {
  if (recheckAskedFor === key || typeof window === 'undefined') return;
  recheckAskedFor = key;
  window.dispatchEvent(new Event(IDENTITY_RECHECK_EVENT));
}
const cachedResponseOrder = new Map<string, number>();

/** Default reads return last-good immediately; the query owns revalidation. */
export async function apiFetch(path: string, init?: RequestInit, verified?: Promise<unknown>): Promise<Response> {
  const readable = (!init?.method || init.method === 'GET') && !path.startsWith('/api/auth/') && init?.cache !== 'no-store';
  if (readable && hintPreviewActive()) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      waitForReadRestoration().catch(() => {}),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, 400); }),
    ]);
    clearTimeout(timeout);
  }
  const saved = readable ? readValue(readClient.getQueryData(readKey(path))) : null;
  if (saved !== null && !init?.signal?.aborted) {
    markReadStale(path);
    void readClient.fetchQuery({ queryKey: readKey(path) }).catch(() => {});
    const response = Response.json(saved, { headers: { 'X-Board-Saved': '1' } });
    // Preserve the lease attached to the value; JSON serialization loses it.
    response.json = async () => {
      const current = readValue(readClient.getQueryData(readKey(path)));
      if (current === null) throw new WithdrawnReadError('This saved read was withdrawn.');
      return current;
    };
    return response;
  }
  return networkFetch(path, init, verified);
}

/** Internal fresh transport. Pages must subscribe through useBoardRead. */
export const OVERVIEW_READ_TIMEOUT_MS = 15000;

export function retryAt(res: Response): number | undefined {
  const value = res.headers?.get?.('Retry-After');
  if (!value) return undefined;
  const seconds = Number(value);
  const deadline = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(value);
  return Number.isFinite(deadline) ? deadline : undefined;
}

export async function overviewNetworkFetch(path: string, init?: RequestInit, verified?: Promise<unknown>): Promise<Response> {
  if ((init?.method && init.method !== 'GET') || !/^\/api\/(?:issues\/(?:all|metrics)|projects)(?:\?|$)/.test(path)) return networkFetch(path, init, verified);
  const controller = new AbortController();
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let status: number | undefined;
  const timer = setTimeout(() => controller.abort(), OVERVIEW_READ_TIMEOUT_MS);
  const stopped = () => {
    if (controller.signal.aborted && !init?.signal?.aborted) {
      if (status === undefined || status < 300) return new TypeError('Overview read timed out.');
      return new ApiError(status, 'The response body did not finish.', undefined, undefined, undefined, 'response_incomplete');
    }
    return new WithdrawnReadError('This read was cancelled.');
  };
  const bounded = async <T,>(read: Promise<T>): Promise<T> => {
    let abort = () => {};
    try {
      return await Promise.race([read, new Promise<never>((_, reject) => {
        abort = () => reject(stopped());
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      })]);
    } catch (error) {
      if (signal.aborted) throw stopped();
      throw error;
    } finally { signal.removeEventListener('abort', abort); }
  };
  try {
    const response = await bounded(networkFetch(path, { ...init, signal }, verified, value => { status = value; }));
    if (!response.ok) { clearTimeout(timer); return response; }
    const json = response.json.bind(response);
    response.json = async () => {
      try { return await bounded(json()); }
      finally { clearTimeout(timer); }
    };
    return response;
  } catch (error) { clearTimeout(timer); throw error; }
}

export async function networkFetch(path: string, init?: RequestInit, verified?: Promise<unknown>, received?: (status: number) => void): Promise<Response> {
  if (hintPreviewActive() && path !== `${API}/api/auth/me`) {
    if (init?.method && init.method !== 'GET') throw new UnverifiedSessionError();
    await waitForHintProbe();
  }
  if (init?.signal?.aborted) throw new WithdrawnReadError('This read was cancelled.');
  if (!init?.method || init.method === 'GET') markReadStale(path);
  const generation = currentPayloadGeneration();
  // A refusal or identity change must fence older sensitive reads still in flight.
  const sensitive = currentSensitiveGeneration();
  const refusalEpoch = currentReadRefusalEpoch(path);
  const context = `${generation}:${sensitive}`;
  if (latestResponseGeneration !== context) {
    latestResponseDeadlines.clear(); withdrawalOrder.clear(); cachedResponseOrder.clear(); latestResponseGeneration = context;
  }
  const own = ++readSequence;
  // A mount may start its fresh queue read alongside the identity probe. Keep
  // the response private until that probe succeeds, then apply the same identity,
  // generation and response-deadline checks as any other read (#1098).
  const [res] = await Promise.all([fetch(path, { ...init, headers: hasStableTargets() ? targetHeaders(path, init?.headers) : init?.headers, credentials: 'include' }).then(response => { received?.(response.status); return response; }), verified]);
  const marked = res.headers?.get?.(SENSITIVE_HEADER) === '1';
  const assertCurrent = () => {
    if (init?.signal?.aborted) throw new WithdrawnReadError('This read was cancelled.');
    if (generation !== currentPayloadGeneration()) throw new WithdrawnReadError('Your GitHub access changed; reload this view.');
    if (marked && own < (withdrawalOrder.get(path) ?? 0)) throw new WithdrawnReadError('This view was refused by a later read.');
    if (marked && sensitive !== currentSensitiveGeneration()) throw new WithdrawnReadError('Your GitHub access changed; reload this view.');
    if (res.ok && marked && refusalEpoch !== currentReadRefusalEpoch(path)) throw new WithdrawnReadError('A later refusal withdrew this read.');
  };
  assertCurrent();
  if ((!init?.method || init.method === 'GET') && !res.ok && !path.startsWith('/api/auth/')) {
    const error = new ApiError(res.status, `read ${res.status}`, undefined, undefined, await serverMessage(res), await serverCode(res));
    assertCurrent();
    // ONLY "NOT YOU" OR "NOT THERE" (#1395). `withdrawsRead` is the whole list:
    // 401, 403, 404. Every other failure leaves this read's saved copy alone, so
    // the page keeps drawing it with the stale marker on while the read is in
    // error — which is what TanStack already does for a query that holds data
    // and fails, and what `hasStaleReads` already reports.
    //
    // Before this, the rule was the inverse and the copy went on an uncoded 503.
    // A cold My work read in production outlives its 60-second access window and
    // the expiry interceptor answers exactly that, so the queue vanished into
    // loading placeholders with no message and the NEXT open had nothing saved to
    // paint. That is the reported bug.
    if (withdrawsRead(error)) {
      withdrawalOrder.set(path, Math.max(own, withdrawalOrder.get(path) ?? 0));
      forgetRead(path);
      // An auxiliary read's outage says nothing about the saved Overview.
      // Sync progress carries no GitHub data; a deploy can remove its records.
      // Every refusal that reaches here is now an access refusal, so the family
      // test is the only one left to make: a withdrawal on one of these reads
      // takes the union copy that holds the same rows (#1042 round 3).
      if (!path.startsWith('/api/sync/')) forgetSavedCopies();
    }
  }
  if (typeof res.json === 'function') {
    const json = res.json.bind(res);
    res.json = async () => {
      const body = await json();
      assertCurrent();
      if (marked && !path.endsWith('/api/auth/me')) {
        const expires = res.headers.get(ACCESS_DEADLINE_HEADER);
        const key = res.headers.get(ACCESS_VISIBILITY_HEADER);
        if (expires !== null || key !== null || requiresResponseDeadline()) {
          const lease = { expiresAt: Number(expires), visibilityKey: key ?? '' };
          if (!validResponseDeadline(lease)) {
            // `lease` is narrowed to `never` by the type guard above, so the
            // header is read again rather than through it.
            askForFreshIdentity(key ?? '');
            throw new WithdrawnReadError('Your GitHub access changed; reload this view.');
          }
          if (lease.expiresAt < (latestResponseDeadlines.get(path) ?? 0)) {
            throw new WithdrawnReadError('A newer authorized response already replaced this view.');
          }
          latestResponseDeadlines.set(path, lease.expiresAt);
          tagResponse(body, lease);
        } else markSensitiveResponse(body);
      }
      if (res.ok && (!init?.method || init.method === 'GET') && !path.startsWith('/api/auth/') && own >= Math.max(cachedResponseOrder.get(path) ?? 0, withdrawalOrder.get(path) ?? 0)) {
        cachedResponseOrder.set(path, own);
        rememberRead(path, body, res.headers);
      }
      return body;
    };
  }
  if (res.status === 401) {
    notifySessionExpired();
    // Same message every caller has always matched on, now carrying the status
    // too — so an editor can say "your session ended" rather than "couldn't save".
    throw new ApiError(401, 'unauthenticated');
  }
  return res;
}

/**
 * What a sign-out did, as far as the browser can tell (#682).
 *
 * `refused` carries the server's own sentence — board-service has two of them
 * (#456, #679), they differ in what they ask the person to do, and a third must
 * reach the screen without this file being edited, so it is never restated here.
 * `unconfirmed` is every answer that is neither a 2xx nor that contract: the
 * cookie may well still be live, so nothing may redirect on it.
 */
export type LogoutOutcome =
  | { kind: 'clean' }
  | { kind: 'refused'; message: string }
  | { kind: 'unconfirmed' };

/**
 * How long a sign-out waits for an answer before reporting it unconfirmed.
 *
 * No browser times a `fetch` out by itself, and the handler makes four database
 * round-trips: a hung query answers nothing and holds the socket, which is the
 * same outage that produces the 503 this notice exists to carry. Without a
 * deadline `logout()` never settles at all — no dialog, and the expiry gate
 * below stays up for the life of the tab.
 *
 * Ten seconds, between two bounds. A healthy sign-out answers in 8-25ms against
 * the local service (fixture mode, no database), so ten seconds is hundreds of
 * times the working cost and will not cut off four slow round-trips under load.
 * And it is a button somebody is standing in front of: `fetchPeople` can
 * spend 15s because a page is loading, this one cannot.
 */
export const LOGOUT_TIMEOUT_MS = 10_000;

/**
 * Sign out: POST (not a GET navigation) so a cross-site page can't force-logout
 * the user, and the server revokes the session server-side (#112).
 *
 * Never rejects. The handler clears the cookie before anything that can fail, so
 * a request that ARRIVES has signed this browser out whatever it answers — but a
 * request that never arrived has not, which is why there are three outcomes and
 * not two.
 */
export async function logout(): Promise<LogoutOutcome> {
  clearSessionHint();
  // Before the request: the cookie dies with it, and every 401 that follows is
  // this sign-out's own doing rather than the session being lost (#512).
  beginSignOut();
  // And the copy on disk goes with the cookie (#824). Before the request rather
  // than after it, and on all three outcomes rather than only the clean one: a
  // sign-out that could not be confirmed is exactly the case where the board
  // must not be holding this person's queue for whoever opens the tab next. The
  // cost of being wrong is one skeleton on a page that is still signed in.
  forgetPayloads();
  const outcome = await attemptLogout();
  // …except when the sign-out did not leave. The person stays on the board on a
  // cookie that may still be live, so the next 401 is an ordinary one again.
  if (outcome.kind === 'unconfirmed') endSignOut();
  return outcome;
}

/**
 * The request, under a deadline. Split out so the gate above has one place to
 * come down, and raced rather than only aborted: the signal frees the socket
 * when the platform honours it, the race is what makes this promise settle
 * whatever the platform does.
 */
async function attemptLogout(): Promise<LogoutOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<LogoutOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unconfirmed' }), LOGOUT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([postLogout(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function postLogout(): Promise<LogoutOutcome> {
  try {
    const res = await fetch(`${API}/api/auth/github/logout`, {
      method: 'POST',
      credentials: 'include',
      signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
    });
    if (res.ok) return { kind: 'clean' };
    const body = (await res.json()) as unknown;
    if (body !== null && typeof body === 'object') {
      const { ok, error } = body as { ok?: unknown; error?: unknown };
      // Trimmed: a blank sentence would draw a titleless dialog nobody can read.
      if (ok === false && typeof error === 'string' && error.trim() !== '') {
        return { kind: 'refused', message: error };
      }
    }
    return { kind: 'unconfirmed' };
  } catch {
    return { kind: 'unconfirmed' };
  }
}

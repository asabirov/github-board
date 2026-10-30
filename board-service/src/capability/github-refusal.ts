import { HttpException } from '@nestjs/common';
import type { Capability } from './capability';

/**
 * The one interpreter of a Github status in this service (#584).
 *
 * Github spends the same status on opposite meanings — 403 is "you may not",
 * "not so fast" and "authorize this org" all at once, and a missing permission
 * on a write reads as 404, which is how #577 hid. Reading that in a catch block
 * per call site produced five dialects. This file is the only place it is read,
 * and the rung order below is the whole of the interpretation.
 */

export type RefusalReason =
  | 'not-permitted'
  | 'not-permitted-yet'
  | 'wrong-value'
  | 'try-again'
  | 'not-found'
  | 'unauthenticated';

/**
 * How widely this refusal may be believed — the design's central rule.
 *  - `credential`: true of every target. Only a 401, a 403 naming the permission
 *    it wanted in `x-accepted-github-permissions`, and a GraphQL
 *    `INSUFFICIENT_SCOPES` reach this.
 *  - `target`: true of the one thing that was addressed and nothing else.
 *  - `none`: says nothing about permission at all — a throttle, a bad value, a
 *    404 the board has not earned the right to reinterpret.
 */
export type RefusalScope = 'credential' | 'target' | 'none';

export interface Refusal {
  reason: RefusalReason;
  /** One sentence, for a person, naming what the board could not do. */
  message: string;
  /** Github's status when there was one; undefined for a dropped socket and for
   *  a GraphQL error, which arrives HTTP 200. */
  status?: number;
  /** `not-permitted-yet` only: where the person goes to make it permitted. */
  authorizeUrl?: string;
  /** Set only when `x-accepted-github-permissions` (or a GraphQL
   *  `INSUFFICIENT_SCOPES`) named what the endpoint required. Operator-facing:
   *  it is the credential's shape and never leaves the log. */
  missingPermission?: string;
  /** True only for `try-again`. Derived, never passed in. */
  retryable: boolean;
  /** Derived, never passed in. */
  scope: RefusalScope;
}

/** What the classifier is told. NOTHING here is a claim a call site makes about
 *  itself — an earlier design asked each call site to assert that it had read
 *  its target, and two of the three that asserted it were wrong about their own
 *  code. A re-read replaced it (`learn-refusal.ts`). */
export interface RefusalContext {
  capability: Capability;
  /** What the board was addressing, and the key a target-scoped refusal is
   *  remembered under. **Always `owner/repo`**, including for an issue write:
   *  Github makes no per-issue permission distinction, so a finer key would be
   *  remembered and never read. The issue number belongs in the log line, not
   *  in the key. */
  target?: string;
}

/** The body a refusal answers with. `reason` is what the frontend keys on;
 *  `message` is what a person reads; `missingPermission` is NOT here. */
export interface RefusalBody {
  message: string;
  reason: RefusalReason;
  authorizeUrl?: string;
}

interface Octokitish {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string>; data?: { message?: string } };
  headers?: Record<string, string>;
  errors?: { type?: string; message?: string }[];
}

/**
 * `x-github-sso: required; url=https://…` — the only header that names where a
 * person goes to make a refusal stop being one.
 *
 * Both halves of the read are deliberate. The parameter name is ANCHORED to a
 * delimiter, so a header that grows a `fallback_url=` later does not match at
 * the substring and hand back the wrong link; and the value stops at the next
 * delimiter rather than swallowing every `;`-separated parameter after it.
 * Then the origin is checked: this arrives in a header from a server, task 7
 * renders it as a link, and a link the board renders is a link the board
 * vouches for. Anything that is not `https://github.com/…` is dropped, which
 * costs the person the shortcut and costs them nothing else — the refusal is
 * still stated, one rung down.
 */
function ssoUrl(headers: Record<string, string>): string | undefined {
  const raw = headers['x-github-sso'];
  if (!raw) return undefined;
  const url = /(?:^|[;,\s])url=([^;,\s]+)/.exec(raw)?.[1];
  if (!url || !url.startsWith('https://github.com/')) return undefined;
  return url;
}

/** Github answers a SECONDARY rate limit with 403, no `retry-after`, and a
 *  non-zero remaining quota — the body is the only signal. */
const SECONDARY_LIMIT = /secondary rate limit|abuse detection/i;

/**
 * Github's own words for "your credential did not bring the permission".
 *
 * `x-accepted-github-permissions` alone is NOT enough to widen a refusal to the
 * whole credential: it is an endpoint describing ITSELF, and it rides along on
 * 403s that are purely about one target — an archived repository, an IP allow
 * list, an organization ruleset. Believing one of those capability-wide is the
 * org-wide outage the scope rule exists to prevent. So the widening rung wants
 * the header AND this message, and every other 403 carrying the header stays
 * target-scoped.
 */
const NOT_ACCESSIBLE = /resource not accessible by (integration|personal access token)/i;

/**
 * GraphQL error types in the order they are believed, most serious first.
 *
 * PRECEDENCE, not first-wins. Github returns an ARRAY, and a partial failure can
 * carry more than one type — the issue query selects `projectItems` and a
 * cross-repo fragment, so a mixed array is reachable rather than theoretical.
 * Reading whichever came first meant `[FORBIDDEN, NOT_FOUND]` and
 * `[NOT_FOUND, INSUFFICIENT_SCOPES]` classified oppositely to
 * `[NOT_FOUND, FORBIDDEN]` and `[INSUFFICIENT_SCOPES, NOT_FOUND]` on the same
 * facts. Both directions were wrong in a way that mattered: the first pair made
 * `fetch()` rethrow where it used to answer null — a 500 on the issue page — and
 * the second let a missing scope read as a plain absence, which is #577's shape
 * arriving by the GraphQL door.
 */
const GQL_PRECEDENCE = ['INSUFFICIENT_SCOPES', 'FORBIDDEN', 'RATE_LIMITED', 'NOT_FOUND'] as const;

export function classifyGithubError(err: unknown, ctx: RefusalContext): Refusal {
  const e = (err ?? {}) as Octokitish;
  // Octokit hangs headers off `response`; older shapes put them on the error.
  // Read both rather than depend on which one this version is.
  const headers = e.response?.headers ?? e.headers ?? {};
  const status = e.status;
  const detail = e.response?.data?.message ?? e.message ?? '';
  const where = ctx.target ? ` on ${ctx.target}` : '';
  const throttled = `GitHub is rate limiting this write${where}. Try again in a moment.`;

  // 1. THROTTLE FIRST. 403 means both "you may not" and "not so fast", and only
  //    the response's own headers — or, for a secondary limit, its body — tell
  //    them apart. Filing a throttle as a permanent refusal withdraws the Retry
  //    that would have worked, for the whole TTL.
  if (status === 403 || status === 429) {
    if (
      headers['retry-after'] != null ||
      headers['x-ratelimit-remaining'] === '0' ||
      SECONDARY_LIMIT.test(detail)
    ) {
      return mk('try-again', throttled, 'none', status);
    }
  }
  if (status === 429) return mk('try-again', throttled, 'none', status);

  if (status === 403) {
    // 2. AUTHORIZATION THAT EXISTS BUT IS NOT ACTIVE YET, and it is read FIRST.
    //    A 403 can carry the SSO header and the permissions header at once, and
    //    reading the permissions one first threw away the link a person could
    //    click AND widened the refusal to the whole credential — the worst
    //    available pair. Believed about the target only: SSO is
    //    per-organization and this board pins to one org, so capability-wide
    //    would also be true, but under-refusing is the safe direction and
    //    target-scoped is the narrower claim.
    const url = ssoUrl(headers);
    if (url) {
      const r = mk(
        'not-permitted-yet',
        `This write needs SSO authorization for the org${where}.`,
        'target',
        status,
      );
      r.authorizeUrl = url;
      return r;
    }

    // 3. THE ONE 403 THAT IS ABOUT THE CREDENTIAL, and it takes TWO signals.
    //    `x-accepted-github-permissions` says what the ENDPOINT wanted, and an
    //    endpoint describing itself rides along on 403s that are purely about
    //    one target. Only when Github ALSO says the resource is not accessible
    //    by this credential do the two together mean "you did not bring it, and
    //    no target is at fault". This is one of exactly two capability-wide
    //    signals in the whole design, and it is the one that can take a whole
    //    capability dark, so it is the one worth being slow about.
    const wanted = headers['x-accepted-github-permissions'];
    const scope: RefusalScope = wanted && NOT_ACCESSIBLE.test(detail) ? 'credential' : 'target';
    const r = mk(
      'not-permitted',
      `GitHub refused this write${where}: the board is not permitted to do it.`,
      scope,
      status,
    );
    // Recorded whenever the header named something, whatever the scope: it is
    // the operator's one line of "what did the endpoint actually want", and it
    // is as worth logging on the narrow answer as on the wide one.
    if (wanted) r.missingPermission = wanted;
    return r;
  }

  if (status === 401) {
    return mk('unauthenticated', 'GitHub rejected the board’s credential.', 'credential', status);
  }
  if (status === 422) {
    return mk('wrong-value', `GitHub would not accept that value${where}.`, 'none', status);
  }

  // 4. GRAPHQL. The three Projects v2 mutations answer HTTP 200 with an `errors`
  //    array and no status that means anything, so without this rung a FORBIDDEN
  //    falls all the way to `try-again` and renders "Couldn't reach Github"
  //    beside a Retry that will fail forever. Whatever status did arrive is
  //    carried on the refusal anyway: it decides nothing here, and a log line
  //    reading "no status" for an error that had one is a lie to an operator.
  //    `e.errors` is whatever came off the wire, so it is checked rather than
  //    trusted: a string, an object or a `[null]` would each throw a TypeError
  //    INSIDE A CATCH BLOCK, replacing the real Github error with "map is not a
  //    function" and answering 500. This file is the universal interpreter; it
  //    is the last place that may assume a shape.
  const types = (Array.isArray(e.errors) ? e.errors : [])
    .map((x) => (x && typeof x.type === 'string' ? x.type : undefined))
    .filter((t): t is string => t != null);
  const gqlType = GQL_PRECEDENCE.find((t) => types.includes(t)) ?? types[0];
  if (gqlType) {
    switch (gqlType) {
      case 'INSUFFICIENT_SCOPES':
        return mk(
          'not-permitted',
          `GitHub refused this write${where}: the board’s credential lacks the scope.`,
          'credential',
          status,
        );
      case 'FORBIDDEN':
        return mk(
          'not-permitted',
          `GitHub refused this write${where}: the board is not permitted to do it.`,
          'target',
          status,
        );
      case 'NOT_FOUND':
        return mk('not-found', `${ctx.target ?? 'That target'} was not found.`, 'none', status);
      case 'RATE_LIMITED':
        return mk('try-again', throttled, 'none', status);
      default:
        // EXPLICIT, not a fall-through. A GraphQL error type nobody has seen
        // must never become a permanent refusal by default.
        return mk('try-again', `GitHub could not complete this write${where}.`, 'none', status);
    }
  }

  // 5. THE 404 (#577). A missing permission reads as 404 on a write, and the
  //    board cannot tell that from a genuinely absent target FROM THIS ERROR.
  //    So it does not try: `not-found`, scope `none`, believed nowhere.
  //    `learnRefusal` is what earns the distinction, by re-reading the target.
  if (status === 404) {
    return mk('not-found', `${ctx.target ?? 'That target'} was not found.`, 'none', status);
  }

  // 6. Everything left — a 5xx, a dropped socket, no status at all — is the one
  //    failure a retry is for.
  return mk('try-again', `GitHub could not be reached${where}.`, 'none', status);
}

function mk(
  reason: RefusalReason,
  message: string,
  scope: RefusalScope,
  status?: number,
): Refusal {
  return { reason, message, status, retryable: reason === 'try-again', scope };
}

const STATUS_FOR: Record<RefusalReason, number> = {
  'not-permitted': 403,
  'not-permitted-yet': 403,
  'wrong-value': 400,
  'not-found': 404,
  // 403, NOT 401. A 401 reaching the browser signs the person out of the board
  // for a credential that was never theirs (board-frontend/src/api.ts:40-44).
  unauthenticated: 403,
  'try-again': 502,
};

/** The Nest exception a refusal answers with. The one place a reason becomes a
 *  status, and the one place `unauthenticated` becomes 403 rather than 401. */
export function refusalToHttp(r: Refusal): HttpException {
  const body: RefusalBody = { message: r.message, reason: r.reason };
  if (r.authorizeUrl) body.authorizeUrl = r.authorizeUrl;
  // `missingPermission` is deliberately absent: it names the credential's shape.
  return new HttpException(body, STATUS_FOR[r.reason]);
}

/** An error's message, for a log line. Six files already declare this locally;
 *  the new call sites import it from here rather than making it eight.
 *  Rewriting the six is a different task and is not attempted in this one. */
export const asMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

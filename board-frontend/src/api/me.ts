import { installTargets } from '../auth/github-target';
import { savedShell } from '../auth/saved-shell';
import { clearSessionHint, finishHintPreview, hintPreviewActive, savedSessionPending } from '../auth/session-hint';
import { API, ApiError, networkFetch as apiFetch, joinRead } from './core';
import type { MeResponse, OrgReadState } from './types';
import { claimFor, forgetPayloads } from '../cache/payload-cache';
import { setResponseIdentity } from '../auth/response-deadline';

/** Narrow one wire entry, or null if it is not one. Defensive for the same
 *  reason `capabilities` is: this is the mount auth probe, and a malformed
 *  entry must cost a claim about that org, never the whole session. */
function narrowOrgReadState(raw: unknown): OrgReadState | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as { org?: unknown; state?: unknown; reason?: unknown };
  if (typeof e.org !== 'string' || !e.org) return null;
  if (e.state !== 'read' && e.state !== 'unreadable') return null;
  return { org: e.org, state: e.state, reason: typeof e.reason === 'string' ? e.reason : null };
}

/**
 * How long the mount probe waits for an answer before giving up (#824).
 *
 * No browser times a `fetch` out on its own, and until this existed the board's
 * "one round trip" was not a bound on anything: a hung upstream left the
 * previous person's board on an unverified screen for as long as the socket
 * stayed open, and the 401 that eventually arrives wipes the disk without
 * taking the page off the screen (`App` ignores an expiry while the session is
 * `remembered`). The probe rejecting is what closes that window, so the probe
 * has to reject.
 *
 * Fifteen seconds, the number `fetchPeople` already spends on the same
 * argument: a page is loading and nobody is standing on a button, so this can
 * be far longer than the sign-out's ten and still be a bound.
 */
export const ME_TIMEOUT_MS = 15_000;

/**
 * The probe itself, and the only place the cache survives a `/api/auth/me`.
 *
 * The wipe happens where the server SAID no, and nowhere else. A 403 is a
 * team-group membership lost since the last visit, and any other 4xx is the
 * board answering about this request rather than failing to answer, so both
 * take the copy with them. The 401 never reaches this function at all:
 * `apiFetch` throws on it, and `session-expiry.ts` wipes there, on the first
 * 401 and once. This used to say the 401 was "wiped again here rather than
 * being special-cased", which described a line that cannot execute.
 *
 * A 5xx is on the other side of the line, and it moved there after #824
 * shipped. Before #1278, `sync/sync-status.tsx` fired this probe on every focus
 * and two-minute tick, and `CONTRIBUTING.md` says every merge to `main` is a
 * production deploy with no staging — so a 502 or a 503 from Caddy with no
 * healthy upstream is a routine window, and wiping in it emptied every open tab
 * and put the next visit back on the network. `ApiError.serverMessage`'s
 * docblock in `api/core.ts` records the same reading from the other side: a reverse proxy
 * with no upstream and a rolling deploy "name nothing".
 *
 * A request that never got an answer does NOT wipe either, and that
 * distinction is the whole of this docblock. An abort, a timeout, a dropped
 * connection and an offline tab all mean the board learned nothing about who is
 * reading it, and throwing the copy away over learning nothing is not a smaller
 * risk than keeping it, because the session it was refusing to trust may be
 * perfectly alive. A 5xx is the same absence of a claim wearing a number.
 *
 * It is written this way because the broad version shipped for an afternoon and
 * silently removed the whole feature. `sync/sync-status.tsx` used to fire this same
 * probe on every focus and every two-minute tick, and a reload aborts whatever
 * is in flight; with the wipe in a `catch`, that abort emptied the cache on the
 * way out of every page, so the next visit had nothing to paint and waited for
 * the network exactly as it had before #824. It was measured, not reasoned
 * about: `scripts/measure-visit-wait.mjs` put the return visit back at 1272ms
 * against 82ms, and the browser showed `board_payload_owner` null 120ms into
 * a reload that had written it seconds earlier.
 *
 * This is a separate function because the two refusals sit above `claimFor` in
 * `fetchMe` and reached no wipe at all when they were written inline, which
 * left a whole cache on the disk under an owner stamp inside the freshness
 * ceiling and repainted that person's board on every later visit.
 */
async function probeMe() {
  const res = await apiFetch(`${API}/api/auth/me`, { signal: AbortSignal.timeout(ME_TIMEOUT_MS) });
  if (res.status === 403) { forgetPayloads(); throw new Error('forbidden'); }
  if (!res.ok) {
    // Below 500 the board answered about this request; at 500 and above it did
    // not answer at all. See the docblock: only the first is a claim about who
    // is holding this browser.
    if (res.status < 500) forgetPayloads();
    throw new Error(`me ${res.status}`);
  }
  try {
    return await res.json();
  } catch (e) {
    // Not everything thrown from here is a body. `apiFetch` wraps `res.json`
    // to assert the answer is still current, and the ApiError it raises there
    // is the BOARD withdrawing its own read, not the server saying something
    // unreadable. Wiping on it deleted the owner stamp `claimFor` had written
    // moments earlier, which put the NEXT `/api/auth/me` back on the
    // first-load path and withdrew a second round of reads behind it — eight
    // of the mounted board's own 200s, on a load that had nothing wrong with
    // it (#1061).
    if (e instanceof ApiError) throw e;
    // A 200 whose body is not the shape this board speaks is the server saying
    // something, and what it said cannot be read. That is a refusal too.
    forgetPayloads();
    throw e;
  }
}

/** The signed-in user (#107) — powers the sidebar account block. isAdmin (#11)
 *  gates the Access link; absent on an old deploy → treated as false.
 *  Also the app's mount auth probe (#197, since the OKR tree was retired), so it
 *  throws the same 'unauthenticated'/'forbidden' sentinels App's gate maps on. */
export function fetchMe(): Promise<MeResponse> {
  return joinRead('me', () => readMe().catch(error => {
    if (savedSessionPending() && !hintPreviewActive()) forgetPayloads();
    clearSessionHint();
    installTargets(undefined);
    throw error;
  }));
}

async function readMe(): Promise<MeResponse> {
  const body = await probeMe();
  installTargets(body.github);
  // Whose the cached payloads are (#824). This is where the app learns its own
  // name, and it is the earliest it can: the session cookie is the server's, so
  // nothing before this answer can tell one reader from another. A different
  // person here takes the last one's copy with them, and every way OUT of
  // `probeMe` that is not this line has already wiped it.
  //
  // THE ADDRESS ALONE, since #1395. The visibility key used to be concatenated
  // onto it, which made `claimFor` read a re-checked access as a different
  // reader — so the eight-hourly token refresh behind that key emptied the
  // cache and the board opened cold. It goes in as its own argument now, and
  // `claimFor` answers the two questions separately.
  claimFor(typeof body.email === 'string' ? body.email : '',
    typeof body.sessionHintId === 'string' ? body.sessionHintId : undefined,
    body.github?.visibilityKey || undefined, savedShell(body));
  setResponseIdentity(body.github?.visibilityKey ?? null, body.github?.responseDeadlines === true, body.github?.expiresAt ?? 0);
  finishHintPreview(true);
  // canWrite (#384) gates in-board issue edits, writesEnabled (#626) gates every
  // other write surface; either absent on an old deploy → false, which withholds
  // a control rather than drawing one over a write that would 403.
  // githubLogin (#520) is absent on an old deploy too, and "unmapped" is the
  // honest reading of that — same answer the server gives for an address the
  // roster doesn't know.
  return {
    email: body.email,
    ...(typeof body.sessionHintId === 'string' && body.sessionHintId ? { sessionHintId: body.sessionHintId } : {}),
    ...(body.github ? { github: body.github } : {}),
    isAdmin: body.isAdmin === true,
    // #811 — `=== true`, like every flag here: absent on an old deploy means the
    // board is not claiming its roster is unread, which is the reading that
    // leaves those surfaces untouched.
    adminsUnread: body.adminsUnread === true,
    writesEnabled: body.writesEnabled === true,
    canWrite: body.canWrite === true,
    githubLogin: typeof body.githubLogin === 'string' && body.githubLogin ? body.githubLogin : null,
    // capabilities (#584) is absent on an old deploy for the same reason the two
    // above are, and an empty map is the honest reading: the board knows nothing
    // about what it may do, and knowing nothing refuses nothing.
    capabilities:
      body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {},
    // orgs (#650) is absent on an old deploy, and `[]` is the honest reading:
    // the board makes NO CLAIM about any org. Not "every org is fine" — see the
    // declaration. A malformed entry drops out of the list for the same reason,
    // and dropping it is what keeps a surface from naming an org it cannot name.
    orgs: Array.isArray(body.orgs)
      ? body.orgs.map(narrowOrgReadState).filter((o: OrgReadState | null): o is OrgReadState => o !== null)
      : [],
  };
}


/**
 * Where an owner the board does not serve went, or `null` (#1167).
 *
 * Asked only from the refusal screen, about the owner in the address, and only
 * when `/api/auth/me` did not list it. Board-service reaches Github for this —
 * up to five repository asks — so it is never on the path of a page that is
 * working.
 *
 * NULL IS THE ANSWER FOR EVERY FAILURE, and that is the point rather than
 * laziness: the caller's fallback is the refusal the board drew before this
 * route existed, so a 404 from an older deploy, a 500, a dropped socket and an
 * honest "the board cannot prove anything" all land on the same screen. There
 * is nothing better this could say about its own failure than the screen it is
 * standing in front of already says.
 *
 * It does NOT wipe the payload cache on a refusal the way `probeMe` does. This
 * is not the identity probe: what it learns is about an organisation, never
 * about who is holding the browser.
 */
export async function fetchOwnerRename(login: string): Promise<string | null> {
  const res = await apiFetch(`${API}/api/auth/owners/${encodeURIComponent(login)}`, {
    signal: AbortSignal.timeout(ME_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  const answer = (body as { renamedTo?: unknown } | null)?.renamedTo;
  return typeof answer === 'string' && answer !== '' ? answer : null;
}

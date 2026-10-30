import { clearReads, clearSensitiveReads, clearSavedReads, forgetRead, readClient } from './read-cache';
import { hintPreviewActive } from '../auth/session-hint';
import { savedShell, type SavedShell } from '../auth/saved-shell';
import { currentResponseIdentity, isSensitiveResponse, markSensitiveResponse, responseExpired, responseDeadline, currentSupersededIdentity, resetResponseRequirements, supersedeVisibility, tagResponse, drawableResponseDeadline, requiresResponseDeadline, type ResponseDeadline } from '../auth/response-deadline';
let payloadGeneration = 0;
export const currentPayloadGeneration = () => payloadGeneration;

/** Fence sensitive answers after an explicit identity change or refusal.
 *  The old access deadline no longer invalidates downloaded data (#1278). */
let sensitiveGeneration = 0;
export const currentSensitiveGeneration = () => sensitiveGeneration;

/**
 * The board's own copy of the last answer it was given, per person, on disk (#824).
 *
 * Two things were wrong before this existed. A refresh took the page away: the
 * 2-minute soft refresh, a manual "Sync now" and a failed background read each
 * put a surface back to its skeleton over data somebody was reading. And every
 * arrival paid a first visit's wait, because nothing the board had ever been
 * told survived the tab closing. This file is the second half of the answer —
 * pages seed from it through `use-cached-state.ts`, paint at once, and let the
 * live read correct them.
 *
 * It is `localStorage`, keyed to the signed-in person, because that is the only
 * store that survives both a new tab and tomorrow morning. That choice was made
 * with its cost in view, and the cost is paid by the rules below: nothing
 * survives a sign-out or an expired session, nothing is painted for a person
 * other than the one it was stored for, and nothing older than
 * `PAYLOAD_MAX_AGE_MS` is painted at all.
 */

/**
 * This deliberately goes around a header board-service sets, and a reader who
 * finds that header first will think this file is a mistake. It is not, and the
 * first draft of this passage argued that by quoting selectively, which is the
 * part the review of #824 was right about.
 *
 * Three of the reads STORED here answer with `Cache-Control: no-store`, and they
 * are the whole of what this passage has to justify: `/api/issues/mine`,
 * `/api/issues/all` and `/api/people`. Several other reads a board page draws
 * carry the header and are NOT stored — `/api/issues/:owner/:repo/:number` and
 * `/api/auth/me` among them. No count is given, because the one that was here
 * was wrong twice over: it said eight and it listed
 * `/api/repos/:owner/:name/page`, which sets no such header at all (the one
 * `no-store` in `repos.controller.ts` is on the `dri` write). A count nothing
 * derives goes stale the first time a route is added, and a reader checking
 * this paragraph checks the routes it names rather than the number.
 * Most of those docblocks give a reason about a cache the board
 * does not own: `issues-metrics.controller.ts` on `mine` says "a per-user
 * response has no business in any shared cache", `people.controller.ts` says "a
 * response that varies by caller has no business in any shared cache", and
 * `issue-buckets.controller.ts` says
 * "so the browser never caches on top of the service's short server-side TTL;
 * the `syncedAt` field carries the real freshness". Not all of them give one at
 * all: `issues-metrics.controller.ts:57` and `:68` set the header over
 * `/api/issues/all` and `/api/issues/search-index` and say nothing about why.
 *
 * Those stated reasons are arguments against a proxy holding one person's
 * answer and handing it to another, and against an opaque HTTP cache stacking
 * its own TTL on top of a TTL the service already tunes. For the routes that
 * remain on the list below, neither is an argument about data at rest: what
 * this file keeps is first-party, per-person, owned by the app, wiped by the
 * app, and never served to anybody, and it is replaced by the live read within
 * the same second.
 *
 * One of those docblocks says something else as well, and it IS about who may
 * hold the content. `people.controller.ts:47` empties `emails` for a static
 * agent token because "the alias table holds people's personal, non-corporate
 * addresses". That sentence is why the roster is written with `emails`
 * emptied, in
 * `team/TeamView.tsx` where the write happens. A disk this app cannot promise
 * to be alone with is closer to that token than to a signed-in reader.
 *
 * `/api/auth/me` is on the `no-store` list and is NOT stored here, along with
 * everything under `/api/admin` and `/api/account`, the audit log, tokens,
 * connected clients, `edit-options` and the repos' security health. What may be
 * stored is `PayloadKey` below, and the compiler enforces it: `writePayload`
 * and `useCachedState` take that type and nothing else, so an off-list key
 * cannot be built rather than merely being against the rules.
 */

/** Namespace for every stored payload. A prefix, not a flat key: there is one
 *  entry per read. Chosen so `forgetPayloads` cannot reach `board_theme`,
 *  `board_timezone`, `board_org`, the `board_viewer:` arrangements or the
 *  command palette's `board.search.recent.v1` — none of which is this file's to
 *  wipe. */
export const PAYLOAD_CACHE_PREFIX = 'board_payload:';

/** Who every stored payload belongs to, and when the board last saw them
 *  signed in. Outside the prefix above so a walk of the entries never meets it,
 *  and removed by `forgetPayloads` in the same breath as the entries, since an
 *  owner with nothing under it says nothing. */
export const PAYLOAD_OWNER_KEY = 'board_payload_owner';

/**
 * How old a stored payload may be and still be painted.
 *
 * Twenty-four hours, because the thing this buys is the first paint of the
 * working day: the board is opened in the morning against what it was showing
 * the previous afternoon, and the live read corrects it in the same second.
 * Past a day the numbers have stopped being a plausible opening frame and start
 * being a claim about a week that has moved on, and the skeleton is the more
 * honest answer. The live read is issued either way, so this only decides what
 * is on screen while it is in flight.
 */
export const PAYLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead of now a stamp may be and still be read.
 *
 * The ceiling above had no floor: all three readings asked `Date.now() - t >
 * PAYLOAD_MAX_AGE_MS`, which refuses only the past. A `t` in the FUTURE makes
 * that negative and passes forever, so a laptop with a dead CMOS battery, a VM
 * resumed from a snapshot, or a clock set forward and then corrected leaves
 * entries stamped next month and the device paints the last person's board on
 * every visit indefinitely. The whole privacy argument at the top of this file
 * rests on that ceiling holding.
 *
 * Five seconds, which is drift and not a clock that is wrong: a stamp is
 * written and read by the same machine, so the only way one lands ahead of now
 * is a correction between the two. Getting this wrong in the tight direction
 * costs one round trip's worth of skeleton. Getting it wrong in the loose
 * direction costs the ceiling entirely, which is what was happening.
 */
export const PAYLOAD_CLOCK_TOLERANCE_MS = 5_000;

/**
 * What shape of entry this build can read.
 *
 * Bump it when a stored payload's SHAPE changes — a field renamed, a list that
 * becomes an object, anything a page written against the new answer would meet
 * the old answer with. Every entry stamped with another number is refused and
 * deleted, so the old shape costs a returning reader one round trip instead of
 * a render throw.
 *
 * It is here because the risk is not tampering. This repo deploys the frontend
 * on every merge to `main` (`CONTRIBUTING.md`), and `readPayload` handed
 * `entry.v` to a render on faith, so the next change to any cached field did
 * that to EVERY returning reader at once. An entry carrying no stamp at all is
 * refused for the same reason: it was written by a build that predates this
 * one.
 *
 * This is the half that is a rule rather than a check, and it says so. The
 * check beside it is `accept` on `readPayload`, which the caller states and the
 * compiler carries.
 */
export const PAYLOAD_SCHEMA_VERSION = 1;

/** The keys this file may hold, one per read, and nothing else may be stored.
 *  Kept here rather than spelled at the call sites so the allowlist is one
 *  place to read and one place to change. */
export const MINE_KEY = 'issues/mine';
export const ORG_QUEUE_KEY = 'issues/all';
export const METRICS_KEY = 'issues/metrics';
export const FILTER_OPTIONS_KEY = 'issues/filter-options';
export const PEOPLE_KEY = 'people';
export const DELIVERY_KEY = 'delivery';

/** A key that may carry an org, and the same key for the union. */
type OrgScoped<Base extends string> = Base | `${Base}:${string}`;

/**
 * Every key this file may be handed, as a type.
 *
 * The allowlist above used to be an enumeration a reader was asked to respect:
 * `writePayload(key: string, …)` took any string at all, so
 * `writePayload('admin/audit', log)` compiled, passed every test, and put the
 * audit log on the disk. The justification in the docblock at the top of this
 * file rests entirely on WHICH reads are stored, and nothing was holding that
 * list. This type is what holds it now, and the failure is a build error at the
 * call site rather than a rule somebody has to have read.
 *
 * The org-scoped forms are here rather than being one `${string}` catch-all
 * because a catch-all would readmit every off-list key through the back door.
 */
export type PayloadKey =
  | OrgScoped<typeof MINE_KEY>
  | OrgScoped<typeof ORG_QUEUE_KEY>
  | OrgScoped<typeof METRICS_KEY>
  | typeof FILTER_OPTIONS_KEY
  | typeof PEOPLE_KEY
  | typeof DELIVERY_KEY
  | OrgScoped<'projects'>
  | OrgScoped<`projects/${number}`>
  | OrgScoped<'repos'>;

/** A read that carries `?org=` is a different answer per org, so the org is in
 *  the key. Without it, `/acme` would open on `/globex`'s boards for as
 *  long as the live read took, which is the one thing #714 spent itself on. The
 *  union writes the bare key, matching `scopeQuery`'s reading of an absent org. */
export function orgScopedKey<Base extends string>(base: Base, org?: string | null): OrgScoped<Base> {
  return org ? `${base}:${org}` : base;
}

/** `/api/projects`, the rollup, per org. */
export const projectsKey = (org?: string | null): OrgScoped<'projects'> => orgScopedKey('projects', org);

/** `/api/projects/:number`, one board. The number alone is not per-board across
 *  a union of orgs, the same reason `projectViewerKeys` gives for the stored
 *  arrangement, so the org rides in the key here too. */
export const projectKey = (number: number, org?: string | null): OrgScoped<`projects/${number}`> =>
  orgScopedKey(`projects/${number}` as const, org);

/** `/api/repos`, the map's rows, per org. */
export const reposKey = (org?: string | null): OrgScoped<'repos'> => orgScopedKey('repos', org);

/**
 * The bits of `Storage` this file uses. Injectable so the rules below can be
 * driven from the suite, which runs `environment: 'node'` and has no DOM and no
 * `localStorage` at all. `window.localStorage` satisfies it
 * structurally, so nothing is adapted in the browser.
 */
export interface PayloadStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One stored payload. `o` is the email it was stored for, `t` the moment it
 *  was written, `s` the shape this build speaks, `v` the answer itself. Short
 *  names because this is written on every read that lands and quota is the
 *  failure mode being defended against. */
interface Entry {
  access?: ResponseDeadline;
  sensitive?: boolean;
  o: string;
  t: number;
  s: number;
  v: unknown;
}

/** Whether a stamp is inside the freshness window, in BOTH directions — the one
 *  reading, so the owner record, the paintable count and the read cannot drift
 *  apart. It was three copies of `Date.now() - t > PAYLOAD_MAX_AGE_MS` and all
 *  three were missing the same floor. */
function fresh(t: number, now: number = Date.now()): boolean {
  const age = now - t;
  return age <= PAYLOAD_MAX_AGE_MS && age >= -PAYLOAD_CLOCK_TOLERANCE_MS;
}

/** What a payload has to be before a page is handed it: an object or an array,
 *  which is what every read on the allowlist answers with. It is the default
 *  `accept` below, and it is what stops a truthy non-object defeating a
 *  `readPayload(...) ?? SOME_EMPTY` at the call site. */
function isObjectPayload(v: unknown): boolean {
  return typeof v === 'object' && v !== null;
}

let injected: PayloadStore | null | undefined;

/** Whether this process has carried the old `lessly_payload:*` keys forward for
 *  the current store. Reset beside `injected` so a fresh fake store in the
 *  suite gets its own migration. */
let payloadKeysMigrated = false;

/** The body length that last failed to fit for a key, with the store already
 *  emptied beneath it. Per process, never stored: it is a fact about this
 *  browser's quota right now, and a device that reloads deserves the retry. */
const didNotFit = new Map<string, number>();

/**
 * Point this file at another store, or at nothing. For the suite: pass a fake,
 * and pass `undefined` to hand it back to the browser. Nothing in the app calls
 * it, and a device whose storage is absent or denied reads as "nothing stored"
 * without anybody having to call it either.
 */
export function setPayloadStore(store: PayloadStore | null | undefined): void {
  injected = store;
  payloadKeysMigrated = false;
  // What did not fit is a fact about one store's remaining budget. A different
  // one knows nothing of it, and neither should this.
  didNotFit.clear();
}

/** The board's old payload-cache keys, carried forward once (#1450). */
const LEGACY_PAYLOAD_CACHE_PREFIX = 'lessly_payload:';
const LEGACY_PAYLOAD_OWNER_KEY = 'lessly_payload_owner';

/** Carry every stored payload and the owner stamp over from `lessly_payload:*`
 *  once: read each old key, write the new one, remove the old one. A new key
 *  that already holds a value wins, so nothing written after the rename is
 *  overwritten. Runs inside `store()` so it never meets a null store. */
function migratePayloadKeys(s: PayloadStore): void {
  if (payloadKeysMigrated) return;
  payloadKeysMigrated = true;
  try {
    for (let i = s.length - 1; i >= 0; i -= 1) {
      const key = s.key(i);
      if (key === null) continue;
      if (key === LEGACY_PAYLOAD_OWNER_KEY) {
        if (s.getItem(PAYLOAD_OWNER_KEY) === null) {
          const v = s.getItem(key);
          if (v !== null) s.setItem(PAYLOAD_OWNER_KEY, v);
        }
        s.removeItem(key);
      } else if (key.startsWith(LEGACY_PAYLOAD_CACHE_PREFIX)) {
        const next = PAYLOAD_CACHE_PREFIX + key.slice(LEGACY_PAYLOAD_CACHE_PREFIX.length);
        const v = s.getItem(key);
        if (v !== null && s.getItem(next) === null) s.setItem(next, v);
        s.removeItem(key);
      }
    }
  } catch {
    // ignore — a store that throws on every access reads as "nothing stored"
  }
}

/** The store, or null when there is none to be had. Every access below goes
 *  through here, and a private window, a disabled storage and a denied getter
 *  all arrive as the same null. */
function store(): PayloadStore | null {
  if (injected !== undefined) {
    if (injected) migratePayloadKeys(injected);
    return injected;
  }
  try {
    const s = typeof localStorage === 'undefined' ? null : localStorage;
    if (s) migratePayloadKeys(s);
    return s;
  } catch {
    return null;
  }
}

function get(s: PayloadStore, key: string): string | null {
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

function remove(s: PayloadStore, key: string): void {
  try {
    s.removeItem(key);
  } catch {
    // ignore — a device that will not let go of a key is a device this file
    // already reads nothing from
  }
}

/** True when the write landed. False is the quota failure and the private
 *  window, which the caller answers differently in each case. */
function put(s: PayloadStore, key: string, value: string): boolean {
  try {
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Every stored payload's key, newest-first order not guaranteed. Read by
 *  index because that is all `Storage` offers, and defensively because a store
 *  mutated mid-walk answers null. */
function entryKeys(s: PayloadStore): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k !== null && k.startsWith(PAYLOAD_CACHE_PREFIX)) keys.push(k);
    }
  } catch {
    return keys;
  }
  return keys;
}

/**
 * Who the board last saw signed in on this device, and when.
 *
 * The `at` is re-stamped on every `/api/auth/me` that answers, so it is always
 * at least as fresh as the newest stored payload. That makes it the one reading
 * worth asking before painting anything at all, and it is the reading
 * `openingSession` asks for.
 */
export interface CacheOwner {
  shell?: SavedShell;
  hintId?: string;
  email: string;
  at: number;
  /**
   * What Github last reported this person could see, as its OWN field (#1395).
   *
   * It used to be glued onto `email` — the stamp was `email:visibilityKey` —
   * which made every reader of this record unable to tell "somebody else" from
   * "the same person, re-checked". `claimFor` could only wipe, so a key that
   * moved for no reason emptied the cache, and `row.version` in the service's
   * `person.key` moved it on every eight-hour token refresh. Separating the two
   * is what lets the identity question and the access question have different
   * answers.
   *
   * Absent when the service sends no key: an unconnected person, or a board with
   * no session secret configured.
   */
  vis?: string;
  /**
   * The key `vis` replaced, kept until a read under `vis` succeeds (#1395).
   *
   * IT HAS TO BE ON THE DISK. `supersedeVisibility` holds the same value in
   * memory, and memory is exactly what a reload throws away: the copy would be
   * drawn stale for the rest of the session and then meet placeholders on the
   * next open, which is the symptom this issue is about. One key, never a chain.
   *
   * WHAT BOUNDS IT is each entry's own age, and NOT this record's: `claimFor`
   * re-stamps `t` on every answer, so the owner record never ages out on a board
   * somebody keeps opening. A copy stops being drawable when it passes its own
   * 24 hours, which `readValue`, `readPayload` and `readSaved` each check, and
   * the key is retired as soon as no copy still stands on it.
   */
  was?: string;
}

/** The claim, or null when there is none, when it is unreadable, or when it is
 *  older than the ceiling. Null is a refusal to paint: an entry with no owner to
 *  check against is an entry that could be anybody's, and a claim nobody has
 *  refreshed for a day is a device nobody has signed in on for a day. */
function ownerRecord(s: PayloadStore): CacheOwner | null {
  const raw = get(s, PAYLOAD_OWNER_KEY);
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { o, t, hintId, vis, was, shell: rawShell } = parsed as Record<string, unknown>;
  if (typeof o !== 'string' || o === '') return null;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (!fresh(t)) return null;
  const shell = savedShell(rawShell);
  // A stamp written before #1395 is `email:visibilityKey`. Split it rather than
  // read it as a different address, so the OWNER RECORD still names the person
  // it has always named and the first open after this deploy does not wipe.
  // The visibility half comes across too, so the access question has its answer
  // on that first open as well.
  //
  // IT DOES NOT SAVE THAT OPEN FROM BEING COLD, and the first draft of this
  // comment claimed it did. Every ENTRY saved by the old build carries the same
  // composite in its own `o`, and the readers below compare that against the
  // split address, so those entries are refused once and rewritten. One cold
  // board each, once, at the deploy. What this avoids is the wipe, which would
  // also have taken the saved copies and the owner's shell.
  const colon = o.indexOf(':');
  const email = colon === -1 ? o : o.slice(0, colon);
  const legacyVis = colon === -1 ? undefined : o.slice(colon + 1);
  const visibility = typeof vis === 'string' && vis ? vis : legacyVis;
  const matches = shell && email === shell.email;
  return { email, at: t, ...(typeof hintId === 'string' ? { hintId } : {}),
    ...(visibility ? { vis: visibility } : {}), ...(typeof was === 'string' && was ? { was } : {}),
    ...(matches ? { shell } : {}) };
}

function owner(s: PayloadStore): string | null {
  return ownerRecord(s)?.email ?? null;
}

/** Who the stored payloads belong to, for the one caller outside this file that
 *  has to know before a page exists: the opening session (#824). */
export function cachedOwner(): CacheOwner | null {
  const s = store();
  return s ? ownerRecord(s) : null;
}

/**
 * Whether anything PAINTABLE is stored. Asked beside `cachedOwner` so a device
 * with a claim and nothing behind it waits for the network like any other,
 * rather than drawing a board made of skeletons over an unverified session.
 *
 * It counts what `readPayload` would actually hand back, not what is on the
 * disk: an entry stamped for somebody else, or one past the ceiling, is not
 * something the board can draw, and a count that included it would be the
 * board deciding to draw on the strength of an entry it then refuses.
 */
export function hasCachedPayloads(): boolean {
  const s = store();
  if (!s) return false;
  const who = owner(s);
  if (who === null) return false;
  const now = Date.now();
  return entryKeys(s).some((k) => {
    // A saved copy is never a first paint (#1035): it is drawn only after a
    // live read has failed, so it says nothing about whether to paint early.
    if (k.startsWith(PAYLOAD_CACHE_PREFIX + SAVED_PREFIX)) return false;
    const raw = get(s, k);
    const entry = raw === null ? null : parse(raw);
    return entry !== null && entry.o === who && fresh(entry.t, now);
  });
}

/** A parsed entry, or null for anything that is not one. Corrupt JSON, a
 *  string where an object should be, a missing owner, a missing timestamp, a
 *  stamp from another build and a value that is not an object all land here,
 *  and every one of them is dropped rather than painted.
 *
 *  The last two are #824's follow-up. Only the ENVELOPE was checked before, and
 *  `readPayload` handed `entry.v` to a render on faith — so the next change to
 *  any cached field, on a repo that deploys on every merge, threw inside a
 *  render for every returning reader at once. */
function parse(raw: string): Entry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { o, t, s, v, access } = parsed as Record<string, unknown>;
  if (typeof o !== 'string' || o === '') return null;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (s !== PAYLOAD_SCHEMA_VERSION) return null;
  if (!('v' in (parsed as Record<string, unknown>))) return null;
  if (!isObjectPayload(v)) return null;
  return { o, t, s, v, sensitive: (parsed as Entry).sensitive === true || undefined, ...(access !== undefined ? { access: access as ResponseDeadline } : {}) };
}

/**
 * The stored payload for a key, or null.
 *
 * Null for every reason there is: no storage, nobody has claimed the entries,
 * nothing is stored under this key, the entry is unreadable, it belongs to
 * somebody else, it is older than a day or stamped ahead of now, it was written
 * by a build that spoke another shape, or the value is not the shape the caller
 * asked for. Every one of those but the first three also DELETES what it
 * refused, so a page that cannot use an entry is not asked about it again.
 *
 * `accept` is the caller's own shape test, and it defaults to "an object or an
 * array" — the shape every read on the allowlist answers with. Pass a narrower
 * one wherever the value goes straight into something that would throw on it:
 * `Array.isArray` for the roster and the boards rollup, both of which used to
 * be `.map`ped on faith. It is here rather than as a per-route validator this
 * file would keep in step with `api.ts`: the caller already knows what it asked
 * for, and this file stays ignorant of every payload's fields.
 *
 * A value the guard refuses is DELETED, like every other reason above. Without
 * that, one bad write bricks the page across reloads: the render throws into an
 * `ErrorBoundary`, nothing removes the entry, and the next visit reads it again
 * for the rest of the freshness ceiling's day.
 */
export function readPayload<T>(key: PayloadKey, accept: (v: unknown) => boolean = isObjectPayload): T | null {
  const s = store();
  if (!s) return null;
  const who = owner(s);
  if (who === null) return null;
  const full = PAYLOAD_CACHE_PREFIX + key;
  const raw = get(s, full);
  if (raw === null) return null;
  const entry = parse(raw);
  if (entry === null || entry.o !== who || !fresh(entry.t) || !accept(entry.v)) {
    remove(s, full);
    return null;
  }
  // Only the inert preview may draw an expired lease. It never tags the saved
  // value as authorized, and App replaces this tree when the probe settles.
  if (hintPreviewActive()) return entry.v as T;
  if (entry.access !== undefined || ((isSensitivePayloadKey(key) || entry.sensitive === true) && requiresResponseDeadline())) {
    if (!drawableResponseDeadline(entry.access)) { remove(s, full); return null; }
    tagResponse(entry.v, entry.access);
  }
  if (entry.sensitive === true) markSensitiveResponse(entry.v);
  return entry.v as T;
}

/**
 * Store a payload under a key, attributed to whoever currently owns the cache.
 *
 * Nothing is written before `claimFor` has run, because an entry with no owner
 * is an entry `readPayload` would refuse anyway. That ordering is NOT by
 * construction, and the first draft of this comment said it was: since #824
 * `App` draws a remembered session before `/api/auth/me` answers, so a page can
 * be mounted and fetching under a claim that is one visit old. What holds is
 * the weaker and sufficient thing: an unclaimed store is never written to, and
 * a claim that turns out to name somebody else takes every entry with it before
 * the new person's first read lands.
 *
 * A full store is the one failure worth trying to survive. `localStorage` is a
 * few megabytes shared with every other key on the origin, and the payloads
 * here are the largest things the board stores by a wide margin, so a quota
 * failure drops the oldest entries and tries once more. A second failure is
 * silent: a page that cannot store its answer still draws it.
 *
 * Silent, but not forgotten. The second `put`'s result was DISCARDED, so a
 * value larger than the whole budget looked like a first failure on every
 * refresh and evicted half the store again each time. Measured with eight
 * entries and one such value: four refreshes gave 8 → 4 → 2 → 1 → 1, and the
 * value never landed. `/api/issues/all` answers 149151 bytes, which is the size
 * of thing this is about. The size that failed
 * is remembered per key, so the second refresh costs nothing and a smaller
 * answer for the same key still gets its retry.
 */
export function writePayload(key: PayloadKey, value: unknown): void {
  if (hintPreviewActive()) return;
  if (responseExpired(value)) return;
  const s = store();
  if (!s) return;
  const who = owner(s);
  if (who === null) return;
  const entry: Entry = { sensitive: isSensitiveResponse(value) || undefined, access: responseDeadline(value), o: who, t: Date.now(), s: PAYLOAD_SCHEMA_VERSION, v: value };
  let body: string;
  try {
    body = JSON.stringify(entry);
  } catch {
    // A value with a cycle in it, which no API response has and no page should
    // hand us. Not storable, and not worth failing a render over.
    return;
  }
  putEvicting(s, PAYLOAD_CACHE_PREFIX + key, body);
}

/** Write one entry, making room once when the store refuses it, and remembering
 *  a size that did not fit even then. Shared by the stored and the saved copies,
 *  so neither re-runs the eviction on every write. */
function putEvicting(s: PayloadStore, full: string, body: string): void {
  if (put(s, full, body)) { didNotFit.delete(full); return; }
  // Already known not to fit at this size or smaller, with the store emptied
  // beneath it. Evicting for it again buys nothing and costs everybody else
  // their copy.
  const failedAt = didNotFit.get(full);
  if (failedAt !== undefined && body.length >= failedAt) return;
  evictOldest(s, full);
  if (put(s, full, body)) { didNotFit.delete(full); return; }
  didNotFit.set(full, body.length);
}

/** Drop the oldest half of the ordinary payloads, never saved copies or the
 *  key being written. Saved copies are the fallback after a failed live read;
 *  a quota failure must leave them available.
 *  Half rather than one, because a store full enough to refuse one write will
 *  refuse the next one too, and this runs on a path nobody is watching. An
 *  entry whose timestamp cannot be read sorts oldest and goes first. */
function evictOldest(s: PayloadStore, keep: string): void {
  const aged = entryKeys(s)
    .filter((k) => k !== keep && !k.startsWith(PAYLOAD_CACHE_PREFIX + SAVED_PREFIX))
    .map((k) => {
      const raw = get(s, k);
      const entry = raw === null ? null : parse(raw);
      return { k, t: entry?.t ?? 0 };
    })
    .sort((a, b) => a.t - b.t);
  for (const { k } of aged.slice(0, Math.ceil(aged.length / 2))) remove(s, k);
}

/**
 * Forget ONE stored payload, leaving the rest and the owner alone.
 *
 * For a page that has learned the entry must not be painted again, which is a
 * narrower thing than a session ending. Two callers today, both #714's defence
 * carried onto the disk: an org the board has stopped serving, and a board that
 * has been deleted. Without this the tab was cleaned and the disk was not, so
 * the next reload put the disowned org's whole map back and did it again every
 * visit for a day.
 */
export function forgetPayload(key: PayloadKey): void {
  const [path, org] = key.split(':');
  forgetRead(`/api/${path}${org ? `?${new URLSearchParams({ org })}` : ''}`);
  const s = store();
  if (!s) return;
  remove(s, PAYLOAD_CACHE_PREFIX + key);
}

/**
 * Forget every stored copy of the Projects ROLLUP, under any org key (#1060).
 *
 * `forgetSavedCopies`'s counterpart, for the reason that one walks a prefix:
 * the union copy `/` draws holds every org's boards, so a refusal on
 * /acme that took only `projects:acme` left acme's boards in
 * `projects` for the next "not now" on `/` to draw them again. A page load
 * bounds that — `projects` is a sensitive key and the mount probe's wipe takes
 * it — but a reader moving between the two addresses inside one document met
 * it, so the bound was not the one the narrow forget was written under.
 *
 * The per-board reads (`projects/7`) are deliberately not here, and that is now
 * a division of labour rather than a gap. Until #1065 it was a gap: the board
 * page forgot its own board only when `scopeStatus` read a 403 or a 404 out of
 * the failure, so a 500 on an open `/projects/7` left the board drawn and
 * `board_payload:projects/7` on the disk. This said `forgetSensitivePayloads`
 * was what took those, and it is not: that runs on a page load and on an expired
 * check, and a refusal is neither. A reviewer reproduced it in a browser.
 *
 * #1065 gave that page the same question these keys are cleared on,
 * `servableBoardFailure`, and #1107 gave its read the "not now" code that
 * question needs to tell a cooldown from a refusal. `ProjectsView` forgets its
 * own board with `forgetPayload(projectKey(...))`, which is why the key is not
 * swept from here: one board's copy is one board's to drop, and a refusal on the
 * rollup says nothing about a board somebody has open.
 *
 * There is no way to forget one org's rollup.
 */
export function forgetProjectsPayloads(): void {
  for (const query of readClient.getQueryCache().getAll()) {
    const path = String(query.queryKey[1]);
    if (/^\/api\/projects(?:\?|$)/.test(path)) forgetRead(path);
  }
  const s = store();
  if (!s) return;
  for (const k of entryKeys(s)) {
    const key = k.slice(PAYLOAD_CACHE_PREFIX.length);
    if (key === 'projects' || key.startsWith('projects:')) remove(s, k);
  }
}

/**
 * Forget every stored payload and who they belonged to.
 *
 * Called by `logout()`, by the first 401 of an expired session, by `beginLogin`
 * before the browser leaves for Google, and by every ANSWER to the mount probe
 * that is not this person confirmed. This is the whole of what makes a
 * per-person copy on disk an acceptable thing to keep: a board that has been
 * signed out of, or that has been told this is somebody else, holds nothing —
 * so the next person to open this browser is shown a skeleton and not somebody
 * else's queue.
 *
 * "Answer" and not "route out", which is what this said and is a wider claim
 * than the code makes. Four exits reach no wipe, deliberately, and they are the
 * ones where the board learned nothing: an abort, a timeout, a dropped
 * connection and a 5xx. `probeMe`'s own docblock is where that argument lives.
 */
export function forgetPayloads(): void {
  clearReads();
  resetResponseRequirements();
  payloadGeneration++;
  // A whole wipe is a superset of a sensitive one, so it moves that generation
  // too: a sensitive read in flight when the cache went must not land either.
  sensitiveGeneration++;
  const s = store();
  if (!s) return;
  for (const k of entryKeys(s)) remove(s, k);
  remove(s, PAYLOAD_OWNER_KEY);
}

/**
 * Take the entries off the disk WITHOUT withdrawing anything in flight.
 *
 * `forgetPayloads` above moves both generations, and that is the half of it
 * that is a withdrawal: `api.ts` refuses every read issued before the move
 * when it lands, because it was authorized under an identity or an access
 * check that has since gone.
 *
 * A device with no usable owner stamp has neither. Nothing stored here is
 * paintable without one — `hasCachedPayloads` says so, and `readPayload`
 * enforces it — so no read in flight can be carrying the last person's
 * authority, and refusing them refuses this person's own reads instead. That
 * is #1061: the first load of a fresh browser wiped an empty cache, the move
 * landed on the second `/api/auth/me` the same mount had in flight, and a page
 * whose every request answered 200 drew "the board couldn't verify your
 * session".
 *
 * The entries still go. An entry under no owner is unreadable rather than
 * harmless, and leaving one on a shared browser is the thing the top of this
 * file promises not to do.
 */
function forgetUnclaimedPayloads(): void {
  clearReads();
  const s = store();
  if (!s) return;
  for (const k of entryKeys(s)) remove(s, k);
  remove(s, PAYLOAD_OWNER_KEY);
}

/** Known sensitive routes also cover unmarked entries from legacy servers.
 *  Response metadata remains authoritative for every other stored key. */
export function isSensitivePayloadKey(key: string): boolean {
  return /^(?:projects(?:\/\d+)?|repos|issues\/(?:mine|all|filter-options))(?::|$)/.test(key);
}

/** Discard sensitive data and pending answers on an explicit identity boundary.
 *  Real request refusals also keep their existing per-view clearing rules. */
export function forgetSensitivePayloads({ preserveLiveMine = false } = {}): void {
  clearSensitiveReads();
  resetResponseRequirements();
  sensitiveGeneration++;
  const s = store();
  if (!s) return;
  for (const k of entryKeys(s)) {
    const key = k.slice(PAYLOAD_CACHE_PREFIX.length);
    if (droppedByWipe(key, parse(get(s, k) ?? ''), preserveLiveMine)) remove(s, k);
  }
}

/** Whether a key names My work, under any org. */
function isMineKey(key: string): boolean {
  return key === MINE_KEY || key.startsWith(MINE_KEY + ':');
}

/**
 * Whether the stored My work answer is still inside the access lease it was
 * served under.
 *
 * A new document may keep My work until that lease ends (#1098). App still
 * waits for fetchMe to confirm the owner; claimFor and readPayload reject a
 * changed identity or visibility before any cached value is drawn.
 */
function liveMineLease(key: string, entry: Pick<Entry, 'access' | 'sensitive'> | null): boolean {
  return isMineKey(key) && !!entry?.access && Number.isFinite(entry.access.expiresAt)
    && entry.access.expiresAt > Date.now() && typeof entry.access.visibilityKey === 'string';
}

/** What the wipe above takes, as one function rather than as a condition
 *  spelled inside the loop — `seedPayload` asks the same question, and the
 *  whole of #1027 was the two of them answering it differently. */
function droppedByWipe(key: string, entry: Pick<Entry, 'access' | 'sensitive'> | null, preserveLiveMine: boolean): boolean {
  if (preserveLiveMine && liveMineLease(key, entry)) return false;
  return isSensitivePayloadKey(key) || entry?.access !== undefined || entry?.sensitive === true;
}

/** Whether arrival could use this answer. Check before serializing a hook's
 *  value: an unreadable write can spend quota and evict useful payloads. */
export function canSeedPayload(key: PayloadKey, value: unknown): boolean {
  return !droppedByWipe(key, {
    access: responseDeadline(value),
    sensitive: isSensitiveResponse(value),
  }, true);
}

/** A matching session hint permits a saved preview while the probe runs.
 *  Ordinary navigation still applies the mount wipe's policy (#1027), so a
 *  click cannot revive data an access check has already withdrawn. */
export function seedPayload<T>(key: PayloadKey, accept?: (v: unknown) => boolean): T | null {
  const s = store();
  if (s && !hintPreviewActive()) {
    const full = PAYLOAD_CACHE_PREFIX + key;
    const raw = get(s, full);
    if (raw !== null && droppedByWipe(key, parse(raw), true)) { remove(s, full); return null; }
  }
  return readPayload<T>(key, accept);
}

/**
 * A SAVED copy of one answer, kept for the one moment the live read of it fails
 * (#1035). What may be saved is `SavedKey`'s to say: the Projects rollup, since
 * #1046 the org queue and metrics the Overview tiles are counted from, and since
 * #1249 one board.
 *
 * Why the seeded copy above is not enough. `projects` is a permission-sensitive
 * key, so `forgetSensitivePayloads` takes it off the disk at every page LOAD
 * (`App`'s mount probe) and at every expired check. A reload whose Projects read
 * then fails has nothing left to draw, and that is the empty strip #974 reported
 * and #1035 reported again: `useCachedState` kept the boards across a failed
 * refresh inside one page, and nothing kept them across a reload.
 *
 * So this sits OUTSIDE that wipe on purpose. Its key does not match
 * `isSensitivePayloadKey` and the entry carries no lease, so the sensitive wipe
 * walks past it. Every whole wipe still takes it, because it lives under the
 * same prefix: a sign-out, a 401, another person's claim.
 *
 * What stops that becoming a way round #892 is the rule it is read under, which
 * is the service's own for the same payload (`projects-last-good.ts` in
 * board-service, #1003): only ever after a live read FAILED, and failed in a way
 * that says "not now" rather than "not you" (the caller decides that); only for
 * the same person (`o`) seen through the same Github access (`seen`, the
 * visibility key this document's own check reported); and only inside the
 * caller's age ceiling. It is never seeded as a first paint.
 */
const SAVED_PREFIX = 'saved/';

/**
 * The answers that may be saved: the Projects rollup, the org queue and metrics
 * the Overview tiles are counted from (#1046), and one board (#1249).
 *
 * The board was the one cached surface with no saved copy at all, and #1243 is
 * what made that visible. Until it, a walk back to `/projects/7` during an
 * outage repainted the board out of `board_payload:projects/7`; a RELOAD never
 * did, because that key is an `isSensitivePayloadKey` entry and the mount wipe
 * takes it. #1243 made the seed ask the wipe's own question, so both routes lost
 * it together and the page emptied whichever way you arrived. The absence was
 * older than the change that exposed it.
 *
 * A board is saved on the same terms as the three above and read back on the
 * same terms: only after a live read FAILED in a way that says "not now", only
 * for the same person seen through the same Github access, and only inside
 * `SAVED_COPY_MAX_AGE_MS`. Its policy half is `projects/projects-last-good.ts`.
 */
export type SavedKey = OrgScoped<'repos' | 'projects' | `projects/${number}` | typeof ORG_QUEUE_KEY | typeof METRICS_KEY>;

/** A saved answer, and when it was saved. */
export interface Saved<T> {
  at: number;
  value: T;
  /** The visibility key it was saved under, null where the board holds no
   *  per-person Github access (fixtures, the deployment credential). */
  seen: string | null;
}

/** Save what a live read just answered. */
export function keepSaved(key: SavedKey, value: unknown): void {
  const s = store();
  if (!s) return;
  const who = owner(s);
  if (who === null || !isObjectPayload(value)) return;
  let body: string;
  try {
    body = JSON.stringify({ o: who, t: Date.now(), s: PAYLOAD_SCHEMA_VERSION, seen: currentResponseIdentity(), v: value });
  } catch {
    return;
  }
  putEvicting(s, PAYLOAD_CACHE_PREFIX + SAVED_PREFIX + key, body);
}

/**
 * The saved answer, or null: nothing saved, somebody else's, saved through
 * different Github access, older than `maxAgeMs`, or not the shape asked for.
 * Anything refused is deleted, as `readPayload` does.
 */
export function readSaved<T>(key: SavedKey, maxAgeMs: number, accept: (v: unknown) => boolean = isObjectPayload): Saved<T> | null {
  const s = store();
  if (!s) return null;
  const who = owner(s);
  if (who === null) return null;
  const full = PAYLOAD_CACHE_PREFIX + SAVED_PREFIX + key;
  const raw = get(s, full);
  if (raw === null) return null;
  const entry = parse(raw);
  // `parse` is the envelope every entry shares; `seen` is this entry's alone.
  const seen = entry === null ? undefined : (JSON.parse(raw) as { seen?: unknown }).seen;
  const age = entry === null ? NaN : Date.now() - entry.t;
  // `seen` is the visibility key this copy was saved under. It must be one the
  // app may still draw: the installed key, or the ONE key it replaced for this
  // same person (#1395). Without the second arm the last-good copies went on the
  // first "not now" after a real access change, which is the symptom this issue
  // is about arriving through the other store. `readValue` and `readPayload`
  // already read the pair this way; this is the third reader and the one the
  // Projects and Repos fallbacks come through.
  const drawableSeen = seen === currentResponseIdentity()
    || (typeof seen === 'string' && seen !== '' && seen === currentSupersededIdentity());
  if (entry === null || entry.o !== who || !(age <= maxAgeMs && age >= -PAYLOAD_CLOCK_TOLERANCE_MS)
    || (seen !== null && typeof seen !== 'string') || !drawableSeen || !accept(entry.v)) {
    remove(s, full);
    return null;
  }
  return { at: entry.t, value: entry.v as T, seen: seen as string | null };
}

/**
 * Forget EVERY saved answer: a read was refused as "not you" (#1042 review,
 * round 3). All of them, not the one whose read failed. The union copy `/`
 * draws holds every org's boards, so forgetting only `projects:acme`
 * left acme's boards in `projects` for the next "not now" to draw. And
 * a copy saved under a key added later goes too, because this walks the
 * prefix rather than a list. There is deliberately no way to forget one key.
 */
export function forgetSavedCopies(): void {
  clearSavedReads();
  const s = store();
  if (!s) return;
  for (const k of entryKeys(s)) if (k.startsWith(PAYLOAD_CACHE_PREFIX + SAVED_PREFIX)) remove(s, k);
}

/**
 * Record who the stored payloads belong to, wiping first if they belonged to
 * anybody else.
 *
 * Called from `fetchMe`, which is where the app learns its own name. The board
 * cannot know who is reading before that answer lands — the session cookie is
 * the server's, not the SPA's — so the entries are attributed rather than
 * derived, and an email that does not match the recorded one takes the whole
 * cache with it before the new person's first read is stored.
 *
 * Which of the two wipes it takes is the difference #1061 turned on. A stamp
 * naming SOMEBODY ELSE is a withdrawal: the reads this document has in flight
 * may have been authorized under them. No stamp at all is not, because there
 * was nobody to authorize anything — see `forgetUnclaimedPayloads`.
 *
 * An empty email wipes and claims nothing. An answer that names nobody is not
 * an owner, and entries under no owner are never painted.
 *
 * THE IDENTITY IS THE PERSON, NOT THE ACCESS CHECK (#1395). `visibilityKey` is
 * recorded beside the address rather than inside it, and it does not decide this
 * question, and the branch below answers it differently: a moved key keeps the
 * copies and marks them stale. What wipes is still exactly what #824 and #1061 said wipes:
 * a different address, or a different session for the same address.
 */
export function claimFor(email: string, hintId?: string, visibilityKey?: string, shell?: SavedShell): void {
  const s = store();
  if (!s) return;
  let who = typeof email === 'string' ? email.trim() : '';
  // THE LEGACY COMPOSITE, ON THIS SIDE TOO (#1395). `ownerRecord` reads a stored
  // `email:visibilityKey` stamp as its two halves, so this has to read the same
  // form the same way: a caller still passing the composite would otherwise
  // never match the record it had just written, and would wipe on every load.
  // An address cannot contain a colon, so the split is unambiguous.
  //
  // No PRODUCTION caller passes the composite any more — `api/me.ts` passes the
  // halves. The one that does is `scripts/fixtures/cache-reader.tsx`, the cache
  // guard's own app, and `check-read-defaults.mjs` went red without this.
  const glued = who.indexOf(':');
  if (glued !== -1) {
    visibilityKey = visibilityKey || who.slice(glued + 1) || undefined;
    who = who.slice(0, glued);
  }
  if (who === '') {
    forgetPayloads();
    return;
  }
  const held = ownerRecord(s);
  let wiped: boolean;
  // Somebody else: everything goes before the new person's first read is stored
  // under them, and every read issued under the last person is withdrawn with
  // it.
  if (held !== null && (held.email !== who || (held.hintId && hintId && held.hintId !== hintId))) { forgetPayloads(); wiped = true; }
  // Nobody at all — a fresh browser, or a claim too old to stand. The entries
  // still go, but nothing is withdrawn: there was no owner, so nothing here was
  // paintable, and no read in flight can be the last person's (#1061).
  else if (held === null) { forgetUnclaimedPayloads(); wiped = true; }
  // THE SAME PERSON, AND GITHUB NOW REPORTS DIFFERENT ACCESS. Nothing is wiped,
  // and that is the one judgement in #1395 that is not a bug fix: Artur decided
  // it (`dec_23f3ca7ff09e`). The reader keeps their own last copy, marked stale,
  // until a live read refuses it.
  //
  // Note what this is NOT. It is not a different person, which the first branch
  // above has already wiped for. It is not a refusal either: nothing has told
  // the board that this reader may not see what they are holding. It is Github
  // reporting a different set of repositories or permissions, which is as often
  // a repository ADDED as one taken away. The live reads that follow settle it,
  // and each carries its own authorization: one refused with 401, 403 or 404
  // withdraws the copy, and one that succeeds replaces it.
  else wiped = false;
  // WHICH KEY THE COPIES MAY STILL BE DRAWN UNDER, written below and re-armed
  // here (#1395). The access change above supersedes the key it replaced; every
  // later answer carries that forward, because a reload has no memory of it and
  // the copies are still the ones the old key issued. It ends when no copy in
  // either store still stands on it (`retireSupersededVisibility`). Each copy's
  // own 24-hour age is the other end of it. This record is NOT a bound, because
  // `claimFor` re-stamps `t` on every answer, so it never ages out on a board
  // somebody keeps opening.
  const superseded = wiped ? undefined
    : visibilityKey && held?.vis && held.vis !== visibilityKey ? held.vis
    : held?.was;
  if (superseded) supersedeVisibility(superseded);
  // Re-stamped on every answer, whoever it named. The stamp is what says this
  // device was signed in RECENTLY, which is the whole of what the opening
  // session is allowed to act on.
  //
  // The verified account LABEL carries over only when nothing was wiped — asked
  // of the wipe rather than re-derived from `held`, which is the shape #1395
  // needed: `held` is read before the wipe, so a branch that re-tested the
  // address would restore the label of a cache that had just gone.
  const display = savedShell(shell);
  if (display && !wiped && held?.shell?.account) {
    display.account = held.shell.account;
  }
  put(s, PAYLOAD_OWNER_KEY, JSON.stringify({ o: who, t: Date.now(), ...(hintId ? { hintId } : {}),
    ...(visibilityKey ? { vis: visibilityKey } : {}), ...(superseded ? { was: superseded } : {}),
    ...(display ? { shell: display } : {}) }));
}

/**
 * A read under the CURRENT key landed, so the key it replaced is finished
 * (#1395).
 *
 * Called by `rememberRead` on a stored answer, which is the only moment the
 * board knows the live reads are working again. It drops the record's `was` so
 * the next open does not re-arm it, and the in-memory one with it.
 *
 * It does nothing at all when there is no superseded key, which is almost every
 * read: this must not write the owner record on every answer the board stores.
 */
/**
 * Whether any localStorage copy still stands on the superseded key (#1395).
 *
 * THE OTHER STORE, and in production it is most of them. Every route but the
 * queue and the roster answers `private, no-store`, so the Projects strip, a
 * board, the Repos map and the filter options live only here. A retirement test
 * that read the query cache alone saw none of them: the queue and the metrics
 * landed under the new key, `was` retired, and the next `readPayload` deleted
 * every copy saved under the old one. A Projects 503, or simply opening a board
 * or the Repos map, then met placeholders.
 *
 * Both halves are counted: the ordinary entries, which carry `access`, and the
 * saved last-good copies, which carry `seen`.
 */
export function supersededCopiesHeld(key: string): boolean {
  const s = store();
  if (!s) return false;
  for (const k of entryKeys(s)) {
    const raw = get(s, k);
    if (raw === null) continue;
    try {
      const held = JSON.parse(raw) as { access?: { visibilityKey?: unknown }; seen?: unknown };
      if (held.access?.visibilityKey === key || held.seen === key) return true;
    } catch { /* an entry this cannot read is one it cannot count. */ }
  }
  return false;
}

export function clearSupersededVisibility(): void {
  if (currentSupersededIdentity() === null) return;
  supersedeVisibility(null);
  const s = store();
  if (!s) return;
  const held = ownerRecord(s);
  if (!held?.was) return;
  put(s, PAYLOAD_OWNER_KEY, JSON.stringify({ o: held.email, t: held.at, ...(held.hintId ? { hintId: held.hintId } : {}),
    ...(held.vis ? { vis: held.vis } : {}), ...(held.shell ? { shell: held.shell } : {}) }));
}


/** Update the last verified account label without extending the owner's lifetime. */
export function rememberShellAccount(email: string, name: string, githubLogin: string | null): void {
  if (hintPreviewActive()) return;
  const s = store();
  if (!s) return;
  const held = ownerRecord(s);
  if (!held?.shell || held.shell.email !== email) return;
  // EVERY FIELD THE RECORD CARRIES, not just the ones this function is about.
  // It rewrites the whole record, so a field left out here is a field deleted:
  // `vis` was lost that way once, and `was` after it, which dropped the
  // superseded key the moment the account label landed and took the kept copies
  // with it on the next open (#1395).
  put(s, PAYLOAD_OWNER_KEY, JSON.stringify({ o: held.email, t: held.at, hintId: held.hintId, vis: held.vis, was: held.was,
    shell: { ...held.shell, account: { name, githubLogin } } }));
}

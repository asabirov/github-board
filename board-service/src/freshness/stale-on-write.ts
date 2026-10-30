import type { Capability } from '../capability/capability';

/**
 * A cache a Github write can leave out of date (#692).
 *
 * `dropCaches()` is the same three moves `repos.service.ts:632` names, and none
 * of the three is optional:
 *
 *  - the cached answers go;
 *  - the in-flight slots go, so a caller arriving after this point starts its
 *    own read instead of being handed the one that went out before the write;
 *  - an epoch moves, so those disowned reads cannot write what they read BEFORE
 *    the write into the cache when they eventually land. Nulling the slots does
 *    not do this on its own — a disowned read holds no reference to the slot it
 *    came from, and would happily overwrite a fresher answer.
 *
 * What a drop must NOT do is turn a Github outage into a 500. Each of these
 * keeps the last good payload it served BESIDE the one it dropped, and serves it
 * only when the post-drop read of the source FAILS. On the success path that
 * copy is unreachable: serving it there would be the stale answer this whole
 * lane exists to stop.
 *
 * What it must not do EITHER is speak with a freshness it has not got. A copy
 * served this way carries no expiry, so `ProjectsService` withholds the four
 * figures its org-wide join produced — the day buckets are a rolling 24 hours
 * anchored to the read that made them — and refuses one at all past a multiple
 * of its TTL (#713, `RETIREE_MAX_TTLS`). Past that point the failure is the
 * honest answer.
 *
 * `warmAfterWrite()` is the second half, and it is OPTIONAL — which is the point
 * of it. Whether a cache may be refilled on the write's own path is a property
 * of the BUDGET it reads against, so each cache answers for itself rather than
 * being named in a list of exceptions somewhere else. Absence is a real answer,
 * and the compiler shows it at the service that gives it.
 *
 * Two caches offer one:
 *
 *  - `IssuesCacheService` — the org-wide ingest, ~70 repos over core REST
 *    (5000/hour) and the slowest read on the board. It is the one most worth
 *    holding warm, and it is strongly consistent: what it re-reads after a write
 *    includes the write.
 *  - `ProjectsService` — Projects-v2 GraphQL, which bills against its own point
 *    budget rather than either REST limit. That separateness is still what earns
 *    it a warm; what has changed is the size of the bill, twice, and it is no
 *    longer the single call this sentence was first written against (#713). A
 *    warm is `refill('write')` — the button's own body bar TWO moves. The first
 *    is the one map it drops and a write keeps: the picker's catalog, which is
 *    its own query and no part of the bill below either way (#713). The second
 *    is that a write's warm goes through `ProjectsService.warmOrg` and the
 *    button's does not, which is the paragraph on the cap below.
 *
 *    What it costs is EVERY org in scope at once, and each
 *    org is a board-list walk — `projectsV2(first:20)`, page after page — and then, board
 *    by board and SEQUENTIALLY, the `items(first:100)` connection of every
 *    surfaced board followed to its own end (#690). So one org costs a round
 *    trip per twenty open boards, plus one per hundred items past the first on
 *    each board it surfaces, with `MAX_PAGES` stopping either walk at twenty
 *    pages. An org under twenty boards holding nothing over a hundred items
 *    still costs the one call, which is the bill this sentence used to describe
 *    and the reason it read as a constant. The walk is also always a FRESH one
 *    now: the write clears the source's in-flight board latch (#713), so a warm
 *    can no longer join a read already going out and take the list for nothing.
 *    That joining is precisely how a pre-write rollup was being cached, so the
 *    saving had to go — and this is the cache that pays for it. It is still
 *    worth paying: a cold rollup is the multi-second read #304 exists to keep
 *    off the page, and not warming means the first reader after every write
 *    meets it.
 *
 *    What bounds it is `ProjectsService.warmOrg`: at most one walk per org in
 *    flight, with a write that arrives during one marking the org so that
 *    exactly one more runs when it lands (#713). A burst that ENDS therefore
 *    costs two walks per org rather than one each — 63 Projects-v2 points a
 *    walk on acme's boards, against a 5,000/hour budget — and the last
 *    walk still goes out after the last write, which is what keeps its answer
 *    cacheable. The registry below neither awaits nor debounces these, so
 *    nothing else was going to. CONCURRENCY, not rate: a write stream that never
 *    pauses keeps one walk permanently in flight per org, because nothing here
 *    is a minimum interval between an org's warms. And the slot that cap keeps
 *    is held for `WARM_WALK_MAX_MS` at the outside (#713) — nothing under it
 *    times out, so without a bound one hung read stopped an org warming for the
 *    life of the process rather than for one write.
 *
 * Two do NOT, and both halves of the reason matter for the first:
 *
 *  - `IssueBucketsService` (four searches) refills from Github SEARCH, which is
 *    limited to THIRTY requests a minute — a separate and far tighter budget
 *    than core REST's 5000/hour, and one that ordinary TTL traffic already
 *    spends a part of. Four searches on every capability-declaring write, across
 *    the nine issue-detail routes that declare one, means ticking a checkbox in
 *    an issue body costs the same four as closing an issue.
 *  - Github Search is EVENTUALLY CONSISTENT. A refill issued in the same breath
 *    as the write usually reads the index from before it, and caches that answer
 *    for a full TTL — so re-warming it does not merely cost budget, it
 *    makes #692 more reproducible than doing nothing at all. Dropping and
 *    letting the next reader pay is the only way their answer can be right.
 *
 * `IssueDetailService` has none for a third reason: its map is keyed per issue,
 * so there is no org-wide answer to warm at all.
 *
 * `resync()` is NOT this and is not declared here. It is the explicit "Sync now"
 * (#301), it is awaited, every one of these four still has it, and
 * `SyncController` still calls it on all of them. `IssuesCacheService`'s
 * `warmAfterWrite` delegates straight to it — same refill, different question
 * about when it is allowed to run.
 *
 * `ProjectsService`'s does not, and the difference is TWO moves (#713). The
 * first is one map: its warm keeps the add-to-project picker's catalog, which
 * `resync` drops — an entry there is a board's identity, and no close and no
 * facet write can change one, so a write that dropped it would spend a
 * Projects-v2 walk to be told the same thing. "Sync now" means "I believe
 * something moved that you cannot see", and a board renamed on Github is exactly
 * that. The second is the warm itself: a write's goes through
 * `ProjectsService.warmOrg`, which caps the walks a burst can start at one per
 * org, and the button's calls `readRollup` directly and is capped by nothing,
 * because a person is waiting on the answer. Same refill still —
 * `ProjectsService.refill` is where the two meet, and it carries the argument
 * for both.
 */
export interface StaleOnWrite {
  /** `written` is what the write's route declared in `@Writes` (#982). Every
   *  cache but one drops the same way whatever was written. The projects
   *  catalog asks, because making a project is the one write that changes what
   *  it lists. */
  dropCaches(written?: readonly Capability[]): void;
  /** Re-fill after a write, in the background and never awaited. Absent = this
   *  cache must not be refilled on a write's own path; see above for which and
   *  why. */
  warmAfterWrite?(): Promise<void>;
}

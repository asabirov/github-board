import { retryOverviewRead } from '../cache/retry-overview-read';
import { notComparableScopes } from '../metric-scope/metric-scope';
import { forgetRead } from '../cache/read-cache';
import { useResolvedTimezone } from '../account/prefs';
import { dayQuery } from '../api/issues';
/**
 * The Overview page (#64, slimmed in #197). The Crew leads (#358) — one card
 * per team-table member — then the org-wide reads below (the folded team Pulse
 * — throughput / projects) and the unit queue. Clicking a Crew card
 * TOGGLES a member filter (#420) — pressed → the page reads that person;
 * pressed again → it clears. The standalone per-member page (/team/:person) was
 * retired with that change.
 *
 * The press narrowed only the queue until #461. It re-points the WHOLE page now:
 * Throughput and Oldest open read that member too (Projects deliberately does
 * not — see `ProjectsCard`). The pressed card is the
 * page's own statement that it is filtered; the queue below states it a second
 * way, as a removable assignee token in its FilterBar, because that token is how
 * the viewer shows every filter it holds and this one is no different.
 *
 * The selection lives in the URL and nowhere else. This page holds no assignee
 * state of its own: it reads `?assignee` through the viewer's codec and writes
 * it back the same way, so a card press, a FilterBar assignee chip and a shared
 * link are one mechanism. That also means the filter survives a reload.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_FILTER_OPTIONS, type FilterOptions, type IssueMetrics, type OrgQueue, fetchFilterOptions, fetchOverviewIssueMetrics as fetchIssueMetrics, fetchOverviewOrgIssues as fetchOrgIssues } from '../api/issues';
import { type Person, fetchPeople } from '../api/people';
// #824 — the last answer, kept per person, so this page opens on figures rather
// than on four skeletons. A withdrawal removes the refused copy.
import { useReadState } from '../cache/use-board-read';
import { scopeQuery } from '../api/core';
import {
  METRICS_KEY, ORG_QUEUE_KEY, orgScopedKey, forgetPayload,
} from '../cache/payload-cache';
import { Pulse } from '../dashboard/Pulse';
import { useOverviewGoal } from '../goals/goals';
import { FlowStrip } from '../flow-strip/FlowStrip';
import { ScopeLine } from '../flow-strip/ScopeLine';
// #714 — what the shell is currently narrowed to, and what the board says
// about it.
import { useOrgScope } from '../org-scope/OrgScopeProvider';
import { useScopeState } from '../org-scope/use-scope-state';
import { ScopeRefusedState } from '../org-scope/ScopeRefusedState';
import { scopeRefusal, scopeWithdrawn, refusedScopeCopy, type ScopeRefusal } from '../org-scope/scope-copy';
import { stripModel } from '../flow-strip/flow-strip.vm';
import { type OrgSource } from '../dashboard/pulse-filter';
import { IssueQueue } from '../ui/IssueQueue';
import { viewerUrl } from '../issues-viewer/viewer-links';
import { fromPersonalIssue } from '../issues-viewer/viewer-issue';
import { useReportOutdated, useRefreshSignal, useRenewalSignal, useAccessEpoch } from '../sync/sync-status';
import { TAB_LABEL, gotoPath } from '../route';
import { canonicalisation, dataLogins, pressCrewCard, selectedLogins } from './crew-filter';
import { RosterPerson, buildRosterFromPeople } from './team-vm';
import { CrewGrid } from './CrewGrid';
import { SessionOrgScopeNotice } from '../OrgScopeNotice';
import { PageHeading, PAGE_RAIL } from '../ui/PageHeading';
import { UNIT_QUEUE_ID } from '../ui/queue-region';
import { useLocationSearch } from '../location-search';
import { LoadingStructure } from '../ui/LoadingStructure';
import { drawable, type Recalled } from '../projects/projects-last-good';
import { ISSUES_NOT_NOW_CODE, recallMetrics, recallQueue, saveMetrics, saveQueue } from './overview-saved';

/** People fetch outcome: pending → loading gate; failed → error notice. */
type PeopleState = { kind: 'pending' } | { kind: 'ready'; people: Person[] } | { kind: 'failed' };

/** Org-queue fetch outcome. `failed` is held apart from `pending` because the
 *  blocks reading it draw the two differently: waiting is right while the queue
 *  is in flight, and waiting for good is not (#461). */
type OrgState = { kind: 'pending' } | { kind: 'ready'; queue: OrgQueue } | { kind: 'failed' };

export function TeamView() {
  const { org: owner } = useOrgScope();
  const timeZone = useResolvedTimezone();
  const [issueRefusal, setIssueRefusal] = useState<ScopeRefusal | null>(null);
  const [issueServed, setIssueServed] = useState(false);
  const scope = useScopeState(issueRefusal, issueServed);
  const queueKey = orgScopedKey(ORG_QUEUE_KEY, owner);
  const metricsKey = orgScopedKey(METRICS_KEY, owner);
  const [heldPeople, setPeople] = useReadState<PeopleState, { people: Person[] }>('/api/people', value => ({ kind: 'ready', people: value.people }));
  const people: PeopleState = heldPeople ?? { kind: 'pending' };
  // Two things this page can no longer say, written here because this is where
  // a reader meets them (#824 review).
  //
  // The "Synced" stamp does not speak for the roster. `sync-status.tsx` keeps
  // the MOST RECENT report from any surface and never moves backwards, so on a
  // page where `Pulse`'s buckets land and this read fails, the bar reads
  // "Synced just now" over a roster that may be a day old. It cannot be made to
  // say otherwise from here: `Person` carries no timestamp at all, so the
  // roster's own freshness is not expressible in the payload, and the cache's
  // write time is a fact about this browser rather than about the data. Naming
  // it here rather than inventing a field the service does not send.
  //
  // And "The unit roster couldn’t be read just now." below is now reachable only by a page that
  // never got a roster at all. Over a seeded one the failure handler keeps what
  // is on screen, so the sentence cannot appear; it would be false if it did,
  // because the table is on the page. The signal that is genuinely gone is "the
  // roster you are looking at is older than the rest of this page", and there
  // is nothing in the payload to build it from.
  // The whole unit's open queue (#284) — same board as Your work, org-wide.
  // The query reader owns the restored answer and its response deadline.
  // The queue joins project memberships, so the server marks it
  // permission-sensitive and it has to go when the check behind it expires —
  // and this hook already owns that: it runs `useResponseDeadline` on what it
  // holds and refuses to paint or persist a value from a spent generation. Its
  // key is org-scoped and `isSensitivePayloadKey` matches the scoped form, so
  // one org's queue is never read as another's and neither survives an expiry.
  // The envelope below is derived rather than held, so a withdrawal takes it
  // with the queue instead of leaving a `ready` wrapper around nothing.
  const [queue, setQueue] = useReadState<OrgQueue>(`/api/issues/all${scopeQuery(owner ?? undefined)}`);
  const [queueFailed, setQueueFailed] = useState(false);
  const org = useMemo<OrgState>(() => queue ? { kind: 'ready', queue } : { kind: queueFailed ? 'failed' : 'pending' }, [queue, queueFailed]);
  // The IssuesViewer's filter autocomplete — org-wide, degrades to empty (#394).
  // Seeded too: an autocomplete that opens empty for a second is a control that
  // silently offers nothing.
  const [heldOptions, setOptions] = useReadState<FilterOptions>('/api/issues/filter-options');
  const options = heldOptions ?? EMPTY_FILTER_OPTIONS;
  // What the flow strip reads (#666): the org's day series. It degrades to
  // `null`, which the view-model draws as "nothing held" rather than as a quiet
  // week. This is the page's ONLY read of metrics,
  // and `Pulse` takes it as a prop: it fetched its own until #666, and the two
  // bare `fetchIssueMetrics()` calls were one URL requested twice at once —
  // nothing coalesces them, and stale-while-revalidate can hand the two halves
  // of this page different snapshots of the same member.
  const [heldMetrics, setMetrics] = useReadState<IssueMetrics>(`/api/issues/metrics${dayQuery(owner ?? undefined, timeZone)}`);
  const [metricsRefusal, setMetricsRefusal] = useState<ScopeRefusal | null>(null);
  const [metricsFailed, setMetricsFailed] = useState(false);
  // The saved copies a failed read recalled (#1046), which the tiles draw when
  // the page holds nothing of its own; null otherwise. `overview-saved.ts`.
  const [savedQueue, setSavedQueue] = useState<Recalled<OrgQueue> | null>(null);
  const [savedMetrics, setSavedMetrics] = useState<Recalled<IssueMetrics> | null>(null);
  // The URL is READ here, never mirrored into state. Mirrored, it went stale on
  // any navigation that fires no popstate — the sidebar's own Overview item goes
  // through App's `navigate`, which pushes history and re-renders without one, so
  // clearing the query left this page still drawing the old selection and the
  // next Crew press appended a second login to an already-bare URL. Read during
  // render, any re-render at all refreshes it; the subscription's only job is to
  // make sure Back and the viewer's own writes cause one.
  const scopeKey = JSON.stringify([owner, timeZone]);
  const [seenOwner, setSeenOwner] = useState(scopeKey);
  if (seenOwner !== scopeKey) {
    setSeenOwner(scopeKey); setIssueRefusal(null); setIssueServed(false);
    setQueueFailed(false); setMetricsFailed(false); setMetricsRefusal(null);
    setSavedQueue(null); setSavedMetrics(null);
  }
  // A named unreadable verdict withholds every metric consumer together. A
  // transient refresh failure may keep the last answer, with a visible notice.
  const metricsNotice = refusedScopeCopy(owner, metricsRefusal);
  const metricsCopy = metricsFailed && heldMetrics === null ? drawable(savedMetrics, owner) : null;
  const metrics = metricsNotice ? null : heldMetrics ?? metricsCopy?.value ?? null;
  const search = useLocationSearch();
  const closedDrilldown = new URLSearchParams(search).get('tf') === 'closed-yesterday';
  // The epoch uses the same saved-copy rule as board detail (#1253): a
  // refusal deletes the copies; a servable failure may draw a marked copy
  // immediately, under the shared identity and age checks.
  // Refetch when a manual "sync now" completes (#301).
  const refresh = useRefreshSignal() + useRenewalSignal() + useAccessEpoch();

  // Track live completion per scope, not the presence of a restored copy.
  const openingReads = useRef({ key: scopeKey, queue: false, metrics: false });
  if (openingReads.current.key !== scopeKey) openingReads.current = { key: scopeKey, queue: false, metrics: false };

  useEffect(() => {
    const completed = openingReads.current;
    let alive = true;
    const retry = new AbortController();
    // Both issue requests describe the same scope. Once either withdraws it,
    // a later success from this refresh cannot restore its state or disk copy.
    let withdrawn = false;
    const withdraw = () => {
      withdrawn = true;
      setQueue(null); setMetrics(null);
      setQueueFailed(true); setMetricsFailed(true);
      forgetPayload(queueKey); forgetPayload(metricsKey); forgetRead(`/api/issues/metrics${dayQuery(owner ?? undefined, timeZone)}`);
      // The saved copies on the disk are already gone: the 403 or 404 that
      // withdraws the scope went through `recallQueue` or `recallMetrics` first,
      // and a refusal there forgets every saved copy.
      setSavedQueue(null); setSavedMetrics(null);
    };
    // The person table (#73). On failure the roster is empty with a notice —
    // but only when there is no roster to keep (#824). A failed refresh over a
    // page of Crew cards took every card off it, which is the blanking this
    // came from; the notice is for a page that never got a roster at all.
    fetchPeople().then(
      (list) => {
        if (!alive) return;
        setPeople({ kind: 'ready', people: list });
      },
      () => { if (alive) setPeople((prev) => (prev?.kind === 'ready' ? prev : { kind: 'failed' })); },
    );
    // Same rule, and `failed` keeps meaning what #461 made it mean: waiting for
    // an answer that is not coming. A queue that HAS an answer is not waiting.
    void retryOverviewRead(() => fetchOrgIssues(owner ?? undefined).then(
      (r) => { if (alive && !withdrawn) { completed.queue = true; setQueue(r); saveQueue(owner, r); setSavedQueue(null); setQueueFailed(false); setIssueRefusal(null); setIssueServed(true); } },
      (e: unknown) => {
        if (!alive || withdrawn) return;
        const refusal = scopeRefusal(e);
        setIssueRefusal(refusal); setIssueServed(false); setQueueFailed(true);
        setSavedQueue(recallQueue(owner, e));
        if (scopeWithdrawn(owner, refusal)) withdraw();
        throw e;
      },
    ), `/api/issues/all${owner ? `?org=${encodeURIComponent(owner)}` : ''}`, ISSUES_NOT_NOW_CODE, retry.signal, () => !completed.queue).catch(() => {});
    // A failed autocomplete refresh retains its previous options.
    fetchFilterOptions().then(
      (o) => { if (alive) { setOptions(o); } },
      () => {},
    );
    void retryOverviewRead(() => fetchIssueMetrics({ org: owner ?? undefined, timeZone }).then(
      (r) => { if (alive && !withdrawn) { completed.metrics = true; setMetrics(r); saveMetrics(owner, r, timeZone); setSavedMetrics(null); setMetricsFailed(false); setMetricsRefusal(null); } },
      (e: unknown) => {
        if (!alive || withdrawn) return;
        const refusal = scopeRefusal(e);
        setMetricsRefusal(refusal); setMetricsFailed(true);
        setSavedMetrics(recallMetrics(owner, e, timeZone));
        if (scopeWithdrawn(owner, refusal)) withdraw();
        throw e;
      },
    ), `/api/issues/metrics${dayQuery(owner ?? undefined, timeZone)}`, ISSUES_NOT_NOW_CODE, retry.signal, () => !completed.metrics).catch(() => {});
    return () => { alive = false; retry.abort(); };
  }, [refresh, owner, timeZone]);

  // One read of the person table: the roster the cards render, and the same list
  // the member-colour scheme keys off (#477).
  const crew = people.kind === 'ready' ? people.people : [];
  const roster = buildRosterFromPeople(crew);

  // What Pulse reads and what the queue renders, both derived once per fetch and
  // not per render: a keystroke in the queue's search box commits, navigates and
  // re-renders this page, and each of these walks the whole org array. A fresh
  // array identity per render also invalidates the viewer's own memos inside it.
  const source: OrgSource = useMemo(
    () => (org.kind === 'ready' ? { kind: 'ready', issues: org.queue.issues } : org),
    [org],
  );
  const viewerIssues = useMemo(
    () => (closedDrilldown ? metrics?.closedYesterday ?? [] : org.kind === 'ready' ? org.queue.issues : []).map(fromPersonalIssue),
    [org, metrics, closedDrilldown],
  );
  // How Github spells the logins this page holds data for. The ROSTER cannot
  // answer that: `Person.githubLogin` is board-assigned and admin-typed, so a
  // roster spelling `ivanroslov` beside ingest data spelling `IvanRoslov` would
  // have us "correct" a working URL into a broken one, on every load.
  const known = useMemo(
    () => dataLogins(org.kind === 'ready' ? org.queue.issues : []),
    [org],
  );

  // Who the page is filtered to — read from the URL, never held here. The array
  // is memoized on its own CONTENTS, so the derivations Pulse memoizes don't
  // re-run on every keystroke in the queue's search box. Keyed on the joined
  // string and handed back whole: splitting that string back into logins turned
  // a single crafted token carrying the separator into two of them.
  const selection = selectedLogins(search, known);
  const selectionKey = selection.join('\u0000');
  const assignees = useMemo(() => selection, [selectionKey]);
  const goal = useOverviewGoal(owner, assignees.length > 0);

  // A login the data spells differently is written back the data's way: the queue
  // matches assignees case-sensitively, so a shared or hand-edited
  // `?assignee=ivanroslov` would otherwise light a Crew card over an empty queue.
  // Nothing is corrected before the queue lands — with nothing to compare
  // against, a guess is exactly what breaks a URL that was working.
  useEffect(() => {
    const fixed = canonicalisation(window.location.search, known);
    if (fixed !== null) gotoPath(window.location.pathname + fixed, { replace: true });
  }, [search, known]);

  // A Crew card toggles its member's login in and out of the URL (#420, #461).
  // What the press SHOULD produce is decided by `pressCrewCard`, which is pure and
  // tested — including the inert card of a member with no linked Github login,
  // which returns null and navigates nowhere. All that is left here is firing it.
  // Held here rather than in `Pulse` because the whole page acts on it: a
  // refused org draws no numbers at all, and `Pulse` is one of the things that comes off.

  // The write replaces the current history entry, the way the viewer's own filter
  // writes do, so a session of filtering stays one Back press.
  const toggleMember = (p: RosterPerson) => {
    const next = pressCrewCard(window.location.search, assignees, p.githubLogin);
    if (next !== null) gotoPath(window.location.pathname + next, { replace: true });
  };
  const isActive = (p: RosterPerson) =>
    p.githubLogin != null && assignees.some((a) => a.toLowerCase() === p.githubLogin!.toLowerCase());

  // The flow strip (#666), derived from the SAME selection the Crew cards and
  // the queue's assignee filter write — `assignees`, read from the URL above.
  // Nothing here re-parses the URL and nothing holds a second copy of who is
  // pressed, which is what `crew-filter.ts` exists to make impossible.
  //
  // `canonicalisation` below rewrites the URL once after the queue lands, so the
  // selection can change on first load with nobody pressing anything. That costs
  // exactly one re-derivation of this memo off data already in hand: the strip
  // corrects itself in place rather than refetching.
  //
  // One clock, shared by the model and the component drawing it, read when the
  // inputs change: every keystroke in the queue's search box re-renders this
  // page, and `stripModel` walks the whole closed history per selected member —
  // a year and more since #817, where it was 98 days.
  // #714: the org the address narrowed to and the one thing the board has to
  // say about it, handed to ScopeLine below.
  //
  // The Oldest-open block came off this page with #815, and the aging derivation
  // went with it: what was left was a walk over the whole org queue on every
  // render feeding nothing. The oldest issue is still on the page and is the
  // flow strip's third tile now (#816) — `stripModel` walks the same queue for
  // it, so the fact survived the block and the page did not gain a second pass
  // over the same array to keep in step with the first.

  // The tiles may count a saved queue after a failed read (#1046). Only the
  // tiles: the list below draws what this page holds and nothing recalled, so
  // Issues offers no way into it then. A recalled METRICS copy is different: it
  // is the page's metrics, the way a held one has been since #824, because the
  // notice above the strip already says the page is showing the last available
  // metrics, and every block reading them sits under it.
  const queueCopy = queueFailed && queue === null ? drawable(savedQueue, owner) : null;
  const stripSource = useMemo<OrgSource>(
    () => (queueCopy ? { kind: 'ready', issues: queueCopy.value.issues } : source),
    [queueCopy, source],
  );
  // Selected people use the same response scope; incompleteness still fails the strict check.
  const combined = assignees.length > 1;
  const queueScope = (queueCopy?.value ?? queue)?.metricScope;
  const metricScope = metrics?.metricScope;
  const notComparable = {
    queue: combined && notComparableScopes(queueScope, queueScope),
    metrics: combined && notComparableScopes(metricScope, metricScope),
  };
  const strip = useMemo(() => {
    const now = Date.now();
    return { now, model: stripModel({ kind: 'org', metrics, org: stripSource, logins: assignees, owner: scope.org }, null, now) };
  }, [metrics, stripSource, assignees, scope.org]);

  useReportOutdated((queueFailed && stripSource.kind === 'ready') || (metricsFailed && metrics !== null));

  const openMetric = (closed: boolean) => {
    gotoPath(`${window.location.pathname}${viewerUrl({ assignees: [...assignees], timeframe: closed ? 'closed-yesterday' : 'any' }, 'repo')}&view=list`);
    requestAnimationFrame(() => document.getElementById(UNIT_QUEUE_ID)?.scrollIntoView({ block: 'start' }));
  };

  const rootCls = `${PAGE_RAIL} pt-5 pb-12 max-[900px]:pt-3 max-[900px]:pb-10`;

  if (people.kind === 'pending') return <div className={rootCls}><LoadingStructure surface="overview" label="overview" /></div>;

  return (
    <div className={rootCls}>
      {/* Overview is top-level — the big H1 is its identity, no breadcrumb (#391). The
          Crew leads (#358): the people are the most human part of the page, so the
          cards sit straight under the heading, above the org-wide metrics — with no
          block header of their own (#459), since they name the unit themselves. */}
      <PageHeading className="mb-6">{TAB_LABEL.team}</PageHeading>
      {scope.notice !== null && scope.org !== null ? (
        <ScopeRefusedState org={scope.org} notice={scope.notice} className="mt-0" />
      ) : (
      <>
      <CrewGrid
        people={crew}
        roster={roster}
        isActive={isActive}
        hasSelection={assignees.length > 0}
        onToggle={toggleMember}
        emptyText={people.kind === 'failed' ? 'The unit roster couldn’t be read just now.' : undefined}
      />

      {/* Reserve the wrapped notice and clearance for the card’s 6px focus outline. */}
      <p role="status" aria-hidden={!metricsFailed || metrics !== null} className={`${roster.length ? 'mt-2 mb-1' : 'mb-4'} text-sm text-dim ${metricsFailed && metrics === null ? '' : 'invisible'}`}>
        {metricsNotice
          ? metricsRefusal?.status === 404
            ? `Issue metrics do not cover ${owner}.`
            : `Issue metrics for ${owner} couldn’t be read just now.`
          : 'Issue metrics couldn’t be read just now.'}
      </p>
      {/* Today's reads (the folded team pulse), below the Crew (#358) — the unit's
          until a Crew card is pressed, that member's from then on (#461). It took
          the org queue as a prop while the Oldest-open block lived inside it; that
          block reads the queue from up here now, which is still why a press costs
          no request and why it and the list below it can never disagree about
          which issues are open. */}
      <div>
        <FlowStrip
          {...goal}
          onIssues={org.kind === 'ready' ? () => openMetric(false) : undefined}
          onClosed={metrics?.closedYesterday ? () => openMetric(true) : undefined}
          model={strip.model}
          notComparable={notComparable}
          pending={{ queue: org.kind === 'pending', metrics: metrics === null && !metricsFailed }}
          /* What the board says about the org the address narrowed to. The
             selected person is not said here: the header names them (#1450). */
          // `FlowStrip` reserves this line's space when no member is selected (#968).
          scopeLine={
            /* The figure already carries the comparison help; retain actual scope errors. */
            (!(notComparable.queue || notComparable.metrics) || scope.notice !== null) && (
              <ScopeLine scope={scope} narrowed className="flex" />
            )
          }
          /* What Issues and Throughput are counting, so a mark means the number
             moved rather than the question changing under it (#824). A Crew
             press re-scopes those two to that member, both figures land
             different, and neither of them rose or fell. `selectionKey` is
             already the joined string the memo above keys on, so the strip and
             everything else on this page agree about what is selected without a
             second derivation to keep in step. */
          subject={selectionKey}
          fromCopy={{ queue: queueFailed && stripSource.kind === 'ready', metrics: metricsFailed && metrics !== null }}
        />
        <Pulse assignees={assignees} metrics={metrics} metricsFailed={metricsFailed && metrics === null} />
      </div>

      {/* The whole unit's open work — the one issue-list system (#394), org-wide:
          a calm list by default, grouped by type, the kanban a toggle away. It
          owns every filter dimension including assignees (#461), so a Crew press
          and a manual assignee token are one selection written to one param: the
          cards write `?assignee` through `withAssignees` and the viewer writes it
          through its own commit. The heading hands the viewer the whole region
          (#447), so the queue is a block like the Pulse blocks above it. */}
      {(org.kind === 'ready' || closedDrilldown) && (
        <div className="mt-6" id={UNIT_QUEUE_ID}>
          {/* Said again here (#650), because this list is a second place the
              missing org is missing FROM: an org the board could not read has no
              rows in it, and a shorter queue reads as a quieter week.

              It stands down when the board already has something to say about
              the org the address narrowed to (#714): the line under the strip
              above says it then, and one fact stated twice in two voices reads
              as two facts. */}
          {scope.org === null && <SessionOrgScopeNotice className="mb-2" />}
          {closedDrilldown && !metrics?.closedYesterday ? <p className="state">Closed issues couldn’t be read just now.</p> : <IssueQueue
            heading={closedDrilldown ? "Closed yesterday" : "Open issues"}
            timeZone={metrics?.timeZone ?? 'UTC'}
            now={metrics?.computedAt ? Date.parse(metrics.computedAt) : undefined}
            issues={viewerIssues}
            options={options}
            persistKey="team"
            emptyText={closedDrilldown ? "No issues closed yesterday." : "No open issues across the unit right now."}
          />}
        </div>
      )}
      </>
      )}
    </div>
  );
}

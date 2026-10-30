import { forgetRead } from '../cache/read-cache';
import { useResolvedTimezone } from '../account/prefs';
import { dayQuery } from '../api/issues';
import { useReadSequence } from '../auth/use-read-sequence';
/**
 * Personal home — "Your work" (#206). The board's default surface is a personal
 * control room, not the team dashboard (that folded into the Unit tab). Top to
 * bottom:
 *   0. Flow strip (#666, #816) — Issues · Throughput · The oldest open issue,
 *      over a closed-per-day grid, with one line under it naming the scope each
 *      tile counted.
 *   1. Contributions strip — a compact one-line memory nudge of which boards I'm in.
 *   2. Your queue — my open issues, grouped by type, the kanban a toggle away.
 *
 * The minimal layout (#413, variant C): the separate "Oldest open" list block was
 * dropped — aging is one queue sort away — and Project contributions collapsed
 * from a tall stacked block to a single compact strip under the stats.
 *
 * Read-only. Personal throughput, queue, per-issue author + project membership
 * come from GET /api/issues/mine; every tile on the strip is derived from that
 * same list, so all three are scoped to me like the queue below. GET /api/delivery
 * was the fourth read on this page until #816 took the Releases tile — the last
 * thing that spent it — off the strip.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EMPTY_FILTER_OPTIONS, type FilterOptions, type PersonalIssues, fetchFilterOptions, fetchMyIssues } from '../api/issues';
import { type ProjectSummary, fetchProjects } from '../api/projects';
import { withdrawnRead } from '../api/core';
import { MINE_UNAVAILABLE, QUEUE_SUBJECT, queueEmptyState } from './mine-fallback';
import { logLoadFailure } from '../auth/session-copy';
// #824 — the last answer, kept per person, so a return visit paints before the
// network answers and a refresh never puts the page back to a skeleton.
import { useReadState } from '../cache/use-board-read';
import { scopeQuery } from '../api/core';
import { MINE_KEY, orgScopedKey, forgetPayload } from '../cache/payload-cache';
import { drawable, projectsAfterFailure, saveProjects, type RecalledProjects } from '../projects/projects-last-good';

/**
 * The empty queue, one line or two (#535).
 *
 * Two lines only when nobody could be attributed: the title states the fact and
 * the body says what has to happen, because that state is the one a person has
 * to act on rather than just read. Every other empty state is a single quiet
 * line and keeps the shape it always had.
 */
function renderQueueEmpty(state: { title: string | null; body: string }): ReactNode {
  if (state.title === null) return state.body;
  return (
    <>
      <div className="text-[13px] text-fg">{state.title}</div>
      <div className="mt-1 max-w-[52ch]">{state.body}</div>
    </>
  );
}
import { useReportOutdated, useRenewalSignal, useAccessEpoch, useRefreshSignal } from '../sync/sync-status';
import { IssueQueue } from '../ui/IssueQueue';
import { fromPersonalIssue } from '../issues-viewer/viewer-issue';
import { PageHeading, PAGE_RAIL } from '../ui/PageHeading';
import { QUEUE_REGION } from '../ui/queue-region';
import { TAB_LABEL, gotoPath } from '../route';
import { personalGoalPath, useDailyGoal } from '../goals/goals';
import { FlowStrip } from '../flow-strip/FlowStrip';
import { ScopeLine } from '../flow-strip/ScopeLine';
// #714 — what the address narrowed to, and what the board says about it.
import { useOrgScope } from '../org-scope/OrgScopeProvider';
import { useScopeState } from '../org-scope/use-scope-state';
import { scopeRefusal, scopeWithdrawn, type ScopeRefusal } from '../org-scope/scope-copy';
import { ScopeRefusedState } from '../org-scope/ScopeRefusedState';
import { stripModel } from '../flow-strip/flow-strip.vm';
import { ProjectContributions } from './ProjectContributions';
import { type BoardAt, pressBoardRing, selectedBoards } from './project-filter';
import { readViewerPrefs } from '../issues-viewer/viewer-prefs';
import { DASHBOARD_VIEWER_KEY } from './viewer-key';
import { useLocationSearch } from '../location-search';
import { BLOCK } from '../ui/block';
import { LoadingStructure } from '../ui/LoadingStructure';

const ROOT = `${PAGE_RAIL} pt-5 pb-[60px] max-[900px]:pt-3 max-[900px]:pb-10`;

/** What this page's Issues and Throughput tiles count, which is one thing and
 *  always the same thing (#824). Named rather than inlined so the reason above
 *  the prop has something to point at. */
const MY_WORK = 'me';

export function Dashboard({ takeOpeningMine }: {
  takeOpeningMine?: (org?: string, timeZone?: string) => Promise<PersonalIssues> | undefined;
}) {
  const { org: owner } = useOrgScope();
  const timeZone = useResolvedTimezone();
  const goal = useDailyGoal(personalGoalPath);
  const mineKey = orgScopedKey(MINE_KEY, owner);
  const [mine, setMine] = useReadState<PersonalIssues>(`/api/issues/mine${dayQuery(owner ?? undefined, timeZone)}`);
  // Why the queue is empty, when it is (#512). Held apart from `mine` because
  // the fallback payload cannot carry it: `login: null` in there means "no
  // answer", and the page must not read it as "no Github identity".
  const [mineError, setMineError] = useState<string | null>(null);
  // Whether a real answer is on the page. The failure handler below cannot read
  // `mine` for itself — its effect is keyed on the refresh nonce, so its closure
  // holds whatever the queue was when that effect was made. Initialised from the
  // seed, because a queue the cache painted is a real answer too.
  const holdsQueue = useRef(mine !== null);
  // The IssuesViewer's filter autocomplete — org-wide, degrades to empty (#394).
  // Seeded from the last set this person was served: an autocomplete that opens
  // empty for a second is a control that silently offers nothing.
  // The shared reader enforces the response lease before painting saved options.
  const [heldOptions, setOptions] = useReadState<FilterOptions>('/api/issues/filter-options');
  const options = heldOptions ?? EMPTY_FILTER_OPTIONS;
  // Keep the last authorized summaries on navigation and transient failures.
  // The shared cache owns permission deadlines and organization boundaries.
  const [projects, setProjects] = useReadState<ProjectSummary[], { projects: ProjectSummary[] }>(`/api/projects${scopeQuery(owner ?? undefined)}`, value => value.projects);
  const [rollupFailed, setRollupFailed] = useState(false);
  // The saved copy a failed read recalled (#1035), as `Pulse` holds it.
  const [saved, setSaved] = useState<RecalledProjects | null>(null);

  // Which boards the page is narrowed to (#750) — read from the URL on every
  // render, never held. The queue's own Project chip writes this same
  // `?project=` param through `encodeViewer`, so a ring and a chip cannot
  // disagree about what is selected, and a reload or a pasted link restores it.
  const search = useLocationSearch();
  const boardSelection = selectedBoards(search);
  // The press replaces the current history entry, the way the viewer's own
  // filter writes do, so a session of narrowing stays one Back press. What the
  // press SHOULD produce is decided by `pressBoardRing`, which is pure and
  // tested; all that is left here is firing it.
  //
  // The remembered arrangement is read HERE, at press time, and handed to the
  // pure half. The press is the write that silences storage — it takes the URL
  // from bare to `?project=` — so what storage was saying has to go into the URL
  // with it, or the queue snaps back to this page's own lead grouping under
  // every ring (#750 review). Read on the press rather than on every render:
  // this touches localStorage.
  //
  const viewerKey = DASHBOARD_VIEWER_KEY;
  const toggleBoard = (at: BoardAt) => {
    const next = pressBoardRing(
      window.location.search, boardSelection, at, readViewerPrefs(viewerKey),
    );
    if (next !== null) gotoPath(window.location.pathname + next, { replace: true });
  };
  // Issue-read coverage governs the page; Projects may cover fewer owners.
  const [refusal, setRefusal] = useState<ScopeRefusal | null>(null);
  // Whether the narrowed read on this page came back with an ANSWER — not with
  // rows, which an org can honestly have none of, but with a body. It is what
  // the device remembers (#714): a stale `/roadmap` bookmark used to write
  // `roadmap` into storage on sight, and that device's `/` then opened a board
  // refusing itself on every tab.
  const [served, setServed] = useState(false);
  // The org and the one thing to say about it, handed to ScopeLine below — this
  // page reads it, the line never reaches for it.
  const scope = useScopeState(refusal, served);

  // The previous org's boards and the previous org's refusal both go the moment
  // the address names another org, BEFORE the new read lands. Without this,
  // arriving on a served org from a refused one left the old 404 in state and
  // the page said "This board does not cover gtm" about acme. Its own
  // effect, keyed on the org alone, so a Sync now still refreshes in place.
  const scopeKey = JSON.stringify([owner, timeZone]);
  const seenOwner = useRef(scopeKey);
  if (seenOwner.current !== scopeKey) {
    seenOwner.current = scopeKey;
    setMineError(null);
    holdsQueue.current = mine !== null;
    setRefusal(null);
    setServed(false);
    setRollupFailed(false);
  }

  // Refetch when a manual "sync now" completes (#301).
  const refresh = useRefreshSignal();
  const accessEpoch = useAccessEpoch();
  const renewal = useRenewalSignal();

  const beginProjects = useReadSequence(JSON.stringify([owner, accessEpoch]));

  useEffect(() => {
    let alive = true;
    const opening = takeOpeningMine?.(owner ?? undefined, timeZone);
    // A changed identity or access check withdraws the speculative response.
    // Ask again under the verified identity instead of treating it as a refusal.
    const read = opening
      ? opening.catch(e => { if (withdrawnRead(e)) return fetchMyIssues(owner ?? undefined, undefined, timeZone); throw e; })
      : fetchMyIssues(owner ?? undefined, undefined, timeZone);
    read.then(
      (r) => { if (alive) { setMine(r); setMineError(null); holdsQueue.current = true; setRefusal(null); setServed(true); } },
      (e: Error) => {
        if (!alive) return;
        // Over a queue that already has real issues on it, a failed read changes
        // NOTHING (#824). Not the rows,
        // because replacing them with the fallback is the blanking this came
        // from; and not `mineError` either, because `stripModel` withholds the
        // Issues figure on ANY error, so raising it would empty the tile over a
        // queue that is still on the page.
        //
        // A FIRST load is the other case and #512's fallback still owns it: the
        // page has no answer, and the fallback plus the error is how it says so.
        // It is DERIVED below rather than set, so the fallback never reaches the
        // cache — stored, it would open the next visit on an empty queue under
        // "No Github login on your account", which is the claim about a person
        // that #512 exists to stop the board making.
        const refusal = scopeRefusal(e);
        setRefusal(refusal); setServed(false);
        if (scopeWithdrawn(owner, refusal)) { setMine(null); forgetPayload(mineKey); forgetRead(`/api/issues/mine${dayQuery(owner ?? undefined, timeZone)}`); holdsQueue.current = false; }
        if (holdsQueue.current) return;
        // The sentence drawn from `mineError` no longer carries the message
        // (#1055), so it is written here, where the rejection was caught. Below
        // the `holdsQueue` return on purpose: a failed read over a queue that
        // is still on the page changes nothing and says nothing.
        logLoadFailure(QUEUE_SUBJECT, e.message);
        setMineError(e.message);
      },
    );
    fetchFilterOptions().then(
      (o) => { if (alive) { setOptions(o); } },
      // Nothing on failure. A hiccup should not cost the filters the set they
      // already had, and an empty set silently narrows what the control offers.
      () => {},
    );
    return () => { alive = false; };
    // The ORG is in the list because `fetchMyIssues` now carries it (#926) —
    // `scope.org` and the `owner` this effect reads are the same value, both
    // off `useOrgScope`, so this covers `owner` and `mineKey` with it.
    // `fetchFilterOptions` still answers the same for either org and is
    // re-read on a navigation for the cost of one request. The rollup, which
    // also carries the org, has its own effect below (#892 review, C2).
    //
    // The EPOCH and the RENEWAL are in the list because both of these reads
    // are permission-sensitive — the queue joins project memberships and the
    // options join `listProjects` — so an expired check has to drop them and a
    // new one has to fetch them again (#905). Without those two the page keeps
    // both across a check it never passed.
  }, [refresh, scope.org, timeZone, accessEpoch, renewal, takeOpeningMine]);

  useEffect(() => {
    const accept = beginProjects();
    fetchProjects(owner ?? undefined).then(
      (r) => {
        if (!accept()) return;
        setProjects(r.projects);
        saveProjects(owner, r.projects);
        setSaved(null);
        setRollupFailed(false);
      },
      (e: unknown) => {
        if (!accept()) return;
        setRollupFailed(true);
        // The same one rule Overview reads (#1060): a refusal this page may not
        // answer for takes the boards it is holding, the stored copy behind
        // them and every saved copy; a "not now" leaves all three. This asked
        // `scopeWithdrawn` — a 403 or an org 404 — so a 500, which is how a
        // Github FORBIDDEN arrives, drew the boards on regardless.
        const after = projectsAfterFailure(owner, e);
        setSaved(after.saved);
        if (!after.keepHeld) setProjects(null);
      },
    );
  }, [refresh, owner, accessEpoch, renewal, beginProjects, setProjects]);

  // What the page draws: the answer we hold, or #512's fallback once a first
  // read has failed with nothing behind it. Derived rather than held, so the
  // fallback is never a value `setMine` was given and never a value the cache
  // was asked to keep.
  const queue = mine ?? (mineError !== null ? MINE_UNAVAILABLE : null);

  // A failed read may draw a copy: the boards held, or the saved ones (#1035).
  const copy = rollupFailed ? drawable(saved, owner) : null;
  const boards = projects ?? copy?.value ?? null;
  useReportOutdated(rollupFailed && boards !== null && Boolean(mine?.projectContributions?.length));

  // One clock for the model and for the strip that draws it, read when the data
  // changes rather than on every render: the grid's calendar and the tiles must
  // agree on which day is today, and `stripModel` walks the whole closed history
  // board-api sends — a year and more since #817, where it was 98 days.
  const strip = useMemo(() => {
    const now = Date.now();
    return { now, model: stripModel({ kind: 'me', mine: queue, error: mineError }, null, now) };
  }, [queue, mineError]);

  return (
    <div className={ROOT}>
      {/* Your work is top-level — its identity is the big H1, no breadcrumb (#391).
          The "Synced" stamp lives in the top bar (#256). */}
      <PageHeading showScope={false} className="mb-[22px]">{TAB_LABEL.dashboard}</PageHeading>
      {scope.notice !== null && scope.org !== null ? (
        <ScopeRefusedState org={scope.org} notice={scope.notice} className="mt-0" />
      ) : (
      <>
      {queue ? (
        <FlowStrip
          {...goal}
          model={strip.model}
          /* Under the tiles, saying which scope each one counted. Nobody is
             selected on this page and the address narrows nothing in the
             ordinary case, so since #816 this line usually renders nothing at
             all — its Releases sentence went with the Releases tile. */
          scopeLine={<ScopeLine scope={scope} narrowed />}
          /* A constant, and that is the honest answer here rather than an
             oversight (#824). Nothing on Your work re-scopes the strip: Issues
             and Throughput are the reader's own work on every render, and the
             boards a ring selects narrow the queue below and never these tiles.
             So the subject never changes, and a figure that lands different
             really did move. Overview passes its Crew selection instead. */
          subject={MY_WORK}
        />
      ) : (
        <LoadingStructure surface="work" label="your work" className="mb-3 min-h-[92px]" />
      )}

      {/* Contributions (#380/#413) — a compact one-line memory nudge: which boards
          am I in, and which have I moved (or not) lately. Sits right under the
          stats, above the queue. Renders itself away when the caller is on no
          boards (quiet by default). */}
      {mine && mine.projectContributions && mine.projectContributions.length > 0 && (
        <div className="mb-3">
          <ProjectContributions
            contributions={mine.projectContributions}
            projects={boards}
            failed={rollupFailed}
            selected={boardSelection}
            onToggle={toggleBoard}
          />
        </div>
      )}

      {mine ? (
        <div>
          <IssueQueue
            heading="Your queue"
            issues={[...mine.issues, ...(mine.recentlyClosed ?? [])].map(fromPersonalIssue)}
            /* THE PAYLOAD'S CLOCK, not the reader's (#1015). The timeframe
               filters cut a window out of the rows this payload carries, and
               `/api/issues/mine` is held from `localStorage` for up to a day and
               kept on screen through a failed read — so dated off `Date.now()`,
               "closed yesterday" selects a day the rows were never gathered for.
               Overview has passed `computedAt` to this same component all along;
               Your work could not until `PersonalIssues` carried a stamp, and
               the two pages answered differently on identical staleness. */
            timeZone={mine.timeZone ?? 'UTC'}
            now={mine.computedAt ? Date.parse(mine.computedAt) || undefined : undefined}
            options={options}
            persistKey={viewerKey}
            emptyText={renderQueueEmpty(queueEmptyState({ error: mineError, login: mine.login }))}
          />
        </div>
      ) : mineError !== null ? (
        <div className={QUEUE_REGION}>{renderQueueEmpty(queueEmptyState({ error: mineError, login: null }))}</div>
      ) : (
        // Keep the queue's region in place while its data loads.
        <LoadingStructure surface="queue" housed label="your queue" className={`${QUEUE_REGION} min-h-[220px]`} />
      )}
      </>
      )}
    </div>
  );
}

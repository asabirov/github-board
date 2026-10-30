import { forgetRead } from '../cache/read-cache';
import { useResolvedTimezone } from '../account/prefs';
import { dayQuery } from '../api/issues';
import { boardLinkProps } from '../repos/repo-page-parts';
import { useEffect, useState } from 'react';
import { fetchOrgIssues, fetchIssueMetrics, type OrgQueue, type IssueMetrics } from '../api/issues';
import { fetchRepos, type ReposView } from '../api/repos';
import { useReadState } from '../cache/use-board-read';
import { scopeQuery } from '../api/core';
import { ORG_QUEUE_KEY, METRICS_KEY, orgScopedKey, reposKey, forgetPayload } from '../cache/payload-cache';
import { useAccessEpoch, useRefreshSignal, useRenewalSignal, useReportOutdated } from '../sync/sync-status';
import { useReadSequence } from '../auth/use-read-sequence';
import { useOrgScope } from '../org-scope/OrgScopeProvider';
import { scopeRefusal, scopeWithdrawn, type ScopeRefusal } from '../org-scope/scope-copy';
import { useScopeState } from '../org-scope/use-scope-state';
import { ScopeRefusedState } from '../org-scope/ScopeRefusedState';
import { usePeople } from '../people-ctx';
import { PageCrumb } from '../PageCrumb';
import { PageHeading, PAGE_RAIL } from '../ui/PageHeading';
import { BLOCK } from '../ui/block';
import { Avatar } from '../ui/avatar';
import { LoadingStructure } from '../ui/LoadingStructure';
import { DayGrid } from '../flow-strip/DayGrid';
import { dateLabel } from '../flow-strip/flow-strip.vm';
import { fromPersonalIssue } from '../issues-viewer/viewer-issue';
import { IssueSummaryRows } from '../issues-viewer/IssueSummaryRows';
import { mayCloseIssue } from '../ui/IssueActions';
import { useMe } from '../use-me';
import { repoPath } from '../route';
import { personView } from './person-view';

const CARD = `${BLOCK} p-4`;

export function PersonPage({ login }: { login: string }) {
  const { org } = useOrgScope();
  const timeZone = useResolvedTimezone();
  const queueKey = orgScopedKey(ORG_QUEUE_KEY, org);
  const metricsKey = orgScopedKey(METRICS_KEY, org);
  const repoKey = reposKey(org);
  const [queue, setQueue] = useReadState<OrgQueue>(`/api/issues/all${scopeQuery(org ?? undefined)}`);
  const [metrics, setMetrics] = useReadState<IssueMetrics>(`/api/issues/metrics${dayQuery(org ?? undefined, timeZone)}`);
  const [repos, setRepos] = useReadState<ReposView>(`/api/repos${scopeQuery(org ?? undefined)}`);
  const [failed, setFailed] = useState({ queue: false, metrics: false, repos: false });
  const [refusal, setRefusal] = useState<ScopeRefusal | null>(null);
  const [served, setServed] = useState(false);
  const scope = useScopeState(refusal, served);
  const epoch = useAccessEpoch();
  const refresh = useRefreshSignal();
  const renewal = useRenewalSignal();
  const readKey = JSON.stringify([org, login, timeZone, epoch]);
  const beginQueue = useReadSequence(readKey);
  const beginMetrics = useReadSequence(readKey);
  const beginRepos = useReadSequence(readKey);
  const people = usePeople();
  const { me } = useMe();
  useEffect(() => {
    const accept = { queue: beginQueue(), metrics: beginMetrics(), repos: beginRepos() };
    let alive = true;
    let withdrawn = false;
    const live = (source: keyof typeof failed) => alive && !withdrawn && accept[source]();
    fetchOrgIssues(org ?? undefined).then(value => {
      if (!live('queue')) return;
      setQueue(value); setServed(true); setRefusal(null);
      setFailed(previous => ({ ...previous, queue: false }));
    }, error => fail('queue', error));
    fetchIssueMetrics({ org: org ?? undefined, timeZone }).then(value => {
      if (!live('metrics')) return;
      setMetrics(value); setFailed(previous => ({ ...previous, metrics: false }));
    }, error => fail('metrics', error));
    fetchRepos(org ?? undefined).then(value => {
      if (!live('repos')) return;
      setRepos(value); setFailed(previous => ({ ...previous, repos: false }));
    }, error => fail('repos', error));
    function fail(source: keyof typeof failed, error: unknown) {
      if (!live(source)) return;
      setFailed(previous => ({ ...previous, [source]: true }));
      const denied = scopeRefusal(error);
      if (scopeWithdrawn(org, denied)) {
        withdrawn = true;
        setFailed({ queue: true, metrics: true, repos: true });
        setRefusal(denied); setServed(false);
        setQueue(null); setMetrics(null); setRepos(null);
        [queueKey, metricsKey, repoKey].forEach(forgetPayload);
        forgetRead(`/api/issues/metrics${dayQuery(org ?? undefined, timeZone)}`);
      }
    }
    return () => { alive = false; };
  }, [org, login, timeZone, epoch, refresh, renewal, beginQueue, beginMetrics, beginRepos, setQueue, setMetrics, setRepos]);
  useReportOutdated(!!((failed.queue && queue) || (failed.metrics && metrics) || (failed.repos && repos)));
  const view = personView(login, people, queue, metrics, repos);
  const figures = [
    ['Open issues assigned', view.known && view.assigned ? view.assigned.length : null],
    ['Closed in the last 7 days', view.member?.closed ?? null],
    ['Opened in the last 7 days', view.member?.opened ?? null],
  ] as const;
  return <div className={`${PAGE_RAIL} flex flex-col gap-4 pt-5 pb-10`}>
    <PageCrumb />
    <div className="flex items-center gap-3.5">
      <span aria-hidden="true"><Avatar name={view.name} login={login} px={96} className="size-12!" showTitle={false} /></span>
      <PageHeading className="min-w-0 break-words">{view.name}</PageHeading>
    </div>
    {scope.notice && scope.org ? <ScopeRefusedState org={scope.org} notice={scope.notice} /> : <>
      {!view.known && queue && metrics && repos && <p className={`${CARD} text-[13px] text-dim`}>The board holds nothing for {login} in this scope.</p>}
      <div className="grid grid-cols-3 gap-3 max-[560px]:gap-2">{figures.map(([label, value]) => <div key={label} className={`${CARD} min-w-0`}>
        <div className="text-[30px] font-semibold tabular-nums max-[560px]:text-[25px]" aria-label={value === null ? `${label} couldn’t be read` : undefined}>{value ?? '—'}</div>
        <div className="mt-2 text-[12px] text-dim max-[560px]:text-[11px]">{label}</div>
      </div>)}</div>
      <section className={CARD} aria-label="Activity history">
        <h2 className="mb-3 text-base font-semibold">Activity</h2>
        {view.grid ? <DayGrid {...view.grid} label={`Issues closed per day by ${view.name}, ending ${dateLabel(view.grid.endsOn)}`} /> : <p className="text-[13px] text-dim">{failed.metrics || metrics ? 'Activity couldn’t be read just now.' : 'Loading personal activity…'}</p>}
      </section>
      <section aria-label="Assigned open issues">
        <h2 className="mb-3 text-base font-semibold">Assigned open issues</h2>
        {view.assigned ? view.assigned.length ? <div className={CARD}><IssueSummaryRows issues={view.assigned.map(fromPersonalIssue)} mayClose={mayCloseIssue(me)} /></div> : <p className={`${CARD} text-[13px] text-dim`}>{view.known ? 'No open issues assigned in this scope.' : 'The board holds no assigned issues for this login.'}</p> : failed.queue ? <p className={`${CARD} text-[13px] text-dim`}>Assigned issues couldn’t be read just now.</p> : <LoadingStructure surface="work" label="assigned issues" />}
      </section>
      <section aria-label="Owned repositories">
        <h2 className="mb-3 text-base font-semibold">Owned repositories</h2>
        {view.owned ? view.owned.length ? <div className="flex flex-col gap-3">{view.owned.map(repo => <a key={repo.full} {...boardLinkProps(repoPath(repo.full))} className={`${CARD} min-h-11 text-[14px] font-medium hover:underline focus-visible:outline-3 focus-visible:outline-offset-2`}>{repo.full}</a>)}</div> : <p className={`${CARD} text-[13px] text-dim`}>{repos?.unreadableOrgs?.length || repos?.repos.some(repo => repo.ownerState === 'unreadable') ? 'No owned repositories here. The owner of some repos couldn’t be read, so this list may be short.' : 'No owned repositories in this scope.'}</p> : failed.repos ? <p className={`${CARD} text-[13px] text-dim`}>Repositories couldn’t be read just now.</p> : <LoadingStructure surface="repos" label="owned repositories" />}
      </section>
    </>}
  </div>;
}

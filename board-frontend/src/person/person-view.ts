import type { IssueMetrics, OrgQueue } from '../api/issues';
import type { Person } from '../api/people';
import type { ReposView } from '../api/repos';
import { gridFor, stripModel } from '../flow-strip/flow-strip.vm';

/** URL identity is an exact Github login, never a display-name or fuzzy match. */
export function personView(login: string, people: Person[], queue: OrgQueue | null, metrics: IssueMetrics | null, repos: ReposView | null) {
  const member = metrics?.byMember.find(row => row.login === login) ?? null;
  const identity = people.find(person => person.githubLogin === login);
  const assigned = queue?.issues.filter(issue => (issue.state ?? 'open') === 'open' && issue.assignees.includes(login)) ?? null;
  const owned = repos?.repos.filter(repo => repo.ownerState !== 'unreadable' && repo.owner?.login === login) ?? null;
  const known = !!member || !!assigned?.length || !!owned?.length;
  const name = known ? identity?.displayName || member?.name || owned?.[0]?.owner?.name || login : login;
  // Preserve the member series; absent member history never falls back to org totals.
  const selectedMetrics = metrics && member ? { ...metrics, byMember: [member], closeEvents: undefined } : null;
  // NOT `updatedAt` (#1015). That stamp is overwritten by board-api with the raw
  // issue cache's fetch time, which is served stale-while-revalidate and can sit
  // days behind the day the series end on — so anchoring a grid to it draws the
  // closes on the wrong cells with the labels agreeing. `stripModel` re-derives
  // this from `computedAt` itself, so the caller's clock is only ever the
  // fallback for a payload that carries no stamp at all.
  const now = Date.parse(metrics?.computedAt ?? '') || Date.now();
  const model = stripModel({ kind: 'org', metrics: selectedMetrics, org: queue ? { kind: 'ready', issues: queue.issues } : { kind: 'pending' }, logins: [login] }, null, now);
  return { name, known, assigned, owned, member, grid: gridFor(model, null) };
}

import { createHash } from 'node:crypto';
import type { IssueActivity, IssueActivityEvent, Person } from './issue-detail.types';

type Here = {
  owner: string; repo: string; number: number;
  /** Whether this timeline was read under the VIEWING person's own Github
   *  credential rather than a deployment one (#892). See `reference`. */
  viewerCredential?: boolean;
};
type RecordValue = Record<string, unknown>;
const object = (v: unknown): RecordValue => v !== null && typeof v === 'object' ? v as RecordValue : {};
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
const KINDS = new Set(['labeled', 'unlabeled', 'assigned', 'unassigned', 'milestoned', 'demilestoned', 'cross-referenced', 'referenced', 'closed', 'reopened']);
const login = (v: unknown): string | null => typeof v === 'string' && /^[a-z\d](?:[a-z\d-]{0,38})(?:\[bot\])?$/i.test(v) ? v : null;
const person = (v: unknown): Person | null => {
  const name = login(object(v).login);
  return name ? { login: name, name: null } : null;
};

function reference(e: RecordValue, here: Here): IssueActivityEvent['reference'] {
  const issue = object(object(e.source).issue);
  const raw = e.event === 'referenced' ? e.commit_url : issue.html_url;
  if (typeof raw !== 'string') return null;
  // Validate the original string, not a URL parser's normalized version of it.
  // No userinfo, query, fragments or dot-path normalization may create a link.
  const match = /^https:\/\/github\.com\/([a-z\d][a-z\d-]*)\/([a-z\d_.-]+)\/(issues|pull)\/([1-9]\d*)$/i.exec(raw);
  const commit = /^https:\/\/api\.github\.com\/repos\/([a-z\d][a-z\d-]*)\/([a-z\d_.-]+)\/commits\/([a-f\d]{40})$/i.exec(raw);
  const parts = match ?? commit;
  if (!parts || ['.', '..'].includes(parts[2])) return null;
  const sameRepo = parts[1].toLowerCase() === here.owner.toLowerCase() && parts[2].toLowerCase() === here.repo.toLowerCase();
  // A reference in another repository is the viewer's to follow when the timeline
  // that named it was read under their OWN credential (#892): Github answered
  // that request with what THEY may see, so handing back the source it returned
  // tells them nothing they could not already read. A deployment credential
  // carries no such promise -- it may see a private repository the caller cannot
  // -- so that read still withholds, and an explicitly public source still links
  // without needing the argument at all.
  //
  // Cross-repo commits still require the viewer credential: the timeline has no
  // repository visibility for them to establish a public source on deployment reads.
  //
  // Never publish titles (including feedback titles) or commit messages.
  if (!sameRepo && !here.viewerCredential && (commit || object(issue.repository).private !== false)) return null;
  if (match) return { url: raw, label: sameRepo ? `#${match[4]}` : `${match[1]}/${match[2]}#${match[4]}` };
  return { url: `https://github.com/${parts[1]}/${parts[2]}/commit/${parts[3]}`, label: parts[3].slice(0, 7) };
}

export function shapeActivityEvent(raw: unknown, here: Here): IssueActivityEvent | null {
  const e = object(raw);
  if (typeof e.event !== 'string' || !KINDS.has(e.event)) return null;
  const createdAt = text(e.created_at);
  if (!createdAt || !/^\d{4}-\d{2}-\d{2}T/.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) return null;
  let id = typeof e.id === 'number' && Number.isSafeInteger(e.id) && e.id > 0 ? String(e.id) : text(e.node_id);
  // REST cross-reference events have no event ID. Hash their stable source ID
  // and time; a private source's identifier must not ride out in our event key.
  if (!id && e.event === 'cross-referenced') {
    const source = object(object(e.source).issue);
    const identity = source.node_id ?? source.id ?? source.html_url;
    if (typeof identity === 'string' || typeof identity === 'number') {
      id = `reference-${createHash('sha256').update(JSON.stringify([identity, createdAt])).digest('hex')}`;
    }
  }
  if (!id) return null;
  const result: IssueActivityEvent = {
    id, kind: e.event as IssueActivityEvent['kind'], createdAt,
    actor: person(e.assigner) ?? person(e.actor),
  };
  if (e.event === 'labeled' || e.event === 'unlabeled') result.label = text(object(e.label).name);
  if (e.event === 'assigned' || e.event === 'unassigned') result.assignee = login(object(e.assignee).login);
  if (e.event === 'milestoned' || e.event === 'demilestoned') result.milestone = text(object(e.milestone).title);
  if (e.event === 'cross-referenced' || e.event === 'referenced') result.reference = reference(e, here);
  return result;
}

type ReadPage = (args: {owner: string; repo: string; issue_number: number; per_page: number; page: number}) => Promise<{data: unknown; headers: {link?: string}}>;

/** Ten pages bounds work on very large threads. Each page includes comments,
 * which stay on their existing read/action path and are not duplicated here. */
export async function readActivity(read: ReadPage, here: Here): Promise<IssueActivity> {
  const events = new Map<string, IssueActivityEvent>();
  let incomplete = false;
  let pagesRead = 0;
  const result = (state: IssueActivity['state']): IssueActivity => ({
    state,
    events: [...events.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
  });
  try {
    for (let page = 1; page <= 10; page++) {
      const response = await read({owner: here.owner, repo: here.repo, issue_number: here.number, per_page: 100, page});
      if (!Array.isArray(response.data)) throw new Error('Invalid timeline page');
      pagesRead++;
      for (const raw of response.data) {
        const event = shapeActivityEvent(raw, here);
        if (event) {
          if (!events.has(event.id)) events.set(event.id, event);
        } else if (KINDS.has(String(object(raw).event))) incomplete = true;
      }
      if (!/(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers.link ?? '')) return result(incomplete ? 'partial' : 'read');
    }
    return result('partial');
  } catch {
    // Keep readable issue/comments. Failure is a state, never an empty history,
    // and raw upstream errors can contain private repository details.
    return result(pagesRead ? 'partial' : 'unreadable');
  }
}

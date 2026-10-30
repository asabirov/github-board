// Preload for run.sh: replaces globalThis.fetch for api.github.com and
// github.com with a synthetic Github and appends one JSON line per request to
// $FAKE_GH_LOG. Nothing reaches the real Github, so a run costs no quota.
//
// The org shape is FAKE_ORGS="acme:96:8,globex:29:4" (org:repos:members).
// Every REST list answers in one page with no Link header, so each paginate() is
// one request: the counts are exact for calls and a floor for pages. Real page
// counts are added by arithmetic in docs/ops/github-request-budget.md.
//
// Each core REST GET answer carries an ETag of its bytes, and a request that
// sends it back gets a 304 with no body, as on Github. X-RateLimit-Used counts
// every answer per credential and bucket except those 304s, and each log line
// carries the status and that count.
//
// Projects boards are FAKE_BOARDS="acme:150,20,20,20;globex:20,20"
// (org:items on each board). Unset, no org has a board, which is the shape the
// budget doc's first table was taken in. A board's items page 100 at a time, as
// on Github, so a board over 100 items costs its continuation. Each GraphQL line
// in the log carries `pts`, the document's cost by Github's formula.
//
// A signed-in person's App grants are FAKE_GRANTS="acme,globex", read
// on every request: `GET /user/installations` answers one installation per named
// owner and `GET /user/installations/{id}/repositories` answers that owner's
// repositories. Unset, a person holds no installation, which is the shape every
// earlier count was taken in.
//
// Issues added mid-run come from FAKE_ISSUES, read on every request: one JSON
// object a line, `{ "repo": "owner/name", "issue": { ...REST issue } }`, added
// to that repo's list. v5.sh writes it just before it delivers the same issue
// as a webhook, so Github's list and the delivery agree, as they would.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { grantsFrom, installationId, orgsFrom, repoAtId, repoId } from './fake-shape.mjs';
import { points } from './points.mjs';

const LOG = process.env.FAKE_GH_LOG;
if (!LOG) throw new Error('fake-github.mjs: set FAKE_GH_LOG to the log file path');
const orgs = orgsFrom();
const boards = new Map(
  (process.env.FAKE_BOARDS ?? '').split(';').filter(Boolean).map((s) => {
    const [org, sizes = ''] = s.split(':');
    return [org.toLowerCase(), sizes.split(',').filter(Boolean).map((n, i) => ({ number: i + 1, items: Number(n) }))];
  }),
);
const realFetch = globalThis.fetch;

function repoList(org) {
  const o = orgs.get(org.toLowerCase());
  const n = o ? o.repos : 0;
  return Array.from({ length: n }, (_, i) => ({
    id: repoId(orgs, org, i), name: `repo-${i}`, full_name: `${org}/repo-${i}`, owner: { login: org },
    archived: false, fork: false, has_issues: true, default_branch: 'main',
    html_url: `https://github.com/${org}/repo-${i}`, pushed_at: '2026-09-01T00:00:00Z',
  }));
}

/** One installation of the board's App on a synthetic org, as
 *  `GET /user/installations` describes it. Every synthetic owner is an
 *  organization, so none is filtered out as somebody else's personal account. */
function installation(org) {
  return {
    id: installationId(orgs, org), app_slug: 'board-synthetic', repository_selection: 'all',
    account: { id: installationId(orgs, org) * 10, login: org, type: 'Organization' },
    suspended_at: null, permissions: { issues: 'read', metadata: 'read', contents: 'read' },
  };
}

const NO_PROJECTS = {
  data: {
    organization: {
      projectsV2: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      repositories: { totalCount: 0, nodes: [] },
      projectV2: null,
    },
    merges: { nodes: [] },
    unassignedPrs: { issueCount: 0 },
    repository: null,
  },
};

/** One page of a list of `total`, starting after cursor `after`. */
function page(total, size, after) {
  const from = after ? Number(after) : 0;
  const to = Math.min(total, from + size);
  return { from, to, pageInfo: { hasNextPage: to < total, endCursor: to < total ? String(to) : null } };
}

function item(org, i) {
  const closed = i % 4 === 0;
  return {
    status: null, fieldValues: { nodes: [] },
    content: {
      __typename: 'Issue', number: i + 1, title: `Issue ${i + 1}`, url: `https://github.com/${org}/repo-0/issues/${i + 1}`,
      state: closed ? 'CLOSED' : 'OPEN', closedAt: closed ? '2026-09-05T00:00:00Z' : null,
      createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
      repository: { nameWithOwner: `${org}/repo-0` }, author: { login: 'someone' }, parent: null, body: '',
      labels: { totalCount: 0, nodes: [] }, assignees: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] },
      timelineItems: { nodes: [] }, lastActivity: { nodes: [] },
    },
  };
}

function board(org, b, itemsFirst, itemsAfter) {
  const node = { id: `PVT_${org}_${b.number}`, number: b.number, title: `Board ${org} ${b.number}`,
    url: `https://github.com/orgs/${org}/projects/${b.number}`, closed: false };
  if (itemsFirst === undefined) return node;
  const p = page(b.items, itemsFirst, itemsAfter);
  return { ...node, items: { totalCount: b.items, pageInfo: p.pageInfo,
    nodes: Array.from({ length: p.to - p.from }, (_, k) => item(org, p.from + k)) } };
}

/** The Projects documents answer from FAKE_BOARDS; every other document gets
 *  the empty answer the harness always gave. */
function graphql(query, variables) {
  const org = String(variables.owner ?? '');
  const list = boards.get(org.toLowerCase()) ?? [];
  const items = /items\(first:\s*(\d+)/.exec(query);
  let m;
  if ((m = /projectsV2\(first:\s*(\d+)/.exec(query))) {
    const p = page(list.length, Number(m[1]), variables.after);
    return { data: { organization: { projectsV2: { totalCount: list.length, pageInfo: p.pageInfo,
      nodes: list.slice(p.from, p.to).map((b) => board(org, b, items ? Number(items[1]) : undefined)) } } } };
  }
  if (/projectV2\(number:/.test(query)) {
    const b = list.find((x) => x.number === Number(variables.number));
    return { data: { organization: { projectV2: b ? board(org, b, items ? Number(items[1]) : 100, variables.after) : null } } };
  }
  return NO_PROJECTS;
}

function answer(path) {
  let m;
  if (path === '/graphql') return NO_PROJECTS;
  if ((m = path.match(/^\/orgs\/([^/]+)\/repos$/))) return repoList(m[1]);
  if ((m = path.match(/^\/orgs\/([^/]+)\/members$/))) {
    const o = orgs.get(m[1].toLowerCase());
    return Array.from({ length: o ? o.members : 0 }, (_, i) => ({ login: `${m[1]}-member-${i}` }));
  }
  if (path.startsWith('/search/')) return { total_count: 0, incomplete_results: false, items: [] };
  if (/\/properties\/schema$/.test(path)) return [{ property_name: 'dri', allowed_values: ['a'], values_editable_by: 'org_actors' }];
  if (/\/properties\/values$/.test(path)) return [];
  if (/\/alerts$/.test(path)) return [];
  if (/\/actions\/runs$/.test(path)) return { total_count: 0, workflow_runs: [] };
  if (/\/settings\/billing\/usage$/.test(path)) return { usageItems: [] };
  if (/\/readme$/.test(path)) return { __status: 404, message: 'Not Found' };
  if (path === '/user') return { login: 'machine-user', id: 1, type: 'User' };
  if (path === '/user/installations') {
    const granted = grantsFrom(orgs);
    return { total_count: granted.length, installations: granted.map((o) => installation(o.org)) };
  }
  if ((m = path.match(/^\/user\/installations\/(\d+)\/repositories$/))) {
    const granted = grantsFrom(orgs).find((o) => installationId(orgs, o.org) === Number(m[1]));
    const repos = granted ? repoList(granted.org) : [];
    return { total_count: repos.length, repositories: repos.map((r) => ({ ...r, permissions: { admin: false, push: true, pull: true } })) };
  }
  if (/\/issues$/.test(path)) return [];
  if (/\/comments$/.test(path)) return [];
  if (/\/labels$/.test(path) || /\/milestones$/.test(path) || /\/assignees$/.test(path)) return [];
  if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/))) {
    return { number: Number(m[3]), title: 't', state: 'open', body: '', labels: [], assignees: [], user: { login: 'x' },
      html_url: `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}`, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' };
  }
  if ((m = path.match(/^\/repositories\/(\d+)$/))) {
    const found = repoAtId(orgs, m[1]);
    if (!found) return { __status: 404, message: 'Not Found' };
    return { id: Number(m[1]), name: found.name, full_name: `${found.org}/${found.name}`, owner: { login: found.org },
      archived: false, fork: false, has_issues: true, permissions: { admin: true, push: true, pull: true } };
  }
  if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
    // The id is Github's, and board binds its destinations to it (#1374), so a
    // repository answered without one is refused as having no verified identity
    // and the boot retries in the background. `repo-<i>` gets the same id the
    // org listing gave it. Any other name gets one derived from the name, which
    // is stable between runs and outside the synthetic orgs' range, so
    // `GET /repositories/{id}` answers 404 for it, as it would for a
    // repository no listing named.
    const index = /^repo-(\d+)$/.exec(m[2]);
    const id = index ? repoId(orgs, m[1], Number(index[1]))
      : 9_000_000 + (parseInt(createHash('sha1').update(`${m[1]}/${m[2]}`).digest('hex').slice(0, 8), 16) % 1_000_000);
    return { id, name: m[2], full_name: `${m[1]}/${m[2]}`, owner: { login: m[1] }, archived: false, fork: false, has_issues: true, permissions: { admin: true, push: true, pull: true } };
  }
  if (/^\/orgs\/[^/]+$/.test(path)) return { login: path.split('/')[2] };
  return {};
}

/** Repos whose issue list has changed since boot, one `owner/repo` a line, read
 *  from FAKE_CHURN on every request so run.sh can change them mid-run. */
function churned() {
  if (!process.env.FAKE_CHURN) return new Set();
  try { return new Set(readFileSync(process.env.FAKE_CHURN, 'utf8').split('\n').filter(Boolean)); } catch { return new Set(); }
}

/** Issues FAKE_ISSUES adds to `full`'s list. */
function addedIssues(full) {
  if (!process.env.FAKE_ISSUES) return [];
  try {
    return readFileSync(process.env.FAKE_ISSUES, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).filter((e) => e.repo === full).map((e) => e.issue);
  } catch {
    return [];
  }
}

/** The issue `POST /repos/{owner}/{repo}/issues` made, as Github answers one.
 *  The number is fixed: the synthetic Github keeps no issue it was sent, so a
 *  caller that reads the list back sees what the list already said. */
function created(full, sent) {
  let title = '';
  try { title = String(JSON.parse(String(sent ?? '{}')).title ?? ''); } catch { title = ''; }
  return { number: 4242, title, state: 'open', body: '', labels: [], assignees: [], user: { login: 'machine-user' },
    html_url: `https://github.com/${full}/issues/4242`, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', closed_at: null };
}

function changedIssue(full) {
  return [{ number: 1, title: 'Changed since boot', state: 'open', body: '', labels: [], assignees: [], user: { login: 'x' },
    html_url: `https://github.com/${full}/issues/1`, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-11T00:00:00Z', closed_at: null }];
}

// X-RateLimit-Used per credential and per bucket, as Github keeps it: every
// answer counts except a 304 to a conditional request ("Making a conditional
// request does not count against your primary rate limit if a 304 response is
// returned", REST best practices, read 2026-09-10).
const used = new Map();
function bucket(path) {
  if (path === '/graphql') return 'graphql';
  return path.startsWith('/search/') ? 'search' : 'core';
}

globalThis.fetch = async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname !== 'api.github.com' && url.hostname !== 'github.com') return realFetch(input, init);
  const method = (init.method ?? (typeof input === 'object' && input.method) ?? 'GET').toUpperCase();
  const sent = new Headers(init.headers);
  let op = '';
  let pts;
  let next;
  let body;
  if (url.pathname === '/graphql' && init.body) {
    let doc = {};
    try { doc = JSON.parse(String(init.body)); } catch { op = '?'; }
    const query = doc.query ?? '';
    const variables = doc.variables ?? {};
    op ||= query.replace(/\s+/g, ' ').trim().slice(0, 90);
    pts = points(query, variables);
    next = Boolean(variables.after);
    body = graphql(query, variables);
  } else {
    const repo = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/);
    body = repo && method === 'POST' ? created(repo[1], init.body)
      : repo ? [...(churned().has(repo[1]) ? changedIssue(repo[1]) : []), ...addedIssues(repo[1])]
      : answer(url.pathname);
  }
  const text = JSON.stringify(body);
  let status = body && body.__status ? body.__status : 200;
  // Search is left untagged: whether a 304 there is free of the search limit
  // is not documented, so no saving on it is claimed.
  const res = bucket(url.pathname);
  const etag = method === 'GET' && res === 'core' && status === 200 ? `W/"${createHash('sha1').update(text).digest('hex')}"` : undefined;
  if (etag && sent.get('if-none-match') === etag) status = 304;
  const who = `${sent.get('authorization') ?? ''} ${res}`;
  if (status !== 304) used.set(who, (used.get(who) ?? 0) + 1);
  const n = used.get(who) ?? 0;
  appendFileSync(LOG, JSON.stringify({ t: Date.now(), method, path: url.pathname, q: url.search.slice(0, 80), op, pts, next, status, res, used: n }) + '\n');
  const answerBody = new Response(status === 304 ? null : text, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(etag ? { etag } : {}),
      'x-ratelimit-limit': '5000', 'x-ratelimit-used': String(n), 'x-ratelimit-remaining': String(Math.max(0, 5000 - n)),
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600), 'x-ratelimit-resource': res,
      'x-oauth-scopes': 'repo, read:org, read:project',
    },
  });
  // A real answer carries the URL it came from, and Octokit's pagination reads
  // it: both to find the next page and to pick the one list out of an answer
  // that wraps it beside `total_count`, which is the shape
  // `GET /user/installations` has. `Response` has no settable `url`.
  Object.defineProperty(answerBody, 'url', { value: url.href });
  return answerBody;
};

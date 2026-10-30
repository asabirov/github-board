/**
 * The /docs API reference content (#343), one source of truth for both the
 * sidebar jump-nav (App) and the page body (DocsPage). The endpoints mirror the
 * board-service controllers' agent-facing REST surface; scopes are the real ones
 * (board:read / board:admin, or human-only where a token deliberately can't act).
 * The board also speaks MCP over HTTP; its tools are in MCP_TOOLS below.
 *
 * That tool list is hand-kept, like every endpoint above it — the frontend and
 * board-service are separate packages and cannot import from each other. The
 * authoritative list lives in board-service's `overview-tools.ts`, and
 * `docs-surface.spec.ts` there fails if a registered tool is missing here.
 */

export type Method = 'GET' | 'POST' | 'DELETE';
/** A token scope, or 'human-only' for a route a personal token can't call. */
export type EndpointScope = 'board:read' | 'board:admin' | 'human-only';

export interface DocEndpoint {
  method: Method;
  /** Path under the API base, e.g. `/issues/mine`. */
  path: string;
  desc: string;
  scope: EndpointScope;
}

export interface DocGroup {
  id: string;
  label: string;
  /** The group's prevailing scope, shown next to its heading. */
  scope: EndpointScope;
  endpoints: DocEndpoint[];
}

export const API_BASE = 'https://board.example.com/api';

/**
 * Each line is what the endpoint answers, said in the words the rest of the app
 * uses (#979). Four of them named things a reader has never been shown: "the
 * unit" is a page that does not exist — the pages are My work, Queue, Person,
 * Overview, Projects and Repos — "boards" is what the code calls a ProjectV2
 * and what this app calls itself, and "lean" and "rollup" are facts about how
 * the payload is built rather than about what is in it.
 */
export const DOC_GROUPS: DocGroup[] = [
  {
    id: 'issues',
    label: 'Issues',
    scope: 'board:read',
    endpoints: [
      { method: 'GET', path: '/issues/mine', desc: 'Your open queue plus throughput', scope: 'board:read' },
      { method: 'GET', path: '/issues/all', desc: 'Every open issue, across the org', scope: 'board:read' },
      { method: 'GET', path: '/issues/metrics', desc: 'Issue-flow metrics', scope: 'board:read' },
      { method: 'GET', path: '/issues/buckets', desc: 'Open / bugs / feedback / unassigned counts', scope: 'board:read' },
      { method: 'GET', path: '/issues/search-index', desc: 'Open issues, trimmed for search', scope: 'board:read' },
      { method: 'GET', path: '/issues/{owner}/{repo}/{number}', desc: "One issue’s detail", scope: 'board:read' },
      { method: 'POST', path: '/issues/{owner}/{repo}/{number}/close', desc: 'Close an issue', scope: 'human-only' },
    ],
  },
  {
    id: 'projects',
    label: 'Projects',
    scope: 'board:read',
    endpoints: [
      { method: 'GET', path: '/projects', desc: 'Every project, with its totals', scope: 'board:read' },
      { method: 'GET', path: '/projects/{number}', desc: "One project’s items", scope: 'board:read' },
    ],
  },
  {
    id: 'people',
    label: 'People',
    scope: 'board:read',
    endpoints: [{ method: 'GET', path: '/people', desc: 'The team roster', scope: 'board:read' }],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    scope: 'board:read',
    endpoints: [{ method: 'GET', path: '/delivery', desc: 'Recent releases and merges', scope: 'board:read' }],
  },
  {
    id: 'account',
    label: 'Account',
    scope: 'human-only',
    endpoints: [
      { method: 'GET', path: '/account/tokens', desc: 'List your tokens', scope: 'human-only' },
      { method: 'POST', path: '/account/tokens', desc: 'Mint a token', scope: 'human-only' },
      { method: 'DELETE', path: '/account/tokens/{id}', desc: 'Revoke a token', scope: 'human-only' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    scope: 'board:admin',
    endpoints: [
      { method: 'GET', path: '/admin/access', desc: 'Who can reach the board', scope: 'board:admin' },
      { method: 'GET', path: '/admin/agents', desc: 'Agents with access to the org', scope: 'board:admin' },
      { method: 'GET', path: '/admin/audit', desc: 'Who did what across write paths', scope: 'board:admin' },
    ],
  },
];

/** One tool on the MCP surface. A tool has no method and no path — it has a
 *  name, what it answers, and the scope that reaches it. */
export interface McpTool {
  name: string;
  desc: string;
  scope: EndpointScope;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'board_whoami',
    scope: 'board:read',
    // The scopes sentence repeats the tool's own description word for word: the
    // operator reading this page and the model reading tools/list both need it,
    // and neither sees the other's copy. Shorten one, shorten both.
    desc: 'The address this session acts as, the GitHub login its work is attributed to, and the scopes limiting it. An empty scopes list means the session is not scope-limited — a signed-in person, not a session that holds nothing. Takes no arguments and answers about the caller only.',
  },
];

/** Sidebar jump-nav sections: the two intro blocks, each endpoint group, then MCP.
 *  `id` matches the section's `data-docs-section` anchor in DocsPage. */
export interface DocSection {
  id: string;
  label: string;
  count?: number;
}

export const DOC_SECTIONS: DocSection[] = [
  { id: 'auth', label: 'Auth' },
  { id: 'scopes', label: 'Scopes' },
  ...DOC_GROUPS.map((g) => ({ id: g.id, label: g.label, count: g.endpoints.length })),
  { id: 'mcp', label: 'MCP' },
];

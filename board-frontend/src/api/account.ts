import { readClient, readKey } from '../cache/read-cache';
import { API, ApiError, networkFetch as apiFetch, serverCode, serverMessage } from './core';

// --- Admin Access panel (#11) — mirror of the backend AccessModel wire shape ---

export type AccessRole = 'admin' | 'writer' | 'reader';

export interface AccessPerson {
  id: string;
  displayName: string;
  emails: string[];
  clickupNames: string[];
  githubLogin: string | null;
  clickupUserId: string | null;
  /** Effective role (#332): the stored override, else admin (assigned/bootstrap), else derived. */
  role: AccessRole;
  /** The board-assigned role stored on the identity, or null (no override). */
  roleOverride: AccessRole | null;
  /** The default role absent any override: writer if a Github login was TYPED, else reader. */
  derivedRole: AccessRole;
  /** Whether `githubLogin` was typed by a person or worked out from commit
   *  authorship (#535); null when there is no handle at all. Absent on an older
   *  deploy, which reads as "no provenance known" and renders as plain. */
  githubLoginSource: 'typed' | 'derived' | null;
}

export interface AdminEntry {
  email: string;
  person: { id: string; displayName: string; githubLogin: string | null } | null;
  /** 'assigned' = a board-assigned admin role (durable); 'bootstrap' = BOARD_ADMIN_EMAILS env only. */
  source: 'assigned' | 'bootstrap';
}

export interface AccessModel {
  admins: AdminEntry[];
  people: AccessPerson[];
  rosterUnavailable: boolean;
}

/** The access model (#11). 403 for a non-admin teammate. */
export async function fetchAdminAccess(): Promise<AccessModel> {
  const res = await apiFetch(`${API}/api/admin/access`);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`access ${res.status}`);
  return res.json();
}

// --- Admin Agents panel (#183) — mirror of the backend AgentsModel wire shape ---

export type ScopeTag = 'read' | 'propose' | 'admin';

export interface AgentScope {
  id: string;
  tag: ScopeTag;
  label: string;
  blurb: string;
}

export interface AgentPreset {
  id: 'agent' | 'full';
  scopes: string[];
}

export interface AgentTool {
  name: string;
  needs: ScopeTag;
}

/** One connected agent on the org roster (#211) — a live `board_pat_` token. */
export interface OrgAgent {
  id: string;
  /** Email of the human the agent acts as. */
  owner: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface AgentsModel {
  /** Live org roster — every active agent token, admin-wide (#211). */
  agents: OrgAgent[];
  scopes: AgentScope[];
  presets: AgentPreset[];
  tools: AgentTool[];
  /** The board's MCP endpoint, or null when MCP is disabled in this environment. */
  mcpUrl: string | null;
}

/** The agents model (#183, #211) — the org agent roster + MCP access reference.
 *  403 for a non-admin. */
export async function fetchAdminAgents(): Promise<AgentsModel> {
  const res = await apiFetch(`${API}/api/admin/agents`);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`agents ${res.status}`);
  return res.json();
}

/**
 * The board cannot say who its admins are (#811) — the sentinel `fetchAuditLog`
 * throws, and the state `AuditSection` draws from it.
 *
 * A sibling of the 'forbidden' sentinel and deliberately not the same one: they
 * are different facts and the second is a claim about the reader that a board in
 * this state cannot make.
 */
export const ADMINS_UNREAD = 'admins-unread';

/** The `code` board's 503 body carries, so this is board's outage and not an
 *  ingress's. Must match `ADMINS_UNREAD_CODE` in `auth/admin-authority.ts`.
 *  Exported for `write-failure.ts`, which needs it to tell a 503 it may repeat
 *  the sentence of from one it may not (#1102 review, the 503 round). */
export const ADMINS_UNREAD_CODE = 'admins_unread';

// --- Admin audit log (#212) — the who-did-what trail ---
export interface AuditEvent {
  id: string;
  /** ISO timestamp. */
  at: string;
  actorEmail: string;
  /** Machine key, e.g. `token.mint` / `agent.revoke`. */
  action: string;
  summary: string;
  targetType: string | null;
  targetId: string | null;
}

/**
 * Whether to believe an empty trail (#781). `disabled` — no database, nothing is
 * recorded here at all; `failing` — records have been lost since the board
 * started, so writes happened that this log does not have; `ok` — the log is the
 * whole story. `null` is an older deploy that answers a bare array and has no
 * opinion, which is not the same as `ok` and may not be drawn as one.
 */
export interface AuditHealth {
  recording: 'ok' | 'failing' | 'disabled';
  /** Lost by ONE instance over ONE window — `instance` and `since` say which
   *  (#812). It is not a number about the board and may not be drawn as one. */
  failures: number;
  lastFailureAt: string | null;
  /** Which board-api process counted `failures`, and when it started (#812).
   *  Empty string when an older deploy sent neither. */
  instance: string;
  since: string;
  /**
   * What the TRAIL says is missing (#812): `audit.gap` rows, written by any
   * instance whose store came back. This is the half that survives a restart and
   * reaches across a second replica.
   *
   * `null` means the count could not be taken — an older deploy that sends no
   * such field, or a store that would not answer. Neither is "nothing is
   * missing", and the pane draws neither as one.
   */
  gaps: { events: number; lastAt: string | null } | null;
}

export interface AuditLog {
  events: AuditEvent[];
  health: AuditHealth | null;
}

/** The audit trail, newest first. Optional actor-substring / action filters. */
export async function fetchAuditLog(filters?: { actor?: string; action?: string }): Promise<AuditLog> {
  const qs = new URLSearchParams();
  if (filters?.actor) qs.set('actor', filters.actor);
  if (filters?.action) qs.set('action', filters.action);
  const res = await apiFetch(`${API}/api/admin/audit${qs.toString() ? `?${qs}` : ''}`);
  if (res.status === 403) throw new Error('forbidden');
  // #811 — the board could not read who its admins are, so it refused everybody
  // rather than judging this one. Matched on the CODE and not the status: a 503
  // from an ingress or a proxy is a different outage, and drawing board's
  // sentence for one would name a failure board never observed.
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    if (body?.code === ADMINS_UNREAD_CODE) throw new Error(ADMINS_UNREAD);
    throw new Error('audit 503');
  }
  if (!res.ok) throw new Error(`audit ${res.status}`);
  return readAuditLog(await res.json());
}

/** Old-deploy skew: the endpoint answered a bare array before #781. */
export function readAuditLog(body: unknown): AuditLog {
  if (Array.isArray(body)) return { events: body as AuditEvent[], health: null };
  const b = (body ?? {}) as { events?: unknown; health?: unknown };
  const h = b.health as (Partial<AuditHealth> & { gaps?: unknown }) | undefined;
  const recording = h?.recording;
  return {
    events: Array.isArray(b.events) ? (b.events as AuditEvent[]) : [],
    health:
      recording === 'ok' || recording === 'failing' || recording === 'disabled'
        ? {
            recording,
            failures: Number(h?.failures) || 0,
            lastFailureAt: h?.lastFailureAt ?? null,
            // #812 — a deploy between #781 and #812 sends the count and not
            // whose it is. Empty strings, so the pane can tell "this instance,
            // since 09:12" from "a count with nobody's name on it" and say the
            // narrower thing only when it has the name.
            instance: typeof h?.instance === 'string' ? h.instance : '',
            since: typeof h?.since === 'string' ? h.since : '',
            gaps: readAuditGaps(h?.gaps),
          }
        : null,
  };
}

/** The trail's own gap count, or `null` for every shape that is not one — an old
 *  deploy that sends nothing, and a server that sends `null` because the store
 *  would not answer. Both mean "not counted", which is not "none" (#812). */
function readAuditGaps(raw: unknown): { events: number; lastAt: string | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as { events?: unknown; lastAt?: unknown };
  if (typeof g.events !== 'number' || !Number.isFinite(g.events)) return null;
  return { events: g.events, lastAt: typeof g.lastAt === 'string' ? g.lastAt : null };
}

/** Admin kill-switch: revoke any connected agent's token (#211). */
export async function revokeAdminAgent(id: string): Promise<void> {
  const res = await apiFetch(`${API}/api/admin/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (res.status === 403) throw new Error('forbidden');
  // 404 = already gone; treat as success (the agent is revoked either way).
  if (!res.ok && res.status !== 404) throw new Error(`revoke ${res.status}`);
}

// --- Personal access tokens (#210) — the caller's own Account > Access & agents ---
/** A minted token as shown in the list — never carries the secret or its hash. */
export interface PersonalToken {
  id: string;
  name: string;
  scopes: string[];
  /** e.g. "board_pat_9f3a" — for display only. */
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AccountTokens {
  /** False when the server has no database — the UI shows an unavailable state. */
  enabled: boolean;
  /** Scopes the caller may grant (board:read; board:admin only if admin). */
  grantableScopes: string[];
  tokens: PersonalToken[];
}

export interface MintTokenRequest {
  name: string;
  scopes: string[];
  /** Null = never expires; otherwise a positive integer day count. */
  expiresInDays: number | null;
}

/** The signed-in user's own tokens + what they may grant. */
export async function fetchMyTokens(): Promise<AccountTokens> {
  const res = await apiFetch(`${API}/api/account/tokens`);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`tokens ${res.status}`);
  return res.json();
}

/** Mint a token — the secret is returned ONCE, in `token`. */
export async function mintToken(
  body: MintTokenRequest,
): Promise<{ token: string; record: PersonalToken }> {
  const res = await apiFetch(`${API}/api/account/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // An `ApiError` and not a bare `Error` (#1079), the shape `submitFeedback`
  // already throws: the sheet draws its own sentence for everything except the
  // five 400s `personal-token.service.ts` writes for that exact spot, and it
  // cannot tell those from a 500's "Internal server error" once both have been
  // collapsed into one string. `message` is what this always threw for a 403,
  // and names the route and status for the rest, so nothing that matched on it
  // stops matching.
  //
  // The `code` beside it is carried for the same reason three READ fetchers
  // above already carry it: one status answers for several verdicts, and on
  // these three routes the 503 is the one where that bites. Dropping it here
  // made every 503 look permanent to `writeFailure`, including the four the
  // auth layer codes `access_not_now` (#1102 review, the 503 round).
  if (res.status === 403) throw new ApiError(403, 'forbidden', undefined, undefined, await serverMessage(res), await serverCode(res));
  if (!res.ok) throw new ApiError(res.status, `tokens ${res.status}`, undefined, undefined, await serverMessage(res), await serverCode(res));
  return res.json();
}

/** Revoke one of the caller's own tokens. */
export async function revokeToken(id: string): Promise<void> {
  const res = await apiFetch(`${API}/api/account/tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(await readErrorReason(res));
}

/** A client holding an OAuth grant on the caller's account (#456). */
export interface ConnectedClient {
  /** The grant's id — what a revoke names. */
  id: string;
  clientId: string;
  /** What the client called itself when it registered, or null if it didn't. */
  clientName: string | null;
  scopes: string[];
  createdAt: string;
  /**
   * When this grant last exchanged a refresh token, or null if it never has.
   * Last *refreshed*, not last used: only the refresh path writes it, and the
   * board does not know when a token was last used.
   */
  lastRefreshedAt: string | null;
}

export interface ConnectedClients {
  /** False when the server has no database — the UI shows an unavailable note. */
  enabled: boolean;
  clients: ConnectedClient[];
}

/** Every client holding an OAuth grant on the signed-in user's own account. */
export async function fetchConnectedClients(): Promise<ConnectedClients> {
  const res = await apiFetch(`${API}/api/account/clients`);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`clients ${res.status}`);
  return res.json();
}

/** Cut off one client's grant on the caller's own account. */
export async function revokeConnectedClient(id: string): Promise<void> {
  const res = await apiFetch(`${API}/api/account/clients/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  // The status and the code reach the row's sentence (#1079) — see `mintToken`.
  if (res.status === 403) throw new ApiError(403, 'forbidden', undefined, undefined, await serverMessage(res), await serverCode(res));
  if (!res.ok) throw new ApiError(res.status, `clients ${res.status}`, undefined, undefined, await serverMessage(res), await serverCode(res));
}

/** Fields an admin edits for one person; `email` is the roster key. */
export interface IdentityUpsert {
  email: string;
  displayName: string;
  emails: string[];
  githubLogin: string | null;
  clickupUserId: string | null;
  clickupNames: string[];
  /** Board-assigned role (#332): null clears the override → derived default. */
  role: AccessRole | null;
}

/** Create/update a person's identity (admin-only). 403 non-admin, 503 without a DB. */
export async function upsertIdentity(body: IdentityUpsert): Promise<void> {
  const res = await apiFetch(`${API}/api/admin/identity`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // The status and the code reach the dialog's sentence (#1079) — see
  // `mintToken` above. This route is where BOTH 503 halves are met: the two the
  // auth layer codes and the roster's own, which carries no code at all.
  // This route is the one of the three whose 403 a browser can actually meet,
  // and the fourteen 400s and two 409s below it are sentences the service wrote
  // for this dialog; `serverMessage` is how they keep reaching it now that the
  // page no longer prints whatever the body held.
  if (res.status === 403) throw new ApiError(403, 'forbidden', undefined, undefined, await serverMessage(res), await serverCode(res));
  if (!res.ok) throw new ApiError(res.status, `identity ${res.status}`, undefined, undefined, await serverMessage(res), await serverCode(res));
}

// Write helpers surface non-2xx body text as the error message so upstream
// error details reach the UI.

/**
 * Reads the body of a non-2xx write response and extracts the most useful
 * reason string. Handles NestJS exception JSON ({ message: string | string[],
 * statusCode }) — surfacing the human message rather than the raw envelope —
 * as well as plain-text bodies. Falls back to the status code when the body is
 * empty or unparseable.
 *
 * `revokeToken` is what is left of "used by every write function" (#1079). The
 * writes whose failure a person reads now throw an `ApiError` carrying the
 * status beside the server's words, because a surface that has been handed one
 * collapsed string cannot tell a sentence the service wrote for its form from
 * Nest's "Internal server error" — and both were being printed. This one has no
 * such surface: `AccountView`'s token revoke is `.catch(() => {})` and the
 * reloaded list is what tells the person, so there is nothing to read the
 * status.
 */
async function readErrorReason(res: Response): Promise<string> {
  const fallback = String(res.status);
  let text: string;
  try {
    text = await res.text();
  } catch {
    return fallback;
  }
  try {
    const json = JSON.parse(text) as { message?: unknown };
    const { message } = json;
    if (typeof message === 'string' && message) return message;
    if (Array.isArray(message) && message.length) return (message as string[]).join('; ');
  } catch {
    // body isn't JSON — fall through to the raw text
  }
  return text || fallback;
}

/** Consent controls act only for the signed-in browser session. */
export async function refreshGithubAccess(): Promise<void> {
  const res = await apiFetch(`${API}/api/auth/github/refresh-access`, { method: 'POST' });
  if (!res.ok) throw new Error(`GitHub access refresh ${res.status}`);
}

export async function disconnectGithub(): Promise<void> {
  const res = await apiFetch(`${API}/api/auth/github/disconnect`, { method: 'POST' });
  if (!res.ok) throw new Error(`GitHub disconnect ${res.status}`);
}

export interface GoalLevels { dailyGoal: number; level2Goal: number; level3Goal: number }
export interface Goal extends GoalLevels { editable: boolean }
export const personalGoalPath = '/api/goals/personal';
export const teamGoalPath = (org: string) => `/api/goals/organisations/${encodeURIComponent(org)}`;

export async function saveGoal(path: string, levels: GoalLevels): Promise<Goal> {
  const response = await apiFetch(path, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(levels),
  });
  if (!response.ok) throw new ApiError(response.status, 'Goal save failed', undefined, undefined, await serverMessage(response), await serverCode(response));
  const result: Goal = await response.json();
  await readClient.invalidateQueries({ queryKey: readKey(path), exact: true });
  return result;
}

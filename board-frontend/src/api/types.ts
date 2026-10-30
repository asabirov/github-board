/** Coarse work type derived from an issue's labels (mirrors the buckets
 *  taxonomy). Drives grouping-by-type and the queue's type chips. */
export type PersonalIssueType = 'bug' | 'feedback' | 'feature' | 'chore';

/** A Github label with its real color (6-digit hex, no `#`) so the issue page can
 *  tint the chip the way Github does instead of a flat grey (#289). */
export interface IssueLabel {
  name: string;
  color: string;
}

/** The wire shape of GET /api/auth/me. */
export interface MeResponse {
  github?: {
    configured?: boolean; connected: boolean;
    repositories?: { id: number; full_name: string }[];
    owners: { id?: number; login: string; type: 'Organization' | 'User' }[];
    visibilityKey: string; expiresAt?: number;
    responseDeadlines?: boolean;
    login?: string | null; installUrl?: string | null; authorizationsUrl?: string;
    installations?: {
      id: number; account: { login: string; type: 'Organization' | 'User' };
      repositorySelection: 'all' | 'selected' | 'unknown'; repositoryCount: number | null;
      permissions: Record<string, string>; suspended: boolean; manageUrl: string;
    }[];
  };
  email: string;
  /**
   * A pseudonym of this signed-in session, stable across this person's devices
   * under one server key and never a credential (#1229, `session-hint.ts`).
   *
   * Reported here as well as in the cookie since #1395, because the cache owner
   * and the mounted tree are keyed on it: the browser has to know which session
   * its saved copy belongs to without reading a cookie back. Absent when the
   * board has no real `BOARD_SESSION_SECRET`, which turns the saved-read feature
   * off altogether — the service logs that.
   */
  sessionHintId?: string;
  isAdmin: boolean;
  /**
   * The board has never successfully read its admin roster, so `isAdmin` above
   * is `false` for everybody and says nothing about this session (#811).
   *
   * On a `db` board that roster is Postgres, so this is what a board whose
   * database was already down when it booted looks like from here. It grants
   * nothing — every admin API still refuses, with a 503 rather than a 403 — and
   * a surface may only use it to say the board cannot answer, never to draw
   * anything as though the reader were an admin.
   *
   * Absent on an older deploy, which reads as `false`: the surfaces this gates
   * then render exactly as they did before the field existed.
   */
  adminsUnread: boolean;
  /** May this session write at all (#626): human session + writes enabled
   *  server-side. The gate for a surface that writes something other than the
   *  issue editor — compose it with that surface's own `capabilities` key. */
  writesEnabled: boolean;
  /** `writesEnabled` AND no ISSUE-editor capability refused (#626). Only the
   *  in-board issue editor may gate on this. */
  canWrite: boolean;
  /** Who the signed-in person is on Github (#520), null when unmapped. */
  githubLogin: string | null;
  /** What the board's own Github credential is known to be able to do (#584),
   *  per capability: `unknown` | `available` | `refused`. Nothing reads it yet. */
  capabilities: Record<string, string>;
  /**
   * Every Github org this deployment was configured to read, and whether the
   * board could read it this ingest (#650).
   *
   * READ `[]` AS "NO CLAIM", NEVER AS "EVERY ORG IS FINE". A board-service that
   * predates this field sends nothing, `fetchMe` defaults that to `[]`, and an
   * empty list therefore carries exactly one meaning: the board is not saying
   * anything about any org. A surface may only change what it draws on an
   * explicit `state: 'unreadable'` entry — which is what makes an old deploy
   * render byte-for-byte as it does today, notice and reassurance both absent.
   *
   * Inverting that reading is the failure this field exists to prevent, in the
   * other direction: an empty list read as "all read" would print a reassurance
   * on the one deploy that has told us nothing.
   *
   * `reason` is Github's own words for the refusal, or null when there are
   * none. It is carried rather than summarised so a person can tell a revoked
   * grant from an outage.
   */
  orgs: OrgReadState[];
}

/** One org's readability (#650) — see `MeResponse.orgs` for what an absent or
 *  empty list means. */
export interface OrgReadState {
  org: string;
  state: 'read' | 'unreadable';
  reason: string | null;
}

/** One GitHub Project the signed-in user is working in, with how much they've
 *  moved it lately — the "Project contributions" memory block (#380). Scoped to
 *  the caller (only issues assigned to them count). `closed7d` is issues they
 *  closed in the trailing 7 days; `lastClosedAtISO` is their most recent close on
 *  the board (null when they've closed nothing there); `openAssigned` is their
 *  current open commitments; `slipping` is true when they hold open work but have
 *  closed nothing in the window. */
export interface ProjectContribution {
  /** The org the board was read from (#697) — the other half of the deep link,
   *  and what makes the join to the `/api/projects` rollup addressable. These
   *  rows are the union across every configured org, so joining on `number`
   *  alone matched whichever board came last: one org's name over another org's
   *  ring. Optional for the deploy-window reason `ProjectSummary.org` states;
   *  absent, the join falls back to the number and behaves as it did before. */
  org?: string;
  /** GitHub Project (v2) number — with `org`, the deep-link segments to the
   *  board's page. Unique within its org, not across the union. */
  number: number;
  name: string;
  closed7d: number;
  openAssigned: number;
  lastClosedAtISO: string | null;
  slipping: boolean;
}

export type { SyncOperation, BoardFreshness, SourceFreshness } from '../sync/sync-operation';
export type { RefusalReason } from '../refusal';

export type IssueState = 'open' | 'closed';

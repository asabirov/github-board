import {
  BOARD_ADMIN,
  BOARD_READ,
  PRESET_SCOPES,
  type Preset,
} from '../auth/scopes';
import {
  HUMAN_WRITE_SUFFIXES,
  READ_SUFFIXES,
} from '../mcp/overview-tools';
import type { PersonalTokenRow } from '../account/personal-token.repository';

/**
 * The read-only "Agents" model behind the admin hub (#183). It documents the
 * board's MCP access surface — the fine-grained scopes (#56), the two consent
 * presets (#43), and which scope gates each MCP tool — so an admin can see
 * exactly what a connected agent can reach. It is DERIVED from the same scope
 * constants and tool suffixes the MCP server enforces with (see
 * `agents.spec.ts`, which pins the tool list to `toolNamesForScope`), so the
 * page can never drift from the real gating.
 *
 * v1 is display + connect: there is no live-session listing or per-tool toggle
 * yet, so the "connect an agent" affordance stands in for a populated sessions
 * list. Grants themselves are in Postgres since #456, so a listing is now
 * possible where it was not — see `McpGrantRepository.listGrantsForSubject`.
 */

/** The scope tag shown against a tool — the coarse capability it needs. */
export type ScopeTag = 'read' | 'admin';

export interface AgentScope {
  /** The wire scope, e.g. `board:read`. */
  id: string;
  tag: ScopeTag;
  /** Short imperative label — "Read the mirror". */
  label: string;
  /** One-line explanation of what it grants. */
  blurb: string;
}

export interface AgentPreset {
  id: Preset;
  scopes: string[];
}

export interface AgentTool {
  /** The tool suffix as an agent calls it (prefix-agnostic), e.g. `okr_tree`. */
  name: string;
  needs: ScopeTag;
}

/** The static access reference — what an agent CAN reach (scopes/presets/tools). */
export interface AgentsReference {
  scopes: AgentScope[];
  presets: AgentPreset[];
  tools: AgentTool[];
  /** The endpoint an MCP client points at, or null when MCP is disabled here. */
  mcpUrl: string | null;
}

/** One connected agent on the org roster (#211) — a live `board_pat_` token,
 *  shaped for display (no secret/hash ever leaves the server). */
export interface OrgAgent {
  id: string;
  /** Lowercased email of the human the agent acts as. */
  owner: string;
  name: string;
  /** Leading chars of the secret (e.g. `board_pat_9f3a`) — a display hint. */
  prefix: string;
  scopes: string[];
  createdAt: string;
  /** Best-effort last-use stamp; null = never used since minting. */
  lastUsedAt: string | null;
  /** null = never expires. */
  expiresAt: string | null;
}

/** The full admin Agents model: the live roster + the access reference. */
export interface AgentsModel extends AgentsReference {
  agents: OrgAgent[];
}

/** Project a stored token row to its wire shape (dates → ISO). Pure. */
export function toOrgAgent(row: PersonalTokenRow): OrgAgent {
  return {
    id: row.id,
    owner: row.ownerEmail,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

const SCOPES: AgentScope[] = [
  {
    id: BOARD_READ,
    tag: 'read',
    label: 'Read the mirror',
    blurb: 'Read-only access to the board.',
  },
  {
    id: BOARD_ADMIN,
    tag: 'admin',
    label: 'Manage',
    // Also the gate on the admin reads since #471, so say so — a person picking
    // scopes at mint time is deciding whether this token sees the token
    // inventory and the audit log. Named concretely rather than as "the admin
    // surface", which means nothing to the person granting it.
    blurb: 'Apply board changes, and see who holds which token.',
  },
];

// The tool→scope map, built from the exact suffix lists the MCP server
// registers from. `agents.spec.ts` asserts this covers `toolNamesForScope`
// so adding a tool without tagging it here fails the build.
const TOOLS: AgentTool[] = [
  ...READ_SUFFIXES.map((name): AgentTool => ({ name, needs: 'read' })),
  ...HUMAN_WRITE_SUFFIXES.map((name): AgentTool => ({ name, needs: 'admin' })),
];

const PRESETS: AgentPreset[] = (Object.keys(PRESET_SCOPES) as Preset[]).map((id) => ({
  id,
  scopes: [...PRESET_SCOPES[id]],
}));

/**
 * Build the agents model. `mcpUrl` is the board's MCP endpoint when MCP is
 * enabled in this environment, else null (the page then hides the connect
 * affordance rather than advertising a dead URL).
 */
export function buildAgentsModel(opts: { baseUrl: string; mcpEnabled: boolean }): AgentsReference {
  return {
    scopes: SCOPES,
    presets: PRESETS,
    tools: TOOLS,
    mcpUrl: opts.mcpEnabled ? `${opts.baseUrl.replace(/\/+$/, '')}/mcp` : null,
  };
}

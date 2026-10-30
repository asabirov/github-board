/**
 * The board's scope vocabulary (#56) and the one rule for who may grant which of
 * it (#545). A programmatic token carries a subset of these scopes; humans are
 * not scope-limited. The two consent presets (agent/full, from #43) expand to
 * scope-sets, and both paths to a scoped credential — the MCP consent screen and
 * personal-token minting — narrow that expansion through the same functions at
 * the bottom of this file, so a grant can never carry a scope its holder's own
 * personal token would be refused.
 */
export const BOARD_READ = 'board:read';
export const BOARD_ADMIN = 'board:admin';

export type Preset = 'agent' | 'full';

// Frozen so an in-repo consumer can't `.push` and permanently widen a preset
// process-wide (expandPreset returns a fresh copy for callers that need one).
export const PRESET_SCOPES: Record<Preset, string[]> = Object.freeze({
  agent: Object.freeze([BOARD_READ]),
  full: Object.freeze([BOARD_READ, BOARD_ADMIN]),
}) as Record<Preset, string[]>;

export function expandPreset(preset: Preset): string[] {
  return [...PRESET_SCOPES[preset]];
}

/** Compat `mcp_scope` for a scope-set: 'full' iff it grants admin, else 'agent'. */
export function deriveLegacyPreset(scopes: string[]): Preset {
  return scopes.includes(BOARD_ADMIN) ? 'full' : 'agent';
}

/**
 * The MCP `actor.agent` flag preserved from the pre-scopes model: an agent is a
 * scoped, non-admin actor (read-only). A 'full' scope-set carries admin and so
 * is not an agent; a scoped actor without admin sees the read tools only.
 *
 * Only ever call this on a token's own scope list — `jwt-auth.guard.ts` calls it
 * at the two places a scoped actor is built and nowhere else. It is NOT a way to
 * work out whether a caller is a human. An unscoped browser session has no scope
 * list at all, and feeding this an empty array to stand in for that returns
 * `true`, which is the opposite of what the guard concludes for the same caller.
 * Whether somebody is an agent is answered by the flag the guard already wrote,
 * never by re-deriving it here.
 */
export function deriveAgentFlag(scopes: string[]): boolean {
  return !scopes.includes(BOARD_ADMIN);
}

/**
 * Who may hold `board:admin` (#545). THE one answer, consumed by both paths to a
 * scoped credential: the MCP consent screen (`mcp/consent.controller.ts` and the
 * page it renders) and personal-token minting
 * (`account/personal-token.service.ts`). Before this existed the rule lived only
 * in the token service, and the consent screen expanded its preset with no check
 * at all — so a non-admin could hold a grant their own token would have been
 * refused.
 *
 * The input is the answer `AdminAuthority.isAdmin` gives for the granter, which
 * stays the single source of truth for WHO is an admin. These functions decide
 * only what that authority may put on a credential, and are pure and
 * synchronous on purpose: `scopes.ts` is imported by the guard chain, and the
 * day one of these takes an await is the day the whole chain does.
 *
 * `full` being un-choosable by a non-admin is a consequence of
 * `PRESET_SCOPES.full` containing `BOARD_ADMIN`, never a second rule about
 * presets — so editing `PRESET_SCOPES` moves both facts at once.
 */
export function grantableScopesFor(isAdmin: boolean): string[] {
  return isAdmin ? [BOARD_READ, BOARD_ADMIN] : [BOARD_READ];
}

/** The requested scopes this authority may NOT hold, request order, de-duplicated.
 *  Empty means the whole request is grantable. An unrecognised scope is nobody's. */
export function ungrantableScopes(requested: string[], isAdmin: boolean): string[] {
  const allowed = new Set(grantableScopesFor(isAdmin));
  return [...new Set(requested)].filter((s) => !allowed.has(s));
}

/** `requested` narrowed to what this authority may hold, request order, de-duplicated. */
export function capToGrantable(requested: string[], isAdmin: boolean): string[] {
  const allowed = new Set(grantableScopesFor(isAdmin));
  return [...new Set(requested)].filter((s) => allowed.has(s));
}

/** The consent presets this authority may choose — one whose expansion it may
 *  hold entirely. `consent-html.ts` builds its buttons from this list and makes
 *  the first entry the primary one, so the order here is the order on screen. */
export function grantablePresets(isAdmin: boolean): Preset[] {
  return (Object.keys(PRESET_SCOPES) as Preset[]).filter(
    (p) => ungrantableScopes(expandPreset(p), isAdmin).length === 0,
  );
}

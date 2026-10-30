import { type ZodRawShape } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { whoAmI, type IdentityDeps } from './identity-tool';

/**
 * # Adding a tool to the board's MCP surface
 *
 * This is the file you edit to add one, so this is where the rules live. They
 * bind. `board_whoami` (#536) is the worked example.
 *
 * ## Naming
 *
 * A suffix is `snake_case` and says what the tool answers or does. No HTTP verb,
 * no route shape — a tool is not a mirror of a URL. `withPrefixes` adds the
 * prefix, so never write one into a suffix.
 *
 * ## Prefix
 *
 * `board_`, and only `board_`. The `atlas_` prefix was retired in #536 while the
 * surface was still empty, so no connected client could have been calling one.
 * The server NAME is still `atlas`, and that is the remaining #142 MCP item —
 * renaming it is client coordination, not a code change.
 *
 * ## Which list
 *
 * `READ_SUFFIXES` goes to every session that reaches `/mcp`.
 * `HUMAN_WRITE_SUFFIXES` goes to a session with `actor.agent === false`. Those
 * are the only two options. There is no third board scope, and adding one is a
 * change to the consent model rather than to a tool. Read the next four
 * paragraphs before you use the second list.
 *
 * ## `HUMAN_WRITE_SUFFIXES` does not mean `board:admin`, and does not mean a human
 *
 * `actor.agent` is `req.user?.agent === true` (`mcp.controller.ts`), so
 * `!actor.agent` is three populations — and since #545 the warning is really
 * about the first one:
 *
 *   1. an unscoped browser cookie session, which holds no scope at all, is
 *      gated by nothing in this file, and belongs to every signed-in member of
 *      the team — `jwt-auth.guard.ts` builds `{ sub, email }` for it;
 *   2. an OAuth grant consented at the `full` preset, which only a board admin
 *      can hold — `consent.controller.ts` caps the preset's expansion to the
 *      consenting person's own authority (#545), the same ceiling
 *      `personal-token.service.ts` holds a minted token to;
 *   3. a personal access token minted with `board:admin`, capped by that same
 *      rule.
 *
 * Putting a suffix here hands it to all three. Two of them are now admin-gated
 * at issue time. The first never was and is not a scope decision at all, so a
 * suffix in this list still reaches every signed-in person on the team — which
 * is the sentence to read twice before appending one.
 *
 * ## Registration is the only gate, unlike REST
 *
 * Every `board:admin` REST route also carries `AdminGuard`, which checks the
 * PERSON through `AdminAuthority.isAdminActor` — the scope gets a caller past
 * `RequiredScopesGuard` and the guard behind it still asks who they are. Nothing
 * sits behind registration here. A suffix in `HUMAN_WRITE_SUFFIXES` is the
 * entire authorisation decision.
 *
 * Both paths to `board:admin` are admin-gated at issue time since #545, but the
 * scope on a live grant is a snapshot — somebody demoted mid-grant keeps it
 * until their access token expires, which #456 cut from seven days to one hour.
 * A refresh re-caps against the authority its owner holds then, so the ceiling
 * is an hour plus however stale `AdminAuthority`'s cache is, not the whole
 * thirty-day refresh window. So a suffix in this list is handed to a scope that
 * can be about an hour stale, on top of being handed to every browser session.
 *
 * ## Never mirror a `MCP_HUMAN_ONLY_WRITES` entry because it says "human-only"
 *
 * Those entries are about `HumanOnlyGuard`, whose predicate is `isHumanSession`
 * — `!user?.scopes` (`human-session.ts`) — population 1 alone, refusing every
 * token including an admin one. No suffix list in this file matches that
 * predicate. The two "human"s are supersets, not synonyms, and the tests cannot
 * tell them apart.
 *
 * ## If a tool needs the `HumanOnlyGuard` population, stop
 *
 * No list gives it. Either leave the capability REST-only and sharpen its
 * `MCP_HUMAN_ONLY_WRITES` reason to name the population, or propose a third list
 * gated on `isHumanSession`: `McpActor` gains the fact, the controller fills it
 * from that one predicate, `toolNamesForScope` and `buildOverviewMcpServer`
 * learn it in the same commit, and `mcp-rest-parity.spec.ts` covers the branch.
 * That is a reviewed change, not an appended array element.
 *
 * ## Registration reads `actor.agent` and nothing else
 *
 * `suffixesForActor` is the one place that decides, and both `toolNamesForScope`
 * and `buildOverviewMcpServer` go through it. It takes the agent flag and the two
 * lists — not `scopes` — so the wrong version cannot be written there without
 * changing the signature.
 *
 * `buildOverviewMcpServer` also takes `scopes`; that argument exists only so
 * `board_whoami` can report it. Never pass it to `deriveAgentFlag` —
 * `deriveAgentFlag([])` is `true` while the unscoped person's `actor.agent` is
 * `false`, so the "agent is derivable, why pass both" tidy-up reclassifies every
 * signed-in person.
 *
 * Be honest about how far the tests reach. `overview-tools.spec.ts` pins the RULE,
 * over synthetic lists, because with `HUMAN_WRITE_SUFFIXES` empty both branches
 * return the same names and an assertion over the real lists proves nothing. A
 * registration inside `buildOverviewMcpServer` that bypassed the rule function
 * would still be unobservable today; it stops being so the day a write tool lands.
 *
 * ## Enforcement is registration, not filtering
 *
 * An agent's server instance never has the write tools on it, so there is no
 * per-call check to forget — and `toolNamesForScope` and
 * `buildOverviewMcpServer` must be kept in step, which `mcp-rest-parity.spec.ts`
 * pins.
 *
 * ## Parity
 *
 * The maps below are keyed by REST WRITE ROUTE, not by tool. Adding a write
 * route means adding an entry; adding a read tool means adding nothing. A tool
 * that mirrors a write route names itself in `MCP_BACKED_WRITES` under that
 * route's key.
 *
 * ## A tool that describes the caller takes no arguments
 *
 * An `email` parameter would turn a self-description into a roster lookup for
 * anybody holding `board:read`.
 *
 * ## Shape
 *
 * One file per tool: the answer as a pure exported function with its own spec,
 * registered from here. `identity-tool.ts` is the worked example.
 *
 * ## When you add one
 *
 * Also update the `/docs` MCP list in `board-frontend/src/docs/docs-data.ts`
 * (guarded by `docs-surface.spec.ts`) and the README's agent-surface section.
 */

export interface McpActor {
  sub: string;
  email: string;
  agent: boolean;
  /** From `isStaticAgent(req.user)` — never from the shape of the address (#525). */
  staticAgent: boolean;
}

export const TOOL_PREFIXES = ['board'] as const;
// These two lists ARE the declaration of who may call a tool. Read the
// convention above before adding to either — especially the second.
export const READ_SUFFIXES = ['whoami'] as const;
export const HUMAN_WRITE_SUFFIXES = [] as const;

/** The dependency bundle, one member per tool file. */
export interface OverviewToolDeps extends IdentityDeps {}

/** Expand tool suffixes to the full names under every live prefix. */
function withPrefixes(suffixes: readonly string[]): string[] {
  return suffixes.flatMap((s) => TOOL_PREFIXES.map((p) => `${p}_${s}`));
}

/**
 * THE rule for which suffixes an actor gets, called by both `toolNamesForScope`
 * and `buildOverviewMcpServer` so the two cannot state it differently.
 *
 * It takes the agent flag and nothing else. That is deliberate: the mistake this
 * guards against is deciding the set from `deriveAgentFlag(scopes)`, and you
 * cannot write that here without changing the signature. `deriveAgentFlag([])`
 * is `true`, while the unscoped browser person's `actor.agent` is `false` — the
 * two disagree for exactly that caller, and it is the one with the most
 * authority on this surface.
 *
 * `read` and `write` are parameters rather than the module constants because
 * `HUMAN_WRITE_SUFFIXES` is empty today. Closed over, both branches would return
 * the same list and no test could tell the rule from its inverse.
 */
export function suffixesForActor(
  agent: boolean,
  read: readonly string[],
  write: readonly string[],
): string[] {
  return agent ? [...read] : [...read, ...write];
}

/** Which tools a session sees; enforcement is registration, not filtering. */
export function toolNamesForScope(agent: boolean): string[] {
  return withPrefixes(suffixesForActor(agent, READ_SUFFIXES, HUMAN_WRITE_SUFFIXES));
}

// ─── REST ↔ MCP write parity (#141) ──────────────────────────────────────────
// The recorded decision for every board-write REST route: either it is backed
// by an MCP tool (below), or it is deliberately human/UI-only (with a reason).
// The mcp-rest-parity test discovers the REST routes from the controllers and
// asserts each appears in exactly one of these maps — so a NEW write endpoint
// fails the build until someone makes (and records) the parity call here.

/** REST write route → the MCP tool that mirrors it. */
export const MCP_BACKED_WRITES: Record<string, string> = {};

/** REST write route → why it is intentionally NOT on the MCP surface. */
export const MCP_HUMAN_ONLY_WRITES: Record<string, string> = {
  'PATCH issues/:owner/:repo/:number/text':
    'Edit an issue body or posted comment (#1379) with personal GitHub credentials; HumanOnlyGuard protects the author’s words, and no MCP tool exposes this write.',
  'PUT goals/personal': 'Human-only personal goal settings; HumanOnlyGuard.',
  'PUT goals/organisations/:org': 'Human-only team goal settings; HumanOnlyGuard and AdminGuard.',
  'POST auth/github/logout':
    'Sign out of the Board browser session — human-only, because it revokes the caller’s own MCP grants and sessions.',
  'POST auth/github/disconnect': 'Only a Board browser session may unlink its Github credential.',
  'POST auth/github/refresh-access':
    "Re-check the caller's own Github visibility after they change a consent on Github (#892) — " +
    'human-only self-service, keyed to the caller and writing nothing; an agent reads whatever the ' +
    "person's last check found and has no consent of its own to refresh.",
  'PUT admin/identity':
    'Identity mapping upsert — admin-only structural edit of the people store.',
  'POST account/tokens':
    'Mint a personal access token — human-only (a token must not mint tokens); HumanOnlyGuard + fail-closed write.',
  'DELETE account/tokens/:id':
    'Revoke a personal access token — human-only self-service, keyed to the caller.',
  'DELETE account/clients/:id':
    'Cut off a client holding an OAuth grant on your own account (#456) — human-only self-service, keyed to the caller; HumanOnlyGuard.',
  'DELETE admin/agents/:id':
    'Admin kill-switch — revoke any connected agent token (#211). Human/UI-only governance action, AdminGuard; never an agent-callable tool.',
  'POST issues/:owner/:repo/:number/close':
    "Close an issue on Github from the board (#287/#291) — human-only (an agent must not close a human's issue); HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED.",
  'PATCH issues/:owner/:repo/:number/state':
    "Open/close an issue on Github from the board (#384) — human-only (an agent must not change a human's issue state); HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED.",
  'PATCH issues/:owner/:repo/:number/assignees':
    "Set an issue's assignees on Github from the board (#384) — human-only; HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED.",
  'POST issues/:owner/:repo/:number/assignees/change':
    "Add and remove named assignees on an issue from the board's picker (#1009), leaving anyone else assigned on Github alone — human-only; HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED.",
  'PATCH issues/:owner/:repo/:number/labels':
    "Set an issue's labels on Github from the board (#384) — human-only; HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED.",
  'PATCH issues/:owner/:repo/:number/milestone':
    "Set an issue's milestone on Github from the board (#384) — human-only; HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED.",
  'POST issues/:owner/:repo/:number/project':
    'Add an issue to a Projects v2 board from the board (#384) — human-only; HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED, owner-bound (B1: the target project must belong to an org the owner scope allows).',
  'POST issues/:owner/:repo/:number/project/new':
    "Make a new Projects v2 project under the issue's own owner and put the issue on it (#982) — human-only (a project lands on Github in the org's name, and deciding one exists is a person's call); HumanOnlyGuard + fail-closed write for both halves, gated on GITHUB_WRITE_ENABLED, owner allow-listed on the owner scope.",
  'DELETE issues/:owner/:repo/:number/project':
    'Remove an issue from a Projects v2 board from the board (#384) — human-only; HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED, owner-bound (B1: projectId+itemId must match a real membership).',
  'PATCH issues/:owner/:repo/:number/field':
    "Set a Projects v2 custom field's value on an issue from the board (#384) — human-only; HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED, owner-bound (B1: projectId+itemId must match a real membership).",
  'PATCH issues/:owner/:repo/:number/task':
    "Toggle one body task-list checkbox on an issue from the board (#426) — human-only (an agent must not tick a human's checklist); HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED, owner allow-listed on the owner scope — an owner outside the orgs this board serves is refused 404 without being told why (#649).",
  'POST issues/:owner/:repo/:number/comment':
    "Answer an issue from the board rather than on Github (#693) — human-only, and this one most of all: a comment goes out in a person's name and under their words, so an agent must never post one as them. HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED, owner allow-listed on the owner scope — an owner outside the orgs this board serves is refused 404 without being told why (#649).",
  'POST sync/operations':
    'Start observable manual refresh of the six read caches (#976); human-only browser convenience, protected by HumanOnlyGuard and principal ownership. Agents read their own surfaces.',
  'POST sync':
    'Force-refresh the board\'s own read caches (#301, "sync now") — a UI convenience, not a GitHub write; an agent refetches on its own schedule. HumanOnlyGuard.',
  'PATCH repos/:owner/:repo/dri':
    "Set (or clear) a repo's dri owner on Github from the board's Repos map (#558) — human-only (deciding who is responsible for a repo is a human's call, not an agent's); HumanOnlyGuard + fail-closed write, gated on GITHUB_WRITE_ENABLED, owner allow-listed on the owner scope — an owner outside the orgs this board serves is refused 404 without being told why (#649).",
};

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Build a per-request MCP server for one authenticated actor. Registration is
 * the enforcement: the set registered here must match `toolNamesForScope`, and
 * `mcp-rest-parity.spec.ts` pins that.
 *
 * `scopes` is what `board_whoami` REPORTS and nothing else. Registration reads
 * `actor.agent`; never re-source it from `scopes` via `deriveAgentFlag`, which
 * returns true for `[]` — the unscoped signed-in person, whose `actor.agent` is
 * false. `overview-tools.spec.ts` pins that too.
 */
export function buildOverviewMcpServer(
  actor: McpActor,
  scopes: string[],
  deps: OverviewToolDeps,
): McpServer {
  const server = new McpServer({ name: 'atlas', version: '1.0.0' });

  // Register one suffix under every live prefix, same handler. A loop of one
  // today; it stays because it is what keeps registration and `withPrefixes`
  // reading from the same list.
  const dual = <A extends ZodRawShape>(
    suffix: string,
    config: { title?: string; description?: string; inputSchema?: A },
    cb: ToolCallback<A>,
  ): void => {
    for (const p of TOOL_PREFIXES) server.registerTool(`${p}_${suffix}`, config, cb);
  };

  // Registration keys on the actor's own flag, through the one rule function.
  // Never `deriveAgentFlag(scopes)` — `scopes` is what board_whoami reports.
  const registered = new Set(suffixesForActor(actor.agent, READ_SUFFIXES, HUMAN_WRITE_SUFFIXES));

  // No inputSchema, deliberately. An `email` parameter would turn a
  // self-description into a roster lookup for anybody holding board:read.
  if (registered.has('whoami')) {
    dual(
      'whoami',
      {
        description:
          'Who this session is signed in as — the address it acts as, the Github login its ' +
          'work is attributed to, and the scopes limiting it. An empty scopes list means the ' +
          'session is not scope-limited, which is a signed-in person with the whole surface, ' +
          'not a session that holds nothing. Answers about the caller only, and takes no ' +
          'arguments.',
      },
      async () => json(await whoAmI(actor, scopes, deps)),
    );
  }

  return server;
}

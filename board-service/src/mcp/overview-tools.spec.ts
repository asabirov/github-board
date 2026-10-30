import { describe, it, expect } from 'vitest';
import {
  MCP_HUMAN_ONLY_WRITES,
  buildOverviewMcpServer,
  suffixesForActor,
  toolNamesForScope,
  TOOL_PREFIXES,
  type McpActor,
  type OverviewToolDeps,
} from './overview-tools';
import { deriveAgentFlag } from '../auth/scopes';
import { RETIRED_SETTINGS } from '../config/retired-settings';

/**
 * The names a real server actually registers for this actor. Reaches into the
 * SDK's `_registeredTools`, the same trick mcp-rest-parity.spec.ts uses, which
 * is why it stays in test code and is not exported from overview-tools.ts.
 * Handlers are closures — never invoked at registration — so stub deps are fine.
 */
function registeredNamesFor(actor: McpActor, scopes: string[]): string[] {
  const server = buildOverviewMcpServer(actor, scopes, {} as unknown as OverviewToolDeps);
  return Object.keys(
    (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
  );
}

describe('toolNamesForScope', () => {
  it('an agent session sees the read tools', () => {
    expect(toolNamesForScope(true)).toEqual(['board_whoami']);
  });

  // NOT a duplicate of the test above, however identical the two lists look
  // while HUMAN_WRITE_SUFFIXES is empty. This one asserts that a write tool
  // never leaks into the agent list; the pair diverges — and starts catching
  // things — the day a suffix lands in HUMAN_WRITE_SUFFIXES. Do not merge them.
  it('a full session sees the same read tools, plus any write tools', () => {
    expect(toolNamesForScope(false)).toEqual(['board_whoami']);
  });

  it('no tool is published under the retired atlas_ prefix (#142)', () => {
    expect(TOOL_PREFIXES).toEqual(['board']);
    expect(toolNamesForScope(false).some((n) => n.startsWith('atlas_'))).toBe(false);
  });

  // The rule itself, driven over SYNTHETIC lists so the two populations
  // actually differ. Against the real lists this cannot be tested — with
  // HUMAN_WRITE_SUFFIXES empty both branches return the same names, and an
  // assertion over them passes whatever the rule underneath does.
  it('the agent flag decides which suffixes an actor gets', () => {
    expect(suffixesForActor(true, ['r'], ['w'])).toEqual(['r']);
    expect(suffixesForActor(false, ['r'], ['w'])).toEqual(['r', 'w']);
  });

  // Why the rule takes the flag and not the scope list. These two disagree for
  // exactly one caller — the unscoped browser session, whose scopes arrive as
  // [] (jwt-auth.guard.ts:132 sets none) and whose agent flag is false.
  // deriveAgentFlag([]) says "agent" because [] holds no board:admin; that
  // session is a signed-in person with the whole surface. Feeding the scopes
  // argument to deriveAgentFlag would hand every signed-in person the agent
  // list. If you are here to drop the `scopes` parameter because "agent is
  // derivable", it is not. Read section 5 of the plan for #536.
  it('deriveAgentFlag disagrees with the agent flag for the unscoped person', () => {
    expect(deriveAgentFlag([])).toBe(true);
    expect(suffixesForActor(deriveAgentFlag([]), ['r'], ['w'])).toEqual(['r']);
    expect(suffixesForActor(false, ['r'], ['w'])).toEqual(['r', 'w']);
  });

  // NOT the same claim as the two above, and weaker than its old name said.
  // It asserts that what a person's server REGISTERS matches what
  // toolNamesForScope DECLARES. While HUMAN_WRITE_SUFFIXES is empty both sides
  // are ['board_whoami'] whatever sources the decision, so this cannot catch a
  // registration keyed on the wrong value — suffixesForActor's own tests do
  // that. This one starts biting the day a write tool lands.
  it('a person gets the same names registered as toolNamesForScope declares', () => {
    const person: McpActor = { sub: 's', email: 'a@b.c', agent: false, staticAgent: false };
    expect(registeredNamesFor(person, [])).toEqual(toolNamesForScope(false));
  });
});

/**
 * These strings are what an agent is told about a route it cannot call, and this
 * file's whole job is describing behaviour that lives somewhere else — so a
 * sentence here goes false without anything in this file changing, and reads
 * exactly as fluently once it has.
 *
 * The rule they broke at #649: three of them promised an owner PINNED TO ONE
 * ORG, which stopped being true the moment the pin became an allow-list. What
 * makes that a false promise rather than a stale one is the direction — an agent
 * told the surface is narrower than it is will not ask why a write it expected
 * to be refused went through.
 *
 * The forbidden SHAPE is checked rather than the three known sentences, and over
 * the whole map rather than the entries this change happened to touch: a fourth
 * written tomorrow is caught by the same line. The keys come from
 * `RETIRED_SETTINGS`, which is where the four that used to pin an owner live
 * now (#1209 part 4) — a description still promising one of them is promising a
 * setting the service no longer reads.
 */
const SINGLE_ORG_PROMISE = new RegExp(`(pinned|bound|belongs?|belong)\\s+to\\s+(${RETIRED_SETTINGS.join('|')})\\b`);

describe('the write descriptions describe the pin that shipped (#649)', () => {
  it('no description in the map promises an owner pinned to one org', () => {
    const stale = Object.entries(MCP_HUMAN_ONLY_WRITES)
      .filter(([, text]) => SINGLE_ORG_PROMISE.test(text))
      .map(([route]) => route);
    expect(stale, 'these promise a single-org pin the code no longer runs').toEqual([]);
  });

  it('the guard above discriminates: it fires on the wording it forbids', () => {
    // Without this the check could be vacuous — a pattern that matches nothing
    // reports a clean map whatever the map says. Both retired shapes are here,
    // because the map used each of them.
    expect(SINGLE_ORG_PROMISE.test('owner-pinned to ISSUES_METRICS_ORG.')).toBe(true);
    expect(SINGLE_ORG_PROMISE.test('the target project must belong to PROJECTS_OWNER')).toBe(true);
    expect(SINGLE_ORG_PROMISE.test('owner allow-listed on PROJECTS_OWNER')).toBe(false);
  });

  it('the pattern covers every retired key, so none can slip past it', () => {
    for (const key of RETIRED_SETTINGS) {
      expect(SINGLE_ORG_PROMISE.test(`owner-pinned to ${key}.`), key).toBe(true);
    }
  });

  it('both owner-gated write routes say what allow-lists them', () => {
    // They named a setting each until #1209 part 4 retired both. One owner
    // scope answers for every route now, so both descriptions name that.
    for (const route of ['PATCH repos/:owner/:repo/dri', 'PATCH issues/:owner/:repo/:number/task']) {
      expect(MCP_HUMAN_ONLY_WRITES[route], route).toContain('owner allow-listed on the owner scope');
    }
  });
});

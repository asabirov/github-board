import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildOverviewMcpServer,
  toolNamesForScope,
  MCP_BACKED_WRITES,
  MCP_HUMAN_ONLY_WRITES,
  type McpActor,
  type OverviewToolDeps,
} from './overview-tools';
// The discovery this guard used to own. It moved to a `.contract.ts` when the
// capability gate (#584) needed the same functions, because a `.spec.ts` cannot
// be imported by another `.spec.ts` without re-registering its whole suite. Its
// fixture tests moved with it, to `write-route-discovery.spec.ts`.
import { extractWriteRoutes, walk } from './write-route-discovery.contract';

/**
 * REST ↔ MCP write-parity guard (#141). Instead of trusting a hand-kept list,
 * this test DISCOVERS every board-write route from the controller sources and
 * asserts each is classified exactly once — either backed by an MCP tool
 * (MCP_BACKED_WRITES) or deliberately human/UI-only (MCP_HUMAN_ONLY_WRITES).
 * A newly added @Post/@Patch/@Delete/@Put therefore fails the build until
 * someone records the parity decision. It also checks the classification's
 * MCP side against the ACTUAL registered tools, so the decision can't lie.
 *
 * The guard fails CLOSED: because it discovers its own inputs, any decorator
 * shape the parser can't read must surface as an obvious route key (never be
 * silently dropped), or a missed route would make "every route is classified"
 * pass vacuously. `extractWriteRoutes` lives in
 * `write-route-discovery.contract.ts` and is fixture-tested in
 * `write-route-discovery.spec.ts` against the shapes a real controller uses —
 * multiline, extra args, array and template-literal paths, `@Controller` with an
 * options object — and to emit a loud `<unparsed:…>` key for anything it
 * genuinely can't read.
 */

// Infrastructure controllers — protocol/auth plumbing, not board mutations.
// Their write routes are intentionally outside the parity contract.
const INFRA_CONTROLLERS = new Set([
  'google-auth.controller.ts', // POST logout
  'consent.controller.ts', // POST OAuth consent
  'mcp.controller.ts', // the MCP transport endpoint itself
  'webhook.controller.ts', // POST Github App webhook deliveries (#1007): Github's, never a person's
]);

/** Discover `METHOD path` route keys from every non-infra controller source. */
function discoverWriteRoutes(): Set<string> {
  const srcRoot = join(__dirname, '..');
  const routes = new Set<string>();
  for (const file of walk(srcRoot)) {
    const base = file.split('/').pop()!;
    if (INFRA_CONTROLLERS.has(base)) continue;
    for (const route of extractWriteRoutes(readFileSync(file, 'utf8'))) routes.add(route);
  }
  return routes;
}

/** The names actually registered on a real server for the given scope. */
function registeredTools(agent: boolean): string[] {
  const actor: McpActor = { sub: 's', email: 'a@b.c', agent, staticAgent: false };
  // Handlers are closures — never invoked at registration — so stub deps are fine.
  const server = buildOverviewMcpServer(actor, [], {} as unknown as OverviewToolDeps);
  return Object.keys(
    (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
  );
}

/** Entries whose named tool is not actually registered. The real check and its
 *  self-test both go through HERE, so the self-test goes red if THIS drifts. */
function unbackedEntries(
  map: Record<string, string>,
  registered: ReadonlySet<string>,
): [string, string][] {
  return Object.entries(map).filter(([, tool]) => !registered.has(tool));
}

describe('REST ↔ MCP write parity (#141)', () => {
  const discovered = discoverWriteRoutes();
  const classified = new Set([
    ...Object.keys(MCP_BACKED_WRITES),
    ...Object.keys(MCP_HUMAN_ONLY_WRITES),
  ]);

  it('every REST write route is classified (mcp-backed or human-only)', () => {
    const unclassified = [...discovered].filter((r) => !classified.has(r)).sort();
    expect(unclassified, 'add these to MCP_BACKED_WRITES or MCP_HUMAN_ONLY_WRITES').toEqual([]);
  });

  it('no stale classification points at a route that no longer exists', () => {
    const stale = [...classified].filter((r) => !discovered.has(r)).sort();
    expect(stale, 'these classified routes were not found in any controller').toEqual([]);
  });

  it('a route is never both mcp-backed and human-only', () => {
    const both = Object.keys(MCP_BACKED_WRITES).filter((r) => r in MCP_HUMAN_ONLY_WRITES);
    expect(both).toEqual([]);
  });

  it('an unrecorded write route is flagged (the guard is not vacuous)', () => {
    // Discovery and classification, exercised end to end on a route that exists
    // in no controller and no map — the shape a new @Post arrives in.
    const newcomer = extractWriteRoutes(
      `@Controller('widgets') class C { @Post(':id/frobnicate') f() {} }`,
    );
    expect(newcomer).toEqual(['POST widgets/:id/frobnicate']);
    expect(newcomer.filter((r) => !classified.has(r))).toEqual(newcomer);
  });

  it('every mcp-backed route maps to a tool that is actually registered', () => {
    const unbacked = unbackedEntries(MCP_BACKED_WRITES, new Set(registeredTools(false)));
    expect(unbacked, 'these routes name a tool no server registers').toEqual([]);
  });

  it('the mcp-backed check would catch a tool that is not registered', () => {
    // MCP_BACKED_WRITES is {} while the surface carries only read tools, so the
    // loop above is a loop over nothing. This drives the SAME function over a
    // synthetic mapping, in both directions, so the check itself is under test.
    const registered = new Set(registeredTools(false));
    expect(unbackedEntries({ 'POST widgets': 'board_not_a_tool' }, registered)).toEqual([
      ['POST widgets', 'board_not_a_tool'],
    ]);
    // …and does not cry wolf over a tool that IS registered
    expect(unbackedEntries({ 'POST widgets': 'board_whoami' }, registered)).toEqual([]);
  });

  it('toolNamesForScope matches the tools actually registered (no drift)', () => {
    expect([...toolNamesForScope(false)].sort()).toEqual(registeredTools(false).sort());
    expect([...toolNamesForScope(true)].sort()).toEqual(registeredTools(true).sort());
  });
});

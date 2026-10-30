import 'reflect-metadata'; // LINE 1. `PATH_METADATA` reads return undefined without it.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { extractWriteRoutes, walk } from '../mcp/write-route-discovery.contract';
import { MCP_BACKED_WRITES } from '../mcp/overview-tools';
import { WRITES_CAPABILITY } from './writes.decorator';
import { CAPABILITIES } from './capability';
import {
  declaredWritesOf,
  undeclaredWrites,
  type DeclaredWrite,
} from './writes-metadata-discovery.contract';

/**
 * Build-time capability gate (#584). Two discoveries, deliberately.
 *
 * SOURCE discovery (`extractWriteRoutes`) reads controller text and answers
 * `METHOD path` for every @Post/@Patch/@Put/@Delete. It is fail-loud: a path it
 * cannot read statically becomes `<unparsed:…>` rather than vanishing. It is the
 * RAW function, not `discoverWriteRoutes` — that one applies INFRA_CONTROLLERS,
 * whose three entries (`mcp-rest-parity.spec.ts:34-36`) are
 * `google-auth.controller.ts`, `consent.controller.ts` and `mcp.controller.ts`.
 * Using it here would drop `POST auth/google/logout` and `POST oauth/consent`
 * from this gate — and logout is the route this plan is most anxious about,
 * because a fail-closed sign-out locks people into a session they asked to
 * leave. (`connected-clients.controller.ts` is NOT in that set; its DELETE is
 * found either way.)
 *
 * METADATA discovery imports the controller CLASSES and reads what Nest actually
 * registered. It exists because source discovery has a hole this issue cares
 * about: `mcp.controller.ts:36` is `@All()`, and the source regex matches only
 * the four write decorators — so the one route on this board that already
 * escapes RequiredScopesGuard's write default is invisible to the source half.
 * `RequestMethod.ALL` is visible to this half, as `ALL mcp`.
 *
 * The two are asserted against each other, so neither can quietly stop finding
 * things.
 */
const SRC = join(__dirname, '..');
const controllerFiles = () =>
  walk(SRC).filter((f) => f.endsWith('.controller.ts') && !f.includes('.spec.'));

let declared: DeclaredWrite[] = [];
const failedImports: string[] = [];

// `require()` does not run here — this is an ESM vitest suite, and a `require`
// of a `.ts` controller throws. A dynamic import does, and it is asynchronous,
// so it belongs in `beforeAll` rather than at module scope.
beforeAll(async () => {
  for (const file of controllerFiles()) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (err) {
      // Collected, never swallowed. A controller that will not import must fail
      // this suite loudly; a caught-and-ignored import shrinks the gate to
      // exactly the routes that still work.
      failedImports.push(`${file}: ${String(err)}`);
      continue;
    }
    // The discovery itself lives in the contract file, so the vacuity check at
    // the bottom of this suite drives the SAME function this gate runs on and
    // not a hand-built copy of it.
    for (const exported of Object.values(mod)) declared.push(...declaredWritesOf(exported));
  }
});

describe('every write route declares what it writes (#584)', () => {
  it('every controller imported', () => {
    // Without this the gate shrinks silently: a controller that fails to import
    // contributes no routes and no failure.
    expect(failedImports).toEqual([]);
  });

  it('the discovery found the write surface, and not a fraction of it', () => {
    // A FLOOR, not a ledger. Every other assertion in this suite is about what
    // `declared` contains, and each of them passes on an empty list: a `walk()`
    // that stopped descending, a rename of `.controller.ts`, or an import loop
    // that emptied the array would leave the gate green while it guarded
    // nothing. Twenty is what the board has today; raise it when routes are
    // added, and never lower it without saying which route left.
    expect(declared.length, `metadata discovery found ${declared.length} write routes`).toBeGreaterThanOrEqual(20);
  });

  it('no write route is missing @Writes', () => {
    expect(
      undeclaredWrites(declared),
      'add @Writes(...) — or @Writes() for a route that writes no Github',
    ).toEqual([]);
  });

  it('every declared capability is a real one', () => {
    const bogus = declared.flatMap((d) =>
      (d.caps ?? []).filter((c) => !(CAPABILITIES as readonly string[]).includes(c)),
    );
    expect(bogus).toEqual([]);
  });

  it('metadata discovery finds every route source discovery finds', () => {
    const fromSource = new Set(
      controllerFiles().flatMap((f) => extractWriteRoutes(readFileSync(f, 'utf8'))),
    );
    const fromMetadata = new Set(declared.map((d) => d.key));
    expect([...fromSource].filter((r) => !fromMetadata.has(r)).sort()).toEqual([]);
    // …and the metadata half finds strictly MORE — the @All() route.
    expect(fromMetadata.has('ALL mcp')).toBe(true);
  });

  it('an undeclared route is flagged, and a declared one is not (the gate is not vacuous)', () => {
    // Two controllers that exist in no file, run through the discovery the gate
    // itself runs — not a predicate rebuilt here. A discovery that read an
    // absent @Writes as `[]` would report `Widgets` as having answered, and this
    // is what catches that.
    class Widgets {
      frobnicate() {}
    }
    Reflect.defineMetadata(PATH_METADATA, 'widgets', Widgets);
    Reflect.defineMetadata(METHOD_METADATA, RequestMethod.POST, Widgets.prototype.frobnicate);

    class Gadgets {
      fettle() {}
    }
    Reflect.defineMetadata(PATH_METADATA, 'gadgets', Gadgets);
    Reflect.defineMetadata(METHOD_METADATA, RequestMethod.PATCH, Gadgets.prototype.fettle);
    Reflect.defineMetadata(WRITES_CAPABILITY, ['issue.labels'], Gadgets.prototype.fettle);

    expect(declaredWritesOf(Widgets)).toEqual([{ key: 'POST widgets', caps: undefined }]);
    expect(declaredWritesOf(Gadgets)).toEqual([{ key: 'PATCH gadgets', caps: ['issue.labels'] }]);
    // …and the gate's own predicate flags the one and passes the other.
    expect(undeclaredWrites([...declaredWritesOf(Widgets), ...declaredWritesOf(Gadgets)])).toEqual([
      'POST widgets',
    ]);
  });

  it('the @All() MCP handler declares @Writes() only because no MCP tool writes Github', () => {
    // `mcp.controller.ts:36` is ONE handler for every MCP tool call. Its
    // `@Writes()` says "this route writes no Github", which is true while
    // MCP_BACKED_WRITES is empty and false the moment it is not. When this fails:
    // give the handler the union of the capabilities its backed writes need, or
    // move the write behind a real route with its own @Writes.
    expect(Object.keys(MCP_BACKED_WRITES)).toEqual([]);
  });

  it('main.ts mounts exactly one raw express router outside the Nest chain', () => {
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
    // If this becomes 2, a new surface has been mounted where no guard can reach
    // it and no decorator can describe it — decide deliberately, then update this.
    // `app.useBodyParser(` does not match; `app.use(` at main.ts:33 does.
    expect([...main.matchAll(/app\.use\(/g)]).toHaveLength(1);
  });
});

import 'reflect-metadata'; // LINE 1. `PATH_METADATA` reads return undefined without it.
import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import ts from 'typescript-api';
import { walk } from '../mcp/write-route-discovery.contract';
import { declaredWritesOf, type DeclaredWrite } from './writes-metadata-discovery.contract';
import {
  buildWriteProgram,
  buildSyntheticProgram,
  envelopeSkippers,
  writeRoots,
  misplacedWrites,
  describeSkipper,
  describeMisplaced,
  SRC_DIR,
  ENVELOPE_FILE,
  ENVELOPE_SYMBOL,
} from './write-reachability.contract';

/**
 * Build-time reachability gate (#616).
 *
 * `writes-declared.spec.ts` asks whether a write route SAYS what it writes.
 * This one asks whether it goes through the envelope that acts on what it said:
 * `guardWrite` is the single place the owner pin, the writes-off 503 and the
 * per-target capability rung live, and a route that never reaches it writes to
 * Github with none of them run. Declaring `@Writes('issue.labels')` and then
 * calling a source method directly compiles, boots, and passes every other
 * suite.
 *
 * Roots are route handlers whose `@Writes` names at least one capability.
 * `@Writes()` with no argument is a route saying it writes no Github, so the
 * nine local-write routes are out by construction rather than by an exemption
 * list; `writes-dominated.spec.ts` is what reads that claim back against the
 * body (#624). `boot-alert.notifier.ts` writes Github and has no route above it,
 * so it is out of this gate's subject for the same reason — nothing named it a
 * write route.
 *
 * This gate stops at REACHABLE. Whether the envelope ran BEFORE the write is
 * `writes-dominated.spec.ts` (#621).
 *
 * Edges come from the TypeScript checker, so `this.service.setLabels(...)`
 * resolves through the injected property's declared type rather than by name.
 */
const SRC = SRC_DIR;

/** The options every synthetic program below is read under. */
const SYNTHETIC = { rootDir: '/synthetic', envelopeFile: 'envelope.ts', envelopeSymbol: 'guardWrite' };

const ENVELOPE_SOURCE = `
  export function guardWrite(subject: { owner: string }): number { return subject.owner.length; }
`;

/** Local stand-ins for the Nest decorators, so a synthetic program needs no
 *  `@nestjs` resolution. Their bodies do nothing, which is the point in the
 *  decorator-edge check: a real `@Writes` body is an arrow under src/. */
const NEST_STUBS = `
  const Controller = (p: string) => (t: unknown) => { void p; void t; };
  const Patch = (p: string) => (t: unknown, k: string, d: unknown) => { void p; void t; void k; void d; };
  const Get = (p: string) => (t: unknown, k: string, d: unknown) => { void p; void t; void k; void d; };
  const Writes = (...c: string[]) => (t: unknown, k: string, d: unknown) => { void c; void t; void k; void d; };
`;

let program: ts.Program;
let roots: ReturnType<typeof writeRoots>;
let skippers: ReturnType<typeof envelopeSkippers>;

// Five minutes, not the default thirty seconds, for the reason its sibling
// `writes-dominated.spec.ts` carries: a gate whose hook compiles a `ts.Program`
// is bounded by machine load rather than by what it asserts, so its timeout must
// have headroom over the load this repo actually sees — not over the load on a
// quiet run. Measured: this file took 25.4s on a run at load ~230, which is 4.6s
// inside the default on a machine that has been between 116 and 419; it timed
// out outright at ~409. That is not passing, it is passing so far.
//
// A gate that stops running when the runner is busy is not a gate, and its
// failure is worse than a plain red: it reads as "just load", gets waved
// through, and the next failure — a real one, in the envelope coverage this file
// exists to hold — gets waved through with it.
beforeAll(() => {
  program = buildWriteProgram();
  roots = writeRoots(program);
  skippers = envelopeSkippers(program);
}, 300_000);

describe('every Github write route reaches the write envelope (#616)', () => {
  it('the discovery found the Github-writing surface, and not a fraction of it', () => {
    // A FLOOR, not a ledger. Every other assertion here passes on an empty root
    // set: a program that stopped resolving files, a rename of `.controller.ts`,
    // or a decorator read that stopped matching would leave this suite green
    // while it guarded nothing. Eleven was the count when this floor was set —
    // `repo.dri`, `feedback.submit` and nine issue facets. #1450 removed
    // `feedback.submit`, and later issue routes keep the count above the floor.
    // Raise it when routes are added, and never lower it without naming the
    // route that left.
    expect(roots.length, `source discovery found ${roots.length} Github-writing routes`).toBeGreaterThanOrEqual(11);
  });

  it('no Github write route skips the envelope', () => {
    expect(skippers.map(describeSkipper)).toEqual([]);
  });

  it('the envelope this gate looks for exists where it says it does', () => {
    // Without this the gate inverts on a rename: an `ENVELOPE_SYMBOL` that
    // matches nothing makes every root unsatisfied, which is loud — but a
    // reachability check whose target is absent is not measuring reachability,
    // and the failure would send whoever trips it looking at their own route.
    const file = program
      .getSourceFiles()
      .find((f) => f.fileName.endsWith(ENVELOPE_FILE));
    expect(file, `${ENVELOPE_FILE} is not in the program this gate reads`).toBeDefined();
    const declared = file!.statements.some(
      (s) => ts.isFunctionDeclaration(s) && s.name?.text === ENVELOPE_SYMBOL,
    );
    expect(declared, `${ENVELOPE_FILE} declares no function ${ENVELOPE_SYMBOL}`).toBe(true);
  });

  it('a skipping route is reported and a guarded one is not (the gate is not vacuous)', () => {
    // Two routes that exist in no file, driven through the SAME discovery the
    // gate runs, over a program built in memory. The assertion above reports an
    // empty list both when every route is guarded and when the walk has stopped
    // walking, and those are opposite facts — this is what tells them apart.
    //
    // Both halves are load-bearing, and the second one is here because the gate
    // failed it once. Both implementers are named in a module file, because a
    // class the container could not construct vouches for nothing — see the
    // check of that below. `guarded` reaches the envelope ONLY through an interface:
    // it calls `ISource.push`, which has no body, so without widening to the
    // classes that implement it the route would be reported and the widening
    // would be untested. `skipping` calls `Map.get`, whose declaration is also
    // a body-less signature — and an unrelated `Elsewhere.get` in the same
    // program does call the envelope. A widening that falls back to "any method
    // of that name" joins those two and reports nothing, which is exactly what
    // the first version of this gate did to a real throwaway route.
    const synthetic = buildSyntheticProgram({
      '/synthetic/envelope.ts': `
        export function guardWrite(subject: { owner: string }): number { return subject.owner.length; }
      `,
      '/synthetic/source.ts': `
        import { guardWrite } from './envelope';
        export interface ISource { push(n: number): void }
        export class RealSource implements ISource {
          push(n: number): void { guardWrite({ owner: 'acme' }); void n; }
        }
        export class Elsewhere {
          get(k: string): void { guardWrite({ owner: 'acme' }); void k; }
        }
      `,
      '/synthetic/app.module.ts': `
        import { Elsewhere, RealSource } from './source';
        export const providers = [Elsewhere, RealSource];
      `,
      '/synthetic/widgets.controller.ts': `
        import type { ISource } from './source';
        const Controller = (p: string) => (t: unknown) => { void p; void t; };
        const Patch = (p: string) => (t: unknown, k: string, d: unknown) => { void p; void t; void k; void d; };
        const Writes = (...c: string[]) => (t: unknown, k: string, d: unknown) => { void c; void t; void k; void d; };

        @Controller('widgets')
        export class WidgetsController {
          constructor(
            private readonly source: ISource,
            private readonly bag: Map<string, number>,
          ) {}

          @Writes('issue.labels')
          @Patch(':id/guarded')
          guarded(): void {
            this.source.push(1);
          }

          @Writes('issue.labels')
          @Patch(':id/skipping')
          skipping(): void {
            this.bag.get('anything');
          }
        }
      `,
    });
    expect(writeRoots(synthetic, SYNTHETIC).map((r) => r.route)).toEqual([
      'PATCH widgets/:id/guarded',
      'PATCH widgets/:id/skipping',
    ]);
    const found = envelopeSkippers(synthetic, SYNTHETIC);
    expect(found.map((s) => s.route)).toEqual(['PATCH widgets/:id/skipping']);
    // The message names the route, the file and symbol it lives in, and the
    // call it must make — all read back off the skipper it describes, so a
    // report that stopped naming any of them fails. `envelopeFile` is the one
    // this run used, not the module default: the report used to name
    // `capability/write-envelope.ts` while the discovery had been pointed at
    // `/synthetic/envelope.ts`, which sends whoever trips it to the wrong file.
    const message = describeSkipper(found[0]);
    expect(message).toContain(found[0].route);
    expect(message).toContain(found[0].where);
    expect(message).toContain(found[0].caps[0]);
    expect(message).toContain(SYNTHETIC.envelopeSymbol);
    expect(message).toContain(SYNTHETIC.envelopeFile);
    expect(message).not.toContain(ENVELOPE_FILE);
  });

  it('the source-level roots are exactly the routes Nest registered with a capability', async () => {
    // Cross-check, the way `writes-declared.spec.ts` checks its two discoveries
    // against each other. This half reads decorators out of the source text;
    // that half imports the controller classes and reads what Nest registered.
    // Neither can quietly stop finding things while the other still does.
    const declared: DeclaredWrite[] = [];
    for (const file of walk(SRC).filter((f) => f.endsWith('.controller.ts') && !f.includes('.spec.'))) {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      for (const exported of Object.values(mod)) declared.push(...declaredWritesOf(exported));
    }
    const fromMetadata = declared
      .filter((d) => (d.caps ?? []).length > 0)
      .map((d) => d.key)
      .sort();
    expect(roots.map((r) => r.route).sort()).toEqual(fromMetadata);
  });

  // ── The fail-open holes two reviewers executed against a copy of the real
  // program. Each one passed the suite above while the gate guarded nothing,
  // so each one gets a program that reproduces it. ──────────────────────────

  it('a decorator on the handler is not a call the handler makes', () => {
    // TS5 keeps decorators in `node.modifiers`, so a naive walk over a handler
    // collects `Writes(...)`, `Patch(...)` and `UseGuards(...)` as calls it
    // makes. `Writes` and `RequiredScopes` are local arrows under src/, which
    // makes them live edges: one line added to `writes.decorator.ts` that
    // reaches the envelope module would mark all eleven routes guarded with
    // every test still green.
    const program = buildSyntheticProgram({
      '/synthetic/envelope.ts': ENVELOPE_SOURCE,
      '/synthetic/decorators.ts': `
        import { guardWrite } from './envelope';
        export const Writes = (...caps: string[]) => (t: unknown, k: string, d: unknown) => {
          guardWrite({ owner: 'acme' });
          void caps; void t; void k; void d;
        };
      `,
      '/synthetic/widgets.controller.ts': `
        import { Writes } from './decorators';
        ${NEST_STUBS}
        @Controller('widgets')
        export class WidgetsController {
          @Writes('issue.labels')
          @Patch(':id/x')
          x(): void {}
        }
      `,
    });
    expect(envelopeSkippers(program, SYNTHETIC).map((s) => s.route)).toEqual(['PATCH widgets/:id/x']);
  });

  it('a handler inherited from a base class is a route, and a root', () => {
    // Nest's MetadataScanner walks the prototype chain, so this route is
    // registered and CapabilityGuard passes it. Both discoveries go blind
    // together here — `declaredWritesOf` reads own properties only, and the
    // metadata walk opens `*.controller.ts` — so the cross-check cannot catch
    // it. Nine near-identical `this.run(...)` bodies sit in
    // `issue-detail.controller.ts` today and hoisting them into a base is the
    // obvious refactor.
    const program = buildSyntheticProgram({
      '/synthetic/envelope.ts': ENVELOPE_SOURCE,
      '/synthetic/base.ts': `
        ${NEST_STUBS}
        export abstract class WriteBase {
          @Writes('issue.labels')
          @Patch(':id/x')
          x(): void {}
        }
      `,
      '/synthetic/widgets.controller.ts': `
        import { WriteBase } from './base';
        ${NEST_STUBS}
        @Controller('widgets')
        export class WidgetsController extends WriteBase {}
      `,
    });
    expect(writeRoots(program, SYNTHETIC).map((r) => r.route)).toEqual(['PATCH widgets/:id/x']);
    expect(envelopeSkippers(program, SYNTHETIC).map((s) => s.route)).toEqual(['PATCH widgets/:id/x']);
  });

  it('a controller nested in a namespace is still a controller', () => {
    const program = buildSyntheticProgram({
      '/synthetic/envelope.ts': ENVELOPE_SOURCE,
      '/synthetic/widgets.controller.ts': `
        ${NEST_STUBS}
        export namespace Api {
          @Controller('widgets')
          export class WidgetsController {
            @Writes('issue.labels')
            @Patch(':id/x')
            x(): void {}
          }
        }
      `,
    });
    expect(writeRoots(program, SYNTHETIC).map((r) => r.route)).toEqual(['PATCH widgets/:id/x']);
  });

  it('two interfaces that merely share a name are not the same interface', () => {
    // Heritage matched by identifier text conflates them, and the union rule
    // then lets the guarding implementer of one vouch for a call on the other.
    // A new `src/widget/` with its own source interface was enough to hide an
    // unguarded `octokit.issues.create` behind a guarded source of the same name.
    const program = buildSyntheticProgram({
      '/synthetic/envelope.ts': ENVELOPE_SOURCE,
      '/synthetic/guarded/types.ts': `export interface ISource { push(n: number): void }`,
      '/synthetic/guarded/impl.ts': `
        import { guardWrite } from '../envelope';
        import type { ISource } from './types';
        export class GuardedSource implements ISource {
          push(n: number): void { guardWrite({ owner: 'acme' }); void n; }
        }
      `,
      '/synthetic/other/types.ts': `export interface ISource { push(n: number): void }`,
      '/synthetic/other/impl.ts': `
        import type { ISource } from './types';
        export class OtherSource implements ISource { push(n: number): void { void n; } }
      `,
      '/synthetic/app.module.ts': `
        import { GuardedSource } from './guarded/impl';
        import { OtherSource } from './other/impl';
        export const providers = [GuardedSource, OtherSource];
      `,
      '/synthetic/widgets.controller.ts': `
        import type { ISource } from './other/types';
        ${NEST_STUBS}
        @Controller('widgets')
        export class WidgetsController {
          constructor(private readonly source: ISource) {}

          @Writes('issue.labels')
          @Patch(':id/x')
          x(): void { this.source.push(1); }
        }
      `,
    });
    expect(envelopeSkippers(program, SYNTHETIC).map((s) => s.route)).toEqual(['PATCH widgets/:id/x']);
  });

  it('a class the container could never construct vouches for nothing', () => {
    // Bound in no module, imported by nothing, constructed never — and under
    // the union rule it was enough to mark a live unguarded Github write as
    // guarded. Dead code must not answer for code that runs.
    const program = buildSyntheticProgram({
      '/synthetic/envelope.ts': ENVELOPE_SOURCE,
      '/synthetic/types.ts': `export interface ISource { push(n: number): void }`,
      '/synthetic/real.ts': `
        import type { ISource } from './types';
        export class RealSource implements ISource { push(n: number): void { void n; } }
      `,
      '/synthetic/dead.ts': `
        import { guardWrite } from './envelope';
        import type { ISource } from './types';
        export class DeadSource implements ISource {
          push(n: number): void { guardWrite({ owner: 'acme' }); void n; }
        }
      `,
      '/synthetic/app.module.ts': `
        import { RealSource } from './real';
        export const providers = [RealSource];
      `,
      '/synthetic/widgets.controller.ts': `
        import type { ISource } from './types';
        ${NEST_STUBS}
        @Controller('widgets')
        export class WidgetsController {
          constructor(private readonly source: ISource) {}

          @Writes('issue.labels')
          @Patch(':id/x')
          x(): void { this.source.push(1); }
        }
      `,
    });
    expect(envelopeSkippers(program, SYNTHETIC).map((s) => s.route)).toEqual(['PATCH widgets/:id/x']);
  });

  it('a capability declared on the controller class reaches its write routes', () => {
    // `SetMetadata` is a ClassDecorator too, and CapabilityGuard reads
    // `getAllAndOverride([handler, class])` — so this route is declared as far
    // as the runtime is concerned, and the gate has to agree.
    const program = buildSyntheticProgram({
      '/synthetic/envelope.ts': ENVELOPE_SOURCE,
      '/synthetic/widgets.controller.ts': `
        ${NEST_STUBS}
        @Controller('widgets')
        @Writes('issue.labels')
        export class WidgetsController {
          @Patch(':id/x')
          x(): void {}

          @Writes()
          @Patch(':id/local')
          local(): void {}
        }
      `,
    });
    // …and a method's own `@Writes()` still overrides the class: `local` says
    // it writes no Github, and that answer wins over the class's.
    expect(writeRoots(program, SYNTHETIC).map((r) => r.route)).toEqual(['PATCH widgets/:id/x']);
    expect(envelopeSkippers(program, SYNTHETIC).map((s) => s.route)).toEqual(['PATCH widgets/:id/x']);
  });

  it('a capability declared on a read verb is reported, not dropped', () => {
    // `capability.guard.ts:63` returns early on read verbs, and `WRITE_METHODS`
    // has no `GET` — so a `@Get` handler that declares a capability and writes
    // Github escapes the runtime check, the metadata discovery and this gate at
    // once, and the cross-check agrees at eleven while saying nothing.
    const program = buildSyntheticProgram({
      '/synthetic/envelope.ts': ENVELOPE_SOURCE,
      '/synthetic/widgets.controller.ts': `
        ${NEST_STUBS}
        @Controller('widgets')
        export class WidgetsController {
          @Writes('issue.labels')
          @Get(':id/x')
          x(): void {}
        }
      `,
    });
    const misplaced = misplacedWrites(program, SYNTHETIC);
    expect(misplaced.map((m) => m.where)).toEqual(['widgets.controller.ts#WidgetsController.x']);
    expect(describeMisplaced(misplaced[0])).toContain('write verb');
    // It is not a root either — a route the gate cannot walk must never be
    // counted among the ones it did.
    expect(writeRoots(program, SYNTHETIC)).toEqual([]);
  });

  it('no capability is declared where neither this gate nor the guard reads it', () => {
    expect(misplacedWrites(program).map(describeMisplaced)).toEqual([]);
  });

  it('the real walk can still answer no', () => {
    // The synthetic checks above all pass on a walk that has quietly gone
    // vacuous over the REAL tree, and every fail-open in this block proved
    // exactly that. So: run the real program against an envelope symbol that
    // exists nowhere, and require every root to come back as a skipper. If the
    // walk has stopped walking, or the root set has emptied, this is what says
    // so.
    const absent = envelopeSkippers(program, { envelopeSymbol: 'guardWriteDeclaredNowhere' });
    expect(absent.map((s) => s.route)).toEqual(roots.map((r) => r.route));
    expect(absent.length).toBeGreaterThanOrEqual(11);
  });

  it('a tsconfig it cannot read is an error, not a default', () => {
    // Truncated mid-token, `buildWriteProgram` silently ran on TypeScript's
    // DEFAULT compiler options and still answered 11 roots / 0 skippers. A gate
    // whose own principle is to fail loud cannot compile the tree under options
    // nobody chose.
    const dir = mkdtempSync(join(tmpdir(), 'write-reachability-'));
    writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict":');
    mkdirSync(join(dir, 'src'));
    expect(() => buildWriteProgram(join(dir, 'src'))).toThrow(/tsconfig/i);
  });

});

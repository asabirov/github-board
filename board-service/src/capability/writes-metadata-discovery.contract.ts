import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { joinPath } from '../mcp/write-route-discovery.contract';
import { WRITES_CAPABILITY } from './writes.decorator';

/**
 * The metadata half of the write-route discovery (#584) — what Nest actually
 * registered, read off the controller CLASS.
 *
 * It lives beside `../mcp/write-route-discovery.contract.ts`, which is the
 * source-text half, and for the same reason: a discovery that only ever ran
 * inside its own spec's `beforeAll` could not be driven over a controller of the
 * test's own making, so `writes-declared.spec.ts` had to re-implement the
 * predicate inline to check itself — and then its vacuity test defended a copy
 * rather than the gate. Exported, the gate and the check against it are one
 * function.
 *
 * `*.contract.ts` is excluded from the build (`tsconfig.build.json:12`), so this
 * compiles under the typecheck CI runs and never reaches `dist`.
 */

/**
 * The four write verbs, plus `ALL` — `mcp.controller.ts:36` is `@All()`, and it
 * is the one route on this board that already escapes RequiredScopesGuard's
 * write default, so a map without it would let the gate miss exactly that.
 *
 * COUPLED to `ROUTE_DECORATORS` in `write-reachability.contract.ts`, which
 * holds the same five verbs as decorator NAMES because it reads source text
 * where this reads the numbers Nest recorded. They cannot share a literal, so
 * the coupling is stated: a verb in one and not the other is a route one
 * discovery counts and the other does not, and the cross-check the two suites
 * run against each other then agrees while both are blind to it.
 */
export const WRITE_METHODS = new Map<number, string>([
  [RequestMethod.POST, 'POST'],
  [RequestMethod.PUT, 'PUT'],
  [RequestMethod.DELETE, 'DELETE'],
  [RequestMethod.PATCH, 'PATCH'],
  [RequestMethod.ALL, 'ALL'],
]);

export interface DeclaredWrite {
  /** `VERB path`, the same key shape source discovery answers in. */
  key: string;
  /** `undefined` means NOTHING was declared, and it is not the same answer as
   *  `[]` — an explicit `@Writes()` is a route saying it writes no Github. The
   *  gate fails closed on `undefined` alone, so the difference is the gate. */
  caps: string[] | undefined;
}

/** Every write route one exported value registers. Anything that is not a
 *  `@Controller` class answers with nothing. */
export function declaredWritesOf(exported: unknown): DeclaredWrite[] {
  if (typeof exported !== 'function') return [];
  const base = Reflect.getMetadata(PATH_METADATA, exported);
  if (typeof base !== 'string') return []; // not a @Controller
  const proto = (exported as { prototype?: object }).prototype;
  if (!proto) return [];
  const found: DeclaredWrite[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    // Read the DESCRIPTOR, not `proto[name]`. A plain property read invokes any
    // getter on the prototype with `this` unbound — `google-auth.controller.ts:28`
    // is `private get base()` and returns `this.config.get(...)`, which throws on
    // a bare prototype and takes the whole gate down with it. An accessor is
    // never a Nest route handler, so taking `descriptor.value` skips them and
    // reads methods exactly.
    const handler = Object.getOwnPropertyDescriptor(proto, name)?.value;
    if (typeof handler !== 'function') continue;
    const method = Reflect.getMetadata(METHOD_METADATA, handler);
    const verb = typeof method === 'number' ? WRITE_METHODS.get(method) : undefined;
    if (!verb) continue;
    const path = Reflect.getMetadata(PATH_METADATA, handler);
    // `joinPath`, not a second copy of it. Both discoveries' keys are compared
    // with `toEqual` in `writes-enveloped.spec.ts`, so two normalisations here
    // would be load-bearing against each other while still being two things to
    // keep in sync.
    const key = `${verb} ${joinPath(base, typeof path === 'string' ? path : '')}`;
    // Array.isArray FIRST. `expect(undefined).toContain(x)` passes silently in
    // vitest, and an unguarded read here would make the whole gate vacuous for
    // exactly the routes it exists to catch. Defaulting to `[]` instead of
    // `undefined` would do worse: every undecorated route would read as an
    // explicit "writes no Github" and the gate would find nothing, ever.
    const raw = Reflect.getMetadata(WRITES_CAPABILITY, handler);
    found.push({ key, caps: Array.isArray(raw) ? (raw as string[]) : undefined });
  }
  return found;
}

/** The gate's own predicate, so the suite and the check on the suite ask one
 *  question. */
export const undeclaredWrites = (declared: DeclaredWrite[]): string[] =>
  declared
    .filter((d) => d.caps === undefined)
    .map((d) => d.key)
    .sort();

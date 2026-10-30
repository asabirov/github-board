import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Source-level discovery of this board's write routes (#141, #584).
 *
 * These five symbols were written for `mcp-rest-parity.spec.ts` and lived there
 * until #584 needed a second gate over the same routes. A `.spec.ts` cannot be
 * imported by another `.spec.ts` without re-registering its whole suite, so the
 * discovery moved here rather than being duplicated. `*.contract.ts` is
 * build-excluded (`tsconfig.build.json:12`), so this file typechecks in CI and
 * never reaches `dist`.
 *
 * The discovery fails LOUD: an argument it cannot read as a static path becomes
 * a `<unparsed:…>` key rather than vanishing, because a route that disappears
 * makes every "every route is classified/declared" assertion pass vacuously.
 *
 * It is blind to `@All()` — `mcp.controller.ts:36` — by design: the regex reads
 * the four write decorators only. The capability gate covers that hole with a
 * second, metadata-based discovery (`capability/writes-declared.spec.ts`).
 */

export const STRING_LITERAL = /(['"`])((?:[^'"`\\]|\\.)*)\1/g;

/** Join a controller base + a route arg into a normalized `a/b/c` path. */
export function joinPath(base: string, arg: string): string {
  return [base, arg]
    .join('/')
    .split('/')
    .filter(Boolean)
    .join('/');
}

/** The controller's base path: bare string, `{ path: '...' }` options, or ''. */
export function controllerBaseOf(source: string): string {
  // @Controller('base') or @Controller("base")
  const bare = /@Controller\(\s*(['"`])([^'"`]*)\1\s*\)/.exec(source);
  if (bare) return bare[2];
  // @Controller({ path: 'base', ... })
  const opts = /@Controller\(\s*\{[\s\S]*?\bpath\s*:\s*(['"`])([^'"`]*)\1/.exec(source);
  if (opts) return opts[2];
  return '';
}

/**
 * Pull `METHOD path` route keys out of one controller source. Reads the FIRST
 * argument of each write decorator regardless of what follows it (extra args,
 * newlines): a quoted string, a template literal, an array of strings (→ one
 * route each), or nothing (→ the controller base). An argument it cannot read
 * as a static path becomes `METHOD <unparsed:…>` so the guard fails loudly
 * instead of dropping the route.
 */
export function extractWriteRoutes(source: string): string[] {
  const base = controllerBaseOf(source);
  const routes: string[] = [];
  // Match the decorator name + everything up to the first ')'. A Nest method
  // decorator takes only an optional path (string | string[]), none of which
  // contain ')', so the first ')' is the real close even across newlines.
  const decorator = /@(Post|Patch|Delete|Put)\(([\s\S]*?)\)/g;
  for (const m of source.matchAll(decorator)) {
    const method = m[1].toUpperCase();
    const raw = m[2].trim();
    if (raw === '') {
      routes.push(`${method} ${joinPath(base, '')}`);
      continue;
    }
    const literals = [...raw.matchAll(STRING_LITERAL)].map((s) => s[2]);
    if (literals.length === 0) {
      // A non-empty arg with no readable string path (dynamic/expression).
      routes.push(`${method} <unparsed:${raw.replace(/\s+/g, ' ')}>`);
      continue;
    }
    for (const lit of literals) routes.push(`${method} ${joinPath(base, lit)}`);
  }
  return routes;
}

/** Every non-spec `*.controller.ts` under `dir`, recursively. */
export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

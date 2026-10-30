import 'reflect-metadata';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from './admin.guard';
import { REQUIRED_SCOPES } from '../auth/required-scopes.decorator';
import { BOARD_ADMIN } from '../auth/scopes';

/**
 * Coverage guard for the admin surface's scope contract (#471), in the spirit of
 * the REST↔MCP write-parity guard (#141): DISCOVER the routes instead of trusting
 * a hand-kept list, so a route added tomorrow is judged by the same rule as the
 * ones written today.
 *
 * What it protects. #471 was an ABSENT check, not a failing one: the admin reads
 * declared no scope, RequiredScopesGuard defaults an undecorated GET to
 * board:read, and every personal access token carries that — so an admin's
 * read-only token read the org's token inventory and audit log, and no test
 * anywhere went red. admin-scope.spec.ts pins the three reads that exist now, but
 * a fourth (`@Get('sessions')` — live MCP session listing is a deferred v1 item;
 * see agents.ts) copied from a sibling WITHOUT the @RequiredScopes line between
 * its @Get and @Header would reproduce #471 exactly, and every existing spec
 * would still pass. This one fails.
 *
 * Why metadata and not source text. The repo's other discovery guard parses
 * controller sources because it only needs the write decorators' path argument.
 * The question here is different — "does this handler carry a second, separate
 * decorator?" — and reading that off the text is the fragile way to ask it:
 * decorator order is free (@RequiredScopes may sit above or below @Get), the
 * shapes are multiline, and getAudit's own signature puts bare `@Query(...)`
 * lines directly beneath the method decorators, so a line-oriented scanner
 * mis-attributes them. Reflect-metadata is what RequiredScopesGuard itself reads
 * at request time, so this asserts against the real gate rather than a
 * best-effort transcription of it, and the whole class of "the parser didn't
 * understand the source" disappears instead of needing to be caught.
 *
 * It still fails LOUD rather than vacuously: source discovery names the files,
 * every named file must yield a controller, every controller must yield routes,
 * and the three known reads must be among what was found. Any of those coming up
 * empty is an error, never a silent pass.
 */

const SRC_ROOT = join(__dirname, '..');

function walkControllers(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkControllers(full));
    else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** Does any @UseGuards(...) in this source name AdminGuard? Selects which files
 *  to load; the runtime guard metadata below is what actually decides. */
function namesAdminGuard(source: string): boolean {
  for (const m of source.matchAll(/@UseGuards\(([\s\S]*?)\)/g)) {
    if (/\bAdminGuard\b/.test(m[1])) return true;
  }
  return false;
}

const guardsOn = (target: unknown): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target as object) as unknown[] | undefined) ?? [];

const isAdminGuarded = (target: unknown): boolean => guardsOn(target).includes(AdminGuard);

/** The scopes RequiredScopesGuard will resolve — handler overrides class, exactly
 *  as Reflector.getAllAndOverride([handler, class]) does. */
function effectiveScopes(cls: object, handler: object): string[] | undefined {
  const onHandler = Reflect.getMetadata(REQUIRED_SCOPES, handler) as string[] | undefined;
  return onHandler ?? (Reflect.getMetadata(REQUIRED_SCOPES, cls) as string[] | undefined);
}

interface AdminRoute {
  controller: string;
  handler: string;
  /** `GET admin/audit` — the human-readable key an assertion failure names. */
  key: string;
  method: number;
  scopes: string[] | undefined;
}

const SOURCE_FILES = walkControllers(SRC_ROOT).filter((f) => namesAdminGuard(readFileSync(f, 'utf8')));

/** Files that named AdminGuard in source but yielded no admin-guarded class. */
const unresolved: string[] = [];
/** Admin-guarded controllers that exposed no routed handler at all. */
const routeless: string[] = [];
const routes: AdminRoute[] = [];

/**
 * Load each discovered controller and read the routes Nest will register.
 *
 * This runs in beforeAll rather than at module scope for two reasons that pull
 * the same way: the controllers must come through the test runner's transform
 * (Node's own strip-only TS loader can't parse Nest's constructor parameter
 * properties), and a top-level `await` is a compile error under this package's
 * commonjs module setting — which CI catches, since it typechecks the specs.
 * Every assertion below therefore reads these arrays at run time instead of
 * generating one test per route.
 */
async function discover(): Promise<void> {
  unresolved.length = 0; // idempotent: a re-run must not double-count
  routeless.length = 0;
  routes.length = 0;

  for (const file of SOURCE_FILES) {
    const where = file.slice(SRC_ROOT.length + 1);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const classes = Object.entries(mod).filter(
      ([, v]) => typeof v === 'function' && (isAdminGuarded(v) ||
        Object.getOwnPropertyNames(v.prototype ?? {}).some((key) =>
          typeof v.prototype[key] === 'function' && isAdminGuarded(v.prototype[key]))),
    ) as [string, new (...args: never[]) => object][];

    if (classes.length === 0) {
      unresolved.push(where);
      continue;
    }

    for (const [name, cls] of classes) {
      const base = Reflect.getMetadata(PATH_METADATA, cls);
      const basePath = typeof base === 'string' ? base : `<unreadable-base:${String(base)}>`;
      let found = 0;

      for (const prop of Object.getOwnPropertyNames(cls.prototype)) {
        if (prop === 'constructor') continue;
        const handler = (cls.prototype as Record<string, unknown>)[prop];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (method === undefined) continue; // not a route — a private helper
        found += 1;

        // A handler carrying its own @UseGuards(AdminGuard) is admin-guarded even
        // when the class is not, so a future route-level application still counts.
        if (!isAdminGuarded(cls) && !isAdminGuarded(handler)) continue;

        const raw = Reflect.getMetadata(PATH_METADATA, handler);
        const path = typeof raw === 'string' ? raw : `<unreadable-path:${String(raw)}>`;
        const key = `${RequestMethod[method] ?? `<unknown-method:${method}>`} ${[basePath, path]
          .join('/')
          .split('/')
          .filter(Boolean)
          .join('/')}`;
        routes.push({ controller: name, handler: prop, key, method, scopes: effectiveScopes(cls, handler) });
      }

      if (found === 0) routeless.push(`${name} (${where})`);
    }
  }
}

beforeAll(discover);

const gets = (): AdminRoute[] => routes.filter((r) => r.method === RequestMethod.GET);
const writes = (): AdminRoute[] => routes.filter((r) => r.method !== RequestMethod.GET);

describe('admin route discovery is not vacuous (#471)', () => {
  it('finds the controllers that apply AdminGuard', () => {
    expect(SOURCE_FILES.length, 'no controller source names AdminGuard — the scan is broken').toBeGreaterThan(0);
  });

  it('every file that names AdminGuard yields an admin-guarded controller', () => {
    expect(unresolved, 'AdminGuard is named in these sources but no exported class carries it').toEqual([]);
  });

  it('every admin-guarded controller exposes at least one route', () => {
    expect(routeless, 'these controllers resolved no routed handler — metadata read is broken').toEqual([]);
  });

  it('the known admin reads are among what was discovered', () => {
    const keys = gets().map((r) => r.key);
    expect(keys).toEqual(
      expect.arrayContaining(['GET admin/access', 'GET admin/agents', 'GET admin/audit']),
    );
  });

  it('no route key was built from metadata this spec could not read', () => {
    const unreadable = routes.filter((r) => r.key.includes('<unreadable') || r.key.includes('<unknown'));
    expect(unreadable.map((r) => `${r.controller}.${r.handler} → ${r.key}`)).toEqual([]);
  });
});

describe('every admin read requires board:admin (#471)', () => {
  it('no admin GET relies on the board:read default', () => {
    const ungated = gets()
      .filter((r) => !(r.scopes ?? []).includes(BOARD_ADMIN))
      .map((r) => `${r.key} (${r.controller}.${r.handler}) declares ${JSON.stringify(r.scopes ?? null)}`);
    expect(
      ungated,
      'add @RequiredScopes(BOARD_ADMIN) — without it RequiredScopesGuard defaults this GET to ' +
        'board:read, which every personal access token carries, so an admin\'s read-only token reads it',
    ).toEqual([]);
  });
});

describe('no admin write is opened to a weaker scope (#471)', () => {
  // A write with NO declaration is denied to every scoped actor (the fail-closed
  // default), which is what DELETE agents/:id relies on. The only acceptable
  // explicit declaration is board:admin — anything else, including the empty
  // @RequiredScopes() "no requirement" form, would widen it.
  it('an admin write is either undeclared (fail-closed) or board:admin', () => {
    const weakened = writes()
      .filter((r) => r.scopes !== undefined && !r.scopes.includes(BOARD_ADMIN))
      .map((r) => `${r.key} (${r.controller}.${r.handler}) declares ${JSON.stringify(r.scopes)}`);
    expect(weakened, 'this write route declares a scope weaker than board:admin').toEqual([]);
  });
});

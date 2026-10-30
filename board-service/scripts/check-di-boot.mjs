#!/usr/bin/env node
/**
 * Boots every class Nest constructs, as `tsc` compiled it (#756 review).
 *
 * WHAT IT CATCHES, and why nothing else in this repo can. `pnpm build` runs
 * `tsc` with `emitDecoratorMetadata: true`, so every decorated class in `dist/`
 * carries a `design:paramtypes` array — the constructor's parameter TYPES, as
 * runtime values. Nest reads that array and treats each entry as a provider
 * token. A parameter typed as a function emits `Function`; one typed as an
 * interface, a union or a type alias emits `Object`. Neither is a token
 * anything provides, so the container throws
 *
 *     Nest can't resolve dependencies of the X (A, ?, Function)
 *
 * inside `NestFactory.create`, and the process exits without ever listening.
 * A constructor default does not save it: Nest never reaches the default,
 * because it refuses to construct the class at all.
 *
 * `pnpm test` is structurally blind to this. Vitest transforms TypeScript with
 * esbuild, which emits NO `design:paramtypes` under any setting — so a spec
 * that says `new WriteIdentityService(config, ask)` passes, and so does one
 * that hands Nest a `useValue` stub instead of the real class. Every spec in
 * this package does one of those two things. The metadata that breaks
 * production exists only in `dist/`, which is why this reads `dist/`.
 *
 * WHAT IT DOES. It finds the modules in `dist/`, takes the classes those
 * modules ask Nest to construct — bare classes in `providers`, `useClass`
 * targets, and `controllers` — and compiles each one in a real Nest container
 * with its declared dependencies stubbed. A dependency is stubbed only when its
 * token is something a module could actually provide: a class, a string or a
 * symbol. `Function`, `Object` and the other bare globals are deliberately NOT
 * stubbed, because stubbing them is what would hide the bug.
 *
 * WHAT IT DOES NOT CATCH. A dependency whose token is a perfectly good class
 * that no module provides — this stubs those, so the boot it performs is not
 * the production boot. That failure is loud, deterministic and caught by the
 * integration specs that boot the real AppModule. This one exists for the
 * failure those specs cannot see.
 *
 * Run it after `pnpm build`, from `board-service/`:  node scripts/check-di-boot.mjs
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('reflect-metadata');

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');

/** The settings this probe hands itself before it requires anything.
 *
 *  Requiring `dist/app.module.js` evaluates `ConfigModule.forRoot({
 *  validationSchema })`, and Joi runs there against whatever environment the
 *  process has. Since #1175 the four keys that name an organisation or a
 *  repository carry no default, so an empty environment — which is exactly what
 *  the CI step has — is refused at that call. What made that hard to read is
 *  WHEN the refusal lands: `forRoot` is `async`, a `@Module`'s `imports` may
 *  hold a promise, and nothing here awaited it, so the process died on an
 *  unhandled rejection only after this script had printed a line saying every
 *  class booted. A green sentence over an exit 1. The loop below now handles
 *  that promise too, so a refusal is reported as the failure it is — and
 *  `strayRejections` right below catches the same shape arriving from anywhere
 *  else, because handling the one promise this script knows about closes that
 *  instance rather than the class of it.
 *
 *  Settings rather than a way past validation, because they are not the same
 *  answer: a probe that got past Joi by ignoring the environment would stop
 *  requiring the modules whose classes it exists to construct, and would prove
 *  nothing while reading green. These values are the probe's own and name no
 *  organisation or repository this board serves — nothing here reaches Github,
 *  and the question being asked is about `design:paramtypes`. They are ASSIGNED
 *  rather than filled in only when absent, so this probe asks the same question
 *  on a runner with no environment and on a machine with a `.env`. */
const PROBE_SETTINGS = {
  GITHUB_ORGS: 'check-di-boot-org',
  FEEDBACK_REPO: 'check-di-boot-org/feedback',
  // Required only where `GITHUB_WRITE_ENABLED=true`, which this probe does not
  // set. Supplied anyway, so an environment that does set it cannot make the
  // probe report a dependency failure that is really a missing setting.
  BOOT_ALERT_REPO: 'check-di-boot-org/boot-alerts',
  BOOT_ALERT_ASSIGNEE: 'check-di-boot-recipient',
};
for (const [key, value] of Object.entries(PROBE_SETTINGS)) process.env[key] = value;

/** Promises nobody awaited, from anywhere in `dist/`.
 *
 *  The loop further down handles the promise a `@Module`'s `imports` carries,
 *  which is the only one the real `dist/` holds today. It is not the only shape
 *  that can reach here: a module-scope async side effect in any compiled file
 *  rejects with no handler anywhere, which Node treats as fatal by default —
 *  and it lands AFTER this script would have printed the line saying every
 *  class booted, a green sentence over an exit 1. That is the failure #1175
 *  reached CI on, arriving from a different place.
 *
 *  Recorded here and checked immediately above that line, rather than exiting
 *  from the handler: a handler that exits on its own is too late, because it
 *  fires only once this script's own microtask chain has run to completion and
 *  the success line is already on stdout. Registered before anything is
 *  required, so there is no window it does not cover. */
const strayRejections = [];
process.on('unhandledRejection', (err) => {
  strayRejections.push(String((err && err.message) || err).split('\n')[0]);
});

const {
  MODULE_METADATA,
  SELF_DECLARED_DEPS_METADATA,
  OPTIONAL_DEPS_METADATA,
  PARAMTYPES_METADATA,
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  PIPES_METADATA,
  EXCEPTION_FILTERS_METADATA,
} = require('@nestjs/common/constants');
const { Logger } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');

// Nest's own boot chatter is not this script's output.
Logger.overrideLogger(false);

/** The emitted types that are NOT tokens: `tsc` writes these for a parameter
 *  Nest was never going to be able to resolve. Leaving them unstubbed is the
 *  whole assertion — stub `Function` and the probe would pass on the bug. */
const NOT_A_TOKEN = new Set([Function, Object, String, Number, Boolean, Array, Symbol, Promise, Date, RegExp]);

/** `dist/main.js` calls `NestFactory.create` and listens; requiring it would
 *  start the server. Everything else in dist only defines classes. */
const SKIP = new Set(['main.js']);

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js') && !SKIP.has(entry)) out.push(full);
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error('check-di-boot: no dist/ — run `pnpm build` first.');
  process.exit(1);
}

// A separate process keeps absent settings absent: this DI probe pins its own
// environment and stubs dependencies, so it cannot establish naming provenance.
const naming = spawnSync(process.execPath, [join(HERE, 'check-naming-settings.mjs'), DIST], { stdio: 'inherit' });
if (naming.error || naming.status !== 0) {
  if (naming.error) console.error(`check-di-boot: naming settings probe failed: ${naming.error.message}`);
  process.exit(1);
}

const files = jsFiles(DIST);
if (files.length === 0) {
  console.error('check-di-boot: dist/ has no .js files.');
  process.exit(1);
}

/** class -> the module file that asks Nest to construct it. */
const targets = new Map();
const loadFailures = [];
/** One settled promise per `imports` entry that is a promise; see below. */
const importChecks = [];
let modulesSeen = 0;

for (const file of files) {
  let loaded;
  try {
    loaded = require(file);
  } catch (err) {
    loadFailures.push(`${relative(DIST, file)}: ${err && err.message}`);
    continue;
  }
  for (const exported of Object.values(loaded)) {
    if (typeof exported !== 'function') continue;
    const where = `${exported.name} (${relative(DIST, file)})`;
    // A `@Module`'s `imports` may hold a PROMISE — `ConfigModule.forRoot` is
    // `async`, so `app.module.js` carries one from the moment it is required.
    // No class is constructed out of it, but a rejection nobody handles kills
    // the process after this script has printed its result: an exit 1 under a
    // green line, which is how #1175 reached CI. A handler is attached HERE,
    // in the same synchronous pass that created the promise, so the rejection
    // is never unhandled, and reported below as the boot failure it is.
    for (const imported of Reflect.getMetadata(MODULE_METADATA.IMPORTS, exported) ?? []) {
      if (!imported || typeof imported.then !== 'function') continue;
      importChecks.push(
        imported.then(
          () => null,
          (err) => `${where}\n    ${String((err && err.message) || err).split('\n')[0]}`,
        ),
      );
    }
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, exported);
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, exported);
    if (providers === undefined && controllers === undefined) continue;
    modulesSeen += 1;
    for (const provider of providers ?? []) {
      // Only the shapes Nest constructs from `design:paramtypes`. A
      // `useFactory` or a `useValue` names its own dependencies and cannot hit
      // this class of failure.
      if (typeof provider === 'function') targets.set(provider, where);
      else if (provider && typeof provider.useClass === 'function') targets.set(provider.useClass, where);
    }
    for (const controller of controllers ?? []) {
      if (typeof controller === 'function') targets.set(controller, where);
    }
  }
}

/** Every enhancer class attached to a controller or its handlers. The metadata
 *  keys are Nest's own (`GUARDS_METADATA` and friends in
 *  `@nestjs/common/constants`), read off the class and off each prototype
 *  method, which is where a method-level `@UseGuards` lands. */
function enhancersOf(cls) {
  const keys = [GUARDS_METADATA, INTERCEPTORS_METADATA, PIPES_METADATA, EXCEPTION_FILTERS_METADATA];
  const found = new Set();
  const carriers = [cls];
  if (cls.prototype) {
    for (const name of Object.getOwnPropertyNames(cls.prototype)) {
      const method = Object.getOwnPropertyDescriptor(cls.prototype, name)?.value;
      if (typeof method === 'function') carriers.push(method);
    }
  }
  for (const carrier of carriers) {
    for (const key of keys) {
      for (const entry of Reflect.getMetadata(key, carrier) ?? []) {
        if (typeof entry === 'function') found.add(entry);
      }
    }
  }
  return found;
}

const failures = [];
let booted = 0;

for (const [cls, where] of targets) {
  const paramtypes = Reflect.getMetadata(PARAMTYPES_METADATA, cls) ?? [];
  const declared = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls) ?? [];
  const optional = new Set(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, cls) ?? []);
  const byIndex = new Map(declared.map((d) => [d.index, d.param]));
  const arity = Math.max(paramtypes.length, ...[...byIndex.keys()].map((i) => i + 1), 0);

  const stubs = [];
  for (let i = 0; i < arity; i += 1) {
    if (optional.has(i)) continue;
    const token = byIndex.has(i) ? byIndex.get(i) : paramtypes[i];
    if (token === undefined || token === null) continue;
    if (typeof token === 'function' && NOT_A_TOKEN.has(token)) continue;
    if (typeof token !== 'function' && typeof token !== 'string' && typeof token !== 'symbol') continue;
    stubs.push({ provide: token, useValue: {} });
  }

  // A controller's guards, interceptors, pipes and filters are constructed by
  // the same container, and they carry their own dependencies — every one of
  // them is also a provider in some module, so each is booted in its own right
  // below. Stub them here so a guard's missing provider does not stand in for
  // the answer about the controller.
  for (const enhancer of enhancersOf(cls)) stubs.push({ provide: enhancer, useValue: {} });

  const isController = Reflect.getMetadata('path', cls) !== undefined;
  try {
    await Test.createTestingModule({
      providers: isController ? stubs : [...stubs, cls],
      controllers: isController ? [cls] : [],
    }).compile();
    booted += 1;
  } catch (err) {
    const message = String((err && err.message) || err);
    // Only a resolution failure ON THIS CLASS is this script's business. A
    // constructor that throws on a `{}` stub got PAST dependency resolution,
    // which is the thing being asked about; and a dependency of something else
    // that this stubbing did not reach is not a statement about this class.
    if (new RegExp(`can't resolve dependencies of the ${cls.name}\\b`).test(message)) {
      failures.push(`${cls.name}, provided by ${where}\n    ${message.split('\n')[0]}`);
    } else {
      booted += 1;
    }
  }
}

if (loadFailures.length > 0) {
  console.error('check-di-boot: could not load compiled files:');
  for (const f of loadFailures) console.error(`  - ${f}`);
  process.exit(1);
}

const importFailures = (await Promise.all(importChecks)).filter(Boolean);
if (importFailures.length > 0) {
  console.error(
    'check-di-boot: a module asked Nest for something that refused before any class was built.\n' +
      'Nest resolves a promise in `imports` during `NestFactory.create`, so this is a boot the\n' +
      'production process would not survive either. A `Config validation error` here means a\n' +
      'setting this probe does not supply became required: add it to PROBE_SETTINGS above.\n',
  );
  for (const f of importFailures) console.error(`  - ${f}\n`);
  process.exit(1);
}

if (failures.length > 0) {
  console.error(
    `check-di-boot: ${failures.length} class(es) Nest cannot construct from the COMPILED output.\n` +
      'This is a production boot failure that `pnpm test` cannot see: vitest transforms with\n' +
      'esbuild, which emits no `design:paramtypes`. Give the named parameter an explicit\n' +
      '`@Inject(TOKEN)`, add `@Optional()` if it has a default, or register the class with a\n' +
      '`useFactory` instead of `@Injectable`.\n',
  );
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

if (modulesSeen === 0 || booted === 0) {
  console.error(
    `check-di-boot: found ${modulesSeen} module(s) and booted ${booted} class(es) — a guard that\n` +
      'checks nothing reads green, so this is a failure. Has the dist layout changed?',
  );
  process.exit(1);
}

// One turn of the event loop, so a rejection recorded above arrives before the
// only line this script prints on success rather than after it.
await new Promise((resolve) => setImmediate(resolve));
if (strayRejections.length > 0) {
  console.error(
    'check-di-boot: something in dist/ rejected a promise with nothing awaiting it. Left\n' +
      'unhandled that is fatal to the process by default, and it lands after the line this\n' +
      'script prints on success — so it is recorded and reported here, above that line,\n' +
      'instead. A module-scope async side effect is the usual cause: await it, or handle the\n' +
      'rejection where the promise is created.\n',
  );
  for (const r of strayRejections) console.error(`  - ${r}\n`);
  process.exit(1);
}

console.log(`check-di-boot: ${booted} class(es) from ${modulesSeen} module(s) construct under real Nest DI.`);

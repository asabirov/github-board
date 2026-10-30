import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
// TypeScript 7 compiles the service; the pinned legacy API keeps these AST
// safety checks working until the native compiler has a stable programmatic API.
import ts from 'typescript-api';
import { joinPath } from '../mcp/write-route-discovery.contract';

/**
 * Static call-graph reachability from a Github write route to the write
 * envelope (#616).
 *
 * The question this answers is not "does this route say it writes Github" —
 * `writes-declared.spec.ts` already answers that — but "does the route it says
 * so on actually go through `guardWrite`". Those are different facts: a handler
 * can carry `@Writes('issue.labels')`, call a source method that reaches
 * Github, never touch the envelope, and compile, boot and pass every other
 * suite. What it skips is the owner pin, the writes-off 503 and the per-target
 * capability rung — every rung the envelope exists to hold.
 *
 * A file-level rule would have been cheaper ("a file calling
 * `buildOctokitClient(_, 'write')` also calls `guardWrite`") and it is wrong
 * here twice over: `repos/github-repos.source.ts#setDri` and
 * `issue-detail/github-issue-detail.source.ts` both mutate Github from a file
 * with no `guardWrite` in it, and both are green because a guarded handler sits
 * above them. Reachability is what distinguishes those from a real skip, and
 * `'write'` as a purpose argument is not a reliable marker of a Github write
 * anyway — the nine issue facets mutate through a client built for reading.
 *
 * ROOTS are route handlers whose `@Writes` names at least one capability,
 * declared on the handler or on its controller class. `@Writes()` with no
 * argument is a route stating it writes no Github, so the nine local-write
 * routes carry nothing here by construction rather than by an exemption list —
 * and `localWriteRoutes` below hands exactly those nine to
 * `write-dominance.contract.ts`, which is where the claim itself is read back
 * against the body (#624). `boot-alert.notifier.ts` is outside the subject on a
 * stronger ground than having no route: its target comes from
 * `BOOT_ALERT_REPO`, operator config, never from request input, so the owner pin
 * has nothing to pin against — and it already checks `GITHUB_WRITE_ENABLED` and
 * consults the registry for a `boot-alert.file` refusal itself.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. Reachability is path-insensitive: a
 * `guardWrite` in a dead branch, inside a `catch`, behind a config flag, or
 * called AFTER the write all count as reached here. This gate proves the
 * envelope is REACHABLE from the route; that it RAN BEFORE the write is a
 * separate fact, and `write-dominance.contract.ts` is what proves it (#621),
 * off a census of the mutations rather than off the declaration. The two are
 * kept apart because they fail for different reasons and a reader needs to be
 * told which: "nothing this route calls reaches the envelope" and "the write
 * went out before the envelope ran" send you to different lines.
 *
 * A known limit both share: a `@Get` handler under a class-level `@Writes` is
 * not a root, because `capability.guard.ts` also returns early on read verbs —
 * a handler declaring a capability on a read verb ITSELF is reported, by
 * `misplacedWrites` below.
 *
 * `*.contract.ts` is excluded from the build (`tsconfig.build.json:12`), so
 * this compiles under the typecheck CI runs and never reaches `dist`. It lives
 * here rather than inside the spec so the gate and the check on the gate drive
 * one function, the same arrangement `writes-metadata-discovery.contract.ts`
 * describes.
 */

export const SRC_DIR = join(__dirname, '..');
export const ENVELOPE_FILE = 'capability/write-envelope.ts';
export const ENVELOPE_SYMBOL = 'guardWrite';

/**
 * Nest's write verbs.
 *
 * COUPLED to `WRITE_METHODS` in `writes-metadata-discovery.contract.ts`, which
 * holds the same five verbs as `RequestMethod` enum members. They cannot share
 * a literal — this half reads decorator NAMES out of source text, that half
 * reads numbers Nest recorded — so the coupling is stated instead: a verb in
 * one and not the other is a route one discovery counts and the other does not,
 * and the cross-check in `writes-enveloped.spec.ts` then agrees while both are
 * blind. `misplacedWrites` is what turns the gap into a failure rather than a
 * silence.
 */
const ROUTE_DECORATORS = new Map<string, string>([
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Delete', 'DELETE'],
  ['Patch', 'PATCH'],
  ['All', 'ALL'],
]);

/** Read verbs, named only so the report can say which one a misplaced
 *  capability was declared on. */
const READ_DECORATORS = ['Get', 'Head', 'Options', 'Search'];

export interface ReachabilityOptions {
  /** Only declarations under here count as edges; everything else — `@octokit`,
   *  `@nestjs`, the standard library — is a leaf. */
  rootDir: string;
  /** Path suffix of the file the envelope is declared in. */
  envelopeFile: string;
  /** The function a Github write route must reach. */
  envelopeSymbol: string;
}

const DEFAULTS: ReachabilityOptions = {
  rootDir: SRC_DIR,
  envelopeFile: ENVELOPE_FILE,
  envelopeSymbol: ENVELOPE_SYMBOL,
};

const resolve = (options: Partial<ReachabilityOptions>): ReachabilityOptions => ({ ...DEFAULTS, ...options });

export interface WriteRoot {
  /** `VERB path`, the key shape `writes-metadata-discovery.contract.ts`
   *  answers in, so the two discoveries can be asserted against each other. */
  route: string;
  /** `<file>#<Class>.<method>` — where whoever trips the gate has to go. For an
   *  inherited handler this is the class the BODY lives in, not the controller
   *  that mounted it. */
  where: string;
  /** The capabilities the route declared, for the report. */
  caps: string[];
  handler: ts.MethodDeclaration;
}

export type EnvelopeSkipper = Pick<WriteRoot, 'route' | 'where' | 'caps'> & {
  /** The envelope the discovery was run against, so the report names the one it
   *  actually looked for rather than the module default. */
  envelopeFile: string;
  envelopeSymbol: string;
};

export interface MisplacedWrite {
  where: string;
  caps: string[];
  /** The read verb it was declared on, or `no route decorator`. */
  verb: string;
}

const TSCONFIG = 'tsconfig.json';
const TSCONFIG_BUILD = 'tsconfig.build.json';

/** Read one tsconfig, LOUDLY. A file TypeScript cannot parse silently becomes
 *  the default compiler options, and the gate then reads the tree under options
 *  nobody chose and reports on it as if it had. */
function readTsconfig(dir: string, name: string): { raw: Record<string, unknown>; options: ts.CompilerOptions } {
  const path = join(dir, name);
  const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  if (error) {
    throw new Error(`${name} could not be parsed: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
  }
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dir);
  if (parsed.errors.length) {
    throw new Error(
      `${name} could not be used: ${parsed.errors
        .map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' '))
        .join('; ')}`,
    );
  }
  return { raw: (config ?? {}) as Record<string, unknown>, options: parsed.options };
}

/** The file suffixes `tsconfig.build.json` keeps out of `dist`, read from that
 *  file rather than copied from it — a hand-copy drifts, and drift here is
 *  fail-open in both directions. */
function excludedSuffixes(dir: string): string[] {
  const { raw } = readTsconfig(dir, TSCONFIG_BUILD);
  const prefix = 'src/**/*';
  const suffixes = (Array.isArray(raw.exclude) ? (raw.exclude as string[]) : [])
    .filter((e) => e.startsWith(prefix) && e.length > prefix.length)
    .map((e) => e.slice(prefix.length));
  if (!suffixes.length) throw new Error(`${TSCONFIG_BUILD} lists no "${prefix}…" exclusion to read the shipped set from`);
  return suffixes;
}

/**
 * The program this gate reads: every `.ts` under `src/` that SHIPS — the set
 * `tsconfig.build.json` excludes, derived from that file.
 *
 * Not a speed choice. Edges through an interface are widened to its
 * implementers below, and a test double implementing a source interface would
 * let a route read as guarded through code that never runs in production.
 * Files those routes import are still pulled in by module resolution, so
 * nothing a shipped route can reach is missing.
 */
export function buildWriteProgram(rootDir: string = SRC_DIR): ts.Program {
  const dir = join(rootDir, '..');
  const { options } = readTsconfig(dir, TSCONFIG);
  const skip = excludedSuffixes(dir);
  const shipped = walkAll(rootDir).filter((f) => f.endsWith('.ts') && !skip.some((s) => f.endsWith(s)));
  return bound(ts.createProgram(shipped, { ...options, noEmit: true }));
}

/**
 * Ask for the checker before handing the program out.
 *
 * `ts.createProgram` parses without parent pointers, and `node.getText()` and
 * `node.getSourceFile()` both walk `parent` to the file — so every read below
 * throws on an unbound program. Building the checker binds every source file,
 * which is what sets them. Not an optimisation and not decoration: without this
 * line the discovery crashes on the first route it finds.
 */
function bound(program: ts.Program): ts.Program {
  program.getTypeChecker();
  return program;
}

/** Every `.ts` under `dir`. `walk` in `../mcp/write-route-discovery.contract`
 *  answers `*.controller.ts` only — the right set there, and too small here,
 *  because every file a route can call is an edge. */
function walkAll(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkAll(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** A program over source strings, for driving this discovery on code that
 *  exists in no file — what the gate's own vacuity checks need. */
export function buildSyntheticProgram(files: Record<string, string>): ts.Program {
  const sources = new Map(
    Object.entries(files).map(([name, text]) => [
      name,
      ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true),
    ]),
  );
  const lib = sharedLibHost();
  const host: ts.CompilerHost = {
    ...lib,
    getSourceFile: (name, languageVersion, onError, shouldCreate) =>
      sources.get(name) ?? lib.getSourceFile(name, languageVersion, onError, shouldCreate),
    fileExists: (name) => sources.has(name) || lib.fileExists(name),
    readFile: (name) => sources.get(name)?.text ?? lib.readFile(name),
    writeFile: () => undefined,
    // Node resolution is answered here rather than left to the default host.
    // The default one asks the real filesystem whether the containing
    // directory exists, an in-memory path never does, and every import then
    // resolves to nothing — which reads as "this route reaches no envelope"
    // and makes the vacuity checks pass for the wrong reason.
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((literal) => {
        const candidate = `${join(dirname(containingFile), literal.text)}.ts`;
        if (sources.has(candidate)) {
          return { resolvedModule: { resolvedFileName: candidate, extension: ts.Extension.Ts } };
        }
        return ts.resolveModuleName(
          literal.text,
          containingFile,
          { moduleResolution: ts.ModuleResolutionKind.Node10 },
          lib,
        );
      }),
  };
  return bound(
    ts.createProgram(
      [...sources.keys()],
      {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true,
        skipLibCheck: true,
        noEmit: true,
      },
      host,
    ),
  );
}

export const isUnder = (file: string, dir: string): boolean => !relative(dir, file).startsWith('..');

/**
 * One compiler host for every synthetic program, with the files it reads off
 * disk kept.
 *
 * `ts.createCompilerHost({})` re-parses `lib.d.ts` on every call, and the two
 * gates here build sixteen synthetic programs between them — 240 ms each
 * against 40 ms with the parse shared, for one function and no change in what
 * anything answers. Lib declarations are read-only, which is what makes them
 * safe to hand to more than one program; the in-memory files are built fresh
 * per call and are not cached here.
 */
let libHost: ts.CompilerHost | undefined;

function sharedLibHost(): ts.CompilerHost {
  if (libHost) return libHost;
  const host = ts.createCompilerHost({});
  const parsed = new Map<string, ts.SourceFile | undefined>();
  const read = host.getSourceFile.bind(host);
  libHost = {
    ...host,
    getSourceFile: (name, languageVersion, onError, shouldCreate) => {
      const key = `${name}\u0000${languageVersion}`;
      if (!parsed.has(key)) parsed.set(key, read(name, languageVersion, onError, shouldCreate));
      return parsed.get(key);
    },
  };
  return libHost;
}

const decoratorsOf = (node: ts.Node): readonly ts.Decorator[] => ts.getDecorators(node as ts.HasDecorators) ?? [];

/** The call of the decorator named `name` on `node`, if it is written as a call. */
function decoratorCall(node: ts.Node, name: string): ts.CallExpression | undefined {
  for (const d of decoratorsOf(node)) {
    const expr = d.expression;
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === name) {
      return expr;
    }
  }
  return undefined;
}

/** Every class under `rootDir`, at any nesting — a `@Controller` inside a
 *  `namespace` is still a controller, and a walk over top-level statements
 *  alone finds neither it nor the classes widening reads. ONE walker, used by
 *  root discovery and by `ImplementerIndex`, so the two cannot disagree about
 *  what a class is. */
function allClasses(program: ts.Program, rootDir: string): ts.ClassDeclaration[] {
  const out: ts.ClassDeclaration[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !isUnder(file.fileName, rootDir)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) out.push(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }
  return out;
}

/** The controller's base path: `@Controller('base')` or `@Controller({ path })`. */
function controllerBase(cls: ts.ClassDeclaration): string | undefined {
  const call = decoratorCall(cls, 'Controller');
  if (!call) return undefined;
  const arg = call.arguments[0];
  if (!arg) return '';
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        prop.name.getText() === 'path' &&
        ts.isStringLiteralLike(prop.initializer)
      ) {
        return prop.initializer.text;
      }
    }
  }
  // A base path this cannot read statically is reported rather than dropped: a
  // route that vanishes makes every assertion over the root set pass vacuously.
  return `<unparsed:${arg.getText().replace(/\s+/g, ' ')}>`;
}

/** The class declaration a heritage clause entry names, when it is one under
 *  `rootDir`. */
function heritageClass(
  type: ts.ExpressionWithTypeArguments,
  checker: ts.TypeChecker,
  rootDir: string,
): ts.ClassDeclaration | undefined {
  for (const decl of declarationsOf(type.expression, checker)) {
    if (ts.isClassDeclaration(decl) && isUnder(decl.getSourceFile().fileName, rootDir)) return decl;
  }
  return undefined;
}

/**
 * Every method a controller mounts: its own, then the ones it inherits.
 *
 * Nest's MetadataScanner walks the prototype chain, so `@Writes` + `@Patch` on
 * an abstract base with `@Controller` on the subclass IS a registered route
 * that CapabilityGuard passes — and reading `members` alone finds nothing.
 * `issue-detail.controller.ts` holds nine near-identical `this.run(...)`
 * bodies, so hoisting them into a base is the refactor this is waiting for.
 * Own members are taken first, so an override wins over what it overrides.
 */
function mountedMethods(
  cls: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  rootDir: string,
): ts.MethodDeclaration[] {
  const byName = new Map<string, ts.MethodDeclaration>();
  const seen = new Set<ts.ClassDeclaration>();
  const visit = (c: ts.ClassDeclaration): void => {
    if (seen.has(c)) return;
    seen.add(c);
    for (const member of c.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      const name = member.name.getText();
      if (!byName.has(name)) byName.set(name, member);
    }
    for (const clause of c.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const type of clause.types) {
        const base = heritageClass(type, checker, rootDir);
        if (base) visit(base);
      }
    }
  };
  visit(cls);
  return [...byName.values()];
}

/** The name of the class a member is declared in, for the report. */
const ownerName = (member: ts.Node): string => {
  const parent = member.parent;
  return ts.isClassDeclaration(parent) ? (parent.name?.text ?? '<anonymous>') : '<anonymous>';
};

const whereOf = (member: ts.MethodDeclaration, rootDir: string): string =>
  `${relative(rootDir, member.getSourceFile().fileName)}#${ownerName(member)}.${member.name.getText()}`;

const capsOf = (call: ts.CallExpression): string[] =>
  call.arguments.map((a) => (ts.isStringLiteralLike(a) ? a.text : a.getText()));

interface Scanned {
  roots: WriteRoot[];
  /** Routes whose effective `@Writes()` names nothing — "I write no Github".
   *  #624 is what reads the body back against that claim; here they are only
   *  collected. */
  local: WriteRoot[];
  misplaced: MisplacedWrite[];
}

/** Both answers root discovery has, produced by one walk so a route can never
 *  be missing from both. */
function scanControllers(program: ts.Program, options: Partial<ReachabilityOptions>): Scanned {
  const { rootDir } = resolve(options);
  const checker = program.getTypeChecker();
  const roots: WriteRoot[] = [];
  const local: WriteRoot[] = [];
  const misplaced: MisplacedWrite[] = [];
  for (const cls of allClasses(program, rootDir)) {
    const base = controllerBase(cls);
    if (base === undefined) continue; // not a @Controller
    // `SetMetadata` is a ClassDecorator too, and `CapabilityGuard` reads
    // `getAllAndOverride([handler, class])` — so a capability declared here
    // covers every write route on the class that does not answer for itself.
    const classWrites = decoratorCall(cls, 'Writes');
    for (const member of mountedMethods(cls, checker, rootDir)) {
      const own = decoratorCall(member, 'Writes');
      // An own `@Writes()` — even empty — is the method's own answer and
      // overrides the class's. Empty means "this route writes no Github".
      const declared = own ?? classWrites;
      if (!declared) continue;
      const verb = [...ROUTE_DECORATORS].find(([name]) => decoratorCall(member, name));
      if (!verb) {
        // Only the method's OWN declaration is an error here. A class-level
        // capability beside a `@Get` is a controller declaring once for its
        // write routes, which is ordinary; a handler declaring one on a read
        // verb is a Github write the runtime check skips as well.
        if (own && own.arguments.length > 0) {
          misplaced.push({
            where: whereOf(member, rootDir),
            caps: capsOf(own),
            verb: READ_DECORATORS.find((r) => decoratorCall(member, r)) ?? 'no route decorator',
          });
        }
        continue;
      }
      const arg = decoratorCall(member, verb[0])!.arguments[0];
      const path = !arg
        ? ''
        : ts.isStringLiteralLike(arg)
          ? arg.text
          : `<unparsed:${arg.getText().replace(/\s+/g, ' ')}>`;
      (declared.arguments.length === 0 ? local : roots).push({
        route: `${verb[1]} ${joinPath(base, path)}`,
        where: whereOf(member, rootDir),
        caps: capsOf(declared),
        handler: member,
      });
    }
  }
  const byRoute = (a: WriteRoot, b: WriteRoot): number => a.route.localeCompare(b.route);
  return {
    roots: roots.sort(byRoute),
    local: local.sort(byRoute),
    misplaced: misplaced.sort((a, b) => a.where.localeCompare(b.where)),
  };
}

/** Every route handler declaring at least one capability, as a BFS root. */
export const writeRoots = (program: ts.Program, options: Partial<ReachabilityOptions> = {}): WriteRoot[] =>
  scanControllers(program, options).roots;

/**
 * Every write route whose `@Writes()` names nothing — the ten local-write
 * routes, and any Github write route whose author reached for the nearest
 * decorator (#624).
 *
 * This gate treats them as out of its subject by construction, which is right:
 * a route writing no Github has nothing for the envelope's rungs to act on.
 * `write-dominance.contract.ts` is where the claim itself is checked.
 */
export const localWriteRoutes = (
  program: ts.Program,
  options: Partial<ReachabilityOptions> = {},
): WriteRoot[] => scanControllers(program, options).local;

/** Every capability declared where this gate cannot walk it — a handler naming
 *  a capability on a read verb, or on no route decorator at all. */
export const misplacedWrites = (
  program: ts.Program,
  options: Partial<ReachabilityOptions> = {},
): MisplacedWrite[] => scanControllers(program, options).misplaced;

/** Every Github write route from which the envelope cannot be reached. */
export function envelopeSkippers(
  program: ts.Program,
  options: Partial<ReachabilityOptions> = {},
): EnvelopeSkipper[] {
  const opts = resolve(options);
  const checker = program.getTypeChecker();
  const index = new ImplementerIndex(program, checker, opts.rootDir);
  return writeRoots(program, opts)
    .filter((root) => !reachesEnvelope(root.handler, checker, index, opts))
    .map(({ route, where, caps }) => ({
      route,
      where,
      caps,
      envelopeFile: opts.envelopeFile,
      envelopeSymbol: opts.envelopeSymbol,
    }));
}

/** Breadth-first over the call graph, from one handler, until the envelope. */
function reachesEnvelope(
  root: ts.Node,
  checker: ts.TypeChecker,
  index: ImplementerIndex,
  opts: ReachabilityOptions,
): boolean {
  const seen = new Set<ts.Node>([root]);
  const queue: ts.Node[] = [root];
  while (queue.length) {
    const body = queue.shift()!;
    for (const call of callsIn(body)) {
      for (const target of resolveTargets(call.expression, checker, index, opts)) {
        if (isEnvelope(target, opts)) return true;
        if (!isUnder(target.getSourceFile().fileName, opts.rootDir)) continue;
        if (seen.has(target)) continue;
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return false;
}

export const isEnvelope = (decl: ts.Node, opts: ReachabilityOptions): boolean =>
  ts.isFunctionDeclaration(decl) &&
  decl.name?.text === opts.envelopeSymbol &&
  decl.getSourceFile().fileName.endsWith(opts.envelopeFile);

/**
 * Every call in a subtree, nested functions included. A callback written inline
 * — `this.run(…, (n) => this.service.setLabels(…))` — is part of the method
 * that wrote it, and `run` is what invokes it.
 *
 * DECORATORS ARE NOT CALLS THE SUBTREE MAKES. TS5 keeps them in
 * `node.modifiers`, so a plain walk collects `Writes(...)`, `Patch(...)` and
 * `UseGuards(...)` as edges — and `Writes` (`capability/writes.decorator.ts`)
 * and `RequiredScopes` (`auth/required-scopes.decorator.ts`) are local arrows
 * under src/, which makes them live ones. They are dead ends today only
 * because their bodies call `SetMetadata`, outside src/; one line inside
 * `writes.decorator.ts` reaching the envelope module would have marked all
 * eleven routes guarded with every test green.
 *
 * `new X()` is NOT an edge either: a constructor is not followed, so a route
 * whose only path to the envelope ran through one would be reported.
 *
 * WHICH WAY A MISSING EDGE ERRS DEPENDS ON WHO IS ASKING, and this comment used
 * to answer for one of them only. For THIS gate, anchored on the declaration, a
 * lost edge makes the envelope unreachable — a loud false report, the safe
 * direction. For `write-dominance.contract.ts`, anchored on the write, a lost
 * edge makes the WRITE unreachable: it drops out of `unguarded` and out of
 * `reachable` together and neither #621 nor #624 says a word. That silence is
 * measured rather than argued — `writes-dominated.spec.ts` requires every
 * census write outside `boot-alert` to appear in some route's reachable set, so
 * an edge this walk loses fails a gate instead of emptying one.
 */
function callsIn(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isDecorator(n)) return;
    if (ts.isCallExpression(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return out;
}

/** The declarations a name resolves to, with import aliases followed. */
function declarationsOf(node: ts.Node, checker: ts.TypeChecker): readonly ts.Declaration[] {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return [];
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol.getDeclarations() ?? [];
}

/** What one call can land on. More than one only where the callee is an
 *  interface or abstract method — see `ImplementerIndex`. */
export function resolveTargets(
  /** The CALLEE, not the call: a tagged template invokes its tag, and passing
   *  the expression rather than the call is what lets both shapes ask this. */
  callee: ts.Expression,
  checker: ts.TypeChecker,
  index: ImplementerIndex,
  opts: ReachabilityOptions,
): ts.Node[] {
  let symbol = checker.getSymbolAtLocation(callee);
  if (!symbol) return [];
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const out: ts.Node[] = [];
  for (const decl of symbol.getDeclarations() ?? []) {
    // An interface method, or an abstract one, has no body of its own. The edge
    // is WIDENED to the implementers that answer it — over-reaching by design:
    // the alternative is reporting a route as a skip because its service calls
    // `this.source.<write>` on a source interface, which is a real edge.
    if (ts.isMethodSignature(decl) || ts.isPropertySignature(decl) || isAbstract(decl)) {
      out.push(...index.implementersOf(decl, symbol.getName()));
      continue;
    }
    const fn = functionOf(decl);
    if (fn) out.push(fn);
  }
  // Anything declared outside `rootDir` is a leaf — `@octokit`, `@nestjs`, the
  // standard library. `guardWrite` is overloaded, so its symbol contributes
  // three signatures and one implementation, and any of the four counts as
  // reaching it.
  return out.filter((n) => isUnder(n.getSourceFile().fileName, opts.rootDir) || isEnvelope(n, opts));
}

const isAbstract = (decl: ts.Declaration): boolean =>
  ts.canHaveModifiers(decl) &&
  (ts.getModifiers(decl) ?? []).some((m) => m.kind === ts.SyntaxKind.AbstractKeyword);

/** The function-like node a declaration stands for, if it has one. */
function functionOf(decl: ts.Declaration): ts.Node | undefined {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return decl;
  if (ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) return decl;
  if (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isParameter(decl)) {
    const init = decl.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init;
  }
  return undefined;
}

/**
 * The classes that may answer for a call landing on an interface or abstract
 * method.
 *
 * Two restrictions, and both were added because a reviewer walked through them
 * on a copy of the real tree.
 *
 * BY SYMBOL, NOT BY NAME. Heritage compared as identifier text conflates two
 * unrelated interfaces that merely share a name: a second source interface in
 * a new directory, with an implementer writing Github through no envelope, came
 * back guarded — because a real guarded source implemented something spelled
 * the same. The checker gives distinct symbols for distinct
 * declarations, so identity is what is compared.
 *
 * ONLY WHAT THE CONTAINER COULD CONSTRUCT. An implementer counts only if some
 * `*.module.ts` under src/ names it. A class bound in no module is not a
 * provider, and under the union rule one such class — imported by nothing,
 * constructed never — was enough to mark a live unguarded Github write as
 * guarded. Dead code does not answer for code that runs.
 *
 * The union rule itself stays: one guarding implementer vouches for its
 * siblings. That is over-reaching by design and settled as such; these two
 * restrictions are what keep the over-reach inside the set of classes the
 * application can actually reach.
 *
 * A call whose declaring type has no such implementer is a dead end. For this
 * gate that errs toward reporting a route that is in fact guarded — loud, and
 * the safe direction. For the write-anchored gates it errs the other way, and
 * the reachable-writes floor in `writes-dominated.spec.ts` is what makes that
 * failure loud too.
 */
export class ImplementerIndex {
  private readonly implements = new Map<ts.ClassDeclaration, Set<ts.Symbol>>();

  constructor(
    program: ts.Program,
    private readonly checker: ts.TypeChecker,
    rootDir: string,
  ) {
    const classes = allClasses(program, rootDir);
    const providers = new Set<ts.ClassDeclaration>();
    for (const file of program.getSourceFiles()) {
      if (!file.fileName.endsWith('.module.ts') || !isUnder(file.fileName, rootDir)) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          for (const decl of declarationsOf(node, checker)) {
            if (ts.isClassDeclaration(decl) && isUnder(decl.getSourceFile().fileName, rootDir)) {
              providers.add(decl);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(file, visit);
    }
    for (const cls of classes) {
      if (!providers.has(cls)) continue;
      const named = new Set<ts.Symbol>();
      for (const clause of cls.heritageClauses ?? []) {
        for (const type of clause.types) {
          const symbol = this.typeSymbolAt(type.expression);
          if (symbol) named.add(symbol);
        }
      }
      if (named.size) this.implements.set(cls, named);
    }
  }

  implementersOf(decl: ts.Declaration, method: string): ts.Node[] {
    const owner = this.declaringTypeSymbol(decl);
    if (!owner) return [];
    const out: ts.Node[] = [];
    for (const [cls, named] of this.implements) {
      if (!named.has(owner)) continue;
      for (const member of cls.members) {
        if (!member.name || member.name.getText() !== method) continue;
        const fn = functionOf(member);
        if (fn) out.push(fn);
      }
    }
    return out;
  }

  /** The symbol a heritage expression names, aliases followed. */
  private typeSymbolAt(node: ts.Node): ts.Symbol | undefined {
    let symbol = this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    return symbol;
  }

  /** The symbol of the interface, class or type alias a member is declared in. */
  private declaringTypeSymbol(decl: ts.Declaration): ts.Symbol | undefined {
    const parent = decl.parent;
    if (parent && (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent))) {
      return parent.name && this.checker.getSymbolAtLocation(parent.name);
    }
    // `interface I { submit: (x) => y }` written as a type literal member.
    if (parent && ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent)) {
      return this.checker.getSymbolAtLocation(parent.parent.name);
    }
    return undefined;
  }
}

/**
 * The report one skipping route produces. Written so whoever trips this gate
 * learns which route broke the rule, where that route lives, and the call it is
 * missing, without opening the issue that asked for the gate. It names the
 * envelope the discovery actually ran against, not the module default.
 */
export const describeSkipper = (s: EnvelopeSkipper): string =>
  `${s.route} declares @Writes(${s.caps.map((c) => `'${c}'`).join(', ')}) but nothing it calls reaches ` +
  `${s.envelopeSymbol}. Route: ${s.where}. Add ${s.envelopeSymbol}(subject, env) from ${s.envelopeFile} ` +
  `to that handler, or to a function it calls, so the owner pin, the writes-off refusal and the ` +
  `capability check run before Github is written.`;

/** The report a capability declared out of this gate's reach produces. */
export const describeMisplaced = (m: MisplacedWrite): string =>
  `${m.where} declares @Writes(${m.caps.map((c) => `'${c}'`).join(', ')}) on ${m.verb}, where neither ` +
  `this gate nor CapabilityGuard checks it — both read write verbs only. Move the write to a POST, ` +
  `PUT, PATCH or DELETE route, or drop the capability if the handler writes no Github.`;

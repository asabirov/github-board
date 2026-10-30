import { relative } from 'path';
import ts from 'typescript-api';
import { Octokit } from '@octokit/rest';
import { SRC_DIR, isUnder } from './write-reachability.contract';

/**
 * The census: every call in this tree that MUTATES Github (#621, #624).
 *
 * `write-reachability.contract.ts` is anchored on what a route DECLARES, which
 * is why it can answer neither of the two questions left open after #616 — did
 * the envelope run before the write (#621), and does a route declaring
 * `@Writes()` write Github anyway (#624). Both need the other anchor: the
 * writes themselves, and which routes reach each one. This file is that anchor;
 * `write-dominance.contract.ts` is what walks routes to it.
 *
 * INVERTED, NOT ENUMERATED. A list of mutating method names is a hole the width
 * of whatever it forgets, so the question asked here is the opposite one: a call
 * on an Octokit client is a WRITE unless it is provably a read. Provably a read
 * means one of three things.
 *
 *   - A REST namespace method — `issues.setLabels`, `search.issuesAndPullRequests`
 *     — whose HTTP verb is GET or HEAD. The verb comes from Octokit's OWN
 *     endpoint table, read off a constructed client
 *     (`fn.endpoint.DEFAULTS.method`), never from a list kept here: 1028
 *     endpoints that Github and Octokit maintain between them. A name the table
 *     does not know is a write, which is what makes a rename or a plugin fail
 *     closed rather than silent.
 *   - `request(…)` or `paginate(…)` whose route is statically a `GET` or `HEAD`
 *     one — a string literal, a `const`, or a parameter typed as a template
 *     literal that pins the verb. `paginate` also takes a REST method by
 *     reference, and that resolves through the same table.
 *   - `graphql(…)` whose document is statically known and does not open with
 *     `mutation`.
 *
 * Local `hook.wrap` registration makes no request and is excluded; calls inside
 * its callback are still walked. Anything else on a client is a write: a `request()` route this cannot read, a
 * graphql document assembled at runtime, `octokit.auth()`, a namespace method
 * Octokit's table has never heard of.
 *
 * HEAD sits beside GET because HTTP defines it as a safe method — the same
 * request as a GET with the body dropped. `capability.registry.ts` probes the
 * credential with `request('HEAD /user')`, and calling that a Github write
 * would be false.
 *
 * WHICH CALLS ARE ON A CLIENT, resolved through the checker rather than by
 * variable name. Two shapes, and the tree holds both. `octokit.issues.update(…)`
 * is a property chain whose base has the client's type — the return type of
 * `buildOctokitClient`, however it was spelled, so a parameter declared
 * `ReturnType<typeof buildOctokitClient>` is a client too. `this.gql()(QUERY)`
 * is not a chain at all: `gql()` returns the client's `graphql` member, so the
 * CALLEE's type is what identifies it, matched against the types of the
 * client's own members. Together they find all 65 Github calls this tree makes,
 * of which 18 are writes — `writes-dominated.spec.ts` pins exactly which.
 *
 * WHAT "ALL" MEANS, said once rather than assumed (#892 review). Both shapes
 * above are resolved through the TYPE CHECKER against the Octokit client, so
 * this census counts every Github call made THROUGH ONE, and a Github call made
 * another way is invisible to it by construction. Two such calls exist, both
 * added by #892 and both raw `fetch` in `auth/github-user.service.ts`: the OAuth
 * token exchange, and the `DELETE /applications/{client_id}/grant` that
 * disconnect uses to revoke the app. They are outside this census deliberately
 * and not by oversight — they authenticate as the OAUTH APP with its client
 * secret rather than as anybody's Github account, so there is no Octokit client
 * to make them on, and neither touches a repository. `docs/ops/per-user-github-credentials.md`
 * records what authorizes each. The number above is not widened to include them:
 * the subject of this file is what a REQUEST can reach through a client, and
 * broadening the walk to chase string literals would weaken the thing it proves.
 *
 * Those two numbers are read back OUT of this comment and compared to what the
 * census answers, by `writes-dominated.spec.ts`. It had claimed as much for a
 * while and only checked the assertion beside it, so this sentence drifted one
 * change later; keep the wording — "all N Github calls this tree makes, of
 * which M are writes" — or the check fails on the sentence going missing, which
 * is the same failure as the sentence being wrong.
 */

export interface CensusOptions {
  /** Only calls in files under here are censused. */
  rootDir: string;
  /** Path suffix of the file declaring the client factory. */
  clientFile: string;
  /** The function whose RETURN TYPE is the Octokit client. */
  clientSymbol: string;
}

export const CLIENT_FILE = 'sources/github-client.ts';
export const CLIENT_SYMBOL = 'buildOctokitClient';

const DEFAULTS: CensusOptions = {
  rootDir: SRC_DIR,
  clientFile: CLIENT_FILE,
  clientSymbol: CLIENT_SYMBOL,
};

const resolve = (options: Partial<CensusOptions>): CensusOptions => ({ ...DEFAULTS, ...options });

/** One Github mutation, where whoever trips a gate has to go to find it. */
export interface GithubWriteSite {
  /** `<file>#<Class>.<method>`, or `<file>#<function>` — the nearest NAMED
   *  enclosing function, so a write inside an inline callback is still
   *  addressed by something a reader can search for. */
  where: string;
  /** What it calls, in the words the source uses. */
  operation: string;
  /** 1-based, so the report can point at the line and not only the symbol. */
  line: number;
}

export const describeWrite = (w: GithubWriteSite): string => `${w.where} → ${w.operation}`;

/** How a call on a client was classified, and under what name. */
export interface GithubCall {
  kind: 'read' | 'write';
  operation: string;
}

/** HTTP's safe methods — the two that cannot change what Github holds. */
const SAFE_VERBS = new Set(['GET', 'HEAD']);

/**
 * The verb a client member addresses Github with, or undefined for a member
 * that is not a REST endpoint method.
 *
 * Octokit mounts every endpoint TWICE — `octokit.orgs.listMembers` and
 * `octokit.rest.orgs.listMembers` are the same function — and this tree spells
 * it both ways. The table is keyed the short way, so the `rest.` a call site
 * chose is dropped before the lookup rather than duplicated into the table.
 */
const verbOf = (path: string): string | undefined =>
  restVerbs().get(path) ?? restVerbs().get(path.replace(/^rest\./, ''));

let restVerbCache: Map<string, string> | undefined;

/**
 * `namespace.method` → HTTP verb, read off a constructed Octokit.
 *
 * Every REST endpoint method Octokit generates carries its own
 * `endpoint.DEFAULTS.method`, so this table is Octokit's, not ours, and it
 * moves when Github's API does. Constructing the client makes no request and
 * needs no credential.
 */
function restVerbs(): Map<string, string> {
  if (restVerbCache) return restVerbCache;
  const probe = new Octokit() as unknown as Record<string, unknown>;
  const out = new Map<string, string>();
  for (const [namespace, api] of Object.entries(probe)) {
    if (!api || typeof api !== 'object') continue;
    for (const [name, fn] of Object.entries(api as Record<string, unknown>)) {
      const verb = (fn as { endpoint?: { DEFAULTS?: { method?: unknown } } })?.endpoint?.DEFAULTS?.method;
      if (typeof verb === 'string') out.set(`${namespace}.${name}`, verb.toUpperCase());
    }
  }
  // A table that came back empty would mark every REST call a write, which is
  // loud — but it would also mean this gate had stopped reading Octokit and
  // started guessing, and that is worth saying in its own words.
  if (!out.size) {
    throw new Error('@octokit/rest exposed no endpoint methods to read HTTP verbs from');
  }
  restVerbCache = out;
  return out;
}

/**
 * Every call on an Octokit client, classified.
 *
 * Built once per program: finding the client type and indexing its members is
 * work that does not change between calls, and `write-dominance.contract.ts`
 * asks this question of every call in the tree.
 */
export class GithubCalls {
  private readonly checker: ts.TypeChecker;
  private readonly clientType: ts.Type;
  /** The type of each of the client's own members, one and two deep, so a
   *  callee that IS such a member is recognised without a property chain. */
  private readonly memberPaths = new Map<ts.Type, string | null>();

  constructor(
    program: ts.Program,
    private readonly options: CensusOptions,
  ) {
    this.checker = program.getTypeChecker();
    this.clientType = this.findClientType(program);
    this.indexMembers(this.clientType, '', 1);
  }

  /** The return type of the client factory. Absent means this census is reading
   *  a tree it does not understand, and saying nothing about it would be the
   *  fail-open answer. */
  private findClientType(program: ts.Program): ts.Type {
    for (const file of program.getSourceFiles()) {
      if (!file.fileName.endsWith(this.options.clientFile)) continue;
      for (const statement of file.statements) {
        if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== this.options.clientSymbol) continue;
        const signature = this.checker.getSignatureFromDeclaration(statement);
        if (signature) return this.checker.getReturnTypeOfSignature(signature);
      }
    }
    throw new Error(
      `${this.options.clientFile} declares no function ${this.options.clientSymbol} to read the Github client's type from`,
    );
  }

  /** Member types that can be CALLED, mapped to their path. A type two members
   *  share is mapped to null rather than to one of them: the census would still
   *  answer, but it would name the wrong operation. */
  private indexMembers(type: ts.Type, prefix: string, depth: number): void {
    for (const member of this.checker.getPropertiesOfType(type)) {
      const declaration = member.valueDeclaration ?? member.declarations?.[0];
      if (!declaration) continue;
      const memberType = this.checker.getTypeOfSymbolAtLocation(member, declaration);
      const path = prefix ? `${prefix}.${member.getName()}` : member.getName();
      if (this.checker.getSignaturesOfType(memberType, ts.SignatureKind.Call).length) {
        this.memberPaths.set(memberType, this.memberPaths.has(memberType) ? null : path);
      }
      if (depth > 0) this.indexMembers(memberType, path, depth - 1);
    }
  }

  private isClient(node: ts.Node): boolean {
    return this.checker.getTypeAtLocation(node) === this.clientType;
  }

  /** `octokit.issues.update` → `issues.update`, when the chain's base is a
   *  client. Undefined when it is not one. */
  private chainPath(expression: ts.Expression): string | undefined {
    const names: string[] = [];
    let current: ts.Expression = expression;
    while (ts.isPropertyAccessExpression(current)) {
      names.unshift(current.name.text);
      current = current.expression;
      if (this.isClient(current)) return names.join('.');
      this.refuseForeignClient(current);
    }
    return undefined;
  }

  /**
   * A SECOND Github client, and why it cannot be quietly ignored.
   *
   * Everything above resolves "is this a client" as type identity with the
   * factory's return type, and that is right for every shape the tree uses —
   * `ReturnType<typeof buildOctokitClient>`, a parameter, a destructured
   * member, `new Octokit(…)` in the registry, an interface extending the client.
   * What it is not right for is a type that RE-DECLARES the members instead of
   * being them: `Octokit.plugin(retry)`, a hand-written port, a test double
   * promoted into src/. Those are not the client, so their calls are not client
   * calls, and the census says nothing about them at all — silence, where every
   * other unknown here is loudly a write.
   *
   * There is no type identity to test, so the test is structural and narrow: a
   * call receiver carrying BOTH `request` and `graphql` is a Github client
   * wearing another name. It is refused rather than censused, because guessing
   * which of its members mutate is the thing this file refuses to do.
   */
  private refuseForeignClient(receiver: ts.Expression): void {
    const type = this.checker.getTypeAtLocation(receiver);
    if (!this.checker.getPropertyOfType(type, 'graphql')) return;
    if (!this.checker.getPropertyOfType(type, 'request')) return;
    throw new Error(
      `${relative(this.options.rootDir, receiver.getSourceFile().fileName)} calls Github through ` +
        `${this.checker.typeToString(type)}, which is not the client ${this.options.clientSymbol} hands out. ` +
        `This census reads calls against that one type, so a second client is a Github write surface it ` +
        `cannot see — route the call through ${this.options.clientSymbol}, or teach this file the new type.`,
    );
  }

  /** The path of the client member a callee IS, for a callee that is not a
   *  property chain — `this.gql()`, which hands back the client's `graphql`. */
  private memberPath(expression: ts.Expression): string | undefined {
    return this.memberPaths.get(this.checker.getTypeAtLocation(expression)) ?? undefined;
  }

  /** The client member a call lands on, or undefined for a call on anything
   *  else. */
  pathOf(call: GithubCallNode): string | undefined {
    const callee = calleeOf(call);
    return this.chainPath(callee) ?? this.memberPath(callee);
  }

  /**
   * The string an expression is statically known to START with, or undefined.
   *
   * A literal answers with all of itself; a `const QUERY = '…'` answers through
   * its literal type; a parameter typed `` `GET /${string}` `` answers with the
   * part the type pins. A union answers only when every arm agrees on a first
   * word, which is what keeps `'GET …' | 'DELETE …'` from reading as a read.
   */
  private staticPrefix(expression: ts.Expression): string | undefined {
    const prefixes = new Set<string>();
    const collect = (type: ts.Type): boolean => {
      if (type.isUnion()) return type.types.every(collect);
      if (type.isStringLiteral()) {
        prefixes.add(type.value);
        return true;
      }
      if (type.flags & ts.TypeFlags.TemplateLiteral) {
        prefixes.add((type as ts.TemplateLiteralType).texts[0] ?? '');
        return true;
      }
      return false;
    };
    // A template with substitutions widens to `string`, so the TYPE says
    // nothing — but its head is written down, and the verb lives there.
    // `request(`GET /repos/${owner}/${repo}`)` is a read, and calling it a
    // write is a false alarm the next templated GET pays for again.
    if (ts.isTemplateExpression(expression)) return expression.head.text;
    if (!collect(this.checker.getTypeAtLocation(expression))) return undefined;
    const [first] = [...prefixes];
    if (first === undefined) return undefined;
    // The arms have to agree on the verb, not on the whole route.
    const verb = (p: string): string => p.split(/\s+/, 1)[0]!;
    return [...prefixes].every((p) => verb(p) === verb(first)) ? first : undefined;
  }

  /** Read or write, for a call on a client. Undefined when the call is not on
   *  one at all. */
  classify(call: GithubCallNode): GithubCall | undefined {
    const path = this.pathOf(call);
    if (path === undefined) return undefined;
    // Octokit's hook registration changes this local client's middleware.
    // It never invokes the hook or sends a request. Do not exclude other hook
    // members or skip walking the callback's own calls.
    if (path === 'hook.wrap') return undefined;
    const argument = firstArgumentOf(call);
    if (path === 'graphql') return this.classifyGraphql(argument);
    // `paginate.iterator` is `paginate` with the pages handed back one at a
    // time — the same route, the same verb, and the obvious next thing on a
    // large listing.
    if (path === 'request' || path === 'paginate' || path === 'paginate.iterator') {
      return this.classifyRoute(path, argument);
    }
    const verb = verbOf(path);
    return { kind: verb && SAFE_VERBS.has(verb) ? 'read' : 'write', operation: path };
  }

  /**
   * A GraphQL document is a read only when it says so.
   *
   * Testing for a leading `mutation` was the wrong way round twice over:
   * GraphQL allows `#` comment lines and fragment definitions ahead of the
   * operation, so `'# set the labels\nmutation(…)'` and
   * `'fragment F on Issue { id } mutation(…)'` both read as queries and dropped
   * out of the census altogether. So both halves have to hold — the document
   * names no mutation anywhere, AND it opens with something this recognises as
   * a read. Anything else is a write.
   */
  private classifyGraphql(argument: ts.Expression | undefined): GithubCall {
    const document = argument && this.staticPrefix(argument);
    if (document === undefined) return { kind: 'write', operation: 'graphql(a document read at run time)' };
    const stripped = document.replace(/#[^\n]*/g, ' ').trimStart();
    if (/\bmutation\b/.test(stripped)) return { kind: 'write', operation: 'graphql mutation' };
    return /^(query\b|subscription\b|fragment\b|\{)/.test(stripped)
      ? { kind: 'read', operation: 'graphql query' }
      : { kind: 'write', operation: 'graphql(a document this cannot read as a query)' };
  }

  /** `request('PATCH …')` and `paginate(…)`, which address a route rather than
   *  a namespace method. `paginate` also takes the method itself. */
  private classifyRoute(path: string, argument: ts.Expression | undefined): GithubCall {
    if (argument) {
      const route = this.staticPrefix(argument);
      if (route !== undefined) {
        const verb = route.split(/\s+/, 1)[0]!.toUpperCase();
        return {
          kind: SAFE_VERBS.has(verb) ? 'read' : 'write',
          operation: `${path}('${route.trim()}')`,
        };
      }
      const referenced = this.chainPath(argument) ?? this.memberPath(argument);
      if (referenced !== undefined) {
        const verb = verbOf(referenced);
        return {
          kind: verb && SAFE_VERBS.has(verb) ? 'read' : 'write',
          operation: `${path}(${referenced})`,
        };
      }
    }
    return { kind: 'write', operation: `${path}(a route read at run time)` };
  }

  /** Where a call sits, for the report. */
  site(call: GithubCallNode, operation: string): GithubWriteSite {
    const file = call.getSourceFile();
    return {
      where: `${relative(this.options.rootDir, file.fileName)}#${enclosingSymbol(call)}`,
      operation,
      line: file.getLineAndCharacterOfPosition(call.getStart()).line + 1,
    };
  }
}

/**
 * The nearest NAMED function around a node.
 *
 * A write inside an inline callback — `write(() => octokit.issues.create(…))`
 * in `boot-alert.notifier.ts` — belongs, for a reader, to the function that
 * wrote the callback. Anonymous arrows are walked through until something with
 * a name answers.
 */
function enclosingSymbol(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if ((ts.isMethodDeclaration(current) || ts.isGetAccessor(current) || ts.isSetAccessor(current)) && current.name) {
      const owner = current.parent;
      const clazz = ts.isClassLike(owner) ? (owner.name?.text ?? '<anonymous class>') : undefined;
      return clazz ? `${clazz}.${current.name.getText()}` : current.name.getText();
    }
    if (ts.isConstructorDeclaration(current)) {
      const owner = current.parent;
      return `${ts.isClassLike(owner) ? (owner.name?.text ?? '<anonymous class>') : ''}.constructor`;
    }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    // `const write = async () => …` names a function; `const res = await
    // octokit.issues.create(…)` names a RESULT, and answering with it would
    // send the reader looking for a function that does not exist.
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return current.name.text;
    }
    if (ts.isPropertyDeclaration(current) && current.name) {
      const owner = current.parent;
      const clazz = ts.isClassLike(owner) ? (owner.name?.text ?? '<anonymous class>') : undefined;
      return clazz ? `${clazz}.${current.name.getText()}` : current.name.getText();
    }
    current = current.parent;
  }
  return '<top level>';
}

/**
 * The two ways a client member is invoked.
 *
 * `graphql\`mutation …\`` is a TaggedTemplateExpression rather than a call, so a
 * walk over `ts.isCallExpression` alone never sees it — and the document is
 * right there in the template, which makes it exactly as readable as the call
 * form and exactly as invisible without this.
 */
export type GithubCallNode = ts.CallExpression | ts.TaggedTemplateExpression;

const calleeOf = (node: GithubCallNode): ts.Expression =>
  ts.isCallExpression(node) ? node.expression : node.tag;

const firstArgumentOf = (node: GithubCallNode): ts.Expression | undefined =>
  ts.isCallExpression(node) ? node.arguments[0] : node.template;

export const isGithubCallNode = (node: ts.Node): node is GithubCallNode =>
  ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node);

/** One classified call on a Github client, wherever it sits. */
export type GithubCallSite = GithubWriteSite & { kind: 'read' | 'write' };

/** Every call this tree makes on a Github client, read and write alike. */
export function githubCalls(program: ts.Program, options: Partial<CensusOptions> = {}): GithubCallSite[] {
  const opts = resolve(options);
  const calls = new GithubCalls(program, opts);
  const out: GithubCallSite[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !isUnder(file.fileName, opts.rootDir)) continue;
    const visit = (node: ts.Node): void => {
      if (isGithubCallNode(node)) {
        const call = calls.classify(node);
        if (call) out.push({ ...calls.site(node, call.operation), kind: call.kind });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }
  return out;
}

/** Every Github mutation this tree makes. */
export const githubWrites = (program: ts.Program, options: Partial<CensusOptions> = {}): GithubWriteSite[] =>
  githubCalls(program, options)
    .filter((call) => call.kind === 'write')
    .map(({ where, operation, line }) => ({ where, operation, line }));

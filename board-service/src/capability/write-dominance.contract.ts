import ts from 'typescript-api';
import {
  ENVELOPE_FILE,
  ENVELOPE_SYMBOL,
  ImplementerIndex,
  SRC_DIR,
  isEnvelope,
  localWriteRoutes,
  resolveTargets,
  writeRoots,
  type ReachabilityOptions,
} from './write-reachability.contract';
import {
  CLIENT_FILE,
  CLIENT_SYMBOL,
  GithubCalls,
  isGithubCallNode,
  type CensusOptions,
  type GithubCallNode,
  type GithubWriteSite,
} from './github-write-census.contract';

/**
 * Does the envelope run BEFORE the write (#621), and does a route that declares
 * `@Writes()` write Github anyway (#624)?
 *
 * `write-reachability.contract.ts` is anchored on the route's declaration and
 * answers neither. It proves `guardWrite` is REACHABLE, which a call behind a
 * config flag, inside a `catch`, or after the mutation all satisfy while the
 * write goes out unguarded; and it excludes no-argument `@Writes()` routes by
 * construction, which is what leaves #624 invisible. Both questions want the
 * other anchor — the WRITE, and which routes reach it — so both are answered
 * here, off one census (`github-write-census.contract.ts`) and one walk.
 *
 * WHAT THE WALK COMPUTES. Each function gets a summary: the Github writes
 * reachable from its entry, which of them are reachable with no `guardWrite`
 * before them, whether `guardWrite` has certainly run by the time it returns,
 * and — the part that decides the real routes — the guard state at which it
 * invokes each of its own PARAMETERS.
 *
 * That last one is the whole of it. `issue-detail.controller.ts#run` is
 *
 *     const n = guardWrite({ … }, this.env(action))!;
 *     try { out = await fn(n); } catch (err) { … }
 *
 * and nine of the eleven routes reach their mutation through `fn` — a callback
 * they pass in the SAME statement that reaches the guard:
 *
 *     return this.run(owner, repo, number, email, 'issue.labels', 'Set labels on',
 *       (n) => this.service.setLabels(owner, repo, n, body.names));
 *
 * Lexical order in the handler settles nothing there. What settles it is that
 * `run` guards before it invokes its parameter, so everything the callback's
 * body reaches is sealed. An analysis that cannot say that reports nine real
 * routes and is switched off by whoever hits it.
 *
 * ORDER WITHIN A BODY is a walk in evaluation order carrying one bit: has
 * `guardWrite` certainly run on every path to here. A branch joins by AND, so
 * `if (flag) guardWrite(…)` leaves the bit false after the `if`. A `catch` is
 * entered at the state the `try` was entered at, because the exception can
 * arrive before anything in the block ran — which is what makes a rescuing
 * `guardWrite` cover nothing. A loop body is walked, and the bit after the loop
 * is the bit before it, since the body may not run at all. `writes-dominated.spec.ts`
 * holds a two-line fixture for each of those, because a rule stated in a comment
 * and asserted nowhere is a rule that drifts.
 *
 * A FUNCTION'S EXIT FACT IS EVERY WAY OUT OF IT, not the state at the closing
 * brace. `if (!enabled) return; guardWrite(…);` guards on one path and not on
 * the other, so the guard state at every `return` is met with the state at the
 * end. A `throw` contributes nothing, which is right: it reaches no caller.
 *
 * AND WHAT A HELPER REPORTS ABOUT ITS CALLBACK IS A MUST-FACT, so it MEETS.
 * A helper invoking `fn` once unguarded and once guarded has not guarded it; a
 * helper handing `fn` on to another helper inherits whatever that one does with
 * that position; and a helper invoking `fn` from inside a wrapper arrow —
 * `this.trace(() => fn(n))` — is still the helper that invoked it, so a closure
 * sees the parameters of the function around it and each parameter carries its
 * own record. Get any of those three wrong and either a write goes out unseen
 * or all nine real facets fire at once over one added wrapper.
 *
 * WHAT IT COSTS, stated rather than hidden. The join is conservative in the
 * loud direction: a guard on one arm of a branch and a write after it is
 * reported even when the other arm cannot return. A function expression that is
 * not an argument of a resolvable call — one assigned to a variable and invoked
 * later — is walked where it is WRITTEN rather than where it runs, so a closure
 * declared before the guard and called after it is reported. Both err toward a
 * report on code that is in fact safe, and the fix in either case is to move the
 * guard earlier, which is the thing this gate is asking for anyway.
 *
 * WHAT A LOST EDGE COSTS runs the OTHER way here, and that is the difference
 * from #616 worth holding on to. This gate is anchored on the write, so a call
 * graph that loses an edge loses the write with it — out of `unguarded` and out
 * of `reachable` together, and both gates fall silent rather than loud. The
 * `reached` set below is what measures that: every census write outside
 * `boot-alert.notifier.ts` has to appear in some route's reachable set, so an
 * edge this walk cannot follow fails a gate instead of emptying one.
 *
 * A KNOWN GAP, the same one `write-reachability.contract.ts` names: a read-verb
 * handler is not a subject here. `capability.guard.ts` returns early on read
 * verbs, so a `@Get` route writing Github escapes the runtime check as well;
 * `misplacedWrites` reports the case where such a handler declares a capability,
 * and the case where it declares nothing is not covered by any gate.
 *
 * A SECOND GAP, dormant rather than open, and left as a note because the thing
 * that would open it is a change somebody makes deliberately elsewhere: a
 * callback handed to `guardWrite` ITSELF is walked as guarded, since everything
 * after the envelope call is. `guardWrite` (`capability/write-envelope.ts`)
 * declares no function-typed parameter, so there is nothing to hand it and
 * nothing to report. The day its signature grows one,
 * `guardWrite({ … }, () => client.issues.setLabels(…))` comes back clean, and
 * the envelope branch in `walkCall` has to stop treating the envelope's own
 * arguments as sealed by the call they are arguments to.
 *
 * `*.contract.ts` is excluded from the build (`tsconfig.build.json:12`), so this
 * compiles under the typecheck CI runs and never reaches `dist`.
 */

export interface DominanceOptions extends ReachabilityOptions, CensusOptions {}

const DEFAULTS: DominanceOptions = {
  rootDir: SRC_DIR,
  envelopeFile: ENVELOPE_FILE,
  envelopeSymbol: ENVELOPE_SYMBOL,
  clientFile: CLIENT_FILE,
  clientSymbol: CLIENT_SYMBOL,
};

const resolveOptions = (options: Partial<DominanceOptions>): DominanceOptions => ({ ...DEFAULTS, ...options });

/** One Github write a declared write route reaches with the envelope unrun. */
export interface UnsealedWrite {
  /** `VERB path`, the same key shape every other write discovery answers in. */
  route: string;
  /** `<file>#<Class>.<method>` — the route handler. */
  where: string;
  caps: string[];
  /** The mutation itself: whoever trips this gate has to open BOTH files. */
  write: GithubWriteSite;
  envelopeFile: string;
  envelopeSymbol: string;
}

/** One Github write reached by a route that declared it writes none (#624). */
export interface UndeclaredWrite {
  route: string;
  where: string;
  write: GithubWriteSite;
  envelopeSymbol: string;
}

/** What one function does to the two things this gate tracks. */
interface Summary {
  /** Writes reachable from entry with no `guardWrite` before them. */
  unguarded: Map<GithubCallNode, GithubWriteSite>;
  /** Writes reachable at all, whatever ran first. */
  reachable: Map<GithubCallNode, GithubWriteSite>;
  /** `guardWrite` has certainly run by a normal return. */
  guards: boolean;
  /** Guard state at which this function invokes its parameter `i`. A parameter
   *  absent here is one this function never calls. */
  params: Map<number, boolean>;
}

/** The accumulator a walk writes into: a summary without its exit facts. */
interface Acc {
  unguarded: Map<GithubCallNode, GithubWriteSite>;
  reachable: Map<GithubCallNode, GithubWriteSite>;
  params: Map<number, boolean>;
}

/**
 * One parameter: its position, and the map its invocations are recorded in.
 *
 * The record travels WITH the symbol rather than with the scope, which is what
 * lets a closure inherit its enclosing function's parameters without confusing
 * them with its own. `run(fn) { guardWrite(…); await this.trace(() => fn(n)); }`
 * has to record `fn` — position 0 of `run` — from inside an arrow that has a
 * position 0 of its own; a scope holding one record map cannot tell those
 * apart, and the answer it gave un-sealed all nine real facets at once.
 */
interface ParamSlot {
  index: number;
  record: Map<number, boolean>;
}

/** The parameters visible where the walk is, and where each one's invocations
 *  land. A closure sees its enclosing function's parameters too, shadowed by
 *  its own. `exits` collects the guard state at every `return`, because the
 *  state at the end of a body is not the state on every path out of it. */
interface Scope {
  params: Map<ts.Symbol, ParamSlot>;
  exits: boolean[];
}

const emptyAcc = (): Acc => ({ unguarded: new Map(), reachable: new Map(), params: new Map() });

/** Fresh each time: a shared literal is a shared mutable, and every field here
 *  is a collection something could write into. */
const emptySummary = (): Summary => ({ ...emptyAcc(), guards: false });

/**
 * How many times the walk may be repeated to let a call cycle settle.
 *
 * A cycle in the call graph is broken by reading the PREVIOUS round's summary,
 * so one round can under-report a write inside a cycle. Repeating until nothing
 * changes fixes that; a walk still moving after this many rounds is a defect in
 * this file rather than in the tree, and it says so instead of answering.
 */
const MAX_ROUNDS = 8;

class Dominance {
  private readonly checker: ts.TypeChecker;
  private readonly index: ImplementerIndex;
  private readonly calls: GithubCalls;
  private summaries = new Map<ts.Node, Summary>();
  private previous = new Map<ts.Node, Summary>();
  private readonly computing = new Set<ts.Node>();
  private cycled = false;

  constructor(
    program: ts.Program,
    private readonly options: DominanceOptions,
  ) {
    this.checker = program.getTypeChecker();
    this.index = new ImplementerIndex(program, this.checker, options.rootDir);
    this.calls = new GithubCalls(program, options);
  }

  /** Summaries for every root, recomputed until the cycles stop moving. */
  settle(roots: ts.Node[]): void {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      this.cycled = false;
      this.summaries = new Map();
      for (const root of roots) this.summarize(root);
      if (!this.cycled || sameAnswers(this.previous, this.summaries)) return;
      this.previous = this.summaries;
    }
    throw new Error(`the dominance walk did not settle in ${MAX_ROUNDS} rounds`);
  }

  summarize(fn: ts.Node): Summary {
    const done = this.summaries.get(fn);
    if (done) return done;
    if (this.computing.has(fn)) {
      // A cycle. The previous round's answer is the best one available, and the
      // round counter above is what turns "best available" into "settled".
      this.cycled = true;
      return this.previous.get(fn) ?? emptySummary();
    }
    this.computing.add(fn);
    const acc = emptyAcc();
    const scope: Scope = { params: this.slotsOf(fn, acc.params), exits: [] };
    let state = false;
    for (const parameter of parametersIn(fn)) state = this.walk(parameter.initializer, state, acc, scope);
    const fallsOut = this.walk(bodyOf(fn), state, acc, scope);
    this.computing.delete(fn);
    // Every way out of the body, not only the last one. A helper shaped
    // `if (!enabled) return; guardWrite(…);` guards on one path and not on the
    // other, and a caller may not treat it as a sealer.
    const guards = fallsOut && scope.exits.every(Boolean);
    const summary: Summary = { ...acc, guards };
    this.summaries.set(fn, summary);
    return summary;
  }

  private slotsOf(fn: ts.Node, record: Map<number, boolean>): Map<ts.Symbol, ParamSlot> {
    const out = new Map<ts.Symbol, ParamSlot>();
    parametersIn(fn).forEach((parameter, index) => {
      const symbol = this.checker.getSymbolAtLocation(parameter.name);
      if (symbol) out.set(symbol, { index, record });
    });
    return out;
  }

  /** A must-fact MEETS. A helper invoking its callback once unguarded and once
   *  guarded has not guarded it, and an assignment there let the second
   *  invocation overwrite the first. */
  private static note(slot: ParamSlot, state: boolean): void {
    slot.record.set(slot.index, (slot.record.get(slot.index) ?? true) && state);
  }

  /** Walk one node in evaluation order, returning the guard state after it. */
  private walk(node: ts.Node | undefined, state: boolean, acc: Acc, scope: Scope): boolean {
    if (!node) return state;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // Written here, run somewhere else. Walked at the state it was written
      // at, which is the loud direction — see the note on what this costs.
      this.walkClosure(node, state, acc, scope);
      return state;
    }
    if (ts.isReturnStatement(node)) {
      const after = this.walk(node.expression, state, acc, scope);
      scope.exits.push(after);
      return after;
    }
    // Declared here, walked when something calls it.
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return state;
    if (isGithubCallNode(node)) return this.walkCall(node, state, acc, scope);
    if (ts.isIfStatement(node)) {
      const after = this.walk(node.expression, state, acc, scope);
      const taken = this.walk(node.thenStatement, after, acc, scope);
      const skipped = this.walk(node.elseStatement, after, acc, scope);
      if (alwaysExits(node.thenStatement)) return node.elseStatement ? skipped : after;
      if (node.elseStatement && alwaysExits(node.elseStatement)) return taken;
      return taken && skipped;
    }
    if (ts.isTryStatement(node)) {
      const tried = this.walk(node.tryBlock, state, acc, scope);
      // The exception can arrive before anything in the block ran, so the catch
      // starts where the try started — never where it ended.
      const rescued = node.catchClause ? this.walk(node.catchClause.block, state, acc, scope) : tried;
      let after = tried;
      if (node.catchClause) {
        if (alwaysExits(node.catchClause.block)) after = tried;
        else if (alwaysExits(node.tryBlock)) after = rescued;
        else after = tried && rescued;
      }
      return this.walk(node.finallyBlock, after, acc, scope);
    }
    if (ts.isConditionalExpression(node)) {
      const after = this.walk(node.condition, state, acc, scope);
      const taken = this.walk(node.whenTrue, after, acc, scope);
      const skipped = this.walk(node.whenFalse, after, acc, scope);
      return taken && skipped;
    }
    if (ts.isBinaryExpression(node) && isShortCircuit(node.operatorToken.kind)) {
      const left = this.walk(node.left, state, acc, scope);
      this.walk(node.right, left, acc, scope);
      return left;
    }
    if (ts.isDoStatement(node)) {
      const body = this.walk(node.statement, state, acc, scope);
      return this.walk(node.expression, body, acc, scope);
    }
    if (ts.isForStatement(node)) {
      // Initializer, condition, body, incrementor — the incrementor runs AFTER
      // the body, and walking it before would carry a guard forward that had
      // not run yet.
      let after = this.walk(node.initializer, state, acc, scope);
      after = this.walk(node.condition, after, acc, scope);
      this.walk(node.incrementor, this.walk(node.statement, after, acc, scope), acc, scope);
      // The body may not run at all, so nothing it guards holds after the loop.
      return after;
    }
    if (isLoop(node)) {
      const after = this.walk(node.expression, state, acc, scope);
      this.walk(node.statement, after, acc, scope);
      return after;
    }
    if (ts.isSwitchStatement(node)) {
      const after = this.walk(node.expression, state, acc, scope);
      for (const clause of node.caseBlock.clauses) this.walk(clause, after, acc, scope);
      return after;
    }
    let after = state;
    ts.forEachChild(node, (child) => {
      after = this.walk(child, after, acc, scope);
    });
    return after;
  }

  /** A closure sees the enclosing function's parameters, shadowed by its own —
   *  and each parameter keeps its own record, so `fn(n)` inside a wrapper arrow
   *  is still recorded against the function that DECLARED `fn`. */
  private walkClosure(
    fn: ts.ArrowFunction | ts.FunctionExpression,
    state: boolean,
    acc: Acc,
    enclosing: Scope,
  ): void {
    const scope: Scope = {
      params: new Map([...enclosing.params, ...this.slotsOf(fn, new Map())]),
      exits: [],
    };
    let after = state;
    for (const parameter of parametersIn(fn)) after = this.walk(parameter.initializer, after, acc, scope);
    this.walk(bodyOf(fn), after, acc, scope);
  }

  /**
   * One invocation — `f(x)` or `` f`x` ``.
   *
   * A tagged template is a call of its tag, and `graphql\`mutation …\`` is a
   * Github write written that way. The census reads both; so must this, or the
   * write is answered by neither gate and the only thing that notices is the
   * reachable-writes floor — which reports it as an ORPHAN, and the remedy for
   * an orphan is to name it as outside the subject. A reader following that
   * would exclude a route-reachable write by hand.
   *
   * A template's substitutions are expressions the walk still has to see, but
   * they are not arguments in a position the tag invokes, so they are walked
   * plainly and the callback machinery below sees none of them.
   */
  private walkCall(call: GithubCallNode, state: boolean, acc: Acc, scope: Scope): boolean {
    const tagged = !ts.isCallExpression(call);
    const callee = ts.isCallExpression(call) ? call.expression : call.tag;
    const args: readonly ts.Expression[] = ts.isCallExpression(call) ? call.arguments : [];
    let after = this.walk(callee, state, acc, scope);
    if (tagged) after = this.walk(call.template, after, acc, scope);
    // A callback argument is CREATED here and invoked by the callee, so it is
    // held back until the callee has said at which guard state that happens.
    const callbacks: { index: number; fn: ts.ArrowFunction | ts.FunctionExpression }[] = [];
    args.forEach((argument, index) => {
      if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
        callbacks.push({ index, fn: argument });
        return;
      }
      after = this.walk(argument, after, acc, scope);
    });

    const github = this.calls.classify(call);
    if (github) {
      if (github.kind === 'write') {
        const site = this.calls.site(call, github.operation);
        acc.reachable.set(call, site);
        if (!after) acc.unguarded.set(call, site);
      }
      for (const callback of callbacks) this.walkClosure(callback.fn, after, acc, scope);
      return after;
    }

    const targets = resolveTargets(callee, this.checker, this.index, this.options);
    // EVERY, not some: a call that can also land somewhere other than the
    // envelope has not certainly run it.
    if (targets.length > 0 && targets.every((target) => isEnvelope(target, this.options))) {
      for (const callback of callbacks) this.walkClosure(callback.fn, true, acc, scope);
      return true;
    }

    const summaries = targets.map((target) => this.summarize(target));
    for (const summary of summaries) {
      for (const [node, site] of summary.reachable) acc.reachable.set(node, site);
      if (!after) for (const [node, site] of summary.unguarded) acc.unguarded.set(node, site);
    }

    /** The state at which a callee invokes the argument in this position. */
    const invokedAt = (index: number): boolean =>
      after || (summaries.length > 0 && summaries.every((summary) => summary.params.get(index) === true));

    // `fn(n)` — the parameter invoked here, at the state reached here.
    const direct = this.parameterSlot(callee, scope);
    if (direct) Dominance.note(direct, after);

    // `this.before(fn)` — the parameter HANDED ON. Its guard state is whatever
    // the callee does with that position, and without this a helper that
    // forwards its callback to an unguarded invoker still reads as a sealer.
    args.forEach((argument, index) => {
      const forwarded = this.parameterSlot(argument, scope);
      if (forwarded) Dominance.note(forwarded, invokedAt(index));
    });

    for (const callback of callbacks) {
      // Guarded only when EVERY callee this call can land on guards before it
      // invokes that argument. A callee this walk could not resolve says
      // nothing, which leaves the callback where it was written.
      this.walkClosure(callback.fn, invokedAt(callback.index), acc, scope);
    }
    return after || (summaries.length > 0 && summaries.every((summary) => summary.guards));
  }

  /** The parameter an expression names, for `fn(n)` and for `helper(fn)`. */
  private parameterSlot(expression: ts.Expression, scope: Scope): ParamSlot | undefined {
    if (!ts.isIdentifier(expression)) return undefined;
    const symbol = this.checker.getSymbolAtLocation(expression);
    return symbol ? scope.params.get(symbol) : undefined;
  }
}

/** Every answer this gate has, from one walk over one program. Exported so a
 *  caller asking more than one question pays for the walk once. */
export interface DominanceAnswers {
  opts: DominanceOptions;
  unsealed: UnsealedWrite[];
  undeclared: UndeclaredWrite[];
  /** Every Github write ANY route reaches, however guarded. The floor that
   *  measures the call graph: a write no route reaches is either out of the
   *  subject by decision, or an edge this walk lost. */
  reached: GithubWriteSite[];
}

export function analyse(program: ts.Program, options: Partial<DominanceOptions> = {}): DominanceAnswers {
  const opts = resolveOptions(options);
  const declared = writeRoots(program, opts);
  const local = localWriteRoutes(program, opts);
  const walk = new Dominance(program, opts);
  walk.settle([...declared, ...local].map((route) => route.handler));

  const unsealed: UnsealedWrite[] = [];
  for (const route of declared) {
    for (const write of sites(walk.summarize(route.handler).unguarded)) {
      unsealed.push({
        route: route.route,
        where: route.where,
        caps: route.caps,
        write,
        envelopeFile: opts.envelopeFile,
        envelopeSymbol: opts.envelopeSymbol,
      });
    }
  }

  const undeclared: UndeclaredWrite[] = [];
  for (const route of local) {
    for (const write of sites(walk.summarize(route.handler).reachable)) {
      undeclared.push({
        route: route.route,
        where: route.where,
        write,
        envelopeSymbol: opts.envelopeSymbol,
      });
    }
  }

  const reached = new Map<GithubCallNode, GithubWriteSite>();
  for (const route of [...declared, ...local]) {
    for (const [node, site] of walk.summarize(route.handler).reachable) reached.set(node, site);
  }
  return { opts, unsealed, undeclared, reached: sites(reached) };
}

/** One write per line of the report, in a fixed order. */
const sites = (found: Map<GithubCallNode, GithubWriteSite>): GithubWriteSite[] =>
  [...found.values()].sort((a, b) => a.where.localeCompare(b.where) || a.line - b.line);

/** Every Github write a declared write route reaches without the envelope
 *  having run (#621). */
export const unsealedWrites = (
  program: ts.Program,
  options: Partial<DominanceOptions> = {},
): UnsealedWrite[] => analyse(program, options).unsealed;

/** Every Github write reached by a route that declared it writes none (#624). */
export const undeclaredWrites = (
  program: ts.Program,
  options: Partial<DominanceOptions> = {},
): UndeclaredWrite[] => analyse(program, options).undeclared;

/** Every Github write some route reaches, guarded or not. */
export const reachedWrites = (
  program: ts.Program,
  options: Partial<DominanceOptions> = {},
): GithubWriteSite[] => analyse(program, options).reached;

/**
 * The report one unsealed write produces.
 *
 * It names the WRITE as well as the route, and it must: the route's own file
 * holds a `guardWrite` in every shape this catches, so a message about the
 * route alone sends the reader to a call that is already there. It also stays
 * out of #616's words — that gate's "nothing it calls reaches guardWrite" is a
 * different fact, and false here.
 */
export const describeUnsealed = (u: UnsealedWrite): string =>
  `${u.route} writes Github at ${u.write.where} line ${u.write.line} (${u.write.operation}) on a path where ` +
  `${u.envelopeSymbol} has not run. Route: ${u.where}, declaring @Writes(${u.caps.map((c) => `'${c}'`).join(', ')}). ` +
  `An envelope behind a condition, inside a catch, or after the mutation covers nothing that already went out — ` +
  `move ${u.envelopeSymbol} from ${u.envelopeFile} ahead of this write on every path.`;

/** The report one undeclared write produces. The declaration is the defect, and
 *  the fix is both halves of it. */
export const describeUndeclared = (u: UndeclaredWrite): string =>
  `${u.route} declares @Writes(), meaning it writes no Github, and reaches ${u.write.where} line ${u.write.line} ` +
  `(${u.write.operation}), which writes Github. Route: ${u.where}. The declaration is what is wrong here: name the ` +
  `capability this route writes, as @Writes('the.capability'), and put the mutation behind ${u.envelopeSymbol}. ` +
  `One without the other leaves either the capability check or the owner pin unrun.`;

// ── The shapes the walk has to read, kept out of the class ────────────────

function bodyOf(fn: ts.Node): ts.Node | undefined {
  if (ts.isArrowFunction(fn)) return fn.body;
  if (
    ts.isFunctionDeclaration(fn) ||
    ts.isMethodDeclaration(fn) ||
    ts.isFunctionExpression(fn) ||
    ts.isConstructorDeclaration(fn) ||
    ts.isGetAccessorDeclaration(fn) ||
    ts.isSetAccessorDeclaration(fn)
  ) {
    return fn.body;
  }
  return undefined;
}

const parametersIn = (fn: ts.Node): readonly ts.ParameterDeclaration[] =>
  ts.isFunctionLike(fn) ? fn.parameters : [];

const isShortCircuit = (kind: ts.SyntaxKind): boolean =>
  kind === ts.SyntaxKind.AmpersandAmpersandToken ||
  kind === ts.SyntaxKind.BarBarToken ||
  kind === ts.SyntaxKind.QuestionQuestionToken;

/** The loops whose head is one expression, walked before a body that may not
 *  run. `for(;;)` has three head parts in an order of its own and is handled
 *  where the walk can say so. */
const isLoop = (node: ts.Node): node is ts.ForOfStatement | ts.ForInStatement | ts.WhileStatement =>
  ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node);

/** Whether control certainly leaves a statement rather than falling out of it.
 *  A branch that cannot reach the code after it contributes nothing to the
 *  join, which is what keeps a `throw` on one arm from reading as a missing
 *  guard. */
function alwaysExits(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isBlock(node)) return node.statements.some(alwaysExits);
  if (ts.isIfStatement(node)) return alwaysExits(node.thenStatement) && alwaysExits(node.elseStatement);
  return false;
}

/**
 * Whether two rounds of the walk reached the same answers.
 *
 * By CONTENTS. Neither write set grows monotonically across rounds — a `guards`
 * flipping false→true drops entries from `unguarded` while `reachable` can gain
 * them — so two rounds of equal SIZE are not two rounds of equal answer, and a
 * walk compared that way can stop short of its fixpoint.
 */
function sameAnswers(a: Map<ts.Node, Summary>, b: Map<ts.Node, Summary>): boolean {
  if (a.size !== b.size) return false;
  const sameKeys = (left: Map<GithubCallNode, unknown>, right: Map<GithubCallNode, unknown>): boolean =>
    left.size === right.size && [...left.keys()].every((key) => right.has(key));
  for (const [node, left] of a) {
    const right = b.get(node);
    if (!right) return false;
    if (left.guards !== right.guards) return false;
    if (!sameKeys(left.unguarded, right.unguarded)) return false;
    if (!sameKeys(left.reachable, right.reachable)) return false;
    if (left.params.size !== right.params.size) return false;
    for (const [index, guarded] of left.params) if (right.params.get(index) !== guarded) return false;
  }
  return true;
}

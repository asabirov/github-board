import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript-api';
import {
  buildWriteProgram,
  buildSyntheticProgram,
  localWriteRoutes,
  writeRoots,
} from './write-reachability.contract';
import { githubCalls, githubWrites, describeWrite } from './github-write-census.contract';
import {
  analyse,
  unsealedWrites,
  undeclaredWrites,
  describeUnsealed,
  describeUndeclared,
  type DominanceAnswers,
} from './write-dominance.contract';

/**
 * Build-time dominance gate (#621) and empty-declaration gate (#624).
 *
 * `writes-enveloped.spec.ts` asks whether a Github write route can REACH
 * `guardWrite`. This one asks the two questions that leaves open, and both need
 * the same thing that gate does not have: a census of the actual Github writes,
 * and which routes reach each one.
 *
 *   #621 — the envelope has to run BEFORE the write. A `guardWrite` behind a
 *   config flag, inside a `catch`, or after the mutation is reachable and
 *   useless: the clear already happened, and the envelope throwing a moment
 *   later does not un-write it.
 *
 *   #624 — a route declaring `@Writes()` says it writes no Github. Nothing read
 *   the body to check, and #616's gate excludes those routes by construction.
 *
 * One machine answers both, because both are "which writes does this route
 * reach, and under what guard".
 */

/** The options every synthetic program below is read under. */
const SYNTHETIC = {
  rootDir: '/synthetic',
  envelopeFile: 'envelope.ts',
  envelopeSymbol: 'guardWrite',
  clientFile: 'client.ts',
  clientSymbol: 'buildClient',
};

const ENVELOPE_SOURCE = `
  export function guardWrite(subject: { owner: string }): number { return subject.owner.length; }
`;

/**
 * A stand-in Octokit, named the way the real one is.
 *
 * `issues.setLabels` and `issues.get` are real endpoint names, so the census
 * resolves their HTTP verbs — PUT and GET — through Octokit's own table here
 * exactly as it does on the real tree. Nothing in this file states which of the
 * two is a write.
 */
const CLIENT_SOURCE = `
  export interface Client {
    issues: {
      setLabels(params: { names: string[] }): Promise<void>;
      get(params: { number: number }): Promise<void>;
    };
    request(route: string): Promise<void>;
    graphql(document: string): Promise<void>;
  }
  export function buildClient(): Client { return undefined as unknown as Client; }
`;

const SOURCE_SOURCE = `
  import { buildClient } from './client';
  export class Source {
    private readonly client = buildClient();
    async setLabels(names: string[]): Promise<void> { await this.client.issues.setLabels({ names }); }
    async read(): Promise<void> { await this.client.issues.get({ number: 1 }); }
    async tagged(): Promise<void> {
      await this.client.graphql\`mutation($p:ID!){ deleteThing(id:$p){ id } }\`;
    }
  }
`;

/** Local stand-ins for the Nest decorators, so a synthetic program needs no
 *  `@nestjs` resolution. */
const NEST_STUBS = `
  const Controller = (p: string) => (t: unknown) => { void p; void t; };
  const Patch = (p: string) => (t: unknown, k: string, d: unknown) => { void p; void t; void k; void d; };
  const Post = (p: string) => (t: unknown, k: string, d: unknown) => { void p; void t; void k; void d; };
  const Writes = (...c: string[]) => (t: unknown, k: string, d: unknown) => { void c; void t; void k; void d; };
`;

/** One program holding every shape, so the gate has to tell them apart rather
 *  than answer the same way to everything it is shown. */
const shapes = (handlers: string): Record<string, string> => ({
  '/synthetic/envelope.ts': ENVELOPE_SOURCE,
  '/synthetic/client.ts': CLIENT_SOURCE,
  '/synthetic/source.ts': SOURCE_SOURCE,
  '/synthetic/widgets.controller.ts': `
    import { guardWrite } from './envelope';
    import { Source } from './source';
    ${NEST_STUBS}

    @Controller('widgets')
    export class WidgetsController {
      constructor(
        private readonly source: Source,
        private readonly flags: { on(key: string): boolean },
      ) {}

      ${handlers}

      /** The real controller's shape: guard, then invoke the callback. */
      private async run(fn: () => Promise<void>): Promise<void> {
        guardWrite({ owner: 'acme' });
        await fn();
      }
    }
  `,
});

const SEALED_HANDLER = `
      @Writes('issue.labels')
      @Patch(':id/sealed')
      async sealed(): Promise<void> {
        await this.run(() => this.source.setLabels(['a']));
      }
`;

let program: ts.Program;
/** One walk of the real tree, shared by every assertion below it — the index,
 *  the census and the fixpoint are the same three answers each time. */
let answers: DominanceAnswers;

// Five minutes, not the default thirty seconds. This hook COMPILES the tree —
// `buildWriteProgram` builds a `ts.Program` — so how long it takes is bounded by
// what else the machine is doing, not by anything below it. At load ~350 on ten
// cores it times out; isolated it is seconds. A gate that stops running when the
// runner is busy is not a gate: it fails, gets read as "just load", and the next
// failure — a real one, in the write census this file exists to hold — gets waved
// through with it.
beforeAll(() => {
  program = buildWriteProgram();
  answers = analyse(program);
}, 300_000);

describe('the census of Github writes (#621/#624)', () => {
  it('finds every Github mutation the tree holds, and none of the reads beside them', () => {
    expect(githubWrites(program).map(describeWrite).sort()).toEqual(
      [
        'boot-alert/boot-alert.notifier.ts#file → issues.create',
        'boot-alert/boot-alert.notifier.ts#file → issues.createComment',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.addAssignees → issues.addAssignees',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.addComment → issues.createComment',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.addToProject → graphql mutation',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.createProject → graphql mutation',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.editText → issues.update',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.editText → issues.updateComment',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.removeAssignees → issues.removeAssignees',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.removeFromProject → graphql mutation',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.setAssignees → issues.update',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.setFieldValue → graphql mutation',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.setFieldValue → graphql mutation',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.setLabels → issues.setLabels',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.setMilestone → issues.update',
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.toggleTask → issues.update',
        // `setState` and `close` share this one call (#1006), so it lives in
        // the private method both of them go through.
        'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.writeState → issues.update',
        "repos/github-repos.source.ts#GithubReposSource.setDri → request('PATCH /repos/{owner}/{repo}/properties/values')",
      ].sort(),
    );
  });
});

describe('the envelope runs before the write (#621)', () => {
  it('walks both ternary branches even when the first has no envelope', () => {
    const synthetic = buildSyntheticProgram(shapes(`
      @Writes('issue.labels')
      @Patch(':id/conditional')
      async conditional(): Promise<void> {
        this.flags.on('FIRST')
          ? await this.source.setLabels(['first'])
          : await this.source.tagged();
      }
    `));
    expect(unsealedWrites(synthetic, SYNTHETIC).map((u) => u.write.operation).sort()).toEqual([
      'graphql mutation',
      'issues.setLabels',
    ]);
  });

  it('a guardWrite behind a flag does not cover the write', () => {
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes('issue.labels')
      @Patch(':id/flagged')
      async flagged(): Promise<void> {
        if (this.flags.on('SOME_FLAG')) guardWrite({ owner: 'acme' });
        await this.source.setLabels(['a']);
      }
      ${SEALED_HANDLER}
    `),
    );
    expect(unsealedWrites(synthetic, SYNTHETIC).map((u) => u.route)).toEqual(['PATCH widgets/:id/flagged']);
  });

  it('a guardWrite inside a catch does not cover the write in the try', () => {
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes('issue.labels')
      @Patch(':id/rescued')
      async rescued(): Promise<void> {
        try {
          await this.source.setLabels(['a']);
        } catch {
          guardWrite({ owner: 'acme' });
        }
      }
      ${SEALED_HANDLER}
    `),
    );
    expect(unsealedWrites(synthetic, SYNTHETIC).map((u) => u.route)).toEqual(['PATCH widgets/:id/rescued']);
  });

  it('a clear before the guarded set is a write the envelope never saw', () => {
    // The realistic shape, and the one human review misses: the file visibly
    // contains `guardWrite`, and the clear went out before it ran.
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes('issue.labels')
      @Patch(':id/replace')
      async replace(): Promise<void> {
        await this.source.setLabels([]);
        await this.run(() => this.source.setLabels(['a']));
      }
      ${SEALED_HANDLER}
    `),
    );
    const found = unsealedWrites(synthetic, SYNTHETIC);
    expect(found.map((u) => u.route)).toEqual(['PATCH widgets/:id/replace']);
    // The report names the write, not only the route — the route's own file
    // holds a `guardWrite`, so a message about the route alone sends the reader
    // to the wrong place.
    const message = describeUnsealed(found[0]);
    expect(message).toContain('source.ts#Source.setLabels');
    expect(message).toContain('issues.setLabels');
    expect(message).toContain('widgets.controller.ts#WidgetsController.replace');
    expect(message).toContain(SYNTHETIC.envelopeSymbol);
  });

  it('a handler that goes through the guarded path is not reported', () => {
    // The nine real facets have this shape, and the guard-reaching call and the
    // mutation-reaching arrow sit in the SAME statement — so lexical order in
    // the handler settles nothing, and only "run guards before it invokes its
    // parameter" makes them green.
    const synthetic = buildSyntheticProgram(shapes(SEALED_HANDLER));
    expect(unsealedWrites(synthetic, SYNTHETIC)).toEqual([]);
  });
});

describe('an empty @Writes() is checked against the body (#624)', () => {
  it('a route declaring no capability while writing Github is reported', () => {
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes()
      @Post('local')
      async local(): Promise<void> {
        await this.source.setLabels(['a']);
      }

      @Writes()
      @Post('honest')
      async honest(): Promise<void> {
        await this.source.read();
      }
    `),
    );
    const found = undeclaredWrites(synthetic, SYNTHETIC);
    expect(found.map((u) => u.route)).toEqual(['POST widgets/local']);
    expect(found.map((u) => u.write.where)).toEqual(['source.ts#Source.setLabels']);
    const message = describeUndeclared(found[0]);
    expect(message).toContain('source.ts#Source.setLabels');
    expect(message).toContain('widgets.controller.ts#WidgetsController.local');
    // The declaration is the defect, and the fix is both halves.
    expect(message).toContain('@Writes(');
    expect(message).toContain(SYNTHETIC.envelopeSymbol);
  });

  it('a route declaring @Writes() is reported even when it guards the write', () => {
    // `undeclaredWrites` reads REACHABLE, not unguarded, and it has to: the
    // capability rung runs over zero capabilities whatever the envelope did, so
    // a `@Writes()` route carrying `guardWrite` is still a route whose
    // declaration is false.
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes()
      @Post('guarded-local')
      async guardedLocal(): Promise<void> {
        guardWrite({ owner: 'acme' });
        await this.source.setLabels(['a']);
      }
    `),
    );
    expect(undeclaredWrites(synthetic, SYNTHETIC).map((u) => u.route)).toEqual(['POST widgets/guarded-local']);
  });
});


describe('the census is inverted, not enumerated', () => {
  it('excludes local hook registration but still sees mutations inside its callback and unknown hook methods', () => {
    const synthetic = buildSyntheticProgram({
      '/synthetic/client.ts': `
        export interface Client {
          hook: { wrap(name: string, callback: () => void): void; invented(): void };
          request(route: string): Promise<void>;
          graphql(document: string): Promise<void>;
        }
        export function buildClient(): Client { return undefined as unknown as Client; }
      `,
      '/synthetic/source.ts': `
        import { buildClient } from './client';
        export function attach() {
          const client = buildClient();
          client.hook.wrap('request', () => { client.request('DELETE /repos/o/r'); });
          client.hook.invented();
        }
      `,
    });
    expect(githubWrites(synthetic, SYNTHETIC).map(describeWrite).sort()).toEqual([
      'source.ts#attach → hook.invented',
      "source.ts#attach → request('DELETE /repos/o/r')",
    ]);
  });

  it('a client member Octokit has never heard of is a write, and a GET route is not', () => {
    // The whole of the fail-closed claim, in one program: nothing here names a
    // mutating method, and the two the census must separate differ only in what
    // Octokit's own endpoint table says about them.
    const synthetic = buildSyntheticProgram({
      '/synthetic/client.ts': `
        export interface Client {
          issues: { invented(params: { x: number }): Promise<void>; get(params: { x: number }): Promise<void> };
          request(route: string): Promise<void>;
          graphql(document: string): Promise<void>;
        }
        export function buildClient(): Client { return undefined as unknown as Client; }
      `,
      '/synthetic/source.ts': `
        import { buildClient } from './client';
        const QUERY = 'query($n:Int!){ node(id:$n){ id } }';
        const MUTATION = 'mutation($n:Int!){ deleteThing(id:$n){ id } }';
        export class Source {
          private readonly client = buildClient();
          async invented(): Promise<void> { await this.client.issues.invented({ x: 1 }); }
          async read(): Promise<void> { await this.client.issues.get({ x: 1 }); }
          async fetched(): Promise<void> { await this.client.request('GET /repos/o/r'); }
          async patched(): Promise<void> { await this.client.request('PATCH /repos/o/r'); }
          async queried(): Promise<void> { await this.client.graphql(QUERY); }
          async mutated(): Promise<void> { await this.client.graphql(MUTATION); }
          async unknowable(route: string): Promise<void> { await this.client.request(route); }
        }
      `,
    });
    expect(githubWrites(synthetic, SYNTHETIC).map(describeWrite).sort()).toEqual(
      [
        'source.ts#Source.invented → issues.invented',
        'source.ts#Source.mutated → graphql mutation',
        "source.ts#Source.patched → request('PATCH /repos/o/r')",
        "source.ts#Source.unknowable → request(a route read at run time)",
      ].sort(),
    );
  });

  it('a tree with no client factory is an error, not an empty census', () => {
    // Silence here would read as "this tree writes no Github", which is the
    // fail-open answer and the one every gate in this directory refuses.
    const synthetic = buildSyntheticProgram({ '/synthetic/source.ts': 'export const nothing = 1;' });
    expect(() => githubWrites(synthetic, SYNTHETIC)).toThrow(/buildClient/);
  });
});

describe('a call cycle does not hide a write (#621)', () => {
  it('a route reaching the write only around the recursion is still reported', () => {
    // The real tree HAS cycles — the walk reports them on every run — so the
    // repeat pass that settles them is load-bearing rather than defensive.
    // Here `a` and `b` call each other and the mutation sits in `a`. Walking
    // from `aaa` finds it; walking from `bbb` reaches it only through the back
    // edge, and the first pass memoises a `b` that was cut short at the cycle.
    // Drop the repeat and this route comes back clean.
    const synthetic = buildSyntheticProgram({
      '/synthetic/envelope.ts': ENVELOPE_SOURCE,
      '/synthetic/client.ts': CLIENT_SOURCE,
      '/synthetic/source.ts': `
        import { buildClient } from './client';
        export class Source {
          private readonly client = buildClient();
          async a(): Promise<void> {
            await this.b();
            await this.client.issues.setLabels({ names: [] });
          }
          async b(): Promise<void> { await this.a(); }
        }
      `,
      '/synthetic/widgets.controller.ts': `
        import { Source } from './source';
        ${NEST_STUBS}
        @Controller('widgets')
        export class WidgetsController {
          constructor(private readonly source: Source) {}

          @Writes('issue.labels')
          @Patch(':id/aaa')
          async aaa(): Promise<void> { await this.source.a(); }

          @Writes('issue.labels')
          @Patch(':id/bbb')
          async bbb(): Promise<void> { await this.source.b(); }
        }
      `,
    });
    expect(unsealedWrites(synthetic, SYNTHETIC).map((u) => u.route)).toEqual([
      'PATCH widgets/:id/aaa',
      'PATCH widgets/:id/bbb',
    ]);
  });
});

describe('the guard state a helper reports for its callback (#621)', () => {
  it('a helper that invokes its callback once unguarded keeps the unguarded answer', () => {
    // The clear-then-set shape moved one level up, into the sealer. A summary
    // that ASSIGNS the last invocation lets the guarded one overwrite the
    // unguarded one; a must-fact meets.
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes('issue.labels')
      @Patch(':id/twice')
      async twice(): Promise<void> {
        await this.runTwice(() => this.source.setLabels(['a']));
      }

      private async runTwice(fn: () => Promise<void>): Promise<void> {
        await fn();
        guardWrite({ owner: 'acme' });
        await fn();
      }
    `),
    );
    expect(unsealedWrites(synthetic, SYNTHETIC).map((u) => u.route)).toEqual(['PATCH widgets/:id/twice']);
  });

  it('a helper whose guard sits after an early return has not guarded', () => {
    // `if (!enabled) return;` above a guard is an ordinary shape. The returning
    // path leaves the helper with the envelope unrun, so the caller cannot
    // treat the helper as having guarded.
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes('issue.labels')
      @Patch(':id/early')
      async early(): Promise<void> {
        await this.gate();
        await this.source.setLabels(['a']);
      }

      private async gate(): Promise<void> {
        if (this.flags.on('SOME_FLAG')) return;
        guardWrite({ owner: 'acme' });
      }
    `),
    );
    expect(unsealedWrites(synthetic, SYNTHETIC).map((u) => u.route)).toEqual(['PATCH widgets/:id/early']);
  });

  it('a callback forwarded to another helper carries that helper answer back', () => {
    // `runForward` invokes `fn` directly and guarded, so on its own it looks
    // like a sealer — and it also hands the same `fn` to a helper that invokes
    // it with nothing run. The forwarded invocation is the one that writes.
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes('issue.labels')
      @Patch(':id/forwarded')
      async forwarded(): Promise<void> {
        await this.runForward(() => this.source.setLabels(['a']));
      }

      private async before(fn: () => Promise<void>): Promise<void> {
        await fn();
      }

      private async runForward(fn: () => Promise<void>): Promise<void> {
        await this.before(fn);
        guardWrite({ owner: 'acme' });
        await fn();
      }
    `),
    );
    expect(unsealedWrites(synthetic, SYNTHETIC).map((u) => u.route)).toEqual(['PATCH widgets/:id/forwarded']);
  });

  it('a sealer that wraps its callback in an arrow still seals', () => {
    // One span, one retry, one timing wrapper inside `run` and all nine real
    // facets fire at once, each message pointing at the source file rather than
    // at the line that changed. That is how a gate gets switched off.
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes('issue.labels')
      @Patch(':id/wrapped')
      async wrapped(): Promise<void> {
        await this.runWrapped(() => this.source.setLabels(['a']));
      }

      private async trace(f: () => Promise<void>): Promise<void> {
        await f();
      }

      private async runWrapped(fn: () => Promise<void>): Promise<void> {
        guardWrite({ owner: 'acme' });
        await this.trace(() => fn());
      }
    `),
    );
    expect(unsealedWrites(synthetic, SYNTHETIC)).toEqual([]);
  });
});

describe('a mutation written as a tagged template is walked like any other (#621/#624)', () => {
  it('a tagged mutation with no envelope before it is reported', () => {
    // The census reads `graphql\`mutation …\``; the walk has to as well, or the
    // write reaches neither gate and the only thing that notices is the orphan
    // floor — whose documented remedy is to name a write as OUTSIDE the
    // subject. A reader following that would exclude a route-reachable write by
    // hand, which is worse than the hole it was reporting.
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes('issue.project.remove')
      @Patch(':id/tagged')
      async tagged(): Promise<void> {
        await this.source.tagged();
      }
    `),
    );
    const found = unsealedWrites(synthetic, SYNTHETIC);
    expect(found.map((u) => u.route)).toEqual(['PATCH widgets/:id/tagged']);
    expect(found.map((u) => u.write.operation)).toEqual(['graphql mutation']);
  });

  it('a tagged mutation behind the envelope is not reported', () => {
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes('issue.project.remove')
      @Patch(':id/tagged')
      async tagged(): Promise<void> {
        await this.run(() => this.source.tagged());
      }
    `),
    );
    expect(unsealedWrites(synthetic, SYNTHETIC)).toEqual([]);
  });

  it('a tagged mutation on a route declaring @Writes() is reported', () => {
    const synthetic = buildSyntheticProgram(
      shapes(`
      @Writes()
      @Post('tagged')
      async taggedLocal(): Promise<void> {
        await this.source.tagged();
      }
    `),
    );
    expect(undeclaredWrites(synthetic, SYNTHETIC).map((u) => u.write.operation)).toEqual(['graphql mutation']);
  });
});

describe('what the ordering rules claim, as fixtures (#621)', () => {
  /** One handler, one expectation: does the write come back unsealed. */
  const reports = (body: string): string[] =>
    unsealedWrites(
      buildSyntheticProgram(
        shapes(`
      @Writes('issue.labels')
      @Patch(':id/x')
      async x(): Promise<void> {
        ${body}
      }
    `),
      ),
      SYNTHETIC,
    ).map((u) => u.route);

  it('a catch is entered where the try was entered, not where it ended', () => {
    expect(
      reports(`
        try {
          guardWrite({ owner: 'acme' });
        } catch {
          await this.source.setLabels(['a']);
        }
      `),
    ).toEqual(['PATCH widgets/:id/x']);
  });

  it('a guard inside a loop body does not survive the loop', () => {
    expect(
      reports(`
        for (const name of ['a']) {
          guardWrite({ owner: name });
        }
        await this.source.setLabels(['a']);
      `),
    ).toEqual(['PATCH widgets/:id/x']);
  });

  it('a guard on the right of a short circuit does not survive it', () => {
    expect(
      reports(`
        this.flags.on('SOME_FLAG') && guardWrite({ owner: 'acme' });
        await this.source.setLabels(['a']);
      `),
    ).toEqual(['PATCH widgets/:id/x']);
  });

  it('a ternary joins its two arms by AND', () => {
    expect(
      reports(`
        this.flags.on('SOME_FLAG') ? guardWrite({ owner: 'acme' }) : 0;
        await this.source.setLabels(['a']);
      `),
    ).toEqual(['PATCH widgets/:id/x']);
  });

  it('a guard on both arms of a ternary does survive it', () => {
    // The other half of the same rule: AND, not "always false".
    expect(
      reports(`
        this.flags.on('SOME_FLAG')
          ? guardWrite({ owner: 'acme' })
          : guardWrite({ owner: 'acme' });
        await this.source.setLabels(['a']);
      `),
    ).toEqual([]);
  });
});

describe('the census reads documents and routes it cannot settle as writes', () => {
  /** Every Github write one source file makes, under the synthetic client. */
  const writesIn = (source: string): string[] =>
    githubWrites(
      buildSyntheticProgram({
        '/synthetic/client.ts': CLIENT_SOURCE,
        '/synthetic/source.ts': `import { buildClient } from './client';\n${source}`,
      }),
      SYNTHETIC,
    ).map(describeWrite);

  it('a mutation behind a leading comment is still a mutation', () => {
    expect(
      writesIn(`
        const DOC = '# set the labels\\nmutation($p:ID!){ deleteProjectV2Item(input:{id:$p}){ id } }';
        export class Source {
          private readonly client = buildClient();
          async go(): Promise<void> { await this.client.graphql(DOC); }
        }
      `),
    ).toEqual(['source.ts#Source.go → graphql mutation']);
  });

  it('a mutation behind a fragment definition is still a mutation', () => {
    expect(
      writesIn(`
        const DOC = 'fragment F on Issue { id } mutation($p:ID!){ deleteThing(id:$p){ id } }';
        export class Source {
          private readonly client = buildClient();
          async go(): Promise<void> { await this.client.graphql(DOC); }
        }
      `),
    ).toEqual(['source.ts#Source.go → graphql mutation']);
  });

  it('a document read at run time is a write', () => {
    // The branch that carries the whole fail-closed claim for GraphQL.
    expect(
      writesIn(`
        export class Source {
          private readonly client = buildClient();
          async go(document: string): Promise<void> { await this.client.graphql(document); }
        }
      `),
    ).toEqual(['source.ts#Source.go → graphql(a document read at run time)']);
  });

  it('union arms that disagree about the verb settle nothing', () => {
    expect(
      writesIn(`
        export class Source {
          private readonly client = buildClient();
          async go(all: boolean): Promise<void> {
            await this.client.request(all ? 'GET /repos/o/r' : 'DELETE /repos/o/r');
          }
        }
      `),
    ).toEqual(['source.ts#Source.go → request(a route read at run time)']);
  });

  it('a GET route assembled from a template literal is a read', () => {
    // `paginate` and `request` both take one, and a false alarm here tells the
    // author of a read route that their declaration is wrong when it is not.
    expect(
      writesIn(`
        export class Source {
          private readonly client = buildClient();
          async go(owner: string, repo: string): Promise<void> {
            await this.client.request(\`GET /repos/\${owner}/\${repo}\`);
          }
        }
      `),
    ).toEqual([]);
  });

  it('the streaming half of paginate is read the same way as paginate', () => {
    expect(
      writesIn(`
        export class Source {
          private readonly client = buildClient();
          async go(): Promise<void> { await this.client.paginate.iterator('GET /repos/o/r/issues'); }
        }
      `),
    ).toEqual([]);
  });

  it('a mutation written as a tagged template is a write', () => {
    // `graphql\`mutation …\`` is not a CallExpression, so a census that only
    // walks calls never sees it at all.
    expect(
      writesIn(`
        export class Source {
          private readonly client = buildClient();
          async go(): Promise<void> { await this.client.graphql\`mutation($p:ID!){ deleteThing(id:$p){ id } }\`; }
        }
      `),
    ).toEqual(['source.ts#Source.go → graphql mutation']);
  });

  it('a second client type that merely looks like the client is an error', () => {
    // A hand-written port, a promoted test double, or `Octokit.plugin(retry)`
    // has a type of its own, so calls on it are not calls on the client this
    // census reads — and silence there is the fail-open answer.
    const synthetic = buildSyntheticProgram({
      '/synthetic/client.ts': CLIENT_SOURCE,
      '/synthetic/source.ts': `
        import { buildClient } from './client';
        interface Ported {
          issues: { setLabels(params: { names: string[] }): Promise<void> };
          request(route: string): Promise<void>;
          graphql(document: string): Promise<void>;
        }
        export class Source {
          private readonly client = buildClient();
          private readonly ported = undefined as unknown as Ported;
          async go(): Promise<void> { await this.ported.issues.setLabels({ names: [] }); }
          async read(): Promise<void> { await this.client.issues.get({ number: 1 }); }
        }
      `,
    });
    expect(() => githubWrites(synthetic, SYNTHETIC)).toThrow(/Ported/);
  });
});

describe('the real tree', () => {
  it('no Github write on any declared write route runs before the envelope', () => {
    expect(answers.unsealed.map(describeUnsealed)).toEqual([]);
  });

  it('no route declaring @Writes() reaches a Github write', () => {
    expect(answers.undeclared.map(describeUndeclared)).toEqual([]);
  });

  it('the walk really does arrive at every mutation a route can reach', () => {
    // The two assertions above pass on a walk that has quietly stopped walking,
    // and that is the failure every gate in this directory has had at least
    // once. So: run the REAL program against an envelope symbol declared
    // nowhere, and every Github write the eleven routes reach comes back
    // unsealed. It pins the whole path — route → service → source → the
    // mutation — and it pins `boot-alert.notifier.ts` as outside the subject,
    // since no route arrives there.
    const absent = unsealedWrites(program, { envelopeSymbol: 'guardWriteDeclaredNowhere' });
    expect([...new Set(absent.map((u) => u.write.where))].sort()).toEqual([
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.addAssignees',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.addComment',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.addToProject',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.createProject',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.editText',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.removeAssignees',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.removeFromProject',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.setAssignees',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.setFieldValue',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.setLabels',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.setMilestone',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.toggleTask',
      'issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.writeState',
      'repos/github-repos.source.ts#GithubReposSource.setDri',
    ]);
  });

  it('every Github write the tree makes is on some route path, or named as outside', () => {
    // The floor that measures what the prose used to assert. A missing
    // call-graph edge — a write behind a constructor, a getter, or a class the
    // container never names — does not make this gate LOUD the way it does for
    // #616: it makes the write unreachable, so it falls out of `unguarded` and
    // out of `reachable` together and neither gate says a word. This is what
    // turns that silence into a failure.
    const key = (w: { where: string; line: number }): string => `${w.where}:${w.line}`;
    const reached = new Set(answers.reached.map(key));
    const orphans = githubWrites(program).filter(
      // `boot-alert.notifier.ts` is outside the subject by decision, not by an
      // accident of the call graph: its target is operator config and no route
      // reaches it.
      (w) => !w.where.startsWith('boot-alert/') && !reached.has(key(w)),
    );
    expect(orphans.map(describeWrite)).toEqual([]);
  });

  it('the calls this census reads are all of them', () => {
    // 62 Github calls, 17 of them writes. Stated in the census's own doc
    // comment, and a sentence nobody checks drifts — so it is checked.
    // Forty-six until #647 added the boot per-org read in
    // `capability.registry.ts#orgProbe` — one list call per configured org,
    // asking whether the board can enumerate it at all. A read: the write count
    // below is unchanged, and this gate is what says so. Forty-seven until #657
    // added a second search for the window's closed half; #752 took the flow
    // chart that read it off Overview, so that call site is GONE again and the
    // running total below ends one lower than it did — and the numbers in
    // between are left as they were written, because they are a history of how
    // this count moved rather than a sum to re-derive. Forty-eight until #666
    // added the bounded release backfill in
    // `delivery/github-delivery.source.ts#GithubDeliverySource.backfill` — up to
    // MAX_RELEASE_BACKFILL_PAGES (8) extra pages for a repo whose first 100
    // releases end inside the day span, without which that repo's series draws a
    // sparse past and invents an upward trend. A read too: the write count is
    // STILL 13. Forty-nine until #690 added the item-page continuation in
    // `projects/github-projects.source.ts#GithubProjectsSource.pageItems` — the
    // next page of one board's items, for a board holding more than the hundred
    // Github returns at once, without which that board is served short at its
    // most recent end. A read as well, and the write count is 13 yet again.
    //
    // Fifty is where #690 left it. FIFTY-ONE is where #693 leaves it, and that
    // one IS a write — `issues.createComment` in
    // `issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.addComment`,
    // the board answering an issue on a reader's behalf — so the write count
    // moves off 13 for the first time since this census was written. Nothing
    // else about #690 moved either number: the continuation's failure handling, the cursor-stall guard and
    // filtering boards through `surfaced()` before paging them all change how
    // often that one call site is REACHED, and this census counts call sites in
    // the source rather than round trips at run time. Re-derived from a run
    // rather than reasoned about — the number below is what the walk answered.
    //
    // FIFTY-TWO would be wrong and FIFTY-ONE is where #756 leaves it: one call,
    // `request('GET /user')` in `sources/write-identity.service.ts#defaultAsk`,
    // asking Github which account the board's write credential belongs to so an
    // operator can read the answer off `/api/admin/write-identity` instead of
    // making a write they cannot take back. It is a READ — `GET` is proven a
    // read by Octokit's own endpoint table, the same way the registry's
    // `HEAD /user` probe is — so the write count does not move, and that is the
    // point: #756 moved WHICH ACCOUNT the fourteen land under, not how many
    // there are.
    //
    // FIFTY-SIX is where #892 leaves it, and all four are READS, so the write
    // count is 14 for the third issue running. Three are in
    // `auth/github-user.service.ts` — `users.getAuthenticated()` in `connect`,
    // naming the Github account a credential belongs to, and the two
    // `paginate` calls in `discover`, `GET /user/installations` and that
    // installation's repositories, which are the whole of what a person is
    // allowed to see. The fourth is `users.getAuthenticated()` in
    // `auth/github-auth.controller.ts`, resolving a sign-in to a Github user
    // before any account is admitted.
    //
    // #892 also makes the first two Github calls in this tree that are NOT on
    // an Octokit client, so this walk cannot see them and they are not in the
    // 56: the OAuth token exchange and the grant revocation, both raw `fetch`
    // in `auth/github-user.service.ts`. The census's own doc comment says so
    // and says why they are outside it.
    //
    // FIFTY-NINE is where #1009's review leaves it, and two of the three are
    // WRITES, so the write count moves to 16. The assign picker stopped saving
    // through `issues.update`, which replaces the set, and saves through
    // `issues.addAssignees` and `issues.removeAssignees` in
    // `issue-detail/github-issue-detail.source.ts`, which name only the people
    // they change. The third is a read, `issues.get` in `currentAssignees`, which
    // the picker ticks its rows from instead of the cached issue detail.
    //
    // SIXTY-ONE is where #982 leaves it, and one of the two is a WRITE, so the
    // write count moves to 17: `createProjectV2` in
    // `issue-detail/github-issue-detail.source.ts#GithubIssueDetailSource.createProject`,
    // making a project from the issue page. The other is that method's read of
    // the owner's node id and of the projects already carrying the name.
    //
    // SIXTY-THREE is where #1167 leaves it, and the one it adds is a READ, so
    // the write count does not move: the repository ask in
    // `auth/owner-rename.controller.ts`, which is how the board tells an
    // organisation that was RENAMED from one a person has genuinely lost. It is
    // a `request` on the person's own client, up to five times per refusal
    // screen and never on a page that is working.
    const calls = githubCalls(program);
    // Includes the repository identity checks before writes and image reads.
    // #1379 adds permission reads, fresh text reads and both text mutations.
    //
    // SIXTY-NINE is where #1209 part 4 leaves it, and the one it takes away is a
    // READ, so the write count does not move: `pinnedRepos` in
    // `repos/github-repos.source.ts` resolved each `ISSUES_METRICS_REPOS` entry
    // with its own `repos.get`. That key is retired and the explicit-repository
    // mode with it, so the Repos map has one scope path and the call is gone.
    //
    // SEVENTY-ONE is where #1450 leaves it, and the one it adds is a READ, so
    // the write count stays 19: `users.getByUsername` in
    // `auth/github-admission.service.ts`, resolving an allow-list login to its
    // stable numeric id so a rename cannot change admission.
    //
    // SEVENTY is where the #1450 feedback-removal slice leaves it, and the one
    // it takes away is a READ, so the write count stays 19: the removed
    // block's search left the tree with its module.
    //
    // SIXTY-FIVE is where the #1450 account-feedback removal leaves it, and one
    // of the five it takes away is a WRITE, so the write count moves to 18:
    // `issues.create` in `GithubFeedbackSource.submit`. The four reads are that
    // source's `repos.get`, the screenshot store's `GET /repositories/{id}` and
    // `issues.get`, and the feedback list's `search.issuesAndPullRequests`.
    expect(calls.length, 'Github calls').toBe(65);
    expect(calls.filter((c) => c.kind === 'write').length, 'Github writes').toBe(18);
  });

  it('the census says the same two numbers in its own prose as it answers here', () => {
    // The comment above claims this sentence is checked because a sentence
    // nobody checks drifts. It was not checked — the assertion above pins the
    // numbers, not the prose — and it drifted on the very next change: #690
    // updated the spec's copy of the count and left the contract's reading 49.
    // So the claim is made true here rather than repaired by hand a second time.
    const contract = readFileSync(join(__dirname, 'github-write-census.contract.ts'), 'utf8');
    const said = /all (\d+) Github calls this tree makes,\s*\n?\s*\*?\s*of which (\d+) are writes/.exec(contract);
    // A sentence that stopped matching is a sentence that stopped saying this,
    // which is the same failure as saying it wrongly.
    expect(said, 'the census doc comment still states its two counts').not.toBeNull();
    const calls = githubCalls(program);
    expect(Number(said![1]), 'Github calls, as the census prose states them').toBe(calls.length);
    expect(Number(said![2]), 'Github writes, as the census prose states them').toBe(
      calls.filter((c) => c.kind === 'write').length,
    );
  });

  it('the routes each gate is asked about are the ones that exist', () => {
    // A floor under both subjects. Every assertion above answers "nothing
    // wrong" on an empty subject too, and an empty subject is what a renamed
    // decorator or a stopped file walk produces.
    // Eleven until #693 added the comment route, which declares a Github write
    // like the ten before it.
    expect(writeRoots(program).length, 'declared Github write routes').toBeGreaterThanOrEqual(12);
    // NINE, not the ten #624 counts: logout, consent, sync, mcp, identity,
    // connected-clients, admin and account TWICE is nine routes, and the
    // discovery agrees. Raise it when routes are added; never lower it without
    // naming the route that left.
    expect(localWriteRoutes(program).length, 'routes declaring @Writes()').toBeGreaterThanOrEqual(9);
  });
});

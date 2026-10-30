// Tests for the exit-code decision behind `pnpm test` (#748).
//
//     node --test scripts/run-vitest.test.mjs scripts/vitest-verdict.test.mjs
//
// Node's own runner, not vitest: this code exists because vitest's exit code
// cannot be trusted on a loaded machine, so vitest cannot be the judge of
// whether it is read correctly. `classify` is pure for the same reason — a
// killed child, a missing verdict, a stalled worker and a 60s RPC timeout cannot
// be produced on demand from a real `pnpm test`.
//
// Verdicts here are built by `summarize`, the same function the reporter uses,
// so a renamed field breaks these tests instead of silently defaulting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChildArgs, buildChildEnv, buildStdio, classify, summarize } from './vitest-classify.mjs';

const RPC = '[vitest-worker]: Timeout calling "onTaskUpdate"';

function fakeModule({ state = 'passed', tests = ['passed'] } = {}) {
  return {
    state: () => state,
    ok: () => state !== 'failed',
    children: {
      *allTests() {
        for (const testState of tests) yield { result: () => ({ state: testState }) };
      },
    },
  };
}

// A run of 100 modules: 99 all-passed, one all-skipped. 2619 passed, 12 skipped,
// the shape of the board-service run in the issue.
function greenModules() {
  const modules = [];
  for (let i = 0; i < 99; i += 1) modules.push(fakeModule({ tests: Array(2619 / 99 | 0).fill('passed') }));
  modules.push(fakeModule({ state: 'skipped', tests: Array(12).fill('skipped') }));
  return modules;
}

function verdictOf({ modules = [fakeModule()], errors = [], reason = 'passed', enqueued = null } = {}) {
  return summarize({
    testModules: modules,
    unhandledErrors: errors,
    reason,
    enqueued: enqueued ?? modules.length,
  });
}

test('a child that exited 0 is silent and green', () => {
  const out = classify({ code: 0, signal: null, verdict: verdictOf() });
  assert.equal(out.exitCode, 0);
  assert.equal(out.line, null);
});

test('a complete green run whose only errors are the onTaskUpdate timeout is green, loudly', () => {
  const out = classify({ code: 1, signal: null, verdict: verdictOf({ modules: greenModules(), errors: [RPC, RPC] }) });
  assert.equal(out.exitCode, 0);
  assert.match(out.line, /every test passed/);
  assert.match(out.line, /RPC to the main process timed out/);
  assert.ok(out.line.includes(RPC), 'the line quotes the error it forgave');
  assert.match(out.line, /#748/);
});

test('a failed test passes the code through and names the failure', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: [fakeModule({ state: 'failed', tests: ['failed', 'passed'] })] }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /1 of 2 tests failed/);
  assert.match(out.line, /A test failed, not the runner/);
});

test('a failed module with no failed test is still a test failure', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: [fakeModule({ state: 'failed', tests: [] }), fakeModule()] }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /1 of 2 test files failed/);
  assert.match(out.line, /not the runner/);
});

test('a failed test alongside an RPC timeout is not forgiven', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: [fakeModule({ state: 'failed', tests: ['failed'] })], errors: [RPC] }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /1 of 1 tests failed/);
});

// C2: a stalled main process strands whole files. vitest prints `Test Files 8
// passed (12)` and exits 1, and every module it did hear from is `ok()`.
test('a run that lost whole test files is not forgiven, however green what reported is', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: [fakeModule(), fakeModule()], errors: [RPC], enqueued: 12 }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /2 of 12 test files/);
  assert.match(out.line, /results are missing/);
});

test('a module that never finished is not forgiven', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: [fakeModule(), fakeModule({ state: 'pending', tests: [] })], errors: [RPC] }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /results are missing/);
  assert.match(out.line, /1 test file did not finish/);
});

test('a test left pending is not forgiven', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: [fakeModule({ tests: ['passed', 'pending', 'pending'] })], errors: [RPC] }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /results are missing/);
  assert.match(out.line, /2 tests never finished/);
});

test('an interrupted run is not forgiven', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: greenModules(), errors: [RPC], reason: 'interrupted' }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /interrupted/);
});

test('a run vitest itself called failed is not forgiven', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: greenModules(), errors: [RPC], reason: 'failed' }),
  });
  assert.equal(out.exitCode, 1);
});

// C3: birpc concatenates the real error into the timeout message
// (`rpc.-pEldfrD.js:48-53`), so a crash can arrive wearing the timeout's prefix.
test('a timeout on onUnhandledError carries a real crash and is not forgiven', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({
      modules: greenModules(),
      errors: ['[vitest-worker]: Timeout calling "onUnhandledError" with "TypeError: Cannot read properties of undefined (reading id)"'],
    }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /not the #748 RPC timeout/);
  assert.ok(out.line.includes('TypeError'), 'the crash is quoted, not laundered');
});

test('a timeout on a module-loading call is not forgiven', () => {
  for (const call of ['fetch', 'transform', 'resolveId', 'snapshotSaved']) {
    const out = classify({
      code: 1,
      signal: null,
      verdict: verdictOf({ modules: greenModules(), errors: [`[vitest-worker]: Timeout calling "${call}" with "[]"`] }),
    });
    assert.equal(out.exitCode, 1, `${call} must not be forgiven`);
  }
});

test('the forgiven message is matched whole, at both ends', () => {
  for (const message of [
    `something before ${RPC}`,
    `${RPC} and something after`,
    '[vitest-pool]: Timeout calling "onTaskUpdate"',
    '[vitest-api]: Timeout calling "onTaskUpdate"',
    '[vitest-worker]: Timeout calling "onTaskUpdateExtra"',
  ]) {
    const out = classify({ code: 1, signal: null, verdict: verdictOf({ modules: greenModules(), errors: [message] }) });
    assert.equal(out.exitCode, 1, `must not forgive: ${message}`);
  }
});

test('zero failures but a non-RPC unhandled error passes the code through', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: greenModules(), errors: ['Error: connect ECONNREFUSED 127.0.0.1:5432'] }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /not the #748 RPC timeout/);
  assert.ok(out.line.includes('ECONNREFUSED'), 'the line quotes the error it refused to forgive');
});

test('one RPC timeout mixed with one other error passes the code through', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: greenModules(), errors: [RPC, 'Error: something else entirely'] }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /not the #748 RPC timeout/);
});

test('a run in which no test passed is not forgiven', () => {
  const out = classify({
    code: 1,
    signal: null,
    verdict: verdictOf({ modules: [fakeModule({ state: 'skipped', tests: ['skipped'] })], errors: [RPC] }),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /no tests/);
});

// Also the shape of a coverage threshold miss and of a rejection that lands
// after `onTestRunEnd`: both set `process.exitCode = 1` without ever reaching
// `unhandledErrors`, so the verdict is complete, green and error-free while the
// child exits 1.
test('a run that collected nothing at all is reported as having run no tests', () => {
  // `vitest run zzz-no-match` exits 1 with no modules and no enqueued count.
  const out = classify({ code: 1, signal: null, verdict: verdictOf({ modules: [], enqueued: 0 }) });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /run no tests/);
});

test('a red run with no unhandled error at all passes the code through', () => {
  const out = classify({ code: 1, signal: null, verdict: verdictOf({ modules: greenModules() }) });
  assert.equal(out.exitCode, 1);
  assert.ok(out.line);
});

test('a missing verdict passes the code through and says so', () => {
  const out = classify({ code: 1, signal: null, verdict: null });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /no readable verdict/);
});

test('a missing verdict on a red run keeps whatever code vitest gave', () => {
  const out = classify({ code: 7, signal: null, verdict: null });
  assert.equal(out.exitCode, 7);
});

test('a child killed by a signal exits non-zero and names the signal', () => {
  const out = classify({ code: null, signal: 'SIGKILL', verdict: verdictOf({ modules: greenModules(), errors: [RPC] }) });
  assert.notEqual(out.exitCode, 0);
  assert.match(out.line, /SIGKILL/);
});

test('a signal wins over an otherwise forgivable verdict', () => {
  const out = classify({ code: 0, signal: 'SIGTERM', verdict: verdictOf({ modules: greenModules() }) });
  assert.notEqual(out.exitCode, 0);
  assert.match(out.line, /SIGTERM/);
});

test('a vitest that never started is reported as never having started', () => {
  const out = classify({ code: null, signal: null, spawnError: 'spawn ENOENT', verdict: null });
  assert.equal(out.exitCode, 1);
  assert.match(out.line, /did not start/);
  assert.match(out.line, /ENOENT/);
});

test('a child that reported neither a code nor a signal fails rather than passing', () => {
  const out = classify({ code: null, signal: null, verdict: null });
  assert.equal(out.exitCode, 1);
  assert.ok(out.line);
});

// The other silent mistake: a CLI `--reporter` REPLACES the config's reporters,
// so injecting the verdict reporter alone would leave a run printing nothing.

const VERDICT = '/abs/scripts/vitest-verdict.mjs';

test('a run with no reporter of its own keeps the default one', () => {
  assert.deepEqual(buildChildArgs([], VERDICT, {}), ['run', '--reporter=default', `--reporter=${VERDICT}`]);
});

test('a caller-chosen reporter is not joined by the default', () => {
  assert.deepEqual(buildChildArgs(['--reporter=dot'], VERDICT, {}), [
    'run',
    '--reporter=dot',
    `--reporter=${VERDICT}`,
  ]);
});

test('the space-separated and plural reporter forms both count as caller-chosen', () => {
  assert.deepEqual(buildChildArgs(['--reporter', 'dot'], VERDICT, {}), ['run', '--reporter', 'dot', `--reporter=${VERDICT}`]);
  assert.deepEqual(buildChildArgs(['--reporters=dot'], VERDICT, {}), ['run', '--reporters=dot', `--reporter=${VERDICT}`]);
});

test('every separator pnpm forwards is dropped, not passed to vitest', () => {
  // `pnpm test -- --reporter=dot` hands the script a literal `--`. vitest files
  // everything after one away and ignores it, so a surviving `--` would drop the
  // verdict reporter itself.
  assert.deepEqual(buildChildArgs(['--', '--reporter=dot'], VERDICT, {}), ['run', '--reporter=dot', `--reporter=${VERDICT}`]);
  assert.deepEqual(buildChildArgs(['--', '--'], VERDICT, {}), ['run', '--reporter=default', `--reporter=${VERDICT}`]);
  assert.deepEqual(buildChildArgs(['src/a.spec.ts', '--'], VERDICT, {}), [
    'run',
    'src/a.spec.ts',
    '--reporter=default',
    `--reporter=${VERDICT}`,
  ]);
});

test('other arguments keep their order', () => {
  assert.deepEqual(buildChildArgs(['--config', 'vitest.db.config.ts'], VERDICT, {}), [
    'run',
    '--config',
    'vitest.db.config.ts',
    '--reporter=default',
    `--reporter=${VERDICT}`,
  ]);
});

test('on CI the github-actions reporter is restored along with the default', () => {
  // vitest only adds it when NO cli reporter was given
  // (`coverage.DfSpMS-b.js:3855`), and losing it loses the inline annotations
  // that say which test failed.
  assert.deepEqual(buildChildArgs([], VERDICT, { GITHUB_ACTIONS: 'true' }), [
    'run',
    '--reporter=default',
    '--reporter=github-actions',
    `--reporter=${VERDICT}`,
  ]);
  assert.deepEqual(buildChildArgs(['--reporter=dot'], VERDICT, { GITHUB_ACTIONS: 'true' }), [
    'run',
    '--reporter=dot',
    `--reporter=${VERDICT}`,
  ]);
});

// C1: the verdict path must not be reachable from a test file. Spec files run in
// workers, and workers inherit the child's environment.
test('no verdict path reaches the child environment', () => {
  const env = buildChildEnv({ PATH: '/usr/bin', VITEST_VERDICT_FILE: '/tmp/stale.json' });
  assert.equal(env.PATH, '/usr/bin');
  const leaked = Object.entries(env).filter(([key, value]) => /verdict/i.test(key) || /verdict/i.test(String(value)));
  assert.deepEqual(leaked, [], 'nothing in the child environment names the verdict');
});

test('the verdict travels on a file descriptor instead', () => {
  assert.deepEqual(buildStdio(17), ['inherit', 'inherit', 'inherit', 17]);
});

// The gate has to run. A `node --test` glob that matches nothing prints
// `tests 0` and exits 0, and a NAMED file that does not exist is ignored as long
// as another one matched — both measured on node 24.18.0. CI names the files and
// checks they exist; this is the other half, catching a test file that exists
// and is never run.
//
// The walk is recursive (#1326). It used to read `scripts/` alone, and
// `scripts/traps/read.test.mjs` sat one folder down and ran in no job at all —
// exactly the gap this test is here to close.
test('AGENTS.md names exactly the harness test files that exist', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const guide = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  // Anchored on run-vitest.test.mjs rather than on `.test.mjs` alone (#1398).
  // board-frontend runs its own `node --test scripts/*.test.mjs` steps, and those
  // paths are relative to that package, so the suffix no longer tells the two
  // apart in the text. This file is the one the local harness run cannot lose.
  // The harness checks moved out of ci.yml to AGENTS.md (#1443), so the guard
  // reads that file back instead of the workflow.
  const line = guide.split('\n')
    .find((text) => text.includes('node --test') && text.includes('scripts/run-vitest.test.mjs'));
  assert.ok(line, 'AGENTS.md names the harness tests');
  const named = line.trim().split(/\s+/).filter((token) => token.endsWith('.test.mjs')).sort();
  const onDisk = readdirSync(path.join(root, 'scripts'), { recursive: true })
    .filter((file) => file.endsWith('.test.mjs'))
    .map((file) => `scripts/${file}`)
    .sort();
  assert.deepEqual(named, onDisk);
});

// Tests for the reporter's mapping and for the verdict it writes (#748).
//
//     node --test scripts/run-vitest.test.mjs scripts/vitest-verdict.test.mjs
//
// Node's runner rather than vitest: this is the code that decides whether
// vitest's exit code can be trusted, so vitest cannot be its judge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readVerdictText, summarize } from './vitest-classify.mjs';
import VerdictReporter from './vitest-verdict.mjs';

export function fakeModule({ state = 'passed', tests = ['passed'] } = {}) {
  return {
    state: () => state,
    // vitest's own `ok()` returns true for a module that never finished
    // (`reporters.d.BuRON0I0.d.ts:95-98`), which is the whole reason the verdict
    // carries module STATES as well.
    ok: () => state !== 'failed',
    children: {
      *allTests() {
        for (const testState of tests) yield { result: () => ({ state: testState }) };
      },
    },
  };
}

test('a whole green run is summarised as complete', () => {
  const verdict = summarize({
    testModules: [fakeModule({ tests: ['passed', 'skipped'] }), fakeModule()],
    unhandledErrors: [],
    reason: 'passed',
    enqueued: 2,
  });
  assert.deepEqual(verdict, {
    reason: 'passed',
    enqueued: 2,
    modules: 2,
    failedModules: 0,
    unfinishedModules: 0,
    tests: { total: 3, passed: 2, failed: 0, skipped: 1 },
    errors: [],
  });
});

test('a module that never finished is counted as unfinished, not as ok', () => {
  const verdict = summarize({
    testModules: [fakeModule(), fakeModule({ state: 'pending', tests: [] })],
    unhandledErrors: [],
    reason: 'passed',
    enqueued: 2,
  });
  assert.equal(verdict.unfinishedModules, 1);
  assert.equal(verdict.failedModules, 0);
});

test('a queued module is unfinished too', () => {
  const verdict = summarize({
    testModules: [fakeModule({ state: 'queued', tests: [] })],
    unhandledErrors: [],
    reason: 'passed',
    enqueued: 1,
  });
  assert.equal(verdict.unfinishedModules, 1);
});

test('a skipped module is finished', () => {
  const verdict = summarize({
    testModules: [fakeModule({ state: 'skipped', tests: ['skipped'] })],
    unhandledErrors: [],
    reason: 'passed',
    enqueued: 1,
  });
  assert.equal(verdict.unfinishedModules, 0);
});

test('a pending test is counted in the total and nowhere else', () => {
  const verdict = summarize({
    testModules: [fakeModule({ tests: ['passed', 'pending'] })],
    unhandledErrors: [],
    reason: 'passed',
    enqueued: 1,
  });
  assert.deepEqual(verdict.tests, { total: 2, passed: 1, failed: 0, skipped: 0 });
});

test('a failed module is counted as failed', () => {
  const verdict = summarize({
    testModules: [fakeModule({ state: 'failed', tests: ['failed'] })],
    unhandledErrors: [],
    reason: 'failed',
    enqueued: 1,
  });
  assert.equal(verdict.failedModules, 1);
  assert.equal(verdict.tests.failed, 1);
  assert.equal(verdict.reason, 'failed');
});

test('unhandled errors are carried as their messages', () => {
  const verdict = summarize({
    testModules: [fakeModule()],
    unhandledErrors: [new Error('boom'), 'a bare string'],
    reason: 'passed',
    enqueued: 1,
  });
  assert.deepEqual(verdict.errors, ['boom', 'a bare string']);
});

test('the reporter writes the verdict to the descriptor it was given', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verdict-test-'));
  const file = path.join(dir, 'verdict.json');
  const fd = openSync(file, 'w');
  try {
    const reporter = new VerdictReporter({ fd });
    reporter.onTestRunStart([{}, {}, {}]);
    reporter.onTestRunEnd([fakeModule(), fakeModule()], [], 'passed');
  } finally {
    closeSync(fd);
  }
  const verdict = readVerdictText(readFileSync(file, 'utf8'));
  assert.equal(verdict.enqueued, 3, 'the enqueued count comes from onTestRunStart');
  assert.equal(verdict.modules, 2, 'only two modules reported back');
  assert.equal(verdict.reason, 'passed');
});

test('a reporter with no usable descriptor neither writes nor throws', () => {
  const reporter = new VerdictReporter({ fd: 9999 });
  reporter.onTestRunStart([{}]);
  assert.doesNotThrow(() => reporter.onTestRunEnd([fakeModule()], [], 'passed'));
});

test('a module that throws while being read does not fail the run', () => {
  const exploding = {
    state: () => 'passed',
    ok: () => true,
    children: { *allTests() { throw new Error('reporter API changed under us'); } },
  };
  const reporter = new VerdictReporter({ fd: 9999 });
  reporter.onTestRunStart([{}]);
  assert.doesNotThrow(() => reporter.onTestRunEnd([exploding], [], 'passed'));
});

test('a verdict with the wrong types is rejected rather than half read', () => {
  assert.equal(readVerdictText('not json at all'), null);
  assert.equal(readVerdictText('{"errors":"oops"}'), null);
  assert.equal(readVerdictText(JSON.stringify({ reason: 'passed', enqueued: 1, modules: 1, failedModules: 0, unfinishedModules: 0, tests: { total: 1, passed: 1, failed: 0, skipped: 0 }, errors: [1] })), null);
  assert.equal(readVerdictText(JSON.stringify({ reason: 'passed', enqueued: 1, modules: 1, failedModules: 0, unfinishedModules: 0, tests: { total: 'many', passed: 1, failed: 0, skipped: 0 }, errors: [] })), null);
});

test('a verdict the reporter really wrote is accepted', () => {
  const written = JSON.stringify(summarize({
    testModules: [fakeModule()],
    unhandledErrors: [],
    reason: 'passed',
    enqueued: 1,
  }));
  assert.notEqual(readVerdictText(written), null);
});

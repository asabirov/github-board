// The decision behind `pnpm test`: what a vitest exit code means (#748).
//
// Everything here is pure, and lives apart from `scripts/run-vitest.mjs` so the
// tests can import it without spawning anything.

// The one message that means "every result was recorded and only the
// acknowledgement was late". Matched whole: birpc appends the real error to this
// same prefix for other calls (`rpc.-pEldfrD.js:48-53`), so
// `Timeout calling "onUnhandledError" with "TypeError: ..."` IS a crash, and
// `fetch`, `transform` and `resolveId` mean a module never loaded.
const FORGIVEN_ERROR = /^\[vitest-worker\]: Timeout calling "onTaskUpdate"$/;

// The child writes its verdict here rather than to a path named in the
// environment, which every test file could read and rewrite.
export const VERDICT_FD = 3;

const MODULE_FINISHED = new Set(['passed', 'skipped']);

export function summarize({ testModules, unhandledErrors, reason, enqueued }) {
  let modules = 0;
  let failedModules = 0;
  let unfinishedModules = 0;
  const tests = { total: 0, passed: 0, failed: 0, skipped: 0 };

  for (const testModule of testModules ?? []) {
    modules += 1;
    const state = testModule.state();
    // `ok()` is true for a module that never finished
    // (`reporters.d.BuRON0I0.d.ts:95-98`), so the state is what says whether the
    // module ran at all.
    if (state === 'failed' || !testModule.ok()) failedModules += 1;
    else if (!MODULE_FINISHED.has(state)) unfinishedModules += 1;

    for (const testCase of testModule.children.allTests()) {
      tests.total += 1;
      const testState = testCase.result().state;
      if (testState === 'passed') tests.passed += 1;
      else if (testState === 'failed') tests.failed += 1;
      else if (testState === 'skipped') tests.skipped += 1;
      // Anything else is `pending`: counted in the total and nowhere else, which
      // is how a lost result shows up.
    }
  }

  const errors = (unhandledErrors ?? []).map((error) => (error && error.message) || String(error));

  return {
    reason: String(reason ?? ''),
    enqueued: enqueued ?? 0,
    modules,
    failedModules,
    unfinishedModules,
    tests,
    errors,
  };
}

function isCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function readVerdictText(text) {
  let verdict;
  try {
    verdict = JSON.parse(text);
  } catch {
    return null;
  }
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return null;
  if (typeof verdict.reason !== 'string') return null;
  if (!['enqueued', 'modules', 'failedModules', 'unfinishedModules'].every((key) => isCount(verdict[key]))) return null;
  const { tests } = verdict;
  if (!tests || typeof tests !== 'object') return null;
  if (!['total', 'passed', 'failed', 'skipped'].every((key) => isCount(tests[key]))) return null;
  if (!Array.isArray(verdict.errors)) return null;
  if (!verdict.errors.every((message) => typeof message === 'string')) return null;
  return verdict;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function classify({ code, signal, spawnError = null, verdict }) {
  if (spawnError) {
    return {
      exitCode: 1,
      line: `board harness: vitest did not start (${spawnError}). Nothing ran.`,
    };
  }

  if (signal) {
    return {
      exitCode: typeof code === 'number' && code !== 0 ? code : 1,
      line: `board harness: vitest was killed by ${signal}, so this run never reported. Failing.`,
    };
  }

  if (code === 0) return { exitCode: 0, line: null };

  // `code` is null when the child could not be run at all. Anything that is not
  // a clean zero has to leave here non-zero.
  const failCode = typeof code === 'number' && code !== 0 ? code : 1;

  if (!verdict) {
    return {
      exitCode: failCode,
      line: `board harness: vitest exited ${failCode} and wrote no readable verdict, so that code stands.`,
    };
  }

  const { total, passed, failed, skipped } = verdict.tests;
  const { enqueued, modules, failedModules, unfinishedModules, errors, reason } = verdict;
  const pendingTests = total - passed - failed - skipped;

  if (failed > 0) {
    return {
      exitCode: failCode,
      line: `board harness: ${failed} of ${total} tests failed. A test failed, not the runner.`,
    };
  }

  if (failedModules > 0) {
    return {
      exitCode: failCode,
      line: `board harness: ${failedModules} of ${modules} test files failed. A test file failed, not the runner.`,
    };
  }

  // Nothing ran at all: a filter that matched no file, or a config that threw.
  if (total === 0 && modules === 0) {
    return {
      exitCode: failCode,
      line: `board harness: vitest exited ${failCode} having run no tests, so that code stands.`,
    };
  }

  // A main process the OS stops scheduling strands whole files: vitest reports
  // `Test Files 8 passed (12)` and every module it did hear from is green. What
  // was never heard from is the only trace, so a run may be forgiven only when
  // every enqueued file reported, every one of them finished, and every test in
  // them reached a result.
  const missing = [];
  if (enqueued > 0 && modules !== enqueued) missing.push(`${modules} of ${enqueued} test files reported`);
  if (enqueued === 0) missing.push('vitest never said how many test files it enqueued');
  if (unfinishedModules > 0) missing.push(`${plural(unfinishedModules, 'test file')} did not finish`);
  if (pendingTests > 0) missing.push(`${plural(pendingTests, 'test')} never finished`);
  if (missing.length > 0) {
    return {
      exitCode: failCode,
      line: `board harness: results are missing from this run (${missing.join(', ')}). vitest exited ${failCode} and that stands.`,
    };
  }

  if (reason !== 'passed') {
    return {
      exitCode: failCode,
      line: `board harness: vitest ended this run as "${reason}" rather than a completed pass, so exit ${failCode} stands.`,
    };
  }

  if (passed === 0) {
    return {
      exitCode: failCode,
      line: `board harness: vitest exited ${failCode} having passed no tests, so that code stands.`,
    };
  }

  if (errors.length === 0) {
    return {
      exitCode: failCode,
      line: `board harness: no test failed and no error was reported, yet vitest exited ${failCode}. That code stands.`,
    };
  }

  if (errors.every((message) => FORGIVEN_ERROR.test(message))) {
    return {
      exitCode: 0,
      line: [
        `board harness: every test passed (${passed} passed, ${skipped} skipped) but vitest exited ${failCode}`,
        `because a worker's RPC to the main process timed out:`,
        ...errors.map((message) => `  ${message}`),
        `That is vitest's own plumbing under load, not your change. See issue #748.`,
        `Treating this run as green.`,
      ].join('\n'),
    };
  }

  return {
    exitCode: failCode,
    line: [
      `board harness: no test failed, but vitest reported ${plural(errors.length, 'unhandled error')}, ` +
        `not the #748 RPC timeout:`,
      ...errors.map((message) => `  ${message}`),
      `Reporting vitest's exit code ${failCode} unchanged.`,
    ].join('\n'),
  };
}

export function buildChildArgs(args, verdictReporter, env = process.env) {
  // `pnpm test -- --reporter=dot` hands the script a literal `--`. vitest's
  // parser files everything after one away and ignores it, so a surviving
  // separator would drop the verdict reporter too, in silence.
  const forwarded = args.filter((arg) => arg !== '--');

  // A `--reporter` on the CLI REPLACES the config's reporters, so adding the
  // verdict reporter alone would silence vitest's own output. Restore what
  // vitest would have chosen, only when the caller chose nothing.
  const callerChoseReporter = forwarded.some((arg) => /^--reporters?(=|$)/.test(arg));
  const restored = [];
  if (!callerChoseReporter) {
    restored.push('--reporter=default');
    // vitest adds this one itself only when no CLI reporter was given
    // (`coverage.DfSpMS-b.js:3855`), and it is what writes the inline
    // `::error file=` annotations that name the failing test on a PR.
    if (env.GITHUB_ACTIONS === 'true') restored.push('--reporter=github-actions');
  }

  return ['run', ...forwarded, ...restored, `--reporter=${verdictReporter}`];
}

export function buildChildEnv(parentEnv) {
  // Spec files run in workers, and workers inherit this. Nothing that names the
  // verdict may travel here — a test that can find the file can write its own
  // verdict.
  const env = { ...parentEnv };
  for (const key of Object.keys(env)) {
    if (/verdict/i.test(key)) delete env[key];
  }
  return env;
}

export function buildStdio(fd) {
  return ['inherit', 'inherit', 'inherit', fd];
}

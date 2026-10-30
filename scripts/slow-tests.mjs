// The report every vitest run ends with: the ten slowest tests, the ten slowest files, and
// anything over budget. The budgets are the org's — 10 seconds for a test that drives a browser, 5
// for any other test, 60 for one file. It only prints, so nothing here can change a run's exit
// code; `scripts/vitest-verdict.mjs` calls it after it has written the verdict the exit code is
// decided from.

import { readFileSync } from 'node:fs';

const BROWSER_BUDGET_MS = 10_000;
const TEST_BUDGET_MS = 5_000;
const FILE_BUDGET_MS = 60_000;
const TOP = 10;

// A browser spec either reaches Chrome through `board-frontend/scripts/browser-harness.mjs` or
// spawns a guard that does, so a file importing one of these three is counted as driving a browser.
// The import and not the bare name, so a file that only mentions one is not counted. It sweeps up
// `mutation-html.spec.mjs`, which tests the mutator and spawns nothing; its tests run in
// milliseconds, so the wider budget changes no row. Read from the file rather than passed in:
// vitest replaces a config's reporters when the command line names one, which `pnpm test` always
// does, so a reporter here gets no options.
const DRIVES_A_BROWSER = /from '\.\/(browser-harness|guard-runner|mutation-html)/;

const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;
const slowestFirst = (a, b) => b.duration - a.duration;
const list = (label, entries) =>
  entries.length === 0
    ? `  ${label}: none\n`
    : `  ${label}\n${entries.map((e) => `    ${seconds(e.duration).padStart(8)}  ${e.name}`).join('\n')}\n`;

function drivesABrowser(moduleId) {
  try {
    return DRIVES_A_BROWSER.test(readFileSync(moduleId, 'utf8'));
  } catch {
    return false;
  }
}

export function reportSlowTests(testModules, write = (text) => process.stdout.write(text)) {
  try {
    const tests = [];
    const files = [];
    for (const testModule of testModules ?? []) {
      // A file's figure is what its tests and hooks took, which is what the file budget is against.
      // Transform, import and environment time are in vitest's own Duration line. A figure that is
      // not a number is left out rather than ending the report, so one odd module costs one row.
      const fileMs = testModule.diagnostic?.()?.duration;
      if (typeof fileMs === 'number') {
        files.push({ name: testModule.relativeModuleId, duration: fileMs, budget: FILE_BUDGET_MS });
      }
      const budget = drivesABrowser(testModule.moduleId) ? BROWSER_BUDGET_MS : TEST_BUDGET_MS;
      for (const testCase of testModule.children.allTests()) {
        const duration = testCase.diagnostic?.()?.duration; // a skipped test has none
        if (typeof duration === 'number') {
          tests.push({ name: `${testModule.relativeModuleId} > ${testCase.fullName}`, duration, budget });
        }
      }
    }
    tests.sort(slowestFirst);
    files.sort(slowestFirst);
    const over = [...tests, ...files].filter((e) => e.duration > e.budget).sort(slowestFirst);
    write(
      `\nslow tests — ${tests.length} tests in ${files.length} files; budget ${seconds(TEST_BUDGET_MS)} a test, ` +
        `${seconds(BROWSER_BUDGET_MS)} a browser test, ${seconds(FILE_BUDGET_MS)} a file\n` +
        list(`the slowest ${Math.min(TOP, tests.length)} tests`, tests.slice(0, TOP)) +
        list(`the slowest ${Math.min(TOP, files.length)} files`, files.slice(0, TOP)) +
        list('over budget', over) +
        'This report never fails the run.\n',
    );
  } catch (error) {
    write(`\nslow tests: no report this run (${error}); the run itself is unaffected.\n`);
  }
}

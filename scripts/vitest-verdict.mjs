// The vitest reporter behind `pnpm test`: it writes the run's verdict to the
// descriptor `scripts/run-vitest.mjs` opened for it (#748). The counts are read
// by `scripts/vitest-classify.mjs`.
//
// `onTestRunEnd` (`reporters.d.BuRON0I0.d.ts:598`) hands back `TestModule`
// objects where the deprecated `onFinished` gives raw tasks (`:580`), and
// `onTestRunStart` (`:594`) is the enqueued count: the only way to notice a
// file that never reported at all.

import { writeSync } from 'node:fs';

import { reportSlowTests } from './slow-tests.mjs';
import { summarize, VERDICT_FD } from './vitest-classify.mjs';

export default class VerdictReporter {
  constructor(options = {}) {
    this.fd = typeof options?.fd === 'number' ? options.fd : VERDICT_FD;
    this.enqueued = 0;
  }

  onTestRunStart(specifications) {
    this.enqueued = (specifications ?? []).length;
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    try {
      const verdict = summarize({ testModules, unhandledErrors, reason, enqueued: this.enqueued });
      writeSync(this.fd, `${JSON.stringify(verdict)}\n`);
    } catch {
      // Unreadable reads as missing, which leaves vitest's exit code standing.
    }
    // After the verdict, never before it: the slowest-tests report prints and
    // nothing more, and this is the one reporter every run here already carries.
    // Wrapped because its own last resort is a write, and a write can fail too.
    try {
      reportSlowTests(testModules);
    } catch {
      // A run is never failed by its report.
    }
  }
}

#!/usr/bin/env node
// Runs vitest and decides the exit code from the results rather than from
// vitest's own status.
//
// The design in one paragraph. vitest is spawned with stdio inherited, so its
// output is untouched and the terminal stays a TTY; nothing here parses stdout.
// The verdict comes back over a fourth file descriptor, written by
// `scripts/vitest-verdict.mjs`, because a path in the environment would be
// readable and writable by every spec file — spec files run in workers, and
// workers inherit the environment. The decision itself is `classify` in
// `scripts/vitest-classify.mjs`, which is pure and tested there.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChildArgs, buildChildEnv, buildStdio, classify, readVerdictText } from './vitest-classify.mjs';

function resolveVitest(cwd) {
  // Each package carries its own vitest; there is no workspace root to hoist to.
  const require = createRequire(path.join(cwd, 'package.json'));
  const manifestPath = require.resolve('vitest/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return path.join(path.dirname(manifestPath), manifest.bin.vitest);
}

// `process.stderr.write` is asynchronous when stderr is a pipe, which is what CI
// gives it, and `process.exit` would drop the line on the way out.
function reportLine(line) {
  const text = `\n${line}\n`;
  try {
    writeSync(2, text);
  } catch {
    process.stderr.write(text);
  }
}

async function main() {
  const cwd = process.cwd();
  const verdictReporter = fileURLToPath(new URL('./vitest-verdict.mjs', import.meta.url));

  let vitestBin;
  try {
    vitestBin = resolveVitest(cwd);
  } catch (error) {
    reportLine(`board harness: no vitest in ${cwd}/node_modules. Run pnpm install here first.\n${error.message}`);
    process.exit(1);
  }

  // The verdict file is unlinked as soon as it is open, so the run carries an
  // anonymous descriptor and no path exists for anything to find, pre-plant or
  // symlink over. The wrapper reads it back through its own fd.
  const verdictDir = mkdtempSync(path.join(os.tmpdir(), 'board-vitest-'));
  const verdictPath = path.join(verdictDir, 'verdict.json');
  const fd = openSync(verdictPath, 'wx+', 0o600);
  rmSync(verdictDir, { recursive: true, force: true });

  const child = spawn(process.execPath, [vitestBin, ...buildChildArgs(process.argv.slice(2), verdictReporter)], {
    cwd,
    stdio: buildStdio(fd),
    env: buildChildEnv(process.env),
  });

  // A CI step timeout sends SIGTERM here. Pass it on rather than dying on top of
  // a still-running vitest.
  const forward = (signal) => () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward(signal));

  const finished = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, spawnError: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal, spawnError: null }));
  });

  let verdict = null;
  try {
    const { size } = fstatSync(fd);
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, 0);
    verdict = readVerdictText(buffer.toString('utf8'));
  } catch {
    verdict = null;
  } finally {
    closeSync(fd);
  }

  const outcome = classify({ ...finished, verdict });
  if (outcome.line) reportLine(outcome.line);
  process.exit(outcome.exitCode);
}

main();

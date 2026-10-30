/**
 * The headless-Chrome-over-CDP machinery both browser guards run on.
 *
 * `check-phone-overflow.mjs` (#508) owned all of this alone until #741 needed a
 * second guard in a real browser — the session notice inside an open area
 * panel, which is a z-order and hit-testing question no `renderToStaticMarkup`
 * can answer. PR #766 answered it by copying ~212 lines of that script, at
 * similarities from 0.81 to 1.00, and was closed partly for it: #762's
 * process-group kill and #735's stdio destroy would have existed in two places
 * to keep in step, and each is a fix nobody re-derives from scratch after it
 * has been lost.
 *
 * So the pieces neither guard's subject is about live here, once: the static +
 * fixture server, finding and starting Chrome, the CDP client, the teardown and
 * the signal handling that reaches it. What stays in a guard is what that guard
 * measures.
 *
 * NO NEW DEPENDENCY, for the reason `check-phone-overflow.mjs`'s own docblock
 * gives: Node's stdlib serves the built `dist/`, and Chrome — already on the CI
 * runner — is driven through Node's built-in `WebSocket`.
 *
 * A THIRD guard belongs here too, and so does a script written for one
 * afternoon: rolling your own `mkdtemp` and `spawn` gets you a fresh copy of
 * every bug this file has already paid for. #813 counted 22 abandoned Chrome
 * profile directories in one `TMPDIR`, 13 of them left by ad-hoc debugging
 * scripts that had none of the cleanup below and are themselves long deleted.
 *
 * Everything here is parameterised on the two things that legitimately differ
 * between the guards and on nothing else: the TOOL NAME every failure line is
 * prefixed with, and the temp-profile prefix. Both are passed explicitly, with
 * no default, because `check-phone-overflow.spec.mjs` asserts on the literal
 * `board-phone-guard-` prefix and a default here would be a second place that
 * decides it.
 */

import { contentSecurityPolicy, cspHeader } from './content-security-policy.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdtemp, rm, stat, writeFile, access } from 'node:fs/promises';
// `rmSync` and not `rm`: the cleanup it serves is called from signal handlers,
// which have to finish in one synchronous run (#762).
import { constants, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** Thrown by `die` and swallowed by the run's own catch, so a deliberate death
 *  is not reported as a crash. */
export class Bail extends Error {}

/**
 * Every failure path ends in the function this returns, so none of them can be
 * mistaken for a pass. The tool name is a parameter rather than a constant
 * because two scripts print through it and a reader needs to know which one
 * spoke.
 */
export function makeDie(tool) {
  return function die(message, detail) {
    console.error(`\n${tool}: ${message}`);
    if (detail) console.error(detail);
    process.exitCode = 1;
    throw new Bail();
  };
}

// ---------------------------------------------------------------- fixture server

/**
 * `dist` is the built SPA to serve; `apiAnswer`, when given, is asked about
 * every `/api/*` request BEFORE the fixture is consulted and answers either
 * `null` (fall through to the fixture, which is what the phone guard gets by
 * passing no hook at all) or `{ status, body }` to reply with. #741's guard
 * needs it: the state it measures is reached by the board's own requests
 * starting to answer 401, which no recorded fixture can express. The hook may be
 * async, and its result is awaited: `scripts/measure-visit-wait.mjs` holds every
 * answer back by a fixed delay so a visit's wait is measured against a network
 * rather than against a loopback fixture server, and a synchronous hook is
 * unaffected because awaiting a plain value passes it straight through.
 *
 * The hook is called `(path, search, method)`. The third argument arrived with
 * `shoot-write-failures.mjs` (#1079), which has to fault one method of a path
 * whose other method draws the form the write is pressed from; every hook
 * written before it takes two arguments and is unaffected.
 */
export async function startServer(fixtures, dist, apiAnswer) {
  /** API routes the page asked for that the fixture has no answer for. Collected
   *  rather than thrown, so one run reports all of them. */
  const missingApi = new Set();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      // The METHOD is passed too (#1079), because a write and the read that
      // draws the form share a path: faulting POST /api/account/tokens on the
      // path alone would fault the GET behind the page and photograph the load
      // failure instead of the write's.
      const forced = apiAnswer ? await apiAnswer(path, url.search, req.method ?? 'GET') : null;
      if (forced) {
        res.writeHead(forced.status, { 'content-type': 'application/json', ...forced.headers });
        // Headers now, body later: the only shape that separates the check a
        // marked response gets on its headers from the one it gets on decode.
        if (forced.bodyDelayMs) {
          res.flushHeaders();
          await new Promise(done => setTimeout(done, forced.bodyDelayMs));
        }
        res.end(JSON.stringify(forced.body === undefined ? {} : forced.body));
        return;
      }
      const hit = fixtures[path + url.search] ?? fixtures[path];
      if (!hit) {
        missingApi.add(path);
        res.writeHead(501, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(hit.status ?? 200, { 'content-type': 'application/json', ...hit.headers });
      res.end(JSON.stringify(hit.body));
      return;
    }

    // Anything under dist that exists is served as-is; everything else is an SPA
    // route and gets index.html, the same as the deployed static host.
    res.setHeader(cspHeader, contentSecurityPolicy());
    const asFile = normalize(join(dist, path));
    const inDist = asFile === dist || asFile.startsWith(dist + '/');
    try {
      if (!inDist) throw new Error('outside dist');
      const body = await readFile(asFile);
      res.writeHead(200, { 'content-type': MIME[extname(asFile)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      try {
        const html = await readFile(join(dist, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end('no dist/index.html');
      }
    }
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  return { server, port: server.address().port, missingApi };
}

// ---------------------------------------------------------------- chrome + CDP

export async function findChrome(die) {
  const named = process.env.CHROME_PATH || process.env.CHROME_BIN;
  if (named) {
    try {
      await access(named, constants.X_OK);
      return named;
    } catch {
      die(
        `CHROME_PATH/CHROME_BIN points at "${named}", which is not an executable file.`,
        'Unset it to fall back to the usual locations, or point it at a real Chrome binary.',
      );
    }
  }
  // The CI runner (ubuntu-latest / Ubuntu 24.04) ships Google Chrome at
  // /usr/bin/google-chrome and exports CHROME_BIN, so the branch above is the one
  // that fires there. These are the local-dev fallbacks.
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch { /* try the next one */ }
  }
  const onPath = await which(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
  if (onPath) return onPath;
  die(
    'no Chrome found, so the page could not be measured in a browser.',
    'Set CHROME_PATH to a Chrome or Chromium binary, or install one. This check never skips:\n' +
      'a guard that excuses itself reads green while guarding nothing.',
  );
}

export function which(names) {
  return new Promise((ok) => {
    const p = spawn('sh', ['-c', names.map((n) => `command -v ${n}`).join(' || ')]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => ok(out.trim().split('\n')[0] || null));
    p.on('error', () => ok(null));
  });
}

/**
 * The live Chrome child process and its temp profile dir, written here AT
 * SPAWN TIME rather than handed back only through `startChrome`'s resolved
 * value: on a rejection, `die` throws before the call site's own assignment
 * ever runs, so a handle that lived only there would be unreachable from the
 * `finally` block of the run — which is the hang in #746.
 */
let spawnedChrome;

/** The file `startChrome` writes at the top of every profile it creates, holding
 *  the pid of the Node process that owns it. It is what lets a later run tell an
 *  abandoned profile from one a concurrent run is still using — twenty lanes
 *  share this machine's `TMPDIR` and each of them may have a guard in flight. */
export const OWNER_FILE = 'board-harness-owner.pid';

/**
 * How old a `board-*-*` directory with NO owner file has to be before the reaper
 * will touch it.
 *
 * Only that case needs an age at all: a profile whose recorded owner is gone is
 * abandoned whatever its mtime says, and is removed at once. The ones with no
 * owner file are the residue of the ad-hoc debugging scripts #813 counted (13 of
 * the 22, under prefixes no committed script has) and of every profile written
 * before this file grew an owner file, and nothing about them says who is using
 * them. Six hours is longer than any guard run this repo has (the longest bound
 * anywhere is 60s) and short enough that a day-old leak is gone by the next run.
 */
export const STALE_PROFILE_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * What a Chrome user-data-dir has in it that an unrelated temp directory does
 * not. Checked before removing an ownerless directory, because `board-*-*` is a
 * wider net than this file's own profiles: `build-icons.mjs` renders into
 * `board-icons-*`, `check-phone-overflow.spec.mjs` copies a whole `dist/` into
 * `board-787-*`, and neither is a Chrome profile. The age bound alone would
 * eventually eat both.
 *
 * Any ONE of these is enough — which of them a given Chrome writes depends on
 * its version and on how far into startup it got before it was killed.
 */
const CHROME_PROFILE_MARKS = [
  'Local State',
  'Default',
  'SingletonLock',
  'DevToolsActivePort',
  'First Run',
];

/** The shell glob #813 counted with, as a regex: `board-`, something, a dash,
 *  something. Both guards' prefixes are inside it and so is every ad-hoc script's. */
const PROFILE_NAME = /^board-.*-.+$/;

/** `true` while the pid is still in the process table. EPERM means it is there
 *  and merely not ours to signal, which is still alive; only ESRCH is gone. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

/** The pid recorded in a profile, or `null` when there is no readable owner file
 *  — which is not the same answer and is not treated as one below. */
async function profileOwner(path) {
  const text = await readFile(join(path, OWNER_FILE), 'utf8').catch(() => null);
  if (text === null) return null;
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Remove the abandoned `board-*-*` profiles sitting in `dir`, and answer with
 * the names of the ones it removed.
 *
 * This is the one hole #762's handlers cannot reach. They run on four signals,
 * on `uncaughtException` and in the run's `finally`, and every one of those is
 * code this process gets to execute; `SIGKILL` is not, and neither is a machine
 * that sleeps and never wakes the run up. #813 counted 22 profiles left in one
 * `TMPDIR` by exactly that. A handler cannot close it, so the NEXT run does:
 * whatever killed the last one, it cannot stop this one from sweeping up after
 * it.
 *
 * Nothing here throws. It is called on the way into `startChrome`, where a
 * rejection would be reported as a Chrome that never started, which is a lie
 * about the guard's subject.
 */
export async function reapStaleProfiles(dir = tmpdir(), now = Date.now()) {
  const reaped = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROFILE_NAME.test(entry.name)) continue;
    const path = join(dir, entry.name);
    const owner = await profileOwner(path);
    // A live owner keeps its profile however old the directory is: a guard run
    // is allowed to take longer than any threshold, and pulling the user-data-dir
    // out from under a running Chrome is a worse failure than a leaked directory.
    if (owner !== null && pidAlive(owner)) continue;
    if (owner === null) {
      const stats = await stat(path).catch(() => null);
      if (!stats || now - stats.mtimeMs < STALE_PROFILE_AGE_MS) continue;
      const inside = await readdir(path).catch(() => []);
      if (!inside.some((name) => CHROME_PROFILE_MARKS.includes(name))) continue;
    }
    // `force` and a catch: two guards starting at once reap the same directory,
    // and the one that loses the race must not care.
    try {
      await rm(path, { recursive: true, force: true });
      reaped.push(entry.name);
    } catch { /* gone already, or never ours to remove */ }
  }
  return reaped;
}

/** `profilePrefix` names the temp directory this run's profile goes in, and has
 *  no default on purpose: `check-phone-overflow.spec.mjs` asserts on the literal
 *  `board-phone-guard-`, and a default here would be a second place deciding it. */
export async function startChrome(binary, profilePrefix, options = {}) {
  // Before this run's own profile exists, so it cannot be a candidate: what is
  // in `TMPDIR` now was left by runs that are already over (#813).
  //
  // Said out loud when it finds anything. A sweep that removes directories in a
  // shared `TMPDIR` and reports nothing is a thing nobody can debug the day it
  // removes one directory too many, and the line is also the cheapest evidence
  // that the leak a reader is looking at came from before this run.
  const reaped = await reapStaleProfiles();
  if (reaped.length) {
    console.error(`browser-harness: reaped ${reaped.length} abandoned Chrome profile(s) in ${tmpdir()}: ${reaped.join(', ')}`);
  }
  const profile = await mkdtemp(join(tmpdir(), profilePrefix));
  // Written the instant it exists, before `spawn()` — a synchronous throw out
  // of `spawn()` (invalid arguments) is narrow but real, and would otherwise
  // leak this directory with nothing recording it.
  spawnedChrome = { profile };
  // And the same thing on disk, for the run AFTER the one that never gets to
  // clean up: `killChrome` removes this directory along with the profile, so a
  // surviving owner file means the process that wrote it did not survive.
  // Best effort — a profile with no owner file is reaped on age instead, and a
  // failure to write one is not a reason to refuse to measure the page.
  await writeFile(join(profile, OWNER_FILE), `${process.pid}\n`).catch(() => {});
  // `detached` puts Chrome in a session of its own, making its pid the leader of
  // a process group its renderer, gpu and zygote children join — which is what
  // gives `killChrome()` below one kill that reaches the whole tree (#762). It
  // calls setsid(2) and NOTHING else: stdio is untouched, so the two pipes
  // configured here are still exactly the ones #735 and #746 are about.
  const child = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    // Hidden by default: a scrollbar's width is a platform's business, and a
    // guard measuring a box it sits beside would read a different number on
    // every OS. `{ scrollbars: true }` is for the one guard whose subject IS a
    // scrollbar (#1113): `measure-board-rail.mjs` reads the rail's bar off the
    // difference between its border box and its content box, and this flag
    // takes that difference to zero on every platform at once, so the guard
    // would pass over a rail drawing nothing.
    ...(options.scrollbars ? [] : ['--hide-scrollbars']),
    // Chromium's own overlay scrollbars, which are what macOS is on by default
    // and what a Linux runner never sees. `{ overlayScrollbars: true }` asks
    // for them so a guard can hold a rule against the path the reporter of
    // #1113 is actually on, rather than against the classic bars CI draws.
    // Newer Chrome defaults this feature to mode/device, which can still draw
    // classic bars on Linux. Force overlay mode; older Chrome ignores the
    // parameter and enables its overlay implementation as before.
    ...(options.overlayScrollbars ? ['--enable-features=OverlayScrollbar:mode/overlay'] : []),
    // NO BACK/FORWARD CACHE (#1419). Three guards here wipe an origin and then
    // reload it. `Storage.clearDataForOrigin` DELETES the IndexedDB database,
    // and a delete waits for every open connection to close first. The document
    // the guard has just navigated away from still holds the app's `idb-keyval`
    // connection, and the back/forward cache KEEPS that document alive instead
    // of destroying it. So the delete waits for a connection that nothing will
    // close, and from that moment every `indexedDB.open` and every
    // `deleteDatabase` of that database queues behind the delete and fires NO
    // event at all. Not success, not error, not blocked. It is origin-wide: a
    // brand new tab sees the same silence on that database, and opens an
    // unrelated database in the same tab without waiting.
    //
    // The renderer itself stays healthy, which is why the only symptom was the
    // next read of the page. An `awaitPromise` `Runtime.evaluate` never came
    // back and timed out after 30 seconds, and that is #1419's reported CI
    // failure. Measured on `check-session-hint.mjs` POSTLOOP_ONLY: 7 of 8 runs
    // hung with the cache on, and 0 of 14 with it off.
    //
    // No guard here navigates back to a cross-document history entry, so the
    // back/forward cache gives them nothing to begin with.
    '--disable-features=BackForwardCache',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  spawnedChrome.child = child;

  let stderr = '';
  const wsUrl = await new Promise((ok, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`Chrome did not report a DevTools endpoint within 30s.\n${stderr}`)),
      30_000,
    );
    child.stderr.on('data', (d) => {
      stderr += d;
      const m = stderr.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(timer); ok(m[0]); }
    });
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`Chrome exited with code ${code} before listening.\n${stderr}`));
    });
  });
  return wsUrl;
}

/**
 * Let go of the browser: the whole process tree, its pipes, and its profile.
 *
 * FULLY SYNCHRONOUS, which is why the profile goes through `rmSync` rather than
 * `await rm(...)`: a caller that awaits can be interrupted before it finishes,
 * and what it would be interrupted before is the removal. Every guard's
 * `cleanup()` calls this from its `finally`, from four signal handlers and from
 * `uncaughtException`, so nothing in here may throw.
 *
 * The ORDER below is the one the comments inside it argue for. It is not
 * incidental and none of them survives a reordering.
 */
export function killChrome() {
  const child = spawnedChrome?.child;
  // THE WHOLE PROCESS GROUP, not the browser's own pid. Chrome's renderer, gpu
  // and zygote children are separate processes that outlive a kill aimed at
  // their parent; `startChrome` spawns `detached`, so they sit in a group
  // Chrome leads and `kill(-pgid)` is this script's only reach on all of them
  // at once (#762).
  //
  // POSIX ONLY. Windows has no process groups to signal this way, so the call
  // throws, the catch swallows it, and the tree leaks there exactly as it did
  // before #762 — the `child.kill()` below is all Windows gets. CI is Linux and
  // this is developed on macOS, so that is a stated limit rather than a
  // regression, and it is the reason this line is a `try` and not an assert.
  //
  // Guarded on a number greater than zero: `child.pid` is
  // `undefined` when the spawn itself failed, and `process.kill(-0, ...)`
  // signals THIS script's own process group — suicide, mid-cleanup.
  if (typeof child?.pid === 'number' && child.pid > 0) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* whole group already gone */ }
  }
  // The cheap fallback for when the group kill above threw: one pid is still
  // better than none.
  try { child?.kill('SIGKILL'); } catch { /* already gone */ }
  // AND LET GO OF ITS STDIO, or this process prints its whole report and then
  // never exits. Chrome's renderer, gpu and zygote children inherit the stdout
  // and stderr pipe this script opened, so killing the browser PARENT does not
  // close the write ends: the two `net.Socket`s wrapping them stay readable, the
  // event loop never drains, and the run hangs after the last line of output with
  // a green report on screen and no exit code. Confirmed by dumping
  // `process._getActiveHandles()` on a hung run — two Sockets, no server, fds 13
  // and 15 — and by this line taking a 420-second timeout down to 65 seconds.
  //
  // It is intermittent, which is worse than always: CI reads the timeout as a
  // failed guard when the page was fine.
  //
  // `detached` did NOT change any of that: it calls setsid(2) and leaves stdio
  // alone, so the pipes are still the ones `stdio: ['ignore','pipe','pipe']`
  // opened and the grandchildren still inherit the write ends.
  try { child?.stdout?.destroy(); child?.stderr?.destroy(); } catch { /* already gone */ }
  if (spawnedChrome?.profile) {
    try { rmSync(spawnedChrome.profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Close a Playwright browser connection and kill its launch-server process.
 *
 * `launchServer()` starts Chrome in a detached process group, just like
 * `startChrome()` above. `connect()` only attaches to that server, so
 * `browser.close()` disconnects and the server must be killed on every run.
 * A close timeout is expected to be recoverable when the group kill succeeds.
 */
export async function closeBrowser(browser, browserServer) {
  if (!browser && !browserServer) return;
  let closeError;
  let timer;
  try {
    if (browser) {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('browser.close() timed out after 5s')), 5_000);
      });
      await Promise.race([browser.close(), timeout]);
    }
  } catch (error) {
    closeError = error;
  } finally {
    clearTimeout(timer);
  }

  const child = browserServer?.process?.();
  let killError;
  if (typeof child?.pid === 'number' && child.pid > 0) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') killError = error;
    }
    // SIGKILL is asynchronous. Wait for the child to report exit before
    // deciding that the group kill failed.
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 1_000)),
      ]);
    }
  }

  let alive = false;
  if (child?.pid > 0) {
    try {
      process.kill(child.pid, 0);
      alive = true;
    } catch (error) {
      if (error.code !== 'ESRCH') {
        alive = true;
        killError ??= error;
      }
    }
  }
  if (killError || alive) {
    throw killError ?? new Error(`Chrome process ${child.pid} survived SIGKILL`);
  }
  if (closeError) console.warn(closeError.message);
}

/**
 * The four signals and the crash handler every guard needs, registered against
 * ITS OWN `cleanup`.
 *
 * Ctrl-C at a terminal reaches a child through the foreground PROCESS GROUP,
 * and `detached` takes Chrome out of it. Under CI and as a background job there
 * is no terminal to deliver that signal in the first place — a `kill` and a job
 * runner reach the script's pid alone — and that is where #762 was reported
 * from. These handlers are what replaces the group, on every one of those, and
 * they exit at the conventional 128+signal.
 *
 * SIGHUP is a closed terminal or a dropped SSH connection, and it needed a
 * handler here both before that change and after it. Measured with a real
 * Chrome, killpg(SIGHUP) at the script's own process group: on the undetached
 * script Chrome IS in that group and does receive the signal — `ps -o pgid=`
 * puts three of its processes on the script's pgid — but it handles SIGHUP
 * itself and goes down slowly and partly, all five still running at +3s and one
 * still at +20s, with the profile directory left behind every time. `detached`
 * puts it out of that group's reach altogether. Neither is a clean shutdown, so
 * what this handler replaces is not a working SIGHUP but the absence of one.
 * SIGQUIT is the same shape from a keyboard \.
 *
 * The crash handler is the other half. A throw from a LISTENER — a socket
 * error, a CDP frame the client did not expect — lands outside the run's try
 * block, so neither its catch nor its finally ever runs and the profile and the
 * browser tree are both left behind. `detached` narrows what can tidy up after
 * that: the surviving tree is in no group anyone else will signal.
 *
 * It prints what the catch block prints and exits NON-ZERO. It exists to clean
 * up after a crash, never to absorb one: a crash that read as a pass would be a
 * guard reporting OK about a page it never measured, which is the failure #762
 * says matters more than the leak.
 */
export function installCleanupHandlers(tool, cleanup) {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
    ['SIGQUIT', 131],
  ]) {
    process.on(signal, () => {
      cleanup();
      process.exit(code);
    });
  }
  process.on('uncaughtException', (e) => {
    console.error(`\n${tool}: crashed`);
    console.error(e);
    cleanup();
    process.exit(1);
  });
}

let cspViolationSeen = false;

/** The smallest CDP client that does the job: one socket, id-matched replies. */
export function cdp(wsUrl, die, onEvent = () => {}) {
  if (typeof WebSocket === 'undefined') {
    die(
      'this Node has no global WebSocket, so CDP cannot be driven without a dependency.',
      'Node 22 or newer is required (CI pins 22; package.json targets the same).',
    );
  }
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  // The last few CDP lines, kept so a timed-out command can say which call was
  // pending and what the page was doing (#1419). A bare "timed out after 30s"
  // cannot tell a blocked renderer from a reply that was never sent, and
  // #1419's first diagnosis was wrong for want of exactly that. The ring is
  // bounded, and it is only read when a command fails.
  const opened = Date.now();
  const trace = [];
  const note = (line) => {
    trace.push(`+${Date.now() - opened}ms ${line}`);
    if (trace.length > 40) trace.shift();
  };
  const ready = new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => fail(new Error(`could not connect to ${wsUrl}`)), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method) {
      note(`event ${msg.method}`);
      onEvent(msg);
    }
    if (msg.method === 'Audits.issueAdded' && msg.params.issue.code === 'ContentSecurityPolicyIssue') {
      const violation = msg.params.issue.details.contentSecurityPolicyIssueDetails;
      console.error('CSP violation:', JSON.stringify(violation));
      process.exitCode = 1;
      if (!cspViolationSeen) {
        cspViolationSeen = true;
        // A caller's later success exit must not erase a browser violation.
        process.once('exit', () => { process.exitCode = 1; });
      }
    }
    const p = pending.get(msg.id);
    if (!p) return;
    note(`reply #${msg.id} ${p.method} after ${Date.now() - p.sentAt}ms${msg.error ? ' ERROR' : ''}`);
    pending.delete(msg.id);
    clearTimeout(p.timer); // an uncleared timer holds the event loop open to its full 30s
    if (msg.error) p.fail(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
    else p.ok(msg.result);
  });
  const client = {
    ready,
    async send(method, params = {}, sessionId) {
      const mid = ++id;
      const result = await new Promise((ok, fail) => {
        const timer = setTimeout(() => {
          if (pending.delete(mid)) fail(new Error([
            `CDP ${method} timed out after 30s`,
            `  params: ${JSON.stringify(params).slice(0, 500)}`,
            `  session: ${sessionId ?? '(browser)'}, id #${mid}`,
            `  still pending: ${[...pending.values()].map((other) => `#${other.id} ${other.method}`).join(', ') || 'none'}`,
            '  last CDP lines:',
            ...trace.map((line) => `    ${line}`),
          ].join('\n')));
        }, 30_000);
        pending.set(mid, { id: mid, ok, fail, timer, method, sentAt: Date.now() });
        note(`send #${mid} ${method}`);
        ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
      if (method === 'Target.attachToTarget') await client.send('Audits.enable', {}, result.sessionId);
      return result;
    },
    close: () => ws.close(),
  };
  return client;
}

/**
 * Call a function in the page with its inputs passed as DATA (#925 CodeQL).
 *
 * `Runtime.callFunctionOn` takes the arguments beside the function rather than
 * inside it, so no value a test is looking for ever becomes part of the program
 * the page runs — which is the only way to hold that line, since escaping a
 * value into source text is the thing nobody gets right. Pass `returnByValue`
 * false for the remote object itself, which is what the accessibility tree and
 * the other object-taking domains want.
 */
export async function callInPage(client, session, fn, args = [], returnByValue = true) {
  const { result: global } = await client.send('Runtime.evaluate', { expression: 'globalThis' }, session);
  const { result, exceptionDetails } = await client.send('Runtime.callFunctionOn', {
    objectId: global.objectId,
    functionDeclaration: String(fn),
    arguments: args.map((value) => ({ value })),
    returnByValue,
    awaitPromise: true,
  }, session);
  if (exceptionDetails) throw evaluationError(exceptionDetails, String(fn));
  return returnByValue ? result.value : result;
}

function evaluationError(details, expression) {
  const exception = details.exception;
  const reason = exception?.description
    ?? (exception && Object.hasOwn(exception, 'value') ? String(exception.value) : details.text);
  return new Error(`Browser evaluation failed: ${reason}\nExpression: ${expression}`);
}

/** Evaluate in the page and bring the value back. A string is an expression; a
 *  `{ fn, args }` pair goes through `callInPage`, so `pollFor` below takes
 *  either without knowing which. Browser exceptions reject with the probe and
 *  exception text; a successful undefined result stays undefined. */
export async function evaluate(client, session, body) {
  if (typeof body !== 'string') return callInPage(client, session, body.fn, body.args);
  const res = await client.send('Runtime.evaluate', { expression: body, returnByValue: true }, session);
  if (res.exceptionDetails) throw evaluationError(res.exceptionDetails, body);
  return res.result.value;
}

/** The CEILING on how long a guard waits for the page it is about to read.
 *
 *  Thirty seconds on a real run, and that is what CI gets. `BOARD_GIVE_UP_MS`
 *  lowers it for the redness proofs, which hide the very element a guard waits
 *  for and then wait out the whole budget to watch it refuse: a dozen guards
 *  doing that cost five minutes of a suite, and none of that time is spent on
 *  anything but a clock. What those proofs assert is the refusal, and the
 *  refusal is the same one at any budget.
 *
 *  A ceiling and not a setting, so a guard that already waits less than thirty
 *  seconds keeps its own number. A value under a tenth of a second is raised to
 *  one: a guard that refuses before the page can answer proves nothing, and
 *  only a test writes this variable at all. */
const testGiveUpMs = process.env.BOARD_TEST_PID ? Number(process.env.BOARD_GIVE_UP_MS) : 30_000;
export const GIVE_UP_MS = Math.max(100, testGiveUpMs || 30_000);

/** A guard's own budget, as rounds of the 250ms poll the hand-written loops
 *  use, with the ceiling above applied. */
export const giveUpRounds = (ms = GIVE_UP_MS) => Math.max(1, Math.round(Math.min(ms, GIVE_UP_MS) / 250));

/** A block renders once its fetch resolves, so poll rather than guess a sleep —
 *  and give up loudly rather than measure a page that never arrived.
 *
 *  `ready` answers `true`, or a SENTENCE saying what is still missing, and that
 *  sentence is what the death at `GIVE_UP_MS` reports. A boolean would do for the
 *  waiting, but not for the message: an expression that found everything it looks
 *  for and is merely holding out for a figure has no `error` to quote, so the
 *  give-up used to read "nothing rendered" over a page that had rendered plenty —
 *  which sends the next reader looking at the selectors rather than at the
 *  fixture. `false` is still accepted and still falls back to that string.
 *
 *  `budgetMs` is a caller's OWN number for one wait, and the ceiling still caps
 *  it: a wait on something the page does in milliseconds has no business holding
 *  a run for thirty seconds before it says so, and a redness proof for that
 *  wait pays the whole of it (#1404). Left out, it is the ceiling, which is
 *  every caller that came before it. A value under a tenth of a second is
 *  raised to one, for the reason the ceiling gives. */
export async function pollFor(client, session, expression, ready, what, hint, die, budgetMs = GIVE_UP_MS) {
  const budget = Math.min(Math.max(100, budgetMs), GIVE_UP_MS);
  const deadline = Date.now() + budget;
  for (;;) {
    const m = await evaluate(client, session, expression);
    const verdict = m && !m.error ? ready(m) : (m?.error ?? 'nothing rendered');
    if (verdict === true) return m;
    if (Date.now() > deadline) {
      // Keep the selector beside a refusal even when the caller's label says
      // only "calendar" or "rows". Source and arguments are local probes.
      const probe = typeof expression === 'string'
        ? expression : `${expression.fn}\nArguments: ${JSON.stringify(expression.args)}`;
      die(`${what} after ${budget / 1000}s: ${typeof verdict === 'string' ? verdict : 'nothing rendered'}.`,
        `${hint}\nProbe: ${probe}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ── Colour arithmetic for a guard that reads `getComputedStyle` ──────────────
// Written for `measure-toggle-plate.mjs` (#1032) and shared from #1112, when
// `measure-light-pins.mjs` needed the same step.

/** `rgb(r, g, b)` / `rgba(...)` / `color(srgb r g b)` -> [r, g, b], or null.
 *  Chrome serializes a `color-mix()` fill, which the public kit's tokens use, as `color(srgb ...)` in 0 to 1. */
export function rgb(colour) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(String(colour));
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const c = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(String(colour));
  return c ? [Number(c[1]) * 255, Number(c[2]) * 255, Number(c[3]) * 255] : null;
}

/** WCAG relative luminance of an sRGB triple. */
export function luminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** The step between two computed colours, 1.000 when they are the same fill. */
export function step(a, b) {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return null;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** `rgb(255, 255, 255)` -> `#ffffff`, for a table a person reads. */
export function colourHex(colour) {
  const c = rgb(colour);
  return c ? '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') : String(colour);
}

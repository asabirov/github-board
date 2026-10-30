#!/usr/bin/env node
/**
 * Expired-session-behind-an-open-panel guard (#741).
 *
 * The bug: a session dies while an area panel (Admin hub, Account, the API
 * reference) is open. The board's own expiry notice lives inside `.shell-main`,
 * which App marks `inert` while a panel is up, under a scrim at z-41 to its
 * z-40 — so the reader watches the panel's content start failing on 401s with
 * nothing on screen saying why, and `document.elementFromPoint` at the Sign in
 * button's centre answers `DIV.area-scrim`. None of that is visible to `pnpm
 * test`: the vitest env is `node` and both DOM shims implement no CSS layout,
 * so z-order, `inert` and hit-testing are questions only a browser answers.
 * This is that browser, with no new dependency — the machinery is
 * `browser-harness.mjs`, shared with `check-phone-overflow.mjs` (#508).
 *
 * WHAT IT ASSERTS, at 1280x800 and again at 390x844:
 *   (a) `.area-panel .session-bar` exists, has a box, and its Sign in button is
 *       the topmost element at its own centre;
 *   (b) that button takes focus — the keyboard half of the same claim;
 *   (c) the panel's own `.area-panel-close` is STILL topmost at its centre.
 *       This is the assertion that fails the other fix that was tried, raising
 *       `.shell-top-alert` above the panel: that lifts the sticky top bar with
 *       it and the <header> lands over the X;
 *   (d) `.shell-main` and `aside.side` both still carry `inert`, so the board
 *       behind has not simply been let back in;
 *   (e) exactly ONE `.session-bar` is in the DOM. Leaving the shell's own copy
 *       in it was measured at 1280 to put a second, VISIBLE Sign in on the
 *       screen — the panel is inset there, so 46px of the shell's 65px bar and
 *       the whole of its button sat in the right gutter, and `elementFromPoint`
 *       at (1222, 32) answered `DIV.area-scrim`, whose handler is `onClose`. A
 *       reader pressing the button at the top of the screen lost their panel.
 *       At 390 the two bars coincide at y=0 and nothing shows, which is why
 *       this is a 1280 finding;
 *   (f) retired with the Feedback form (#1450). It read back a message typed
 *       into that panel's composer, and no account panel now holds free text
 *       outside a modal sheet;
 *   (g) Chrome's own accessibility tree offers exactly one unignored "Sign in"
 *       button and one expiry sentence. See `axCounts` for what that proves and
 *       what it does not. It is NOT what catches (e): measured against a build
 *       with the shell's copy back in the markup, this still reads 1, because
 *       `inert` really does keep that node out of the tree. Two exposed copies
 *       needs `inert` dropped as well, and then (d), (e) and (g) all fire. The
 *       two rules answer different questions — what a reader is offered, and
 *       what a hand can hit — and neither stands in for the other;
 *   (h) closing the panel on a dead session puts the shell's notice back, on
 *       screen and hit-testable. Without it (e) would be satisfied by deleting
 *       the notice outright;
 *   (i) a panel REOPENED on an already dead session lands focus on its X and
 *       not on "Sign in". That state is the only one where the notice is the
 *       panel's first focusable child, and pressing the landing there sets
 *       `window.location.href`.
 *
 * IT NEVER PRESSES THE BUTTON. `onSignIn` is `beginLogin`, which sets
 * `window.location.href` to the Google login route: a press navigates the
 * document away, and every reading taken after it describes a page that is
 * gone. PR #766 was closed partly for asserting through that press.
 *
 * HOW THE STATE IS REACHED: `/api/auth/me` answers from the recorded fixture
 * throughout, so the mount probe succeeds and the board draws rather than the
 * full-screen AuthScreen. The board comes up on a LIVE session; the Preferences
 * panel is opened from the account menu the way a person opens it; and only
 * THEN does every other `/api/*` route start answering 401. A `focus` event
 * dispatched at the page makes the board's own auto-refresh (#375) refetch, the
 * dashboard behind the scrim re-reads, and that 401 is what
 * `src/auth/session-expiry.ts` latches.
 *
 * It refuses to measure until the board says it is expired: every assertion
 * above passes vacuously on a live session, which is the degenerate pass #766
 * was closed for.
 *
 * Usage: pnpm run build && node scripts/check-expired-panel.mjs
 * Env:   CHROME_PATH / CHROME_BIN override the browser binary.
 *        BOARD_DIST points the run at a `dist/` built from another commit,
 *          which is how the before/after reading is taken.
 *        PANEL_GUARD_REPORT=1 (or --report) prints the readings and exits 0
 *          instead of failing — the same script, run the same way, on a build
 *          that has the fix and on one that does not.
 *        PANEL_GUARD_SHOTS=<dir> (or --shots <dir>) writes a PNG of the state
 *          per viewport.
 */

import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureAnswerFault } from './fixture-answers.mjs';
import { expirySentence, panelFaults, reportLines, stillSettling } from './expired-panel-verdict.mjs';
import {
  Bail, cdp, evaluate, findChrome, installCleanupHandlers, killChrome, makeDie,
  pollFor, startChrome, startServer,
} from './browser-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.BOARD_DIST ? resolve(process.env.BOARD_DIST) : resolve(HERE, '..', 'dist');
const FIXTURE = resolve(HERE, 'fixtures', 'team-api.json');
const SESSION_COPY = resolve(HERE, '..', 'src', 'auth', 'session-copy.ts');
const die = makeDie('check-expired-panel');

const flag = (name) => process.argv.includes(`--${name}`);
const flagValue = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
/** Readings without a verdict: the run still has to REACH the state, and still
 *  dies loudly if it cannot, but a state that fails the assertions is printed
 *  rather than failed. That is what makes one script produce both halves of a
 *  before/after against two `BOARD_DIST` builds. */
const REPORT = flag('report') || process.env.PANEL_GUARD_REPORT === '1';
const SHOTS = flagValue('shots') ?? process.env.PANEL_GUARD_SHOTS;

/** Both halves of #741's report. The panel is full-bleed under 900px and inset
 *  above it, and the notice's own row wraps under 560px, so neither width
 *  stands in for the other. */
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

/** How long a click will wait for something moving to stop moving (#797), and
 *  how often it looks. The slide it exists for is `--side-slide-dur`, 0.22s —
 *  this is twenty times that, because the bound is only ever PAID by a page
 *  that is animating without end, and a passing run leaves the loop on its
 *  first or second look. The cadence is fast because each look is one CDP
 *  round trip and the point is to press the moment the box stops: at the
 *  harness's own 250ms poll a 220ms slide would be over for most of an
 *  interval before anything noticed. */
const SETTLE_MS = 5_000;
const SETTLE_POLL_MS = 25;

/** The one route that keeps answering after the session is armed to die, and
 *  the one the run answers itself (see `meLive`). App's mount probe reads it,
 *  and a 401 there is a different bug's state — the full-screen AuthScreen,
 *  with no board and no panel to measure. */
const ALWAYS_LIVE = new Set(['/api/auth/me']);

// ---------------------------------------------------------------- in the page

/** `desc` names what was hit in the shape a failure line quotes, and `at`
 *  is the hit test itself: an element's own centre, and whether the topmost
 *  thing there is that element or something inside it. Written once and spliced
 *  into every expression below, because "reachable" has to mean one thing. */
const HELPERS = `
  const desc = (el) => {
    if (!el) return 'nothing';
    const cls = el.getAttribute && el.getAttribute('class');
    // The first three classes and a count, not the whole list: one @acme/ui
    // Button carries 24 of them, and a failure line nobody reads to the end is
    // a failure line that does not say what was hit.
    const words = cls ? cls.trim().split(/\\s+/) : [];
    const shown = words.slice(0, 3).join('.');
    return el.tagName + (shown ? '.' + shown : '') + (words.length > 3 ? \`(+\${words.length - 3})\` : '');
  };
  /** Every animation that could still be moving what a click has to reach: the
   *  target's own box and subtree, its ancestors, and the chain of boxes the hit
   *  test landed in.
   *
   *  The chain from the HIT is the half #794's palette pass did not need. There
   *  the thing in motion was the dialog being measured, so
   *  \`getAnimations({ subtree: true })\` on it saw everything. Here the box that
   *  covers the phone menu button is neither the target nor a child of it — it
   *  is the sidebar sheet sliding across it — and a subtree read on the button
   *  sees nothing at all. \`document.getAnimations()\` would see it, and would
   *  also hang behind one endless spinner anywhere else on the page. Asking the
   *  chain the hit landed in is the narrow form of the same question: if
   *  something is over this control, either it is moving or it is not.
   *
   *  CSS TRANSITIONS COUNT, and here they are the whole point: \`.side\` slides on
   *  \`transition: transform var(--side-slide-dur)\` (src/app.css) rather than on a
   *  keyframe animation, and \`getAnimations()\` hands back the CSSTransition for
   *  it exactly as it does a CSSAnimation. */
  const settling = (el, found) => {
    const upFrom = (n) => { const out = []; for (; n; n = n.parentElement) out.push(n); return out; };
    const anims = [
      ...el.getAnimations({ subtree: true }),
      ...upFrom(el.parentElement).flatMap((n) => n.getAnimations()),
      ...upFrom(found).flatMap((n) => n.getAnimations()),
    ];
    const named = (a) => {
      const target = a.effect && a.effect.target;
      return (a.transitionProperty || a.animationName || 'an animation') + ' on ' + desc(target || el);
    };
    return [...new Set(anims.filter((a) => a.playState === 'running').map(named))];
  };
  const at = (el) => {
    const b = el.getBoundingClientRect();
    const cx = Math.round(b.left + b.width / 2);
    const cy = Math.round(b.top + b.height / 2);
    const inViewport = cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight;
    const found = inViewport ? document.elementFromPoint(cx, cy) : null;
    return {
      width: b.width, height: b.height, cx, cy, inViewport,
      hit: { desc: desc(found), inside: !!found && (found === el || el.contains(found)) },
      settling: settling(el, found),
    };
  };`;

/** The board is up — `.side-acct` is drawn only once `/api/auth/me` has
 *  answered, so this is also the proof the mount probe succeeded.
 *
 *  That holds because the class belongs to the pressable account block alone.
 *  Since #1229 step 1 the shell goes up BEFORE the probe answers, with a
 *  placeholder row standing in the rail's foot; it wears no class of this
 *  family precisely so this reading stays true, and `ProbeShell.spec.tsx` keeps
 *  it that way (#1233). The `.shell-main` line below is that window: the shell
 *  is up, the account block is not, and this keeps polling rather than pressing
 *  furniture. */
const BOARD = `(() => {
  if (document.querySelector('.side-acct')) return { ready: true };
  if (document.querySelector('.shell-main')) return { ready: false, what: 'the shell is up but the account block has not drawn' };
  return { ready: false, what: 'no .shell-main at all — the page is on the AuthScreen or has not mounted' };
})()`;

/** `menuOpen` is asked by `data-state` rather than by the node's presence:
 *  Radix keeps a closed menu mounted while its exit animation runs, and in a
 *  headless run that animation does not always finish — measured, `data-state`
 *  is `closed` while `animationName` is still `exit` at opacity 1. What this
 *  run needs to know is that the app closed it, so the layer at z-50 is not
 *  something a person is still looking at. */
const OPENING = `({
  panel: !!document.querySelector('.area-panel'),
  expired: !!document.querySelector('.shell-top-alert'),
  menuOpen: !!document.querySelector('[role="menu"][data-state="open"]'),
})`;

/** The whole reading. `expired-panel-verdict.mjs` judges it. */
const MEASURE = `(() => {${HELPERS}
  const bar = document.querySelector('.area-panel .session-bar');
  const btn = bar && bar.querySelector('button');
  const close = document.querySelector('.area-panel-close');
  // The shell's own copy of the notice - the one #741 is a report about. Read
  // and printed, never asserted on: after the fix it is still under the scrim
  // and still inside an inert subtree, which is correct and deliberate. What it
  // gives is the before/after in the issue's own words: DIV.area-scrim.
  const shellBar = [...document.querySelectorAll('.session-bar')].find((b) => !b.closest('.area-panel'));
  const shellBtn = shellBar && shellBar.querySelector('button');
  const inertOf = (sel) => { const el = document.querySelector(sel); return el ? el.hasAttribute('inert') : null; };
  const barBox = bar && bar.getBoundingClientRect();
  let focus = null;
  if (btn) {
    // FOCUSED, NEVER PRESSED (#766): pressing runs beginLogin, which sets
    // window.location.href, and the document this is measuring goes away.
    btn.focus({ preventScroll: true });
    const active = document.activeElement;
    focus = { ok: active === btn || btn.contains(active), activeDesc: desc(active) };
  }
  return {
    sessionExpired: !!document.querySelector('.shell-top-alert'),
    panel: !!document.querySelector('.area-panel'),
    barsOnPage: document.querySelectorAll('.session-bar').length,
    bar: bar ? { width: barBox.width, height: barBox.height } : null,
    signIn: btn ? Object.assign({ label: (btn.textContent || '').trim() }, at(btn)) : null,
    focus,
    close: close ? at(close) : null,
    shellSignIn: shellBtn ? at(shellBtn) : null,
    inert: { shellMain: inertOf('.shell-main'), side: inertOf('aside.side') },
  };
})()`;

/** The page once the panel has been closed on a session that is already dead.
 *  The shell's notice was taken out of the markup while the panel was up, so
 *  this is the other half of that claim: closing puts it back, on screen and
 *  pressable, and the reader is never left with no way in. */
const AFTER_CLOSE = `(() => {${HELPERS}
  const bar = document.querySelector('.session-bar');
  const btn = bar && bar.querySelector('button');
  return {
    bars: document.querySelectorAll('.session-bar').length,
    inPanel: !!document.querySelector('.area-panel .session-bar'),
    signIn: btn ? Object.assign({ label: (btn.textContent || '').trim() }, at(btn)) : null,
  };
})()`;

/** Where the panel PUT the reader when it opened. Asked on a reopen, because
 *  that is the only way to open a panel with the notice already inside it. */
const LANDING = `(() => {${HELPERS}
  const a = document.activeElement;
  const closest = (sel) => !!a && !!a.closest && !!a.closest(sel);
  return {
    desc: desc(a),
    label: a ? (a.getAttribute('aria-label') || (a.textContent || '').trim().slice(0, 40)) : null,
    inPanel: closest('.area-panel'),
    onClose: closest('.area-panel-close'),
    onSignIn: closest('.session-bar'),
  };
})()`;

/** Where an element is, and whether anything is over it — asked before every
 *  click, so a click that would land on a scrim is a named failure rather than
 *  a poll that times out somewhere else. */
const locate = (find) => `(() => {${HELPERS}
  const el = ${find};
  if (!el) return { error: 'not on the page' };
  return Object.assign({ desc: desc(el) }, at(el));
})()`;

// ---------------------------------------------------------------- run

let server;
let client;
let cleanedUp = false;

/** Called from the `finally` below and from every handler installed beside it.
 *  Synchronous throughout, and the server closes LAST — it does not drop open
 *  connections, so it only resolves once Chrome's sockets are gone (#735). */
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { client?.close(); } catch { /* already gone */ }
  killChrome();
  try { server?.close(); } catch { /* already gone */ }
}
installCleanupHandlers('check-expired-panel', cleanup);

/** A real mouse at an element's centre. Radix opens the account menu on
 *  pointerdown and selects a row on pointerup, and CDP input is what produces
 *  either — a synthetic `el.click()` produces neither and would silently do
 *  nothing. */
async function clickCentre(client, session, find, what) {
  let box = await evaluate(client, session, locate(find));
  // A HIT TEST TAKEN MID-SLIDE IS NOT A HIT TEST (#797).
  //
  // Below 900px the sidebar is a sheet on `transition: transform
  // var(--side-slide-dur), visibility 0s var(--side-slide-dur)` (src/app.css):
  // the transform runs for 220ms and the `visibility: hidden` that finally
  // takes the rail out of the hit test is held back until it ends, deliberately
  // and for #608's reasons. So for those 220ms after the sheet is dismissed the
  // rail is still drawn across the top bar, and `elementFromPoint` at the phone
  // menu button's centre answers the lit nav item — `BUTTON.side-item
  // .side-item-on`, which is the sentence #797 reports verbatim. This run opens
  // the panel TWICE and the second `openPanel()` reaches for that button
  // inside the window. One reader met it four times in ten; eighteen runs
  // elsewhere, twelve of them with two Chromes racing, met it none.
  //
  // A longer sleep is the same bug with a bigger number, so this waits on the
  // animation itself. And it only ever waits while something relevant IS
  // running: a control genuinely covered by a box at rest still fails on the
  // first reading, with the same sentence and at the same speed as before.
  const deadline = Date.now() + SETTLE_MS;
  while (stillSettling(box)) {
    if (Date.now() > deadline) {
      die(
        `${what} never settled: ${box.settling.join(', ')} still running after ${SETTLE_MS}ms, and ` +
          (box.inViewport
            ? `the point is still covered by ${box.hit.desc}.`
            : `it is still outside the viewport at (${box.cx}, ${box.cy}).`),
        'This is not the #797 race, which clears in a fifth of a second. Something over the control\n' +
          'this run has to press is animating without end, or a transition that never completes is\n' +
          'holding a box where it does not belong.',
      );
    }
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    box = await evaluate(client, session, locate(find));
  }
  if (!box || box.error) die(`${what} is ${box?.error ?? 'unreadable'}, so this run cannot reach the state it measures.`);
  if (!box.inViewport) die(`${what} sits at (${box.cx}, ${box.cy}), outside the viewport.`);
  if (!box.hit.inside) die(`${what} is covered by ${box.hit.desc}, so the click would land on that instead.`);
  const xy = { x: box.cx, y: box.cy };
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...xy, button: 'none' }, session);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...xy, button: 'left', clickCount: 1 }, session);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...xy, button: 'left', clickCount: 1 }, session);
}

/**
 * What the accessibility tree — the thing a screen reader is actually handed —
 * holds at this state. Chrome's own tree, over CDP, so it costs no jsdom, no
 * axe and no new dependency: `Accessibility.getFullAXTree` is one call on the
 * client `cdp()` already returns.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It proves Chrome does not EXPOSE a
 * second notice — the only claim a browser can make. It is not a screen reader,
 * so "no reader announces it twice" stays unproven and stays unclaimed; that
 * one needs VoiceOver or NVDA and a person listening. The gap is narrower than
 * "we could not check": an `ignored: false` node here is a node every reader is
 * offered.
 */
async function axCounts(client, sessionId, expiry) {
  await client.send('Accessibility.enable', {}, sessionId);
  const { nodes } = await client.send('Accessibility.getFullAXTree', {}, sessionId);
  const named = (n) => (n.name?.value ?? '').trim();
  const role = (n) => n.role?.value ?? '';
  const live = nodes.filter((n) => !n.ignored);
  return {
    nodes: nodes.length,
    live: live.length,
    // The button by role AND name: `Sign in` is the only control the notice
    // carries, so two of these is two notices offered to a reader.
    signIn: live.filter((n) => role(n) === 'button' && named(n) === 'Sign in').length,
    // The sentence itself, as a text run. Counted on StaticText alone — the
    // alert's own computed name repeats its contents, and counting that too
    // would report 2 for one notice.
    expiry: live.filter((n) => role(n) === 'StaticText' && named(n) === expiry).length,
  };
}

try {
  await access(join(DIST, 'index.html')).catch(() =>
    die(
      `no index.html in ${DIST} — build first.`,
      'Run `pnpm run build` in board-frontend, then re-run this check.\n' +
        'If that path is not board-frontend/dist, this run is reading a BOARD_DIST copy that does\n' +
        'not hold a build.',
    ),
  );
  const fixtures = JSON.parse(await readFile(FIXTURE, 'utf8'));

  // BEFORE CHROME (#735): an entry stored as its bare payload keeps its key, so
  // the server never records it as missing and never sends the 501 that would
  // fail this run — it answers 200 with a zero-length body, the block renders
  // its nothing-yet state, and a guard reads that as a legitimate empty API.
  const answerFault = fixtureAnswerFault(fixtures);
  if (answerFault) die(answerFault.message, answerFault.detail);

  // The sentence the AX rule counts, out of the app's own source. A copy here
  // would be a second place to keep in step, green after a reword and asserting
  // on a sentence nobody ships.
  const expiry = expirySentence(await readFile(SESSION_COPY, 'utf8'));
  if (!expiry) {
    die(
      `no SESSION_ENDED_TITLE to read out of ${SESSION_COPY}.`,
      'That constant is what the notice says and what the accessibility rule counts. Renamed or\n' +
        'reshaped, this run stops rather than counting nodes that match `undefined` and failing for\n' +
        'the wrong reason.',
    );
  }

  /**
   * `/api/auth/me` as recorded. It is the one route that stays live after the
   * 401s are armed, so the mount probe keeps succeeding.
   */
  const recordedMe = fixtures['/api/auth/me']?.body;
  if (!recordedMe || typeof recordedMe !== 'object') {
    die(
      'scripts/fixtures/team-api.json carries no /api/auth/me body to answer the mount probe with.',
      'Without it the board never draws — the page stops at the full-screen AuthScreen and there is\n' +
        'no panel to measure. Re-record the fixture against a fixture-mode board-service.',
    );
  }
  const meLive = { status: 200, body: recordedMe };

  /** Armed once the panel is open, and the whole mechanism by which the
   *  session dies: `apiFetch` calls `notifySessionExpired()` on any 401. */
  let armed = false;
  const started = await startServer(
    fixtures, DIST,
    (path) => {
      if (ALWAYS_LIVE.has(path)) return meLive;
      return armed ? { status: 401, body: { message: 'session expired' } } : null;
    },
  ).catch((e) => die('the fixture server did not start.', String(e)));
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;

  const binary = await findChrome(die);
  const wsUrl = await startChrome(binary, 'board-panel-guard-').catch((e) => die('Chrome did not start.', String(e)));
  console.log(`chrome:  ${binary}`);
  console.log(`serving: ${origin}  (${DIST}${process.env.BOARD_DIST ? '  <- BOARD_DIST' : ''} + scripts/fixtures/team-api.json)`);
  if (SHOTS) await mkdir(SHOTS, { recursive: true });

  client = cdp(wsUrl, die);
  await client.ready.catch((e) => die('could not attach to Chrome over CDP.', String(e)));

  const failures = [];
  for (const v of VIEWPORTS) {
    const where = `${v.width}x${v.height}`;
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.width < 900,
    }, sessionId);
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);

    armed = false;
    await client.send('Page.navigate', { url: origin + '/' }, sessionId);
    await pollFor(
      client, sessionId, BOARD, (m) => m.ready || m.what,
      `the board never came up at ${where}`,
      'Every /api/* route is answering from the recorded fixture at this point, so this is the page\n' +
        'failing to mount rather than a session state. Check scripts/fixtures/team-api.json still\n' +
        'answers /api/auth/me, and that dist/ holds a real build.',
      die,
    );

    // The session must still be LIVE here, or the panel is opened onto a state
    // that was already dead and this run is telling a story that did not happen.
    const beforeOpen = await evaluate(client, sessionId, OPENING);
    if (beforeOpen.expired) {
      die(
        `the board at ${where} was already expired before the panel was opened.`,
        'Nothing is answering 401 yet at this point — every /api/* route is still the recorded\n' +
          'fixture. So this is not a session state at all; something else on the board decided it\n' +
          'was expired, and what this run would have measured is not the state #741 describes.',
      );
    }

    /** Opened the way a person opens it. Below 900px the sidebar is a sheet
     *  parked off-canvas, so the top bar's menu button comes first. Written
     *  once because this run opens the panel TWICE — the second time on a
     *  session that is already dead, which is the only way to see where the
     *  panel puts a reader when the notice is inside it from the first frame. */
    const openPanel = async () => {
      if (v.width <= 900) {
        await clickCentre(client, sessionId, "document.querySelector('button[aria-controls=\"shell-menu\"]')", 'the phone menu button');
        await pollFor(
          client, sessionId, locate("document.querySelector('.side-acct')"),
          (m) => m.inViewport || 'the sidebar sheet has not slid in',
          `the sidebar sheet never opened at ${where}`, null, die,
        );
      }
      await clickCentre(client, sessionId, "document.querySelector('.side-acct')", 'the account block in the sidebar');
      await pollFor(
        client, sessionId, "({ items: [...document.querySelectorAll('[role=\"menuitem\"]')].map((e) => e.textContent.trim()) })",
        (m) => m.items.includes('Preferences') || `the account menu holds ${JSON.stringify(m.items)}`,
        `the account menu never offered Preferences at ${where}`,
        'src/SideAccount.tsx is what draws these rows.', die,
      );
      await clickCentre(
        client, sessionId,
        "[...document.querySelectorAll('[role=\"menuitem\"]')].find((e) => e.textContent.trim() === 'Preferences')",
        'the Preferences row of the account menu',
      );
      await pollFor(
        client, sessionId, OPENING,
        (m) => (!m.panel ? 'no .area-panel yet' : m.menuOpen ? 'the account menu is still open over it' : true),
        `the Preferences panel never opened at ${where}`, null, die,
      );
    };

    // The panel first, and only then the expiry — in that order, because that
    // is the order #741 is about: the panel is open, and the session dies
    // underneath it.
    await openPanel();

    // NOW the session is allowed to die. `armed` flips every /api/* route
    // except /api/auth/me to 401, and the board's own focus refetch (#375) is
    // what asks: `softRefresh` bumps the refresh nonce, the dashboard behind
    // the scrim re-reads, and that 401 is what `src/auth/session-expiry.ts` latches.
    // Dispatched rather than waited for — the periodic poll is 120s.
    armed = true;
    const seen = await evaluate(client, sessionId, "(() => { window.dispatchEvent(new Event('focus')); return { visibility: document.visibilityState }; })()");
    if (seen.visibility !== 'visible') {
      die(
        `the page at ${where} reports document.visibilityState === '${seen.visibility}'.`,
        'The focus refetch is gated on visibility (src/sync/auto-refresh.ts), so the event just\n' +
          'dispatched was a no-op and the wait below would time out saying the session is still live.\n' +
          'Said here instead, because that message would send the next reader to the wrong file.',
      );
    }
    await pollFor(
      client, sessionId, OPENING,
      (m) => (!m.panel ? 'the panel closed again' : m.expired || 'the session is still live'),
      `the session never expired behind the open panel at ${where}`,
      'Every /api/* route except /api/auth/me is answering 401 by now, and a focus event has been\n' +
        'dispatched at the page to make the board refetch. If this timed out, either the focus\n' +
        'refetch stopped firing (src/sync/sync-status.tsx, throttled at 30s from the LAST refresh —\n' +
        'nothing has refreshed yet in this run, so it should pass) or src/auth/session-expiry.ts\n' +
        'stopped latching. Until it says expired there is nothing here worth asserting.',
      die,
    );

    // The picture BEFORE the reading: the reading focuses the Sign in button,
    // and a focus ring nobody put there is not the state a person is in.
    if (SHOTS) {
      const shot = join(SHOTS, `expired-panel-${where}.png`);
      // Twice, and the first one thrown away: a headless page composites only
      // when something asks it to, and the account menu's exit animation is
      // mid-flight when the panel opens. One capture advances it; the second is
      // the picture of the state rather than of the animation leaving it.
      await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await new Promise((r) => setTimeout(r, 400));
      const { data } = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(shot, Buffer.from(data, 'base64'));
      console.log(`\n${where} — screenshot ${shot}`);
    } else {
      console.log(`\n${where}`);
    }

    // The AX tree BEFORE the DOM reading: `MEASURE` focuses the Sign in button,
    // and focus is a thing the tree reports.
    const ax = await axCounts(client, sessionId, expiry);
    const reading = Object.assign(await evaluate(client, sessionId, MEASURE), { ax });

    // ── the other two states the fix is answerable for ──────────────────────
    //
    // CLOSED, still expired: the shell's notice was taken out of the markup
    // while the panel was up, so the claim it has to make good is that closing
    // puts it back — a reader who shuts the panel is not left with a dead board
    // and nothing saying why.
    //
    // REOPENED, still expired: the only way to open a panel with the notice
    // inside it from the first frame, and the state where the mount landing was
    // wrong. The notice is the panel's first focusable child, so a landing that
    // asks the panel for its first control lands on "Sign in" — and pressing
    // that sets `window.location.href`. A habitual Enter after opening left the
    // document. The X is what the landing has to be, in both session states.
    await clickCentre(client, sessionId, "document.querySelector('.area-panel-close')", "the panel's close control");
    await pollFor(
      client, sessionId, OPENING, (m) => !m.panel || 'the panel is still open',
      `the panel never closed at ${where}`,
      'The X was clicked and nothing came of it. Everything below is about the states either side\n' +
        'of that press, so this run stops rather than measuring the same open panel twice.',
      die,
    );
    reading.afterClose = await evaluate(client, sessionId, AFTER_CLOSE);
    await openPanel();
    reading.landing = await pollFor(
      client, sessionId, LANDING, (m) => m.inPanel || `focus is on ${m.desc}, outside the panel`,
      `the reopened panel never took focus at ${where}`,
      'The mount effect focuses twice — once on mount and once on the next frame, because the\n' +
        'account menu unmounts in between and blurs what it had. If focus never arrives inside the\n' +
        'panel at all, that is src/area-panel/AreaPanel.tsx and not a landing question.',
      die,
    );

    for (const line of reportLines(reading)) console.log(line);
    for (const fault of panelFaults(reading)) failures.push(`${where}: ${fault}`);

    await client.send('Target.closeTarget', { targetId });
  }

  if (started.missingApi.size > 0) {
    die(
      'the pages asked for API routes the fixture cannot answer while the session was still live.',
      `Missing: ${[...started.missingApi].join(', ')}\n` +
        'Re-record scripts/fixtures/team-api.json against a fixture-mode board-service.',
    );
  }

  if (failures.length === 0) {
    console.log(`\ncheck-expired-panel: OK — the notice, its button and the panel's X are all reachable at ${VIEWPORTS.map((v) => `${v.width}x${v.height}`).join(' and ')}.`);
  } else if (REPORT) {
    console.log('\ncheck-expired-panel: readings only (--report), so these are not failing the run:');
    for (const f of failures) console.log(`  - ${f}`);
  } else {
    console.error('\ncheck-expired-panel: FAILED');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nThis is #741: with a panel open, the shell\'s own expiry notice is inside `.shell-main`,\n' +
        'which is `inert` and sits under the scrim, so the reader is told nothing and can reach\n' +
        'nothing. The notice has to be drawn INSIDE the panel — a descendant of it is over the\n' +
        'scrim and inside the focus wrap by construction, with no z-index for anyone to keep in\n' +
        'step. Raising `.shell-top-alert` over the panel instead lifts the top bar with it, and\n' +
        'the <header> lands on the panel\'s X: assertion (c) above is what says so.',
    );
    process.exitCode = 1;
  }
} catch (e) {
  if (!(e instanceof Bail)) {
    console.error('\ncheck-expired-panel: crashed');
    console.error(e);
    process.exitCode = 1;
  }
} finally {
  cleanup();
}

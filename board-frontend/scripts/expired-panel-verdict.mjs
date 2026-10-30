/**
 * What a reading of the expired-session-with-a-panel-open state has to say for
 * the state to pass (#741), separated from the browser that takes it.
 *
 * Separate for the reason `fixture-answers.mjs` and `day-grid-expectation.mjs`
 * are separate: importing the guard starts a server and a browser, and this is
 * the part a unit test can reach. It is also the only definition of "this
 * reading passes" — the guard prints and the spec asserts through the same
 * function, so neither can drift from the other.
 *
 * THE READING IS THE SUBJECT, not the page. `readPanel` in the guard collects
 * one plain object per viewport; every judgement about it is made here.
 */

/** The state the whole measurement is about. A reading taken against a LIVE
 *  session says nothing at all — every assertion below would pass on a board
 *  that never expired, over a bar the code draws in that state anyway — and
 *  that is the degenerate pass PR #766 was closed for. So it is a fault, not a
 *  precondition somebody remembered to check. */
const NOT_EXPIRED =
  'the board never reached the expired session state, so nothing below was measured against the '
  + 'state #741 is about: a reading taken on a live session passes over a bar nobody needed';

/**
 * Every sentence wrong with one reading, in the order a reader wants them.
 * Empty means the state holds.
 *
 * A missing element is reported once and its dependent checks are skipped, so a
 * panel that never opened reads as one line rather than seven.
 */
export function panelFaults(r) {
  const bad = [];
  if (!r || r.error) return [r?.error ?? 'the page answered nothing at all'];

  if (!r.panel) bad.push('no `.area-panel` on the page — the panel was not open when this was measured');
  if (!r.sessionExpired) bad.push(NOT_EXPIRED);

  // (a) the notice is drawn INSIDE the open panel, with a box and a reachable
  // button. `.session-bar` alone is not the claim: the shell draws one of those
  // behind the scrim, which is the bug.
  if (!r.bar) {
    bad.push(
      'no `.area-panel .session-bar` — the expiry notice is not inside the open panel, so the only '
      + 'copy of it is the shell\'s, behind the scrim and inside an `inert` subtree',
    );
  } else if (!(r.bar.width > 0 && r.bar.height > 0)) {
    bad.push(`the notice inside the panel has a zero box (${r.bar.width}x${r.bar.height})`);
  }

  if (r.bar) {
    if (!r.signIn) bad.push('the notice inside the panel draws no button, so it holds no way back');
    else bad.push(...hitFaults(r.signIn, 'the panel notice\'s "' + r.signIn.label + '" button'));
  }

  // (b) the keyboard half. Focus is asserted rather than pressed, deliberately:
  // pressing runs `beginLogin`, which sets `window.location.href`, and anything
  // reported after that navigation is about a document that has gone.
  if (r.signIn && r.focus && !r.focus.ok) {
    bad.push(
      `the "${r.signIn.label}" button inside the panel cannot take focus — after \`.focus()\` the `
      + `active element is ${r.focus.activeDesc}`,
    );
  }

  // (c) the panel's own way out, still reachable. This is what kills the
  // "raise `.shell-top-alert` to 43" fix: that lifts the sticky top bar with
  // the notice, and the <header> lands over the X.
  if (!r.close) bad.push('no `.area-panel-close` — the panel has no close control to reach');
  else bad.push(...hitFaults(r.close, "the panel's own close control"));

  // (d) the board behind stays out of reach. A notice reachable because the
  // panel stopped being modal is not the fix.
  for (const [what, selector] of [['shellMain', '`.shell-main`'], ['side', '`aside.side`']]) {
    if (r.inert?.[what] === null || r.inert?.[what] === undefined) {
      bad.push(`${selector} is not on the page, so this run cannot say whether the board behind is reachable`);
    } else if (r.inert[what] !== true) {
      bad.push(`${selector} lost its \`inert\` while the panel is open — the board behind is reachable again`);
    }
  }

  // (e) ONE notice in the DOM, not two (#741 review). The shell's own copy used
  // to stay in the markup behind the panel, on the argument that `inert` and the
  // scrim made it harmless. `inert` keeps it out of the accessibility tree; it
  // does not take it off the glass. Measured in Chrome at 1280, where the panel
  // is inset: 46px of the shell's 65px bar was on screen and the WHOLE of its
  // Sign in button sat in the right gutter at (1222, 32), outside the panel and
  // plainly pressable — and `elementFromPoint` there answered `DIV.area-scrim`,
  // whose handler is `onClose`. So a reader saw two Sign in buttons, pressed the
  // one at the top of the screen, and lost the panel. The count is the rule
  // because the count is the claim: while a panel is open there is one notice.
  if (r.panel && r.barsOnPage > 1) {
    bad.push(
      `${r.barsOnPage} \`.session-bar\` blocks are in the DOM with the panel open — the shell's own copy `
      + 'is still drawn behind it, and at 1280 its Sign in button shows in the gutter beside the inset '
      + 'panel, where pressing it lands on `.area-scrim` and CLOSES the panel',
    );
  } else if (r.panel && r.shellSignIn) {
    bad.push(
      'a Sign in button outside `.area-panel` is on the page with the panel open, at '
      + `(${r.shellSignIn.cx}, ${r.shellSignIn.cy}) — the shell draws its notice only while no panel is up`,
    );
  }

  // (f) retired with the Feedback form (#1450). See the guard's header.

  // (g) what a screen reader is offered. Chrome's own accessibility tree, which
  // is as far as a browser can take this: it says the second notice is not
  // EXPOSED, not that no reader announces it. See `axCounts` in the guard.
  if (r.ax) {
    if (r.ax.signIn !== 1) {
      bad.push(
        `the accessibility tree offers ${r.ax.signIn} unignored "Sign in" buttons, not 1 — a reader is `
        + 'handed the wrong number of ways back',
      );
    }
    if (r.ax.expiry !== 1) {
      bad.push(
        `the accessibility tree holds ${r.ax.expiry} unignored copies of the expiry sentence, not 1`,
      );
    }
  }

  // (h) the way back survives closing the panel. The shell's notice is out of
  // the markup only while a panel is up (e), so this is the other half of that
  // claim: shut the panel on a dead session and the bar is back, on screen and
  // pressable. Without it, (e) would be satisfied by deleting the notice.
  if (r.afterClose) {
    if (r.afterClose.bars !== 1) {
      bad.push(
        `${r.afterClose.bars} \`.session-bar\` blocks on the page once the panel is closed, not 1 — `
        + 'the shell\'s notice does not come back when the panel goes',
      );
    } else if (r.afterClose.inPanel) {
      bad.push('the only notice left after closing the panel is still inside a panel, so the panel did not close');
    } else if (!r.afterClose.signIn) {
      bad.push('the notice that came back when the panel closed draws no button, so it holds no way back');
    } else {
      bad.push(...hitFaults(r.afterClose.signIn, 'the shell notice\'s "' + r.afterClose.signIn.label + '" button after the panel closed'));
    }
  }

  // (i) where the panel PUTS a reader who opens it on an already dead session.
  // The notice is the panel's first focusable child, so a mount landing that
  // asks the panel for its first control lands on "Sign in" — and `onSignIn` is
  // `beginLogin`, which sets `window.location.href`. A habitual Enter straight
  // after opening then leaves the document for Google, from a panel the reader
  // has not read a word of. The landing is the X, in every session state.
  if (r.landing) {
    if (!r.landing.inPanel) {
      bad.push(`the reopened panel left focus on ${r.landing.desc}, outside the panel entirely`);
    } else if (r.landing.onSignIn) {
      bad.push(
        'the reopened panel landed focus on the notice\'s Sign in button — Enter there leaves the '
        + 'document for the login route, so the panel opens with the way OUT under the reader\'s hand',
      );
    } else if (!r.landing.onClose) {
      bad.push(
        `the reopened panel landed focus on ${r.landing.desc} (${JSON.stringify(r.landing.label)}) rather `
        + 'than its close control',
      );
    }
  }

  return bad;
}

/** Is this element the topmost thing at its own centre? The one question both
 *  (a) and (c) ask, of two different elements, so it is written once. */
function hitFaults(el, what) {
  const bad = [];
  if (!(el.width > 0 && el.height > 0)) {
    bad.push(`${what} has a zero box (${el.width}x${el.height}), so there is nothing to press`);
    return bad;
  }
  if (!el.inViewport) {
    bad.push(
      `${what} has its centre at (${el.cx}, ${el.cy}), outside the viewport — a control off the screen `
      + 'cannot be hit-tested and cannot be pressed either',
    );
    return bad;
  }
  if (!el.hit.inside) {
    bad.push(
      `${what} is covered: \`document.elementFromPoint(${el.cx}, ${el.cy})\` answers ${el.hit.desc}, `
      + 'not that button or a descendant of it',
    );
  }
  return bad;
}

/** The readings themselves, as lines. Printed on every run, pass or fail: this
 *  script is a measuring instrument before it is a gate, and a run against a
 *  `BOARD_DIST` built from another commit is how the before/after is taken. */
export function reportLines(r) {
  if (!r || r.error) return [`  reading failed: ${r?.error ?? 'nothing at all'}`];
  const box = (e) => (e ? `${e.width.toFixed(2)}x${e.height.toFixed(2)} at (${e.cx}, ${e.cy})` : 'absent');
  // The shell's own copy is READ, never judged: it is under the scrim and
  // inside an `inert` subtree both before the fix and after it, and that is
  // correct — what changes is that a second copy exists where the reader is
  // looking. It is here because it is the sentence #741 was reported in.

  const hit = (e) => (e ? `${e.hit.desc}${e.hit.inside ? '' : '  <- NOT the control'}` : '—');
  return [
    `  session expired:        ${r.sessionExpired}`,
    `  .area-panel open:       ${r.panel}`,
    `  .session-bar on page:   ${r.barsOnPage}`,
    `  .area-panel .session-bar: ${r.bar ? `${r.bar.width.toFixed(2)}x${r.bar.height.toFixed(2)}` : 'absent'}`,
    `  sign-in button:         ${box(r.signIn)}`,
    `  elementFromPoint there: ${hit(r.signIn)}`,
    `  takes focus:            ${r.focus ? r.focus.ok : '—'}  (active: ${r.focus?.activeDesc ?? '—'})`,
    `  .area-panel-close:      ${box(r.close)}`,
    `  elementFromPoint there: ${hit(r.close)}`,
    `  the shell's own copy:   ${box(r.shellSignIn)}`,
    `  elementFromPoint there: ${r.shellSignIn ? r.shellSignIn.hit.desc + (r.shellSignIn.hit.inside ? '' : '  (covered — the #741 report)') : '—'}`,
    `  .shell-main inert:      ${r.inert?.shellMain}`,
    `  aside.side inert:       ${r.inert?.side}`,
    `  AX "Sign in" buttons:   ${r.ax ? r.ax.signIn : '—'}  (unignored, of ${r.ax?.nodes ?? '—'} nodes)`,
    `  AX expiry sentences:    ${r.ax ? r.ax.expiry : '—'}`,
    `  closed again — bars:    ${r.afterClose ? r.afterClose.bars : '—'}, sign-in ${box(r.afterClose?.signIn)}`,
    `  elementFromPoint there: ${hit(r.afterClose?.signIn)}`,
    `  reopened — focus on:    ${r.landing ? `${r.landing.desc} ${JSON.stringify(r.landing.label)}` : '—'}`,
  ];
}

/**
 * The expiry sentence, taken out of the app's own source rather than copied
 * here. `src/auth/session-copy.ts` is where that wording is decided, and a
 * second copy in a guard is a second place to keep in step — one that stays
 * green after a reword while asserting on a sentence nobody ships.
 *
 * Returns null when the constant has gone or changed shape, which the guard
 * reports rather than working around: an AX rule that counted nodes matching
 * `undefined` would find 0 of them and fail for the wrong reason.
 */
export function expirySentence(source) {
  const m = /SESSION_ENDED_TITLE\s*=\s*'([^']+)'/.exec(source);
  return m ? m[1] : null;
}

/**
 * Whether `clickCentre` should go round again on a reading — the settling wait
 * #797 added, split out here so the answer for an UNREADABLE reading can be
 * asserted without a browser.
 *
 * `evaluate` hands back `undefined` whenever the page-side expression throws
 * (`browser-harness.mjs`: `Runtime.evaluate` carries no `result.value` on an
 * exception), and the first draft of the wait read `box.inViewport` before the
 * null check below the loop could speak. A page that threw got a stack trace
 * where it used to get a sentence that named the control it could not read.
 * Cleanup ran either way, so the cost was only ever diagnosis — but a guard that answers a broken page with a stack trace is
 * a guard people stop reading, which is the whole subject of #797.
 *
 * So this stops on anything it cannot judge — no reading, or a reading that
 * already carries an `error` — and leaves the sentence to the checks below the
 * loop, which is where it was before.
 */
export function stillSettling(box) {
  if (!box || box.error) return false;
  if (box.inViewport && box.hit.inside) return false;
  return box.settling.length > 0;
}

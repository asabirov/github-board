/**
 * Guard for #1200 — the sidebar must not move when "New project" opens.
 *
 * WHAT IT READS. The properties panel and EVERY box inside it, in document
 * coordinates, closed and open, at the six widths the page is laid out for.
 * Document coordinates because a page that scrolled under the reader would
 * otherwise read as a panel that moved. The panel's own box and its descendants
 * both, and the descendant COUNT is asserted as well: a regression that takes a
 * row away leaves the survivors where they were, and a reading that only
 * compared the boxes it found would call that no movement at all.
 *
 * WITH REAL SCROLLBARS, which is the whole reason this cannot be one width with
 * the harness default. `browser-harness.mjs` hides scrollbars unless a guard
 * asks otherwise, and a hidden scrollbar is zero pixels wide — which takes away
 * the ONE mechanism by which this modal could still move the sidebar. Radix
 * locks the page scroll when the dialog opens; with a real bar that lock widens
 * the layout viewport, and the sidebar stays put only because react-remove-
 * scroll compensates with a margin on `body`. Under `--hide-scrollbars` there is
 * nothing to compensate for and the guard passes without having looked.
 *
 * Nothing here asserts a scrollbar's WIDTH, which is a platform's business and
 * would read differently on every OS. It asserts that the lock fires — the
 * layout viewport changes width when the dialog opens — and that no box in the
 * panel moves by so much as a hundredth of a pixel while it does.
 *
 * AND WHAT A PRESS OUTSIDE DOES, which since #1250 is nothing. The form this
 * dialog replaced kept a half-typed name through a stray click on purpose, and
 * #1094's acceptance row still asks for that, so a press on the scrim must
 * leave the dialog up, the name in the field and
 * no write on the wire. Twelve rounds of it, each with a name of its own, at the
 * four corners in turn: a name that survived because the field was never
 * refilled would read the same as one the dialog held on to, and a round that
 * pressed the same pixel every time would say nothing about the other three.
 *
 * The `creates` counter says the press wrote nothing, and it is worth something
 * only because the create at the end of this file drives it to one. A counter
 * that can never move reads zero over anything.
 *
 * AND THE DISMISSALS THAT ARE STILL DISMISSALS — Escape, Cancel and the corner
 * mark, four rounds each. Radix restores focus from a deferred task, so
 * `document.activeElement` read in the same turn as the press is read too early
 * and says `<body>` on a page that is about to put focus back on the trigger.
 * This waits for the restore instead of racing it, and reports the page's own
 * measurement of how long it took, because a focus rule that has only been seen
 * work once has not been seen work.
 *
 * A press outside DOES take focus to `<body>`: the overlay takes none, and
 * Radix leaves a press on an unfocusable thing alone. Every round reads the Tab
 * that follows, because the claim worth guarding is not where focus rests but
 * that the dialog is still the live layer and a keyboard can get back into it.
 *
 * `pnpm test` can see none of it: the vitest environment has no layout, no
 * scrollbars and no focus, and the dialog portals its content out of the tree
 * the specs render. `scripts/check-new-project-modal.spec.mjs` is the redness
 * proof.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cdp, evaluate, findChrome, installCleanupHandlers, killChrome, makeDie, pollFor, startChrome, startServer } from './browser-harness.mjs';

const outIndex = process.argv.indexOf('--out');
const out = outIndex < 0 ? null : process.argv[outIndex + 1];
const distIndex = process.argv.indexOf('--dist');
const dist = distIndex < 0 ? resolve(process.env.BOARD_DIST ?? 'dist') : resolve(process.argv[distIndex + 1]);
/** Every width the stylesheet lays this page out for, so a rule that only bites
 *  on one of them cannot hide between two readings. */
const WIDTHS = [768, 900, 1024, 1100, 1280, 1440];
/** Rounds of "type a name, press outside, then dismiss for real". Twelve so each
 *  of the three dismissal paths below is walked four times. */
const ROUNDS = 12;
/** Where the press outside lands, one corner per round: an offset from a
 *  viewport edge, negative meaning the far one. Far enough in at those edges
 *  that a real scrollbar's track is never the thing being pressed. */
const CORNERS = [[20, 20], [-40, 20], [20, -40], [-40, -40]];
/**
 * Two marks in the page's own clock: when a dismissal was asked for, and when
 * the trigger got focus back. Taken here rather than from the run's wall clock
 * because everything this file does to the page crosses a debugger socket, and
 * a number measured across one says more about the socket than about the page.
 */
const TIMING = `(() => {
  window.__dismissAt = null;
  window.__restoredAt = null;
  const trigger = () => Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim() === 'New project');
  addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__dismissAt = performance.now(); }, true);
  addEventListener('click', (e) => {
    const pressed = e.target instanceof Element ? e.target.closest('button') : null;
    if (pressed && ['Cancel', 'Close'].includes(pressed.textContent.trim())) window.__dismissAt = performance.now();
  }, true);
  addEventListener('focusin', (e) => { if (e.target === trigger()) window.__restoredAt = performance.now(); }, true);
  return true;
})()`;
/**
 * How long the trigger has to get focus back after a dismissal that is one.
 *
 * Radix restores focus from a task it defers, and this host puts it back in
 * about fifteen milliseconds — the run prints the largest of the twelve it
 * measured, so that number is on the record rather than in this comment. Ten
 * seconds is six hundred times it.
 *
 * It is ten and not thirty because the redness proof for this one wait pays the
 * whole of it: a build that drops focus never satisfies the poll, and thirty
 * seconds of clock was a third of this file's budget (#1404). The harness
 * ceiling still caps it, so `guard-exit-paths.spec.mjs` buys the same refusal
 * for six.
 */
const FOCUS_BUDGET_MS = 10_000;
const waitForFocus = async (client, session, die, round, path) => {
  const value = await pollFor(client, session, `(() => {
      const t = Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim() === 'New project');
      return document.activeElement === t || 'focus is on ' + (document.activeElement === document.body ? '<body>' : document.activeElement?.tagName);
    })()`, (v) => v === true || v, `${path} round ${round}`,
    'The New project trigger must regain focus after dismissal.', die, FOCUS_BUDGET_MS);
  return value;
};
const fixtures = JSON.parse(await readFile(new URL('./fixtures/team-api.json', import.meta.url), 'utf8'));
/** Long enough to overflow every width above, so the page really has a scrollbar
 *  for the modal's scroll lock to take away. */
const BODY = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of the report this issue was filed with.`).join('\n\n');
/**
 * A FULL panel and not a bare one. Every row in this column is a box the dialog
 * could push, so an issue with no labels, no assignee, no milestone and no board
 * gives the reading below almost nothing to be wrong about — and the block that
 * moves under an overlay is the one with the most in it. Labels, assignees, a
 * milestone, a type and a board with four fields put every kind of row the panel
 * can draw in front of the measurement at once.
 */
const issue = {
  owner: 'acme', repo: 'acme', number: 218, title: 'Project creation modal', state: 'open',
  htmlUrl: 'https://github.com/acme/acme/issues/218',
  author: { login: 'mira', avatarUrl: null },
  createdAt: '2026-09-01T12:00:00Z', updatedAt: '2026-09-01T12:00:00Z', bodyMarkdown: BODY,
  labels: [{ name: 'accessibility', color: '5319e7' }, { name: 'frontend', color: '0e8a16' }, { name: 'needs design', color: 'd93f0b' }],
  assignees: [{ login: 'mira', avatarUrl: null }, { login: 'toomas', avatarUrl: null }],
  milestone: 'Autumn release', issueType: 'Task', linkedPrs: [], comments: [],
  totalComments: 0, commentsTruncated: false,
  projects: [{
    projectId: 'P_HELD', itemId: 'I_HELD', number: 12, title: 'Frontend quality', owner: 'acme',
    fields: [
      { fieldId: 'F_STATUS', name: 'Status', dataType: 'single_select', builtInStatus: true, options: [{ optionId: 'O_DOING', name: 'In progress' }, { optionId: 'O_DONE', name: 'Done' }] },
      { fieldId: 'F_SIZE', name: 'Size', dataType: 'single_select', options: [{ optionId: 'O_M', name: 'Medium' }] },
      { fieldId: 'F_DUE', name: 'Due', dataType: 'date' },
      { fieldId: 'F_NOTE', name: 'Note', dataType: 'text' },
    ],
    values: {
      F_STATUS: { kind: 'single_select', optionId: 'O_DOING' },
      F_SIZE: { kind: 'single_select', optionId: 'O_M' },
      F_DUE: { kind: 'date', date: '2026-10-15' },
      F_NOTE: { kind: 'text', text: 'Measured at six widths.' },
    },
  }],
  relations: { parent: null, subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0, blockedBy: [], blocking: [] },
};
const base = '/api/issues/acme/acme/218';
let creates = 0;
const die = makeDie('check-new-project-modal');
const { server, port, missingApi } = await startServer(fixtures, dist, (path, search, method) => {
  if (path === '/api/auth/me') return { status: 200, body: { ...fixtures[path].body, writesEnabled: true, canWrite: true } };
  if (path === base) return { status: 200, body: issue };
  if (path === base + '/project/new' && method === 'POST') {
    creates++;
    issue.projects = [...issue.projects, { projectId: 'P_NEW', itemId: 'I_NEW', title: 'Launch week', number: 99, owner: 'acme', fields: [], values: {} }];
    return { status: 200, body: { project: { id: 'P_NEW', title: 'Launch week', number: 99, owner: 'acme', url: 'https://github.com/orgs/acme/projects/99' }, itemId: 'I_NEW' } };
  }
  if (path === '/api/issues/search-index') return { status: 200, body: [] };
  return null;
});
const submissions = [];
server.on('request', (request) => {
  if (request.url !== base + '/project/new' || request.method !== 'POST') return;
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => submissions.push(JSON.parse(body)));
});
let client;
const cleanup = () => { client?.close(); killChrome(); server.closeAllConnections(); server.close(); };
installCleanupHandlers('check-new-project-modal', cleanup);
const failures = [];
try {
  // `scrollbars: true` — see the note at the top of this file. Without it the
  // scroll lock has nothing to take away and the six widths below read the same
  // page six times.
  client = cdp(await startChrome(await findChrome(die), 'board-new-project-modal-', { scrollbars: true }), die);
  await client.ready;
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, s);
  await client.send('Runtime.enable', {}, s);
  await client.send('Accessibility.enable', {}, s);
  const run = expression => evaluate(client, s, expression);
  const wait = expression => pollFor(client, s, expression, Boolean, 'project modal', expression, die);
  const width = async value => {
    await client.send('Emulation.setDeviceMetricsOverride', { width: value, height: 900, deviceScaleFactor: 1, mobile: false }, s);
    await wait(`document.documentElement.clientWidth > 0`);
  };
  const button = name => `Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim() === ${JSON.stringify(name)})`;
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, s);
  };
  const click = async name => {
    const box = await run(`(() => { const r = ${button(name)}.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; })()`);
    await clickAt(box.x, box.y);
  };
  /**
   * Put the trigger where a click will reach it, and wait until one would.
   *
   * The fixture issue is taller than the window on purpose — the page has to
   * have a scrollbar for the modal's lock to take one away — so the trigger can
   * sit below the fold, and a click dispatched outside the viewport lands
   * nowhere. Scrolling it into view is half of that. The other half is that
   * after a resize Chrome answers `getBoundingClientRect` from a layout the
   * compositor has not taken up yet: the box is right and the click still goes
   * to whatever used to be there. So this waits on the thing the click actually
   * depends on — the page hit-testing that point to the trigger — rather than
   * on a sleep long enough to have usually worked.
   *
   * Every reading in this file is in document coordinates, so where the page
   * has been scrolled to when one is taken changes nothing about what it says.
   */
  const reveal = async () => {
    await run(`(() => { ${button('New project')}.scrollIntoView({ block: 'center' }); return true; })()`);
    await pollFor(client, s, `(() => {
      const b = ${button('New project')};
      if (!b) return 'there is no New project trigger';
      const r = b.getBoundingClientRect();
      if (r.width === 0) return 'the New project trigger draws nothing';
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return b.contains(hit) ? true : 'a click on the New project trigger would land on ' + (hit ? hit.tagName : 'nothing');
    })()`, v => v === true, 'the New project trigger', 'the page must route a click at the trigger to the trigger', die);
  };
  /** Chrome moves focus and submits forms off the virtual key code, not off
   *  `key`, so a press sent without the right one is a press the page ignores. */
  const CODES = { Escape: 27, Enter: 13, Tab: 9 };
  const key = async (key, code) => {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...(key === 'Enter' ? { text: '\r' } : {}), windowsVirtualKeyCode: CODES[key], nativeVirtualKeyCode: CODES[key] }, s);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: CODES[key], nativeVirtualKeyCode: CODES[key] }, s);
  };
  /**
   * A beat long enough for anything the press was going to do to have happened.
   * Two turns of the event loop around a frame: Radix dismisses synchronously
   * on pointerdown and React paints the removal on the next frame, so a dialog
   * still standing after this is one that was never asked to go.
   */
  const settle = () => client.send('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(() => requestAnimationFrame(() => setTimeout(r, 60)), 60))', awaitPromise: true }, s);
  /** The three presses that do dismiss it. The corner mark carries its name in
   *  a screen-reader-only span, which is what `click` reads. */
  const PATHS = [
    { name: 'Escape', dismiss: () => key('Escape', 'Escape') },
    { name: 'Cancel', dismiss: () => click('Cancel') },
    { name: 'the corner mark', dismiss: () => click('Close') },
  ];
  const tree = async name => {
    const ax = await client.send('Accessibility.getFullAXTree', {}, s);
    if (out) await writeFile(resolve(out, name + '.ax.json'), JSON.stringify(ax, null, 2));
    return ax.nodes;
  };
  const focused = nodes => nodes.find(n => n.role?.value !== 'RootWebArea' && n.properties?.some(p => p.name === 'focused' && p.value.value));
  const shot = async name => {
    await client.send('Runtime.evaluate', {
      expression: 'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))).then(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))))',
      awaitPromise: true,
    }, s);
    if (out) {
      const { data } = await client.send('Page.captureScreenshot', { format: 'png' }, s);
      await writeFile(resolve(out, name + '.png'), Buffer.from(data, 'base64'));
    }
  };
  /**
   * The properties panel and every box under it, in DOCUMENT coordinates, each
   * tagged with where it sits in the panel so a refusal can name the box rather
   * than its index. `[data-add-project]`'s parent IS the panel root
   * (`PropertiesPanel.tsx`), which is the one hook in this column that is in the
   * markup on purpose rather than a class a restyle would rename.
   */
  const PANEL = `(() => {
    const root = document.querySelector('[data-add-project]')?.parentElement;
    if (!root) return null;
    const box = (e, path) => { const r = e.getBoundingClientRect(); return { path, x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; };
    const walk = (e, path, into) => { into.push(box(e, path)); Array.from(e.children).forEach((c, i) => walk(c, path + '>' + c.tagName.toLowerCase() + '(' + i + ')', into)); return into; };
    return { boxes: walk(root, 'panel', []), text: root.textContent, viewport: document.documentElement.clientWidth };
  })()`;
  if (out) await mkdir(out, { recursive: true });
  await width(1280);
  await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/issue/acme/acme/218` }, s);
  await wait(`Boolean(${button('New project')})`);

  // ── The claim #1200 is about, at six widths with a real scrollbar ──────────
  const geometry = [];
  for (const w of WIDTHS) {
    await width(w);
    await wait(`Boolean(${button('New project')})`);
    await reveal();
    const closed = await run(PANEL);
    assert(closed, `no properties panel at ${w}px`);
    assert(closed.boxes.length > 40, `${w}px: the panel drew ${closed.boxes.length} boxes; this reading is worth nothing over a panel that did not render`);
    // The rows the fixture seeded, named. A box count alone passes over a panel
    // that quietly stopped drawing the block with the most in it, and a reading
    // of the rows that are left would then report no movement at all.
    for (const row of ['accessibility', 'Autumn release', 'Frontend quality', 'Status', 'Due', 'Note'])
      assert(closed.text.includes(row), `${w}px: the panel does not draw "${row}", so this reading is over a panel the fixture did not fill`);
    assert(await run(`document.documentElement.scrollHeight > document.documentElement.clientHeight`),
      `${w}px: the page does not scroll, so the modal's scroll lock has nothing to take away and this width proves nothing`);
    await click('New project');
    await wait(`Boolean(document.querySelector('[role="dialog"]'))`);
    const open = await run(PANEL);
    // The lock fired: with a real bar, taking the page scroll away widens the
    // layout viewport. This is the mechanism the guard exists to watch, so a
    // build where it silently stopped firing must not read as good news.
    if (open.viewport === closed.viewport) failures.push(`${w}px: the scroll lock never fired (layout viewport stayed ${closed.viewport}px), so nothing here was tested`);
    const moved = open.boxes.filter((b, i) => {
      const was = closed.boxes[i];
      return !was || was.path !== b.path || was.x !== b.x || was.y !== b.y || was.width !== b.width || was.height !== b.height;
    });
    if (open.boxes.length !== closed.boxes.length) failures.push(`${w}px: the panel drew ${closed.boxes.length} boxes closed and ${open.boxes.length} open`);
    for (const b of moved.slice(0, 4)) {
      const was = closed.boxes.find(c => c.path === b.path);
      failures.push(was
        ? `${w}px: ${b.path} moved from ${was.x},${was.y} ${was.width}x${was.height} to ${b.x},${b.y} ${b.width}x${b.height}`
        : `${w}px: ${b.path} is not in the closed panel at all`);
    }
    geometry.push({ width: w, boxes: closed.boxes.length, viewportClosed: closed.viewport, viewportOpen: open.viewport, moved: moved.length });
    if (w === 1280) await shot('sidebar-modal-open');
    await key('Escape', 'Escape');
    await wait(`!document.querySelector('[role="dialog"]')`);
  }
  console.log(geometry.map(g => `${g.width}px: ${g.boxes} boxes, viewport ${g.viewportClosed}->${g.viewportOpen}, ${g.moved} moved`).join('\n'));

  // ── What a reader receives, and where focus goes ───────────────────────────
  await width(1280);
  await wait(`Boolean(${button('New project')})`);
  await reveal();
  await shot('sidebar-closed');
  await click('New project');
  await wait(`Boolean(document.querySelector('[role="dialog"]'))`);
  const opened = await tree('modal-open');
  assert.equal(focused(opened)?.role.value, 'textbox');
  assert.equal(focused(opened)?.name.value, 'Project name');
  assert.equal(opened.find(n => n.role?.value === 'dialog')?.name.value, 'New project');
  assert(opened.some(n => n.name?.value === 'Made on GitHub, with this issue on it.'));
  await key('Escape', 'Escape');
  await wait(`!document.querySelector('[role="dialog"]')`);
  await wait(`document.activeElement === ${button('New project')}`);
  const closedTree = await tree('escape-closed');
  assert.equal(focused(closedTree)?.name.value, 'New project');

  /**
   * Twelve rounds of the thing #1250 is about, each with its own name, its own
   * corner of the scrim and its own way out.
   *
   * The press outside is read in two halves. `settle` first, because Radix arms
   * its outside-pointer listener one task after the layer mounts and ignores a
   * press inside that window on purpose — a reading taken there would be of the
   * window and not of the rule. Then `settle` again after the press, long enough
   * that a dismissal would already have happened, because what is being read is
   * the absence of one and an absence read too early is just an absence of time.
   *
   * The dismissal that follows is read only once focus has settled. `pollFor` is
   * the settling: it waits for the restore Radix defers rather than reading
   * `document.activeElement` in the same turn as the press, which is a reading
   * of `<body>` taken a few milliseconds too early. It gives up loudly after
   * `FOCUS_BUDGET_MS` if focus never comes back, which is the failure this is
   * here to catch.
   */
  await run(TIMING);
  const kept = [];
  const restored = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const path = PATHS[(i - 1) % PATHS.length];
    const [dx, dy] = CORNERS[(i - 1) % CORNERS.length];
    await reveal();
    await click('New project');
    await wait(`Boolean(document.querySelector('[role="dialog"]'))`);
    await wait(`document.activeElement?.tagName === 'INPUT'`);
    // A dialog that reopened still holding the last round's name would pass the
    // reading below without this round's press having preserved anything.
    const fresh = await run(`document.querySelector('[data-new-project] input').value`);
    if (fresh !== '') failures.push(`round ${i}: the dialog opened holding "${fresh}" rather than an empty field`);
    await settle();
    const typed = `Half typed name ${i}`;
    await client.send('Input.insertText', { text: typed }, s);
    const { width: vw, height: vh } = await run(`({ width: innerWidth, height: innerHeight })`);
    const at = [dx < 0 ? vw + dx : dx, dy < 0 ? vh + dy : dy];
    await clickAt(at[0], at[1]);
    await settle();
    const after = await run(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const input = document.querySelector('[data-new-project] input');
      return { open: Boolean(dialog), value: input ? input.value : null };
    })()`);
    if (!after.open) {
      failures.push(`round ${i}: the press at ${at[0]},${at[1]} dismissed the dialog, and "${typed}" went with it`);
      kept.push(false);
      continue;
    }
    if (after.value !== typed) failures.push(`round ${i}: the dialog stayed up and the name did not — the field holds ${JSON.stringify(after.value)} rather than "${typed}"`);
    if (creates !== 0) failures.push(`round ${i}: the press at ${at[0]},${at[1]} sent ${creates} create(s)`);
    // The press does take focus to `<body>`. What matters is that the dialog is
    // still the live layer, which is what a Tab landing back inside it says.
    await key('Tab', 'Tab');
    await settle();
    if (!await run(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`))
      failures.push(`round ${i}: Tab after the press outside did not land back inside the dialog`);
    kept.push(after.open && after.value === typed);

    await run(`(() => { window.__dismissAt = null; window.__restoredAt = null; return true; })()`);
    await path.dismiss();
    await wait(`!document.querySelector('[role="dialog"]')`);
    const landed = await waitForFocus(client, s, die, i, path.name);
    restored.push({ path: path.name, back: landed === true, ms: await run(`window.__restoredAt === null || window.__dismissAt === null ? null : Math.round(window.__restoredAt - window.__dismissAt)`) });
  }
  console.log(`press outside: the dialog stayed up with the name intact and nothing written, ${kept.filter(Boolean).length}/${ROUNDS} times`);
  console.log(`focus after dismissal: ${PATHS.map(p => `${p.name} ${restored.filter(r => r.path === p.name && r.back).length}/${restored.filter(r => r.path === p.name).length}`).join(', ')}`);
  console.log(restored.length
    ? `the trigger had focus back within ${Math.max(...restored.map(r => r.ms ?? 0))}ms of the press that asked for it`
    : 'no round reached a dismissal, so nothing here says where focus goes');

  // ── The create still goes through, from the dialog ─────────────────────────
  await reveal();
  await click('New project');
  await wait(`document.activeElement?.tagName === 'INPUT'`);
  await client.send('Input.insertText', { text: 'Launch week' }, s);
  await wait(`!${button('Create project')}.disabled`);
  await key('Enter', 'Enter');
  await wait(`!document.querySelector('[role="dialog"]') && document.body.textContent.includes('Launch week')`);
  assert.equal(creates, 1);
  assert.deepEqual(submissions, [{ title: 'Launch week' }]);
  await shot('project-created');
  await wait(`document.activeElement === ${button('New project')}`);
  const saved = await tree('project-created');
  assert.equal(focused(saved)?.name.value, 'New project');
  assert.deepEqual([...missingApi], [], 'unanswered fixture routes');

  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('the sidebar holds still while the New project dialog is open, at every width and with the page scroll locked');
  }
  const result = { geometry, rounds: ROUNDS, kept: kept.filter(Boolean).length, restored, creates, submissions, backend: 'HTTP fixture; no GitHub writes' };
  if (out) await writeFile(resolve(out, 'browser-results.json'), JSON.stringify(result, null, 2));
} finally { cleanup(); }

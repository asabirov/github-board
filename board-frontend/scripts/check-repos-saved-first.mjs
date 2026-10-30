/** Saved route content must precede background reads on every return visit. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { findChrome, makeDie, startServer } from './browser-harness.mjs';
const root = new URL('../', import.meta.url);
const fixtures = { ...JSON.parse(await readFile(new URL('scripts/fixtures/team-api.json', root))), ...JSON.parse(await readFile(new URL('scripts/fixtures/repos-api.json', root))) };
const id = 'a'.repeat(64), visibility = 'saved-first';
const cookie = `board_session_hint=${encodeURIComponent(JSON.stringify({ id, visibilityKey: visibility }))}; Path=/; SameSite=Lax`;
let held = false;
let release = () => {};
let gate = Promise.resolve();
const executablePath = await findChrome(makeDie('check-repos-saved-first'));
const { server, port } = await startServer(fixtures, process.env.BOARD_DIST ?? new URL('dist', root).pathname, async path => {
  if (held && ['/api/repos', '/api/issues/all', '/api/issues/mine'].includes(path)) await gate;
  const expiresAt = Date.now() + 60000;
  if (path === '/api/auth/me') return { status: 200, headers: { 'set-cookie': cookie }, body: { ...fixtures[path].body, sessionHintId: id, github: { connected: true, configured: true, owners: [{ login: 'acme', type: 'Organization' }], visibilityKey: visibility, expiresAt, responseDeadlines: true, login: 'octocat' } } };
  const hit = fixtures[path];
  return hit ? { ...hit, status: hit.status ?? 200, headers: { ...hit.headers, 'X-Board-Sensitive': '1', 'X-Board-Visibility': visibility, 'X-Board-Access-Expires-At': String(expiresAt) } } : null;
});
function sampleStartup({ theme, mode = 'saved' }) {
  localStorage.setItem('board_theme', theme);
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args) => {
    window.storageStarted ??= performance.now();
    if (mode === 'throws') throw new DOMException('Storage blocked', 'SecurityError');
    if (mode === 'hangs' || mode === 'no-saved') return {};
    return open(...args);
  };
  // Exercise both sides of the 400 ms budget without delaying network reads.
  const descriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess');
  Object.defineProperty(IDBRequest.prototype, 'onsuccess', { ...descriptor, set(callback) {
    descriptor.set.call(this, this.source?.name === 'reads' && callback
      ? event => setTimeout(() => callback.call(this, event), mode === 'slow' ? 750 : 50) : callback);
  } });
  window.savedFrames = [];
  const sample = () => {
    window.savedFrames.push({ path: location.pathname, at: performance.now(),
      storageElapsed: performance.now() - window.storageStarted,
      text: document.querySelector('[data-board-content]')?.textContent ?? '',
      blank: !document.querySelector('#root')?.textContent?.trim(),
      loading: !!document.querySelector('[data-board-content] [aria-busy="true"]') });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
// Allow 150 ms for React and a frame after the storage budget expires.
function assertPaint(frames, label, limit = 550) {
  const first = frames.findIndex(frame => !frame.blank);
  assert.ok(first >= 0, `${label}: no painted frame`);
  assert.equal(frames.filter(frame => frame.blank && frame.storageElapsed > limit).length, 0,
    `${label}: blank frame past startup budget`);
  assert.equal(frames.slice(first).filter(frame => frame.blank).length, 0, `${label}: blank frame after mount`);
  return frames[first];
}
let browser;
const results = [];
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(sampleStartup, { theme });
    const page = await context.newPage();
    held = false;
    await page.goto(`http://127.0.0.1:${port}/repos`, { waitUntil: 'domcontentloaded' });
    await page.getByText('github-board', { exact: true }).first().waitFor();
    const navigate = name => page.locator('.side-nav button').filter({ hasText: name }).evaluate(button => button.click());
    await navigate('Overview');
    await page.waitForFunction(marker => document.body.textContent.includes(marker), [...fixtures['/api/issues/all'].body.issues].sort((a,b) => b.ageDays-a.ageDays)[0].title);
    await navigate('My work');
    await page.waitForFunction(marker => document.body.textContent.includes(marker), [...fixtures['/api/issues/mine'].body.issues].sort((a,b) => b.ageDays-a.ageDays)[0].title);
    held = true; gate = new Promise(resolve => { release = resolve; });
    const record = async (target, scenario, path, marker) => {
      await target.bringToFront();
      await target.waitForFunction(marker => document.querySelector('[data-board-content]')?.textContent.includes(marker), marker);
      await target.waitForTimeout(200);
      const frames = await target.evaluate(path => window.savedFrames.filter(frame => frame.path === path), path);
      const first = assertPaint(frames, `${scenario} ${width} ${theme}`);
      results.push({ width, theme, scenario, path, contentFrames: frames.filter(frame => frame.text.includes(marker)).length,
        loadingFrames: frames.filter(frame => frame.loading).length,
        blankFrames: frames.filter(frame => frame.blank).length,
        overdueBlankFrames: frames.filter(frame => frame.blank && frame.storageElapsed > 550).length,
        firstPaintMs: first.at, storageWaitMs: first.storageElapsed });
    };
    await page.evaluate(() => { window.savedFrames = []; });
    await navigate('Repos');
    await record(page, 'switch-back', '/repos', 'github-board');
    await page.reload({ waitUntil: 'domcontentloaded' });
    // The first route render is the comparison point, with network reads held.
    await page.getByRole('heading', { name: 'Repos', exact: true }).waitFor();
    if (process.env.EVIDENCE_DIR) {
      await mkdir(process.env.EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/${process.env.CAPTURE_PREFIX ?? 'after'}-repos-${width}-${theme}.png` });
    }
    await record(page, 'reload', '/repos', 'github-board');
    const fresh = await context.newPage();
    await fresh.goto(`http://127.0.0.1:${port}/repos`, { waitUntil: 'domcontentloaded' });
    await record(fresh, 'fresh-tab', '/repos', 'github-board');
    await fresh.close();
    for (const [name, path, api] of [['Overview', '/overview', '/api/issues/all'], ['My work', '/', '/api/issues/mine']]) {
      const marker = [...fixtures[api].body.issues].sort((a,b) => b.ageDays-a.ageDays)[0].title;
      await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'domcontentloaded' });
      await record(page, name, path, marker);
    }
    const storageState = await context.storageState({ indexedDB: true });
    for (const mode of ['throws', 'hangs', 'slow', 'no-saved']) {
      const failureContext = await browser.newContext({ viewport: { width, height: 1000 },
        ...(mode === 'no-saved' ? {} : { storageState }) });
      await failureContext.addInitScript(sampleStartup, { theme, mode });
      const target = await failureContext.newPage();
      let releaseProbe = () => {};
      if (mode === 'hangs' || mode === 'throws') {
        const probeGate = new Promise(resolve => { releaseProbe = resolve; });
        await target.route('**/api/auth/me', async route => { await probeGate; await route.continue(); });
      }
      await target.goto(`http://127.0.0.1:${port}/repos`, { waitUntil: 'commit' });
      await target.waitForFunction(() => document.querySelector('#root')?.textContent?.trim(), null, { timeout: 2000 });
      await target.waitForTimeout(100);
      const frames = await target.evaluate(() => window.savedFrames);
      const first = assertPaint(frames, mode, mode === 'no-saved' || mode === 'throws' ? 200 : 550);
      assert.ok(first.storageElapsed < (mode === 'no-saved' || mode === 'throws' ? 200 : 550),
        `${mode}: first paint after ${first.storageElapsed} ms of storage wait`);
      results.push({ width, theme, scenario: mode, firstPaintMs: first.at,
        storageWaitMs: first.storageElapsed, blankFrames: frames.filter(frame => frame.blank).length,
        overdueBlankFrames: 0 });
      if (process.env.EVIDENCE_DIR) await target.screenshot({ path: `${process.env.EVIDENCE_DIR}/${mode}-${width}-${theme}.png` });
      if (mode === 'slow') {
        await target.getByText('github-board', { exact: true }).first().waitFor({ timeout: 2000 });
      }
      if (mode === 'hangs' || mode === 'throws') {
        assert.equal(await target.getByText('github-board', { exact: true }).count(), 0,
          `${mode}: content appeared before verification and network release`);
        releaseProbe();
        held = false; release();
        await target.getByText('github-board', { exact: true }).first().waitFor({ timeout: 2000 });
        results.at(-1).networkRecovered = true;
        held = true; gate = new Promise(resolve => { release = resolve; });
      }
      await failureContext.close();
    }
    held = false; release();
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
  if (process.env.EVIDENCE_DIR) await writeFile(`${process.env.EVIDENCE_DIR}/${process.env.CAPTURE_PREFIX ?? 'after'}-frames.json`, JSON.stringify(results, null, 2));
  for (const result of results) {
    const label = `${result.scenario} ${result.width} ${result.theme}`;
    assert.equal(result.overdueBlankFrames, 0, `${label}: blank frame past startup budget`);
    if (result.contentFrames === undefined) continue;
    assert.ok(result.contentFrames > 0, `${label}: saved content did not paint while the read was held`);
    assert.equal(result.loadingFrames, 0, `${label}: painted loading placeholders over saved content`);
  }
} finally {
  held = false; release();
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

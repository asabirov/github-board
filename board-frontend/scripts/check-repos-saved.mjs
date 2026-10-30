/** The saved repo map survives a reload during an upstream outage. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { findChrome, makeDie, startServer } from './browser-harness.mjs';

const executablePath = await findChrome(makeDie('check-repos-saved'));
const root = new URL('../', import.meta.url);
const fixtures = Object.assign(
  JSON.parse(await readFile(new URL('scripts/fixtures/team-api.json', root))),
  JSON.parse(await readFile(new URL('scripts/fixtures/repos-api.json', root))),
);
fixtures['/api/repos'].headers = { 'X-Board-Sensitive': '1' };
let status = 200;
const { server, port } = await startServer(fixtures, new URL('dist', root).pathname,
  path => path === '/api/repos' && status !== 200 ? { status, body: {} } : null);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/repos`);
  await page.getByText('github-board', { exact: true }).first().waitFor();
  status = 502;
  await page.reload();
  await page.getByRole('img', { name: 'This page may be showing out-of-date data.' }).first().waitFor({ timeout: 5000 });
  assert.match(await page.locator('body').innerText(), /github-board/, 'an unavailable upstream must leave the saved map visible after reload');
  assert.doesNotMatch(await page.locator('body').innerText(), /Reload the page to try again/);
  assert.doesNotMatch(await page.locator('body').innerText(), /couldn’t be read just now|Showing the .*copy/);
  const warning = page.getByRole('img', { name: 'This page may be showing out-of-date data.' }).first();
  assert.equal(await warning.getAttribute('title'), 'This page may be showing out-of-date data.');
  assert.equal(await warning.innerText(), '!');
  assert.match(await page.getByRole('button', { name: 'View sync sources', exact: true }).first().getAttribute('aria-description'), /This page may be showing out-of-date data/);
  if (process.env.EVIDENCE_DIR) {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/after-repos-${theme}.png`, fullPage: true });
      await page.getByRole('button', { name: 'View sync sources', exact: true }).first().screenshot({ path: `${process.env.EVIDENCE_DIR}/after-sync-${theme}.png` });
    }
  }
  status = 200;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await warning.waitFor({ state: 'detached', timeout: 5000 });
  assert.match(await page.locator('body').innerText(), /github-board/);
  console.log('PASS: saved map warns in sync indicator without page notice; fresh read clears warning');
  status = 502;
  await page.reload();
  await warning.waitFor({ timeout: 5000 });
  // Emit the successful access-probe event and hold its new row read.
  let releaseRows;
  const rowsRequested = new Promise(resolve => { releaseRows = resolve; });
  await page.route('**/api/repos', route => releaseRows(route));
  await page.evaluate(() => window.dispatchEvent(new Event('board-github-verified')));
  let requestTimer;
  const pendingRows = await Promise.race([
    rowsRequested,
    new Promise((_, reject) => {
      requestTimer = setTimeout(() => reject(new Error('access reset did not request rows')), 10_000);
    }),
  ]).finally(() => clearTimeout(requestTimer));
  await page.waitForFunction(() => !document.body.textContent.includes('github-board'), null, { timeout: 5000 });
  assert.doesNotMatch(await page.locator('body').innerText(), /github-board/, 'an access reset must remove the saved rows before the new read settles');
  // #1395. The access reset takes the map off the screen, because a completed
  // check does not reauthorize what it is holding. What the NEXT failed read
  // does with the copy on the disk is a separate question, and a 500 is not a
  // refusal: the reader gets their own last map back, marked, rather than an
  // error over an empty page. A 403 still takes it, which is the case below.
  await pendingRows.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  await page.getByRole('img', { name: 'This page may be showing out-of-date data.' }).first().waitFor({ timeout: 5000 });
  assert.match(await page.locator('body').innerText(), /github-board/, 'a 500 after an access reset must draw the saved map');
  assert.doesNotMatch(await page.locator('body').innerText(), /Reload the page to try again/, 'a 500 must not settle on the error over a copy it can draw');
  console.log('PASS: access reset clears the saved map; a subsequent 500 draws it again, marked');
  await page.unroute('**/api/repos');
  status = 200;
  await page.reload();
  await page.getByText('github-board', { exact: true }).first().waitFor();
  status = 403;
  await page.reload();
  await page.waitForFunction(() => document.body.textContent.includes('couldn’t be read just now'));
  assert.doesNotMatch(await page.locator('body').innerText(), /github-board/, 'access refusal must not show the saved map');
  status = 502;
  await page.reload();
  await page.waitForFunction(() => document.body.textContent.includes('Reload the page to try again'));
  assert.doesNotMatch(await page.locator('body').innerText(), /github-board/, 'a refused copy must not return on a later outage');
  console.log('PASS: saved map after reload; refusal clears it; later outage cannot resurrect it');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

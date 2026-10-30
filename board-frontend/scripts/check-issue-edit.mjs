import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './browser-harness.mjs';
const fixtures = JSON.parse(await readFile(new URL('./fixtures/team-api.json', import.meta.url), 'utf8'));
const me = fixtures['/api/auth/me'].body;
me.writesEnabled = true;
me.canWrite = true;
me.capabilities['issue.comment'] = 'available';
const issue = {
  owner: 'acme', repo: 'acme', number: 218, title: 'Edit an issue without leaving the board', state: 'open',
  htmlUrl: 'https://github.com/acme/acme/issues/218', author: { login: 'alex', name: 'Alex' },
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', bodyMarkdown: 'Keep the release checklist here.', viewerCanUpdate: true,
  labels: [], assignees: [], milestone: null, issueType: null,
  relations: { parent: null, subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0, blockedBy: [], blocking: [] },
  linkedPrs: [], comments: [{ id: 12, viewerCanUpdate: true, author: { login: 'alex', name: 'Alex' }, bodyMarkdown: 'The release is ready for review.', createdAt: '2026-09-02T00:00:00Z', htmlUrl: 'https://github.com/acme/acme/issues/218#issuecomment-12' }], totalComments: 1, commentsTruncated: false, projects: [],
};
let status = 200;
let writes = 0;
const { server, port } = await startServer(fixtures, process.env.BOARD_DIST ?? new URL('../dist', import.meta.url).pathname, (path, _search, method) => {
  if (path.endsWith('/218/text') && method === 'PATCH') { writes++; return { status, body: status === 200 ? { bodyMarkdown: 'Saved on GitHub.' } : { message: status === 409 ? 'The text changed on GitHub; your draft is kept.' : 'GitHub no longer allows you to edit this text. Your draft is kept.' } }; }
  if (path === '/api/issues/acme/acme/218') return { status: 200, body: issue };
  if (path.startsWith('/api/issues/edit-options/')) return { status: 200, body: { labels: [], milestones: [], assignableLogins: [] } };
  if (path === '/api/issues/search-index') return { status: 200, body: [] };
  return null;
});
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const evidence = process.env.EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/issue/acme/acme/218`);
    await page.getByText('The release is ready for review.').waitFor();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.evaluate(() => document.fonts.ready);
    if (evidence) await page.screenshot({ path: `${evidence}/${process.env.CAPTURE_BEFORE ? 'before' : 'after'}-${width}-${theme}.png`, fullPage: true });
    if (!process.env.CAPTURE_BEFORE) {
      const edit = page.getByRole('button', { name: 'Edit comment', exact: true });
      await edit.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.getByRole('combobox', { name: 'Edit text' }).inputValue(), issue.comments[0].bodyMarkdown);
      if (evidence) await page.screenshot({ path: `${evidence}/editing-${width}-${theme}.png`, fullPage: true });
      const field = page.getByRole('combobox', { name: 'Edit text' });
      await field.fill('Please ask @al');
      await page.getByRole('option', { name: 'alex Alex', exact: true }).waitFor();
      await field.press('Enter');
      assert.equal(await field.inputValue(), 'Please ask @alex ');
      const beforeWrites = writes;
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(writes, beforeWrites);
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Edit comment');
      await edit.click();
      for (const failure of [409, 403]) {
        status = failure;
        await page.getByRole('combobox', { name: 'Edit text' }).fill('My draft');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.getByRole('alert').waitFor();
        assert.match(await page.getByRole('alert').innerText(), failure === 409 ? /changed on GitHub/ : /no longer allows/);
        assert.equal(await page.getByRole('combobox', { name: 'Edit text' }).inputValue(), 'My draft');
      }
      status = 200;
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Saved on GitHub.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit issue body', exact: true }).click();
      await field.fill('Updated issue body @al');
      await page.getByRole('option', { name: 'alex Alex', exact: true }).waitFor();
      await field.press('Enter');
      assert.equal(await field.inputValue(), 'Updated issue body @alex ');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('combobox', { name: 'Edit text' }).waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('combobox', { name: 'Edit text' }).count(), 0);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await context.close();
  }
  if (!process.env.CAPTURE_BEFORE) {
    for (const denied of ['github', 'writes-off', 'capability']) {
      issue.viewerCanUpdate = denied !== 'github'; issue.comments[0].viewerCanUpdate = denied !== 'github';
      me.writesEnabled = denied !== 'writes-off';
      me.capabilities['issue.comment'] = denied === 'capability' ? 'refused' : 'available';
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/issue/acme/acme/218`);
      await page.getByText('The release is ready for review.').waitFor();
      assert.equal(await page.getByRole('button', { name: /^Edit (comment|issue body)$/ }).count(), 0, denied);
      await page.close();
    }
  }
  console.log('Issue editing browser checks passed.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

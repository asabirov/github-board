import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { GithubIssueDetailSource } from './github-issue-detail.source';

const principal = { key: 'editor', token: 'personal', cache: new WeakMap() } as GithubPrincipal;
function setup(body = 'old') {
  const issues = {
    get: vi.fn().mockResolvedValue({ data: { body } }),
    getComment: vi.fn().mockResolvedValue({ data: { body, issue_url: 'https://api.github.com/repos/org/repo/issues/1' } }),
    update: vi.fn().mockResolvedValue({ data: { body: 'saved' } }),
    updateComment: vi.fn().mockResolvedValue({ data: { body: 'saved' } }),
  };
  const source = new GithubIssueDetailSource(new ConfigService());
  return { source, issues };
}
const personal = (fn: () => Promise<unknown>) => githubContext.run({ principal }, fn);
for (const commentId of [undefined, 12]) {
  describe(`edit ${commentId ? 'comment' : 'body'}`, () => {
    it('saves GitHub’s returned text using the personal client', async () => {
      const { source, issues } = setup();
      await personal(async () => {
        Object.assign(source, { readClient: { issues }, writeClient: { issues } });
        expect(await source.editText('org', 'repo', 1, 'draft', 'old', commentId)).toEqual({ bodyMarkdown: 'saved' });
      });
      expect(commentId ? issues.updateComment : issues.update).toHaveBeenCalledOnce();
    });
    it('refuses a changed original without writing', async () => {
      const { source, issues } = setup('changed elsewhere');
      await personal(async () => {
        Object.assign(source, { readClient: { issues }, writeClient: { issues } });
        await expect(source.editText('org', 'repo', 1, 'draft', 'old', commentId)).rejects.toMatchObject({ status: 409 });
      });
      expect(issues.update).not.toHaveBeenCalled();
      expect(issues.updateComment).not.toHaveBeenCalled();
    });
    it('reports a lost permission as 403', async () => {
      const { source, issues } = setup();
      issues.update.mockRejectedValue({ status: 403 });
      issues.updateComment.mockRejectedValue({ status: 403 });
      await personal(async () => {
        Object.assign(source, { readClient: { issues }, writeClient: { issues } });
        await expect(source.editText('org', 'repo', 1, 'draft', 'old', commentId)).rejects.toMatchObject({ status: 403 });
      });
    });
    it('never falls back to the shared account', async () => {
      const { source, issues } = setup();
      Object.assign(source, { readClient: { issues }, writeClient: { issues } });
      await expect(source.editText('org', 'repo', 1, 'draft', 'old', commentId)).rejects.toMatchObject({ status: 403 });
      expect(issues.update).not.toHaveBeenCalled();
    });
  });
}

it('refuses a comment from another issue before writing', async () => {
  const { source, issues } = setup();
  issues.getComment.mockResolvedValue({ data: { body: 'old', issue_url: 'https://api.github.com/repos/org/repo/issues/2' } });
  await personal(async () => {
    Object.assign(source, { readClient: { issues }, writeClient: { issues } });
    await expect(source.editText('org', 'repo', 1, 'draft', 'old', 12)).rejects.toMatchObject({ status: 404 });
  });
  expect(issues.updateComment).not.toHaveBeenCalled();
});

it('reads edit permission from GitHub for both the body and comment', async () => {
  const { source } = setup();
  await personal(async () => {
    const graphql = vi.fn().mockResolvedValue({ repository: { issue: {
      number: 1, title: 'Issue', state: 'OPEN', url: 'https://github.com/org/repo/issues/1', body: 'old', viewerCanUpdate: true,
      createdAt: '', updatedAt: '', author: null, comments: { nodes: [
        { databaseId: 12, url: '', body: 'old', author: null, createdAt: '', viewerCanUpdate: false },
      ] },
    } } });
    Object.assign(source, { readClient: { graphql, issues: { listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }) } } });
    const result = await source.fetch('org', 'repo', 1);
    expect(result?.viewerCanUpdate).toBe(true);
    expect(result?.comments[0]).toMatchObject({ id: 12, viewerCanUpdate: false });
    expect(graphql.mock.calls[0][0]).toContain('viewerCanUpdate');
  });
});

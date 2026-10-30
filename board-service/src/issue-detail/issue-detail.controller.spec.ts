import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { WRITES_CAPABILITY } from '../capability/writes.decorator';
import type { FreshnessRegistry } from '../freshness/freshness.registry';
import { IssueDetailController } from './issue-detail.controller';
import { COMMENT_BODY_MAX } from './issue-detail.types';
import { commentFooter, maxAuthorBody } from './comment-footer';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { IssueDetailService } from './issue-detail.service';
import { FixtureIssueDetailSource } from './fixture-issue-detail.source';
import { AuditService } from '../audit/audit.service';
import { RecordAudit } from '../audit/audit.types';
import { ConfigService } from '@nestjs/config';
import { CapabilityRegistry } from '../capability/capability.registry';
import type { IssuesCacheService } from '../issues-metrics/issues-cache.service';

function controller(opts: { writeEnabled?: boolean } = {}) {
  // `GITHUB_ORGS` is pinned at the org this file's expectations name (#1166):
  // it was the default too until the organisation was renamed to `acme`.
  const config = {
    get: (k: string, d?: unknown) =>
      k === 'GITHUB_WRITE_ENABLED'
        ? !!opts.writeEnabled
        : k === 'GITHUB_ORGS'
          ? 'acme'
          : // No default since #1175, and the service builds the
            // submission-visibility scope from it in its constructor.
            k === 'FEEDBACK_REPO'
            ? 'acme/board'
            : d,
  } as unknown as ConfigService;
  // The service reads the shared cache for one thing: the relations gate's
  // submission index (#516). This controller spec is about writes and audit, so
  // it stands in an index that read every body and found no footer.
  const issuesCache = { submissionIndex: async () => ({ lookup: () => false }) } as unknown as IssuesCacheService;
  // Kept, so a spec can change the issue "on Github" behind the service's back.
  const source = new FixtureIssueDetailSource();
  const svc = new IssueDetailService(source, config, issuesCache);
  const recorded: RecordAudit[] = [];
  const audit = { record: vi.fn(async (e: RecordAudit) => { recorded.push(e); }) } as unknown as AuditService;
  // A real registry, empty: every capability reads `unknown`, and `unknown`
  // refuses nothing — so these cases test the envelope's other rungs, exactly
  // as they did before the capability rung existed.
  const registry = new CapabilityRegistry(config);
  // What a write that the interceptor cannot see asks to drop (#982).
  const freshness = { invalidateAll: vi.fn() } as unknown as FreshnessRegistry;
  return {
    c: new IssueDetailController(svc, config, audit, registry, freshness),
    recorded,
    service: svc,
    registry,
    source,
    freshness,
  };
}

const authed = { user: { email: 'octocat@example.com' } };

describe('IssueDetailController', () => {
  const { c } = controller();

  it('returns the fixture issue with its thread and linked PR', async () => {
    const d = await c.issue('acme', 'acme', '218');
    expect(d).toMatchObject({ number: 218, state: 'open', title: "Board deploy didn't fire on merge" });
    expect(d.comments.length).toBeGreaterThan(0);
    expect(d.linkedPrs[0]).toMatchObject({ number: 240, state: 'merged' });
  });

  it('400s on a non-numeric or non-positive issue number', async () => {
    await expect(c.issue('acme', 'acme', 'abc')).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.issue('acme', 'acme', '0')).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.issue('acme', 'acme', '-4')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on an unknown issue', async () => {
    await expect(c.issue('acme', 'acme', '9999')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('owner pin on the issue read (#483)', () => {
    it('serves an issue inside the mirrored org, body and thread included', async () => {
      const { c: cr } = controller();
      const d = await cr.issue('acme', 'acme', '218');
      expect(d.number).toBe(218);
      expect(d.bodyMarkdown.length).toBeGreaterThan(0);
      expect(d.comments.length).toBeGreaterThan(0);
    });

    it('404s an owner outside the mirrored org without ever reading it (blast-radius cap)', async () => {
      const { c: cr, service } = controller();
      const read = vi.spyOn(service, 'getIssue');
      await expect(cr.issue('evilcorp', 'acme', '218')).rejects.toBeInstanceOf(NotFoundException);
      // The refusal must come from the pin, not from the source happening to
      // hold nothing for that owner — the body must never be fetched at all.
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('close (#287/#291)', () => {
    it('closes the issue and records an audit event when writes are enabled', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      const res = await cw.close('acme', 'acme', '218', authed);
      // No reason asked for is Github's default, and the answer says which.
      expect(res).toEqual({ state: 'closed', stateReason: 'completed' });
      expect(recorded).toEqual([
        expect.objectContaining({
          action: 'issue.close',
          actorEmail: 'octocat@example.com',
          targetType: 'issue',
          targetId: 'acme/acme#218',
        }),
      ]);
    });

    it('503s when GITHUB_WRITE_ENABLED is off, and records nothing', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: false });
      await expect(cw.close('acme', 'acme', '218', authed)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(recorded).toEqual([]);
    });

    it('401s when there is no session email', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      await expect(cw.close('acme', 'acme', '218', {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('404s when the issue does not exist, and records nothing', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await expect(cw.close('acme', 'acme', '9999', authed)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(recorded).toEqual([]);
    });

    it('400s on a non-numeric issue number before touching writes', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      await expect(cw.close('acme', 'acme', 'abc', authed)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404s for an owner outside the mirrored org, recording nothing (blast-radius cap)', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await expect(cw.close('some-other-org', 'x', '218', authed)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(recorded).toEqual([]);
    });
  });

  describe('close with a reason (#1006)', () => {
    it('closes as not planned, answers with it and audits it', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      const res = await cw.close('acme', 'acme', '218', authed, { reason: 'not_planned' });
      expect(res).toEqual({ state: 'closed', stateReason: 'not_planned' });
      expect((await cw.issue('acme', 'acme', '218')).state).toBe('closed');
      expect(recorded).toEqual([
        expect.objectContaining({
          action: 'issue.close',
          summary: 'Closed acme/acme#218 (not_planned)',
          targetId: 'acme/acme#218',
        }),
      ]);
    });

    it('takes each reason Github takes for a close', async () => {
      for (const reason of ['completed', 'not_planned', 'duplicate']) {
        const { c: cw } = controller({ writeEnabled: true });
        const res = await cw.close('acme', 'acme', '218', authed, { reason });
        expect(res.stateReason).toBe(reason);
      }
    });

    it('400s a reason Github does not take for a close, without writing or auditing', async () => {
      // `reopened` is a real `state_reason`, but it names a reopen.
      for (const reason of ['reopened', 'wontfix', 'NOT_PLANNED', 1]) {
        const { c: cw, recorded } = controller({ writeEnabled: true });
        await expect(cw.close('acme', 'acme', '218', authed, { reason })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect((await cw.issue('acme', 'acme', '218')).state).toBe('open');
        expect(recorded).toEqual([]);
      }
    });

    it('answers the envelope first, whatever the reason says', async () => {
      const { c: off } = controller({ writeEnabled: false });
      await expect(off.close('acme', 'acme', '218', authed, { reason: 'wontfix' })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const { c: cw } = controller({ writeEnabled: true });
      await expect(cw.close('some-other-org', 'x', '218', authed, { reason: 'wontfix' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reports the reason Github kept when the issue was already closed (a stale card)', async () => {
      // Github ignores `state_reason` unless the state changes, so the second
      // close cannot move the reason. The route says what is true, not what was
      // asked for.
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await cw.close('acme', 'acme', '218', authed, { reason: 'completed' });
      const res = await cw.close('acme', 'acme', '218', authed, { reason: 'not_planned' });
      expect(res).toEqual({ state: 'closed', stateReason: 'completed' });
      // The second close changed nothing, so it writes no row (#1006 review).
      expect(recorded.map((r) => r.summary)).toEqual(['Closed acme/acme#218 (completed)']);
    });

    it('writes no audit row for a close that changed nothing, with the same reason or none', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await cw.close('acme', 'acme', '218', authed, { reason: 'not_planned' });
      await cw.close('acme', 'acme', '218', authed, { reason: 'not_planned' });
      await cw.close('acme', 'acme', '218', authed);
      expect(recorded.map((r) => r.summary)).toEqual(['Closed acme/acme#218 (not_planned)']);
    });
  });

  describe('the picker changes assignees by name, never by set (#1009 review)', () => {
    const at = ['acme', 'acme', '218'] as const;
    const logins = (r: { assignees: { login: string }[] }) => r.assignees.map((a) => a.login);

    it('reads who holds the issue from Github on every call, never through the issue cache', async () => {
      const { c: cw, source } = controller();
      const cached = vi.spyOn(source, 'fetch');
      const fresh = vi.spyOn(source, 'currentAssignees');
      expect(logins(await cw.assignees(...at))).toEqual(['octocat']);
      // Somebody assigns Ivan on Github, and the next read says so.
      await source.addAssignees('acme', 'acme', 218, ['hubot']);
      expect(logins(await cw.assignees(...at))).toEqual(['octocat', 'hubot']);
      expect(fresh).toHaveBeenCalledTimes(2);
      expect(cached).not.toHaveBeenCalled();
    });

    // The regression this route exists to prevent.
    it('a set changed on Github between the read and the save survives the save', async () => {
      const { c: cw, source } = controller({ writeEnabled: true });
      // The reader opens the picker, and octocat holds the issue.
      expect(logins(await cw.assignees(...at))).toEqual(['octocat']);
      // While it is open, somebody assigns Ivan on Github.
      await source.addAssignees('acme', 'acme', 218, ['hubot']);
      // The reader ticks monalisa, unticks octocat and saves. The page sends what
      // the reader changed, and Ivan is on neither side of it.
      const res = await cw.changeAssignees(...at, { add: ['monalisa'], remove: ['octocat'] }, authed);
      expect(logins(res)).toEqual(['hubot', 'monalisa']);
      expect(logins(await cw.assignees(...at))).toEqual(['hubot', 'monalisa']);
    });

    it('where the replace the picker used to save through takes that person off', async () => {
      // The same moment saved as a set, which is why the picker stopped doing it.
      // `Assign to me` and the hand-over picker still replace, and say so.
      const { c: cw, source } = controller({ writeEnabled: true });
      await source.addAssignees('acme', 'acme', 218, ['hubot']);
      expect(logins(await cw.setAssignees(...at, { logins: ['monalisa'] }, authed))).toEqual(['monalisa']);
    });

    it('leaves a holder the repo no longer assigns where they are, unless the reader takes them off', async () => {
      const { c: cw, source } = controller({ writeEnabled: true });
      // `gone` holds the issue and has since lost access to the repo.
      (await source.fetch('acme', 'acme', 218))!.assignees.push({ login: 'gone', name: null });
      expect(logins(await cw.changeAssignees(...at, { add: ['monalisa'] }, authed))).toEqual(['octocat', 'gone', 'monalisa']);
      expect(logins(await cw.changeAssignees(...at, { remove: ['gone'] }, authed))).toEqual(['octocat', 'monalisa']);
    });

    it('records each Github call as it lands, removals first', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await cw.changeAssignees(...at, { add: ['monalisa'], remove: ['octocat'] }, authed);
      expect(recorded.map((r) => [r.action, r.summary])).toEqual([
        ['issue.assignees', 'Removed assignees from acme/acme#218 (asked octocat; now nobody)'],
        ['issue.assignees', 'Added assignees to acme/acme#218 (asked monalisa; now monalisa)'],
      ]);
    });

    it('keeps the removal on record when the add after it fails, and answers the failure', async () => {
      const { c: cw, recorded, service } = controller({ writeEnabled: true });
      vi.spyOn(service, 'addAssignees').mockRejectedValue(new Error('Github blinked'));
      await expect(cw.changeAssignees(...at, { add: ['monalisa'], remove: ['octocat'] }, authed)).rejects.toThrow(
        'Github blinked',
      );
      expect(recorded.map((r) => r.summary)).toEqual([
        'Removed assignees from acme/acme#218 (asked octocat; now nobody)',
      ]);
    });

    it('400s a change that names nobody, names a login twice or is not login lists, and writes nothing', async () => {
      const bodies = [
        undefined,
        {},
        { add: [], remove: [] },
        { add: ['monalisa'], remove: ['MONALISA'] },
        { add: 'monalisa' },
        { remove: [1] },
        { add: ['  '] },
        { add: Array.from({ length: 11 }, (_, i) => `p${i}`) },
      ];
      for (const body of bodies) {
        const { c: cw, recorded } = controller({ writeEnabled: true });
        await expect(cw.changeAssignees(...at, body as never, authed)).rejects.toBeInstanceOf(BadRequestException);
        expect(recorded).toEqual([]);
        expect(logins(await cw.assignees(...at))).toEqual(['octocat']);
      }
    });

    it('answers the envelope first, whatever the body says', async () => {
      const { c: off } = controller({ writeEnabled: false });
      await expect(off.changeAssignees(...at, { add: 'nonsense' } as never, authed)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const { c: cw } = controller({ writeEnabled: true });
      await expect(
        cw.changeAssignees('some-other-org', 'x', '218', { add: 'nonsense' } as never, authed),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('owner-pins and number-checks the fresh read, and 404s a missing issue', async () => {
      const { c: cr, service } = controller();
      const read = vi.spyOn(service, 'currentAssignees');
      await expect(cr.assignees('evilcorp', 'acme', '218')).rejects.toBeInstanceOf(NotFoundException);
      expect(read).not.toHaveBeenCalled();
      await expect(cr.assignees('acme', 'acme', 'abc')).rejects.toBeInstanceOf(BadRequestException);
      await expect(cr.assignees('acme', 'acme', '9999')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('native facet mutations (#384)', () => {
    it('setState closed reflects on the next read + audits the real target', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      const res = await cw.setState('acme', 'acme', '218', { state: 'closed' }, authed);
      expect(res).toEqual({ state: 'closed' });
      expect((await cw.issue('acme', 'acme', '218')).state).toBe('closed');
      expect(recorded).toEqual([
        expect.objectContaining({
          action: 'issue.state',
          actorEmail: 'octocat@example.com',
          targetType: 'issue',
          targetId: 'acme/acme#218',
        }),
      ]);
    });

    it('setLabels replaces the whole set and echoes GitHub-stored labels', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      const res = await cw.setLabels('acme', 'acme', '218', { names: ['bug'] }, authed);
      expect(res.labels.map((l) => l.name)).toEqual(['bug']);
      expect((await cw.issue('acme', 'acme', '218')).labels.map((l) => l.name)).toEqual(['bug']);
    });

    it('setAssignees returns GitHub\'s coerced subset, dropping a non-assignable login (B2)', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      const res = await cw.setAssignees('acme', 'acme', '218', { logins: ['octocat', 'ghost'] }, authed);
      // 'ghost' is not repo-assignable → the fixture drops it, proving the echo is
      // GitHub-truth not the client's input.
      expect(res.assignees.map((a) => a.login)).toEqual(['octocat']);
      expect((await cw.issue('acme', 'acme', '218')).assignees.map((a) => a.login)).toEqual(['octocat']);
    });

    it('setAssignees audits the ACCEPTED set, not the request (#751)', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await cw.setAssignees('acme', 'acme', '218', { logins: ['octocat', 'ghost'] }, authed);
      expect(recorded).toHaveLength(1);
      // Who holds it now has to be readable off the row: without this the summary
      // is 'Set assignees on acme/acme#218' and names nobody.
      expect(recorded[0].summary).toContain('octocat');
      // 'ghost' was in the request and Github dropped it, so a row naming it
      // would be a record of something that did not happen.
      expect(recorded[0].summary).not.toContain('ghost');
    });

    it('setAssignees records an emptied set as nobody, not as a blank (#751)', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await cw.setAssignees('acme', 'acme', '218', { logins: [] }, authed);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].summary).toContain('nobody');
    });

    it('setMilestone clears when given null', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      const res = await cw.setMilestone('acme', 'acme', '218', { milestoneNumber: null }, authed);
      expect(res).toEqual({ milestone: null });
    });

    it('503s a native write when GITHUB_WRITE_ENABLED is off, recording nothing', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: false });
      await expect(
        cw.setAssignees('acme', 'acme', '218', { logins: [] }, authed),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(recorded).toEqual([]);
    });

    it('404s a native write for an owner outside the mirrored org', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      await expect(
        cw.setState('evilcorp', 'acme', '218', { state: 'open' }, authed),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a native write on an unknown issue, recording nothing', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await expect(
        cw.setLabels('acme', 'acme', '9999', { names: ['bug'] }, authed),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(recorded).toEqual([]);
    });
  });

  describe('body task-list toggle (#426)', () => {
    // The fixture body's checklist sits at raw source lines 23 (`- [x] Reproduce
    // on a labeled PR`) and 24 (`- [ ] Make the skipped apply step fail loud`) —
    // the toggle is addressed by 1-based source line, not occurrence index.
    it('checks the addressed body-task line, reflects on the next read + echoes the resulting body, audits the real target', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      const res = await cw.toggleTask('acme', 'acme', '218', { line: 24, checked: true }, authed);
      expect(res.bodyMarkdown).toContain('- [x] Make the skipped apply step fail loud');
      // B2 — the echoed body is GitHub's truth, and a cold read matches it.
      expect((await cw.issue('acme', 'acme', '218')).bodyMarkdown).toContain(
        '- [x] Make the skipped apply step fail loud',
      );
      expect(recorded).toEqual([
        expect.objectContaining({
          action: 'issue.body.task',
          actorEmail: 'octocat@example.com',
          targetType: 'issue',
          targetId: 'acme/acme#218',
        }),
      ]);
    });

    it('unchecks an already-checked body task by its line', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      const res = await cw.toggleTask('acme', 'acme', '218', { line: 23, checked: false }, authed);
      expect(res.bodyMarkdown).toContain('- [ ] Reproduce on a labeled PR');
    });

    it('400s when the addressed line is not a task-list item, recording nothing', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await expect(
        cw.toggleTask('acme', 'acme', '218', { line: 1, checked: true }, authed),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        cw.toggleTask('acme', 'acme', '218', { line: 9999, checked: true }, authed),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(recorded).toEqual([]);
    });

    it('503s a body-task toggle when GITHUB_WRITE_ENABLED is off, recording nothing', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: false });
      await expect(
        cw.toggleTask('acme', 'acme', '218', { line: 23, checked: true }, authed),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(recorded).toEqual([]);
    });

    it('401s a body-task toggle without a session email', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      await expect(
        cw.toggleTask('acme', 'acme', '218', { line: 23, checked: true }, {}),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('404s a body-task toggle on an unknown issue, recording nothing', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await expect(
        cw.toggleTask('acme', 'acme', '9999', { line: 23, checked: true }, authed),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(recorded).toEqual([]);
    });

    it('404s a body-task toggle for an owner outside the mirrored org', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      await expect(
        cw.toggleTask('evilcorp', 'acme', '218', { line: 23, checked: true }, authed),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is human-only: the route carries HumanOnlyGuard (no agent/PAT toggles a body)', () => {
      const guards = Reflect.getMetadata('__guards__', IssueDetailController.prototype.toggleTask) as unknown[];
      expect(guards).toContain(HumanOnlyGuard);
    });
  });

  describe('comment on an issue (#693)', () => {
    it('gives a personal comment the full GitHub body limit', async () => {
      const { c } = controller({ writeEnabled: true });
      const principal: GithubPrincipal = {
        key: 'alice', email: authed.user.email, login: 'alice', token: 'personal-token',
        owners: [{ login: 'acme', type: 'Organization' }], repositories: [], cache: new WeakMap(),
      };
      await githubContext.run({ principal }, async () => {
        const post = (bodyMarkdown: string) => c.postComment('acme', 'acme', '218', { bodyMarkdown }, authed);
        expect((await post('x'.repeat(COMMENT_BODY_MAX))).bodyMarkdown).toHaveLength(COMMENT_BODY_MAX);
        await expect(post('x'.repeat(COMMENT_BODY_MAX + 1))).rejects.toThrow('GitHub’s limit');
      });
    });

    it.each([true, false])('uses credential ownership for comment attribution (personal=%s)', async (personal) => {
      const { c } = controller({ writeEnabled: true });
      const principal: GithubPrincipal = {
        key: 'alice', email: authed.user.email, login: 'alice', token: 'personal-token',
        owners: [{ login: 'acme', type: 'Organization' }], repositories: [], cache: new WeakMap(),
      };
      const post = () => c.postComment('acme', 'acme', '218', { bodyMarkdown: '  Answered.\n' }, authed);
      const result = personal ? await githubContext.run({ principal }, post) : await post();
      expect(result.bodyMarkdown).toBe(personal ? '  Answered.\n' : `${commentFooter(authed.user.email)}\n\n  Answered.\n`);
    });

    it('posts the comment, hands back what Github stored, and the next read carries it in the thread', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      const before = (await cw.issue('acme', 'acme', '218')).comments;
      expect(before).toHaveLength(3);
      const res = await cw.postComment(
        'acme',
        'acme',
        '218',
        { bodyMarkdown: 'Answered from the board: **the quota is raised**.' },
        authed,
      );
      // The board's footer, then the author's markdown untouched under it —
      // what Github stored, so the page draws the comment a Github reader sees.
      // The footer leads because nothing downstream of it can swallow it (#693).
      expect(res.bodyMarkdown).toBe(
        `\u2014 ${authed.user.email} via the board\n\nAnswered from the board: **the quota is raised**.`,
      );
      expect(res.createdAt).toEqual(expect.any(String));
      expect(res.htmlUrl).toContain('#issuecomment-');
      // B2 — the echo is the source's answer, and the issue's thread now ends
      // with exactly it, so what the page appends is what a reload will show.
      //
      // NOT the eviction: `FixtureIssueDetailSource` hands out the same object
      // it stores, so this read would find the comment whether or not the cache
      // was dropped. That one is measured by fetch count in
      // `issue-detail.service.spec.ts` — "a posted comment drops this issue's
      // cached detail".
      const thread = (await cw.issue('acme', 'acme', '218')).comments;
      expect(thread).toHaveLength(4);
      expect(thread.at(-1)).toEqual(res);
      expect(recorded).toEqual([
        expect.objectContaining({
          action: 'issue.comment',
          actorEmail: 'octocat@example.com',
          targetType: 'issue',
          targetId: 'acme/acme#218',
        }),
      ]);
    });

    it('400s a whitespace-only body, recording nothing and writing nothing', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      const before = (await cw.issue('acme', 'acme', '218')).comments.length;
      for (const bodyMarkdown of ['', '   ', '\n\t \n']) {
        await expect(
          cw.postComment('acme', 'acme', '218', { bodyMarkdown }, authed),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(recorded).toEqual([]);
      expect((await cw.issue('acme', 'acme', '218')).comments).toHaveLength(before);
    });

    it('the cap counts what is SENT, footer included, so nothing becomes a Github 422', async () => {
      // The footer is appended server-side, so the author's budget is the cap
      // MINUS it. Counting only the author's text would let a body that fits
      // arrive over the limit and come back a 422 — an upstream failure the page
      // can only read as the board breaking.
      const { c: cw, recorded } = controller({ writeEnabled: true });
      const room = maxAuthorBody(authed.user.email);
      expect(room).toBeLessThan(COMMENT_BODY_MAX); // the footer really does cost something

      await expect(
        cw.postComment('acme', 'acme', '218', { bodyMarkdown: 'x'.repeat(room + 1) }, authed),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(recorded).toEqual([]);

      // Inclusive at the boundary, and what lands is exactly the cap: the
      // author's whole text plus the footer, with nothing to spare.
      const ok = await cw.postComment(
        'acme',
        'acme',
        '218',
        { bodyMarkdown: 'x'.repeat(room) },
        authed,
      );
      expect(ok.bodyMarkdown).toHaveLength(COMMENT_BODY_MAX);
      expect(ok.bodyMarkdown.startsWith(commentFooter(authed.user.email))).toBe(true);
    });

    it('signs the comment with the SESSION\u2019s address, on its own line above their text', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      const res = await cw.postComment(
        'acme',
        'acme',
        '218',
        { bodyMarkdown: 'The quota is raised.' },
        authed,
      );
      expect(res.bodyMarkdown).toBe(
        `\u2014 ${authed.user.email} via the board\n\nThe quota is raised.`,
      );
      // What comes back is what Github stored, so the thread the page draws and
      // the thread a Github reader sees are the same comment.
      const thread = (await cw.issue('acme', 'acme', '218')).comments;
      expect(thread.at(-1)?.bodyMarkdown).toBe(res.bodyMarkdown);
    });

    it('the address is the session\u2019s and no request body can name another', async () => {
      // The forgery: a hand-typed line in the author's own text, shaped like the
      // board's footer and naming somebody else. It is refused rather than
      // stripped — see `assertUnsigned`.
      const { c: cw, recorded } = controller({ writeEnabled: true });
      for (const forged of [
        'nasty\n\n\u2014 ceo@example.com via the board',
        '\u2014 ceo@example.com via the board',
        '  \u2014 ceo@example.com via the board  ',
        // Their OWN address is refused too: the board owns this line, not the
        // person, and a duplicate footer is as misleading as a forged one.
        `hi\n\n\u2014 ${authed.user.email} via the board`,
      ]) {
        await expect(
          cw.postComment('acme', 'acme', '218', { bodyMarkdown: forged }, authed),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(recorded).toEqual([]);
    });

    it('a QUOTED footer is somebody\u2019s words, and is kept', async () => {
      // Replying to a comment by quoting it is ordinary, and Github quotes with
      // a leading `>`. The refusal above is anchored to the line's start, so a
      // quote survives it — otherwise answering a comment would be impossible.
      const { c: cw } = controller({ writeEnabled: true });
      const quoting = `> \u2014 ceo@example.com via the board\n\nAgreed.`;
      const res = await cw.postComment('acme', 'acme', '218', { bodyMarkdown: quoting }, authed);
      expect(res.bodyMarkdown).toBe(`\u2014 ${authed.user.email} via the board\n\n${quoting}`);
    });

    it('503s when GITHUB_WRITE_ENABLED is off, recording nothing', async () => {
      const { c: cw, recorded } = controller();
      await expect(
        cw.postComment('acme', 'acme', '218', { bodyMarkdown: 'hi' }, authed),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(recorded).toEqual([]);
    });

    it('401s without a session email', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      await expect(
        cw.postComment('acme', 'acme', '218', { bodyMarkdown: 'hi' }, {}),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('404s on an unknown issue, recording nothing', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await expect(
        cw.postComment('acme', 'acme', '9999', { bodyMarkdown: 'hi' }, authed),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(recorded).toEqual([]);
    });

    it('404s for an owner outside the mirrored org (blast-radius cap)', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await expect(
        cw.postComment('evilcorp', 'acme', '218', { bodyMarkdown: 'hi' }, authed),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(recorded).toEqual([]);
    });

    it('400s a non-numeric issue number before touching writes', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: true });
      await expect(
        cw.postComment('acme', 'acme', 'abc', { bodyMarkdown: 'hi' }, authed),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(recorded).toEqual([]);
    });

    it('signs ABOVE the author\u2019s text, so nothing they write can swallow the signature', async () => {
      // Markdown parses forward. With the footer LAST, a body ending in an
      // unterminated `<!--` opens an HTML block CommonMark runs to end of
      // document and Github's sanitiser then drops whole; a trailing `<details>`
      // hides the footer behind a toggle; a trailing fence demotes it into a code
      // block. All three were rendered through Github's own POST /markdown and
      // the signature was gone or unreadable. A block that PRECEDES the author's
      // text cannot be reached by any of them.
      const { c: cw } = controller({ writeEnabled: true });
      const footer = commentFooter(authed.user.email);
      for (const hostile of [
        'The quota is raised.\n\n<!--',
        'The quota is raised.\n\n<details><summary>more</summary>',
        'The quota is raised.\n\n```',
      ]) {
        const res = await cw.postComment('acme', 'acme', '218', { bodyMarkdown: hostile }, authed);
        expect(res.bodyMarkdown, JSON.stringify(hostile)).toBe(`${footer}\n\n${hostile}`);
      }
    });

    it('refuses a forged footer written as an HTML ENTITY or wrapped in a tag', async () => {
      // The refusal has to be measured against what RENDERS, not against the
      // source bytes. Each of these was rendered through Github's own POST
      // /markdown and came back a line pixel-identical to the board's footer,
      // and react-markdown decodes the same entities in the board's own thread.
      const { c: cw, recorded } = controller({ writeEnabled: true });
      for (const forged of [
        '&mdash; ceo@example.com via the board',
        '&#8212; ceo@example.com via the board',
        '&#08212; ceo@example.com via the board', // leading zeros decode too
        '&#x2014; ceo@example.com via the board',
        '&#X2014; ceo@example.com via the board', // an uppercase X decodes too
        '<p>\u2014 ceo@example.com via the board</p>',
        '\u2014 ceo@example.com via the b<span></span>oard', // a tag splitting the tail
        '\u2014 ceo@example.com via the b&#111;ard', // an entity inside the tail
        '*\u2014 ceo@example.com via the board*', // italic, and still the line
        '\u2015 ceo@example.com via the board', // U+2015, an em dash to the eye
      ]) {
        await expect(
          cw.postComment('acme', 'acme', '218', { bodyMarkdown: forged }, authed),
          JSON.stringify(forged),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(recorded).toEqual([]);
    });

    it('still leaves ordinary prose and a quoted footer alone', async () => {
      // The floor under the widening above: a matcher that refused everything
      // would pass every assertion in the test before this one.
      const { c: cw } = controller({ writeEnabled: true });
      for (const innocent of [
        '> \u2014 ceo@example.com via the board\n\nAgreed.',
        // Nested markup Github draws with the leftover VISIBLE — it renders
        // `p>\u2014 ceo@\u2026` and `-- x -->\u2014 ceo@\u2026`, neither of which is the
        // board's line. Refusing them would be a 400 on prose.
        '<<p>p>\u2014 ceo@example.com via the board',
        '<!<p>-- x -->\u2014 ceo@example.com via the board',
        '&amp;mdash; is how you write an em dash entity without one appearing.',
        '&mdash is missing its semicolon, so it renders as those seven characters via the board.',
        'Filed via the board earlier today.',
        '\u2014 Ivan',
      ]) {
        const res = await cw.postComment('acme', 'acme', '218', { bodyMarkdown: innocent }, authed);
        expect(res.bodyMarkdown, JSON.stringify(innocent)).toBe(
          `${commentFooter(authed.user.email)}\n\n${innocent}`,
        );
      }
    });

    it('records WHICH Github comment the row produced, so several on one issue stay apart', async () => {
      // Actor, action, issue and timestamp cannot say which board user wrote
      // which Github comment once an issue has two. The permalink can, and it is
      // in hand the moment the write returns.
      const { c: cw, recorded } = controller({ writeEnabled: true });
      const first = await cw.postComment('acme', 'acme', '218', { bodyMarkdown: 'One.' }, authed);
      const second = await cw.postComment('acme', 'acme', '218', { bodyMarkdown: 'Two.' }, authed);
      expect(first.htmlUrl).not.toBe(second.htmlUrl);
      expect(recorded).toHaveLength(2);
      expect(recorded[0].summary).toContain(first.htmlUrl!);
      expect(recorded[1].summary).toContain(second.htmlUrl!);
      expect(recorded[0].summary).not.toContain(second.htmlUrl!);
    });

    it('refuses in sentences a person can read, naming the real numbers', async () => {
      // These three strings are shown verbatim in the browser — the service is
      // the only place the real reason lives. They are the only copy on that
      // page not written for a reader.
      const { c: cw } = controller({ writeEnabled: true });
      const room = maxAuthorBody(authed.user.email);
      const said = async (bodyMarkdown: string) => {
        const err = await cw
          .postComment('acme', 'acme', '218', { bodyMarkdown }, authed)
          .catch((e: BadRequestException) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        return (err as BadRequestException).message;
      };
      const messages = [
        await said('   '),
        await said('\u2014 ceo@example.com via the board'),
        await said('x'.repeat(room + 1)),
      ];
      for (const m of messages) {
        expect(m[0], m).toBe(m[0].toUpperCase()); // a capital opener
        expect(m.endsWith('.'), m).toBe(true); // a full stop
        expect(/[<>]/.test(m), m).toBe(false); // no placeholder syntax
      }
      // The cap sentence quotes the room the author actually has, and how far
      // over it they are — both numbers, not a rule to work out.
      expect(messages[2]).toContain(String(room));
      expect(messages[2]).toContain(String(room + 1));
    });

    it('is human-only: the route carries HumanOnlyGuard (no agent/PAT answers in a human\u2019s name)', () => {
      const guards = Reflect.getMetadata('__guards__', IssueDetailController.prototype.postComment) as unknown[];
      // `toContain` passes against an `undefined` actual when the expected is a
      // class, so the array itself is asserted first.
      expect(Array.isArray(guards)).toBe(true);
      expect(guards).toContain(HumanOnlyGuard);
    });
  });

  describe('project membership + custom-field writes (#384 Task 7)', () => {
    it('setField updates the issue project value + audits fieldId (B2 echo)', async () => {
      const { c: cw, recorded, service } = controller({ writeEnabled: true });
      const before = (await service.getIssue('acme', 'acme', 218))!.projects[0];
      const res = await cw.setField(
        'acme',
        'acme',
        '218',
        { projectId: before.projectId, itemId: before.itemId, fieldId: before.fields[0].fieldId, value: { kind: 'single_select', optionId: 'opt_todo' } },
        authed,
      );
      expect(res).toEqual({ value: { kind: 'single_select', optionId: 'opt_todo' } });
      const after = (await service.getIssue('acme', 'acme', 218))!.projects[0];
      expect(after.values[before.fields[0].fieldId]).toEqual({ kind: 'single_select', optionId: 'opt_todo' });
      expect(recorded).toEqual([
        expect.objectContaining({
          action: 'issue.field',
          actorEmail: 'octocat@example.com',
          targetType: 'issue',
          targetId: 'acme/acme#218',
        }),
      ]);
    });

    it('B1: field-set on a projectId the issue is NOT a member of → 404, recording nothing and writing nothing', async () => {
      const { c: cw, recorded, service } = controller({ writeEnabled: true });
      const before = (await service.getIssue('acme', 'acme', 218))!.projects[0];
      const valuesBefore = structuredClone(before.values);
      await expect(
        cw.setField(
          'acme',
          'acme',
          '218',
          { projectId: 'PVT_foreign', itemId: 'ITEM_foreign', fieldId: 'F1', value: { kind: 'text', text: 'x' } },
          authed,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(recorded).toEqual([]);
      // Prove the reject is a true no-write, not just a thrown status: the
      // issue's real project field values are byte-for-byte unchanged.
      const after = (await service.getIssue('acme', 'acme', 218))!.projects[0];
      expect(after.values).toEqual(valuesBefore);
    });

    it('B1: field-set with a real projectId but a foreign itemId → 404 (cross-item tampering)', async () => {
      const { c: cw, service } = controller({ writeEnabled: true });
      const before = (await service.getIssue('acme', 'acme', 218))!.projects[0];
      await expect(
        cw.setField(
          'acme',
          'acme',
          '218',
          { projectId: before.projectId, itemId: 'ITEM_foreign', fieldId: before.fields[0].fieldId, value: { kind: 'text', text: 'x' } },
          authed,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('B1: add-to-project on a project owned outside PROJECTS_OWNER → 404, recording nothing and writing nothing', async () => {
      const { c: cw, recorded, service } = controller({ writeEnabled: true });
      await expect(
        cw.addProject('acme', 'acme', '218', { projectId: 'PVT_evil' }, authed),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(recorded).toEqual([]);
      // Prove the reject is a true no-write: no PVT_evil membership was appended.
      expect(
        (await service.getIssue('acme', 'acme', 218))!.projects.some((p) => p.projectId === 'PVT_evil'),
      ).toBe(false);
    });

    it('addProject adds the issue to a project owned by PROJECTS_OWNER and audits projectId', async () => {
      const { c: cw, recorded, service } = controller({ writeEnabled: true });
      const before = (await service.getIssue('acme', 'acme', 218))!;
      const seededProjectId = before.projects[0].projectId;
      const res = await cw.addProject('acme', 'acme', '218', { projectId: seededProjectId }, authed);
      expect(typeof res.itemId).toBe('string');
      expect(res.itemId.length).toBeGreaterThan(0);
      const after = (await service.getIssue('acme', 'acme', 218))!;
      expect(after.projects.some((p) => p.itemId === res.itemId && p.projectId === seededProjectId)).toBe(true);
      expect(recorded).toEqual([
        expect.objectContaining({ action: 'issue.project.add', targetId: 'acme/acme#218' }),
      ]);
    });

    it('#404: adds the issue to a projects-catalog board id (PVT_fixture_*), not only the seeded one', async () => {
      // The add picker offers boards from GET /api/projects/catalog, whose fixture
      // ids are `PVT_fixture_<n>` — a different id space than the issue's seeded
      // membership. Regression for the live 404: the fixture owner-pin must resolve
      // those catalog ids to PROJECTS_OWNER (as real GitHub does for any board under
      // the org), or picking a candidate rejects with "project … not found".
      const { c: cw, recorded, service } = controller({ writeEnabled: true });
      const res = await cw.addProject('acme', 'acme', '218', { projectId: 'PVT_fixture_7' }, authed);
      expect(res.itemId.length).toBeGreaterThan(0);
      const after = (await service.getIssue('acme', 'acme', 218))!;
      expect(after.projects.some((p) => p.projectId === 'PVT_fixture_7')).toBe(true);
      expect(recorded).toEqual([
        expect.objectContaining({ action: 'issue.project.add', targetId: 'acme/acme#218' }),
      ]);
    });

    it('removeProject removes a real membership and audits projectId', async () => {
      const { c: cw, recorded, service } = controller({ writeEnabled: true });
      const before = (await service.getIssue('acme', 'acme', 218))!.projects[0];
      const res = await cw.removeProject(
        'acme',
        'acme',
        '218',
        { projectId: before.projectId, itemId: before.itemId },
        authed,
      );
      expect(res).toEqual({ ok: true });
      const after = (await service.getIssue('acme', 'acme', 218))!;
      expect(after.projects.some((p) => p.itemId === before.itemId)).toBe(false);
      expect(recorded).toEqual([
        expect.objectContaining({ action: 'issue.project.remove', targetId: 'acme/acme#218' }),
      ]);
    });

    it('B1: project-remove on a membership the issue does not hold → 404', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      await expect(
        cw.removeProject('acme', 'acme', '218', { projectId: 'PVT_foreign', itemId: 'ITEM_foreign' }, authed),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('503s a project write when GITHUB_WRITE_ENABLED is off, recording nothing', async () => {
      const { c: cw, recorded } = controller({ writeEnabled: false });
      await expect(
        cw.addProject('acme', 'acme', '218', { projectId: 'PVT_kwDOAboardhardening' }, authed),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(recorded).toEqual([]);
    });
  });

  describe('a new project from the issue page (#982)', () => {
    const made = async (service: IssueDetailService) =>
      (await service.getIssue('acme', 'acme', 218))!.projects.map((p) => p.title);

    it('makes the project under the issue’s owner, puts the issue on it, and records both writes in order', async () => {
      const { c: cw, recorded, service } = controller({ writeEnabled: true });
      const res = await cw.createProject('acme', 'acme', '218', { title: '  Launch week  ' }, authed);
      expect(res.project).toEqual(expect.objectContaining({ title: 'Launch week', owner: 'acme' }));
      expect(res.itemId.length).toBeGreaterThan(0);
      const after = (await service.getIssue('acme', 'acme', 218))!;
      expect(after.projects.some((p) => p.projectId === res.project.id && p.itemId === res.itemId)).toBe(true);
      expect(recorded.map((r) => r.action)).toEqual(['issue.project.create', 'issue.project.add']);
      expect(recorded[0].summary).toBe(
        `Made a project from acme/acme#218 (Launch week, project ${res.project.number} of acme)`,
      );
      expect(recorded[1].summary).toContain(res.project.id);
    });

    it('400s a blank or missing name, making nothing and recording nothing', async () => {
      const { c: cw, recorded, service } = controller({ writeEnabled: true });
      const before = await made(service);
      for (const body of [{ title: '   ' }, { title: 42 }, {}, undefined]) {
        await expect(cw.createProject('acme', 'acme', '218', body, authed)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(recorded).toEqual([]);
      expect(await made(service)).toEqual(before);
    });

    it('409s a name a board of that owner already carries, naming that board, whatever its case', async () => {
      const { c: cw, recorded, service } = controller({ writeEnabled: true });
      const before = await made(service);
      const thrown = await cw
        .createProject('acme', 'acme', '218', { title: 'acme go-to-market' }, authed)
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).getResponse()).toEqual({
        message:
          'acme already has a project called “Acme Go-To-Market”. Choose another name, or add this issue to that project.',
        project: { id: 'PVT_fixture_7', number: 7, title: 'Acme Go-To-Market', owner: 'acme' },
      });
      expect(recorded).toEqual([]);
      expect(await made(service)).toEqual(before);
    });

    it('a second create of a name the owner now has is a 409, where the read finds it', async () => {
      const { c: cw } = controller({ writeEnabled: true });
      await cw.createProject('acme', 'acme', '218', { title: 'Launch week' }, authed);
      await expect(
        cw.createProject('acme', 'acme', '218', { title: 'Launch week' }, authed),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers the envelope first, whatever the name says', async () => {
      const off = controller({ writeEnabled: false });
      await expect(off.c.createProject('acme', 'acme', '218', { title: '' }, authed)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const on = controller({ writeEnabled: true });
      await expect(on.c.createProject('evilcorp', 'acme', '218', { title: 'x' }, authed)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(on.c.createProject('acme', 'acme', '218', { title: 'x' }, { user: {} })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect([...off.recorded, ...on.recorded]).toEqual([]);
    });

    it('makes nothing when the add is already known to be refused, so no empty project is left behind', async () => {
      const { c: cw, recorded, service, registry } = controller({ writeEnabled: true });
      registry.recordRefusal(
        'issue.project.add',
        { reason: 'not-permitted', message: 'refused', scope: 'target', retryable: false },
        'acme/acme',
      );
      const create = vi.spyOn(service, 'createProject');
      await expect(
        cw.createProject('acme', 'acme', '218', { title: 'Launch week' }, authed),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(create).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    });

    it('when the add fails after the project was made, says it was made, keeps the add’s status, and records only the create', async () => {
      const { c: cw, recorded, source } = controller({ writeEnabled: true });
      vi.spyOn(source, 'addToProject').mockRejectedValue(
        new HttpException(
          { message: 'GitHub refused this write on acme/acme: the board is not permitted to do it.', reason: 'not-permitted' },
          403,
        ),
      );
      const thrown = await cw
        .createProject('acme', 'acme', '218', { title: 'Launch week' }, authed)
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(403);
      expect((thrown as HttpException).getResponse()).toEqual({
        message:
          'The project “Launch week” was made in acme, but this issue could not be added to it. GitHub refused this write on acme/acme: the board is not permitted to do it.',
        reason: 'not-permitted',
        project: expect.objectContaining({ title: 'Launch week', owner: 'acme' }),
      });
      expect(recorded.map((r) => r.action)).toEqual(['issue.project.create']);
    });

    it('is human-only and declares both writes it makes', () => {
      const guards = Reflect.getMetadata('__guards__', IssueDetailController.prototype.createProject);
      expect(Array.isArray(guards)).toBe(true);
      expect(guards).toContain(HumanOnlyGuard);
      expect(Reflect.getMetadata(WRITES_CAPABILITY, IssueDetailController.prototype.createProject)).toEqual([
        'issue.project.create',
        'issue.project.add',
      ]);
    });

    // The fixture numbers the projects it makes from 100, so a project made by
    // mistake would answer this lookup.
    const madeAny = (source: FixtureIssueDetailSource) => source.projectOwnerLogin('PVT_made_100');

    it('404s an issue that is not there, and makes no project', async () => {
      const { c: cw, recorded, source } = controller({ writeEnabled: true });
      await expect(
        cw.createProject('acme', 'acme', '99999', { title: 'Launch week' }, authed),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(recorded).toEqual([]);
      await expect(madeAny(source)).resolves.toBeNull();
    });

    it('400s a name that is too long, runs over a line, or is one the board hides, making nothing', async () => {
      const { c: cw, recorded, source } = controller({ writeEnabled: true });
      for (const title of ['x'.repeat(257), 'Launch\nweek', 'Acme', 'Untitled plan']) {
        await expect(cw.createProject('acme', 'acme', '218', { title }, authed)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(recorded).toEqual([]);
      await expect(madeAny(source)).resolves.toBeNull();
    });

    it('when the add throws something that is not an HTTP answer, logs it, answers 502 with the project, and drops the catalog', async () => {
      const { c: cw, recorded, source, freshness } = controller({ writeEnabled: true });
      vi.spyOn(source, 'addToProject').mockRejectedValue(new Error('socket hang up'));
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      try {
        const thrown = await cw
          .createProject('acme', 'acme', '218', { title: 'Launch week' }, authed)
          .catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(HttpException);
        expect((thrown as HttpException).getStatus()).toBe(502);
        expect((thrown as HttpException).getResponse()).toEqual({
          message: 'The project “Launch week” was made in acme, but this issue could not be added to it.',
          project: expect.objectContaining({ title: 'Launch week', owner: 'acme' }),
        });
        expect(recorded.map((r) => r.action)).toEqual(['issue.project.create']);
        expect(freshness.invalidateAll).toHaveBeenCalledWith(['issue.project.create']);
        expect(logged.mock.calls.some(([line]) => String(line).includes('socket hang up'))).toBe(true);
      } finally {
        logged.mockRestore();
      }
    });

    it('refuses a second create of the same name while the first is still being made', async () => {
      const { c: cw, source } = controller({ writeEnabled: true });
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const real = source.createProject.bind(source);
      vi.spyOn(source, 'createProject').mockImplementation(async (o, r, n, t) => {
        await held;
        return real(o, r, n, t);
      });
      const first = cw.createProject('acme', 'acme', '218', { title: 'Launch week' }, authed);
      await expect(
        cw.createProject('acme', 'acme', '218', { title: 'launch WEEK' }, authed),
      ).rejects.toBeInstanceOf(ConflictException);
      release();
      await expect(first).resolves.toEqual(expect.objectContaining({ project: expect.objectContaining({ title: 'Launch week' }) }));
    });
  });

  describe('edit-options (#384)', () => {
    it('edit-options returns repo labels + open milestones', async () => {
      const { c } = controller();
      const opts = await c.editOptions('acme', 'acme');
      expect(opts.labels.some((l) => l.name === 'bug')).toBe(true);
      expect(Array.isArray(opts.milestones)).toBe(true);
    });

    it('edit-options 404 off-org', async () => {
      const { c } = controller();
      await expect(c.editOptions('evilcorp', 'acme')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('personal text edits (#1379)', () => {
  const principal = { key: 'edit', token: 'personal', cache: new WeakMap(), owners: [{ login: 'acme', type: 'Organization' }], repositories: [], email: authed.user.email } as unknown as GithubPrincipal;
  const input = { bodyMarkdown: 'Revised words', expectedBody: 'Original words', commentId: 12 };
  it('uses the comment guard and audits the edited target without adding a signature', async () => {
    const { c, service, recorded } = controller({ writeEnabled: true });
    const edit = vi.spyOn(service, 'editText').mockResolvedValue({ bodyMarkdown: 'Revised words' });
    await githubContext.run({ principal }, () => c.editText('acme', 'acme', '218', input, authed));
    expect(edit).toHaveBeenCalledWith('acme', 'acme', 218, 'Revised words', 'Original words', 12);
    expect(recorded).toMatchObject([{ action: 'issue.comment', summary: 'Edited text on acme/acme#218 (comment 12)' }]);
    expect(Reflect.getMetadata('__guards__', IssueDetailController.prototype.editText)).toContain(HumanOnlyGuard);
    expect(Reflect.getMetadata(WRITES_CAPABILITY, IssueDetailController.prototype.editText)).toEqual(['issue.comment']);
  });
  it('rejects shared credentials, invalid targets, and writes-off before changing anything', async () => {
    const { c, service, recorded } = controller({ writeEnabled: true });
    const edit = vi.spyOn(service, 'editText');
    await expect(c.editText('acme', 'acme', '218', input, authed)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.editText('outside', 'acme', '218', input, authed)).rejects.toBeInstanceOf(NotFoundException);
    await githubContext.run({ principal }, async () => {
      await expect(c.editText('acme', 'acme', '218', { ...input, commentId: -1 }, authed)).rejects.toBeInstanceOf(BadRequestException);
    });
    expect(edit).not.toHaveBeenCalled(); expect(recorded).toEqual([]);
  });
  it('gives the length limit without writing or auditing an oversized edit', async () => {
    const { c, service, recorded } = controller({ writeEnabled: true });
    const edit = vi.spyOn(service, 'editText');
    await githubContext.run({ principal }, async () => {
      await expect(c.editText('acme', 'acme', '218',
        { ...input, bodyMarkdown: 'x'.repeat(COMMENT_BODY_MAX + 1) }, authed))
        .rejects.toThrow(`Shorten the text to ${COMMENT_BODY_MAX} characters or fewer.`);
    });
    expect(edit).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });
  it('does not audit a failed edit', async () => {
    const { c, service, recorded } = controller({ writeEnabled: true });
    vi.spyOn(service, 'editText').mockRejectedValue(new ConflictException());
    await githubContext.run({ principal }, async () => {
      await expect(c.editText('acme', 'acme', '218', input, authed)).rejects.toBeInstanceOf(ConflictException);
    });
    expect(recorded).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import type { AccessModel, AdminAccessService } from './admin-access.service';
import type { AgentsModel } from './agents';
import type { AgentsService } from './agents.service';
import type { AuditService } from '../audit/audit.service';
import type { AuditEventRow, AuditHealth } from '../audit/audit.types';
import type { WriteIdentity, WriteIdentityService } from '../sources/write-identity.service';

const HEALTHY: AuditHealth = {
  recording: 'ok',
  failures: 0,
  lastFailureAt: null,
  instance: 'abc12345',
  since: '2026-09-02T00:00:00.000Z',
  gaps: { events: 0, lastAt: null },
};
const audit = { record: async () => {}, list: async () => [], health: async () => HEALTHY } as unknown as AuditService;
const IDENTITY: WriteIdentity = {
  state: 'resolved',
  login: 'board-bot',
  reason: null,
  checkedAt: '2026-09-01T00:00:00.000Z',
  writesEnabled: true,
  separateWriteToken: true,
};
const writeIdentity = { resolve: async () => IDENTITY } as unknown as WriteIdentityService;
const REQ = { user: { email: 'admin@x.io' } };

describe('AdminController (#11, #183)', () => {
  it('delegates access to AdminAccessService.getModel', async () => {
    const model = { admins: [], people: [], health: [], rosterUnavailable: false } as unknown as AccessModel;
    let called = 0;
    const access = {
      getModel: async () => {
        called += 1;
        return model;
      },
    } as unknown as AdminAccessService;
    const agents = { getModel: () => ({}) as AgentsModel } as unknown as AgentsService;
    const ctl = new AdminController(access, agents, audit, writeIdentity);
    await expect(ctl.getAccess()).resolves.toBe(model);
    expect(called).toBe(1);
  });

  it('delegates agents to AgentsService.getModel', async () => {
    const model = { scopes: [], presets: [], tools: [], mcpUrl: null, agents: [] } as AgentsModel;
    const access = { getModel: async () => ({}) } as unknown as AdminAccessService;
    const agents = { getModel: async () => model } as unknown as AgentsService;
    const ctl = new AdminController(access, agents, audit, writeIdentity);
    await expect(ctl.getAgents()).resolves.toBe(model);
  });

  it('revokes an agent token, 204 on success and 404 when nothing was live (#211)', async () => {
    const access = { getModel: async () => ({}) } as unknown as AdminAccessService;
    const calls: string[] = [];
    const agents = {
      revokeAgent: async (id: string) => {
        calls.push(id);
        return id === 'live';
      },
    } as unknown as AgentsService;
    const ctl = new AdminController(access, agents, audit, writeIdentity);
    await expect(ctl.revokeAgent('live', REQ)).resolves.toBeUndefined(); // 204, no throw
    await expect(ctl.revokeAgent('gone', REQ)).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toEqual(['live', 'gone']);
  });

  /**
   * The rows and the reason to doubt them travel together (#781). Two calls
   * could disagree — a log that filled in between them, a health read that
   * never happened — and an operator would be looking at rows with no caveat on
   * them, which is the state this issue is about.
   */
  it('answers the audit rows WITH the health of the trail that holds them', async () => {
    const rows = [
      { id: '1', at: new Date(), actorEmail: 'a@x.io', action: 'boot.alert', summary: 'Filed a boot error as #900', targetType: 'issue', targetId: '900' },
    ] as AuditEventRow[];
    const failing: AuditHealth = {
      recording: 'failing',
      failures: 2,
      lastFailureAt: '2026-09-02T00:00:00.000Z',
      instance: 'abc12345',
      since: '2026-09-02T00:00:00.000Z',
      gaps: { events: 1, lastAt: '2026-09-02T00:01:00.000Z' },
    };
    const access = { getModel: async () => ({}) } as unknown as AdminAccessService;
    const agents = { getModel: () => ({}) as AgentsModel } as unknown as AgentsService;
    const ctl = new AdminController(
      access,
      agents,
      { list: async () => rows, health: async () => failing } as unknown as AuditService,
      writeIdentity,
    );

    await expect(ctl.getAudit('a@x.io', 'boot.alert')).resolves.toEqual({ events: rows, health: failing });
  });

  it('passes the filters through untouched', async () => {
    const seen: unknown[] = [];
    const access = { getModel: async () => ({}) } as unknown as AdminAccessService;
    const agents = { getModel: () => ({}) as AgentsModel } as unknown as AgentsService;
    const ctl = new AdminController(
      access,
      agents,
      { list: async (f: unknown) => { seen.push(f); return []; }, health: async () => HEALTHY } as unknown as AuditService,
      writeIdentity,
    );

    await ctl.getAudit('bob', 'token.mint');
    expect(seen).toEqual([{ actor: 'bob', action: 'token.mint' }]);
  });

  it('delegates the write identity to WriteIdentityService.resolve (#756)', async () => {
    const access = { getModel: async () => ({}) } as unknown as AdminAccessService;
    const agents = { getModel: () => ({}) as AgentsModel } as unknown as AgentsService;
    const ctl = new AdminController(access, agents, audit, writeIdentity);
    await expect(ctl.getWriteIdentity()).resolves.toBe(IDENTITY);
  });
});

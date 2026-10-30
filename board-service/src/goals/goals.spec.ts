import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { AdminAuthority } from '../auth/admin-authority';
import { AuditService } from '../audit/audit.service';
import { GoalsController } from './goals.controller';
import { AdminGuard } from '../admin/admin.guard';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { GoalsService, goalLevels } from './goals.service';

const levels = (dailyGoal: unknown) => ({ dailyGoal, level2Goal: 500, level3Goal: 1000 });
const defaults = { dailyGoal: 100, level2Goal: 200, level3Goal: 300 };

const goals = { enabled: true, personal: vi.fn(async () => levels(100)), team: vi.fn(async () => levels(100)), savePersonal: vi.fn(async (_sub, n) => goalLevels(n)), saveTeam: vi.fn(async (_org, n) => goalLevels(n)) };
const principal: GithubPrincipal = { key: 'person', email: 'reader@example.test', login: 'person', token: 'synthetic', owners: [{ id: 10, login: 'acme', type: 'Organization' }, { id: 20, login: 'other', type: 'Organization' }], repositories: [], cache: new WeakMap() };
const actor = { email: 'reader@example.test', boardSub: 'stable-person', scopes: undefined as string[] | undefined };
let app: INestApplication;
let base: string;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [GoalsController],
    providers: [AdminGuard, HumanOnlyGuard,
      { provide: GoalsService, useValue: goals },
      { provide: ConfigService, useValue: new ConfigService({ GITHUB_ORGS: 'acme,other' }) },
      { provide: AdminAuthority, useValue: { isAdminActor: () => actor.email === 'admin@example.test', adminRefusal: () => actor.email === 'admin@example.test' ? null : 'not-admin' } },
      { provide: AuditService, useValue: { record: vi.fn() } },
    ],
  }).compile();
  app = module.createNestApplication();
  app.use((req: { user: typeof actor }, _res: unknown, next: () => void) => { req.user = actor; githubContext.run({ principal }, next); });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });

async function request(path: string, dailyGoal?: unknown) {
  return fetch(`${base}/goals/${path}`, dailyGoal === undefined ? {} : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(levels(dailyGoal)) });
}

describe('goal ownership and validation', () => {
  it('keys personal reads and edits by stable session identity', async () => {
    expect(await (await request('personal')).json()).toEqual({ ...levels(100), editable: true });
    expect((await request('personal', 125)).status).toBe(200);
    expect(goals.savePersonal).toHaveBeenCalledWith('stable-person', levels(125));
  });
  it('shows the team goal read-only and rejects a non-admin write', async () => {
    expect(await (await request('organisations/acme')).json()).toEqual({ ...levels(100), editable: false });
    expect((await request('organisations/acme', 150)).status).toBe(403);
    expect(goals.saveTeam).not.toHaveBeenCalled();
  });
  it('allows admins only in an organisation they can access, folding its name', async () => {
    actor.email = 'admin@example.test';
    try {
      expect((await request('organisations/stranger', 150)).status).toBe(403);
      expect((await request('organisations/ACME', 150)).status).toBe(200);
      expect(goals.saveTeam).toHaveBeenCalledWith(10n, levels(150));
      expect(app.get(AuditService).record).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.team.update', summary: 'Set acme flame levels to 150, 500, 1000', targetId: '10' }));
    } finally { actor.email = 'reader@example.test'; }
  });
  it('rejects token actors, invalid numbers, and a missing stable identity', async () => {
    for (const bad of [0, -1, 1.5, '100', null, 2147483648]) expect((await request('personal', bad)).status).toBe(400);
    actor.scopes = ['board:read'];
    try { expect((await request('personal')).status).toBe(403); } finally { actor.scopes = undefined; }
    actor.boardSub = '';
    try { expect((await request('personal')).status).toBe(403); } finally { actor.boardSub = 'stable-person'; }
  });
});

it('uses 100 without storage and refuses to pretend an edit persisted', async () => {
  const service = new GoalsService(new ConfigService({ IDENTITY_SOURCE: 'fixture' }));
  expect(await service.personal('p')).toEqual(defaults);
  expect(await service.team(10n)).toEqual(defaults);
  expect(service.enabled).toBe(false);
  await expect(service.savePersonal('p', levels(120))).rejects.toThrow('unavailable');
});

it('uses the caller’s GitHub organisations instead of the deployment list', async () => {
  const controller = app.get(GoalsController);
  const principal: GithubPrincipal = { key: 'person', email: actor.email, login: 'person', token: 'synthetic', owners: [{ id: 20, login: 'other', type: 'Organization' }], repositories: [], cache: new WeakMap() };
  await githubContext.run({ principal }, async () => {
    expect(controller.organisations()).toEqual(['other']);
    await expect(controller.team({ user: actor }, 'acme')).rejects.toThrow('not available');
    expect(await controller.team({ user: actor }, 'OTHER')).toEqual({ ...levels(100), editable: false });
  });
});

it('retains the goal after rename and isolates a new organisation claiming the old login', async () => {
  const service = new GoalsService(new ConfigService({ IDENTITY_SOURCE: 'fixture' }));
  const rows = new Map<bigint, ReturnType<typeof levels>>();
  Object.defineProperty(service, 'db', { value: { organisationGoal: {
    findUnique: async ({ where }: { where: { orgId: bigint } }) => rows.get(where.orgId),
    upsert: async ({ where, create, update }: { where: { orgId: bigint }; create: ReturnType<typeof levels>; update: ReturnType<typeof levels> }) => {
      rows.set(where.orgId, rows.has(where.orgId) ? update : create);
    },
  } } });
  const controller = new GoalsController(service, new ConfigService({ GITHUB_ORGS: 'acme' }), app.get(AdminAuthority), app.get(AuditService));
  const asOrg = <T>(id: number, login: string, run: () => T) => githubContext.run({ principal: { ...principal, owners: [{ id, login, type: 'Organization' }] } }, run);
  await asOrg(10, 'acme', () => controller.saveTeam({ user: actor }, 'ACME', levels(250)));
  await asOrg(10, 'renamed', async () => {
    expect((await controller.team({ user: actor }, 'renamed')).dailyGoal).toBe(250);
    await expect(controller.team({ user: actor }, 'acme')).rejects.toThrow('not available');
    await controller.saveTeam({ user: actor }, 'renamed', levels(300));
  });
  await asOrg(20, 'acme', async () => {
    expect((await controller.team({ user: actor }, 'acme')).dailyGoal).toBe(100);
    await expect(controller.saveTeam({ user: actor }, 'renamed', levels(999))).rejects.toThrow('not available');
    await controller.saveTeam({ user: actor }, 'acme', levels(150));
  });
  expect(await service.team(10n)).toEqual(levels(300));
  expect(await service.team(20n)).toEqual(levels(150));
});

it('refuses team storage without a verified organisation account id', async () => {
  const controller = app.get(GoalsController);
  for (const owner of [
    { login: 'acme', type: 'Organization' as const },
    { id: 0, login: 'acme', type: 'Organization' as const },
    { id: 10, login: 'acme', type: 'User' as const },
  ]) {
    await githubContext.run({ principal: { ...principal, owners: [owner] } }, async () => {
      await expect(controller.team({ user: actor }, 'acme')).rejects.toThrow('not available');
      await expect(controller.saveTeam({ user: actor }, 'acme', levels(150))).rejects.toThrow('not available');
    });
  }
  await expect(controller.team({ user: actor }, 'acme')).rejects.toThrow('not available');
});

it('returns three defaults and validates the entire ordered set before saving', async () => {
  const service = new GoalsService(new ConfigService({ IDENTITY_SOURCE: 'fixture' }));
  expect(await service.personal('new')).toEqual({ dailyGoal: 100, level2Goal: 200, level3Goal: 300 });
  for (const levels of [
    { dailyGoal: 100, level2Goal: 100, level3Goal: 300 },
    { dailyGoal: 100, level2Goal: 300, level3Goal: 200 },
    { dailyGoal: 0, level2Goal: 200, level3Goal: 300 },
    { dailyGoal: 100, level2Goal: 200.5, level3Goal: 300 },
    { dailyGoal: 100, level2Goal: 200 },
  ]) await expect(service.savePersonal('new', levels)).rejects.toThrow(/levels.*whole numbers.*increasing/i);
});

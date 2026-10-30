import { afterAll, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { AdminAuthority } from '../auth/admin-authority';
import { AuditService } from '../audit/audit.service';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';

const levels = (dailyGoal: number) => ({ dailyGoal, level2Goal: 500, level3Goal: 1000 });
const defaults = { dailyGoal: 100, level2Goal: 200, level3Goal: 300 };

const config = new ConfigService({ IDENTITY_SOURCE: 'db' });
const first = new GoalsService(config);
const second = new GoalsService(config);
const sub = `goal-person-${process.pid}`;
const orgId = BigInt(process.pid) * 10n;
afterAll(async () => {
  await first.db!.personalGoal.deleteMany({ where: { sub: { startsWith: sub } } });
  await first.db!.organisationGoal.deleteMany({ where: { orgId: { in: [orgId, orgId + 1n, orgId + 2n, orgId + 3n, orgId + 4n] } } });
  await first.onModuleDestroy(); await second.onModuleDestroy();
});

it('persists personal and organisation goals across service instances without crossing owners', async () => {
  expect(await first.personal(sub)).toEqual(defaults);
  expect(await first.team(orgId)).toEqual(defaults);
  await first.savePersonal(sub, levels(125));
  await first.saveTeam(orgId, levels(250));
  expect(await second.personal(sub)).toEqual(levels(125));
  expect(await second.team(orgId)).toEqual(levels(250));
  expect(await second.personal(`${sub}-other`)).toEqual(defaults);
  expect(await second.team(orgId + 1n)).toEqual(defaults);
  await second.savePersonal(sub, levels(90));
  expect(await first.personal(sub)).toEqual(levels(90));
  expect(await first.team(orgId)).toEqual(levels(250));
});

it('enforces defaults and positive goals in the database', async () => {
  expect(await first.db!.personalGoal.create({ data: { sub: `${sub}-default` } })).toEqual({ sub: `${sub}-default`, ...defaults });
  expect(await first.db!.organisationGoal.create({ data: { orgId: orgId + 2n } })).toEqual({ orgId: orgId + 2n, ...defaults });
  await expect(first.db!.personalGoal.update({ where: { sub }, data: levels(0) })).rejects.toThrow();
  await expect(first.db!.organisationGoal.update({ where: { orgId }, data: { dailyGoal: -1 } })).rejects.toThrow();
});

it('keeps the stored goal across rename and prevents a re-registered login from reading or updating it', async () => {
  const admin = { isAdminActor: () => true } as unknown as AdminAuthority;
  const audit = { record: async () => undefined } as unknown as AuditService;
  const before = new GoalsController(first, config, admin, audit);
  const after = new GoalsController(second, config, admin, audit);
  const req = { user: { email: 'admin@example.test', boardSub: sub } };
  const asOrg = <T>(id: bigint, login: string, run: () => T) => {
    const principal: GithubPrincipal = { key: String(id), email: req.user.email, login: 'admin', token: 'synthetic', owners: [{ id: Number(id), login, type: 'Organization' }], repositories: [], cache: new WeakMap() };
    return githubContext.run({ principal }, run);
  };
  const originalId = orgId + 3n;
  const newId = orgId + 4n;
  await asOrg(originalId, 'old-login', () => before.saveTeam(req, 'old-login', levels(250)));
  await asOrg(originalId, 'new-login', async () => {
    expect((await after.team(req, 'NEW-LOGIN')).dailyGoal).toBe(250);
    await after.saveTeam(req, 'new-login', levels(300));
    await expect(after.team(req, 'old-login')).rejects.toThrow('not available');
  });
  await asOrg(newId, 'old-login', async () => {
    expect((await after.team(req, 'old-login')).dailyGoal).toBe(100);
    await expect(after.saveTeam(req, 'new-login', levels(999))).rejects.toThrow('not available');
    await after.saveTeam(req, 'old-login', levels(150));
  });
  expect(await first.team(originalId)).toEqual(levels(300));
  expect(await first.team(newId)).toEqual(levels(150));
  expect(await first.db!.organisationGoal.findUnique({ where: { orgId: originalId } })).toEqual({ orgId: originalId, ...levels(300) });
});

it('rejects equal or descending levels in both database tables without changing saved settings', async () => {
  for (const data of [
    { dailyGoal: 100, level2Goal: 100, level3Goal: 300 },
    { dailyGoal: 100, level2Goal: 300, level3Goal: 200 },
    { dailyGoal: 100, level2Goal: 0, level3Goal: 300 },
  ]) {
    await expect(first.db!.personalGoal.update({ where: { sub }, data })).rejects.toThrow();
    await expect(first.db!.organisationGoal.update({ where: { orgId }, data })).rejects.toThrow();
  }
  expect(await first.personal(sub)).toEqual(levels(90));
  expect(await first.team(orgId)).toEqual(levels(250));
});

it('updates both higher thresholds independently and preserves them across service instances', async () => {
  const personal = { dailyGoal: 80, level2Goal: 170, level3Goal: 420 };
  const team = { dailyGoal: 120, level2Goal: 450, level3Goal: 900 };
  await first.savePersonal(`${sub}-higher`, defaults);
  await first.saveTeam(orgId + 1n, defaults);
  await second.savePersonal(`${sub}-higher`, personal);
  await second.saveTeam(orgId + 1n, team);
  expect(await first.personal(`${sub}-higher`)).toEqual(personal);
  expect(await first.team(orgId + 1n)).toEqual(team);
});

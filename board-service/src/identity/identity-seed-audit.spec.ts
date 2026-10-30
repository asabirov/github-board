import { describe, it, expect, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { IdentitySeedAudit } from './identity-seed-audit';
import type { AuditService } from '../audit/audit.service';
import type { IdentityRepository, IdentityRecord } from './identity.repository';
import { fakeIdentityStore, unreachableIdentityStore } from './identity.test-double';
import type { AuditEventRow } from '../audit/audit.types';

const idn = (id: string, displayName: string): IdentityRecord => ({
  id,
  displayName,
  emails: [`${displayName.toLowerCase()}@x.com`],
  githubLogin: null,
  clickupUserId: null,
  clickupNames: [],
  role: null,
});

function make(opts: {
  source?: string;
  people?: IdentityRecord[];
  seedEvents?: Partial<AuditEventRow>[];
}) {
  const record = vi.fn().mockResolvedValue(undefined);
  const list = vi.fn().mockResolvedValue(opts.seedEvents ?? []);
  const audit = { record, list } as unknown as AuditService;
  const base = fakeIdentityStore(opts.people ?? []);
  // Honestly typed, with `list` spied so the "never reads the store" case can
  // still assert on the call count.
  const identities: IdentityRepository = { ...base, list: vi.fn(() => base.list()) };
  const config = { get: () => opts.source ?? 'db' } as unknown as ConfigService;
  return { svc: new IdentitySeedAudit(identities, audit, config), record, list, identities };
}

describe('IdentitySeedAudit (#264)', () => {
  it('records a system seed event for every identity that has none', async () => {
    const { svc, record } = make({ people: [idn('a', 'Artur'), idn('b', 'Ivan')] });
    await svc.onApplicationBootstrap();
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity.seed', actorEmail: 'system', targetId: 'a' }),
    );
  });

  it('is idempotent — skips identities that already have a seed event', async () => {
    const { svc, record } = make({
      people: [idn('a', 'Artur'), idn('b', 'Ivan')],
      seedEvents: [{ targetId: 'a' }], // Artur already recorded
    });
    await svc.onApplicationBootstrap();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'b' }));
  });

  it('does nothing when IDENTITY_SOURCE is not db', async () => {
    const { svc, record, identities } = make({ source: 'fixture', people: [idn('a', 'Artur')] });
    await svc.onApplicationBootstrap();
    expect(identities.list).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('never throws — a reconcile failure is swallowed so boot is never wedged', async () => {
    const identities = unreachableIdentityStore();
    const audit = { record: vi.fn(), list: vi.fn().mockResolvedValue([]) } as unknown as AuditService;
    const config = { get: () => 'db' } as unknown as ConfigService;
    const svc = new IdentitySeedAudit(identities, audit, config);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});

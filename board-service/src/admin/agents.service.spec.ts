import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AgentsService } from './agents.service';
import { toOrgAgent } from './agents';
import type {
  PersonalTokenRepository,
  PersonalTokenRow,
} from '../account/personal-token.repository';

function config(mcp = false): ConfigService {
  const v: Record<string, unknown> = { BOARD_BASE_URL: 'https://board', BOARD_MCP_ENABLED: mcp };
  return { get: (k: string, d?: unknown) => (k in v ? v[k] : d) } as unknown as ConfigService;
}

function row(p: Partial<PersonalTokenRow> = {}): PersonalTokenRow {
  return {
    id: 't1', ownerEmail: 'a@x.io', ownerSub: 'sub-a', name: 'laptop-agent', scopes: ['board:read'],
    tokenHash: 'h', prefix: 'board_pat_9f3a', expiresAt: null,
    lastUsedAt: new Date('2026-07-25T00:00:00Z'), revokedAt: null,
    createdAt: new Date('2026-07-20T00:00:00Z'), ...p,
  };
}

function repo(rows: PersonalTokenRow[], enabled = true): PersonalTokenRepository & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    enabled, revoked,
    listAllActive: async () => rows,
    revokeAny: async (id: string) => { revoked.push(id); return id === 't1'; },
    create: async () => row(), listByOwner: async () => [], findByHash: async () => null,
    revoke: async () => false, touchLastUsed: async () => {},
  } as unknown as PersonalTokenRepository & { revoked: string[] };
}

describe('toOrgAgent (#211)', () => {
  it('projects a token row to wire shape — dates to ISO, no secret/hash', () => {
    const a = toOrgAgent(row());
    expect(a).toEqual({
      id: 't1', owner: 'a@x.io', name: 'laptop-agent', prefix: 'board_pat_9f3a',
      scopes: ['board:read'], createdAt: '2026-07-20T00:00:00.000Z',
      lastUsedAt: '2026-07-25T00:00:00.000Z', expiresAt: null,
    });
    expect(a).not.toHaveProperty('tokenHash');
  });

  it('keeps a never-used token as lastUsedAt: null', () => {
    expect(toOrgAgent(row({ lastUsedAt: null })).lastUsedAt).toBeNull();
  });
});

describe('AgentsService (#183, #211)', () => {
  it('assembles the reference + the org roster from the token store', async () => {
    const svc = new AgentsService(config(true), repo([row(), row({ id: 't2', ownerEmail: 'b@x.io' })]));
    const model = await svc.getModel();
    expect(model.mcpUrl).toBe('https://board/mcp'); // reference still present
    expect(model.scopes.length).toBeGreaterThan(0);
    expect(model.agents.map((a) => a.id)).toEqual(['t1', 't2']); // roster, order preserved
    expect(model.agents[1].owner).toBe('b@x.io');
  });

  it('renders an empty roster when the store is DB-less', async () => {
    const svc = new AgentsService(config(false), repo([], false));
    const model = await svc.getModel();
    expect(model.agents).toEqual([]);
    expect(model.mcpUrl).toBeNull();
  });

  it('delegates admin revoke to the store', async () => {
    const r = repo([]);
    const svc = new AgentsService(config(), r);
    expect(await svc.revokeAgent('t1')).toBe(true);
    expect(await svc.revokeAgent('nope')).toBe(false);
    expect(r.revoked).toEqual(['t1', 'nope']);
  });
});

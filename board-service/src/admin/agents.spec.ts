import { describe, expect, it } from 'vitest';
import { buildAgentsModel } from './agents';
import { BOARD_ADMIN, BOARD_READ } from '../auth/scopes';
import { TOOL_PREFIXES, toolNamesForScope } from '../mcp/overview-tools';

describe('buildAgentsModel', () => {
  const model = buildAgentsModel({ baseUrl: 'https://board', mcpEnabled: true });

  it('lists the fine-grained scopes with a coarse tag each', () => {
    expect(model.scopes.map((s) => s.id)).toEqual([BOARD_READ, BOARD_ADMIN]);
    expect(model.scopes.map((s) => s.tag)).toEqual(['read', 'admin']);
  });

  it('exposes the two consent presets, expanded to scope-sets', () => {
    const agent = model.presets.find((p) => p.id === 'agent');
    const full = model.presets.find((p) => p.id === 'full');
    expect(agent?.scopes).toEqual([BOARD_READ]);
    expect(full?.scopes).toEqual([BOARD_READ, BOARD_ADMIN]);
  });

  it('covers exactly the tools the MCP server registers for a full session', () => {
    // The full (non-agent) session sees every tool; strip the dual prefixes
    // down to base suffixes and dedupe. The catalog must match it 1:1 so a new
    // tool can never ship untagged.
    const prefix = new RegExp(`^(${TOOL_PREFIXES.join('|')})_`);
    const registered = [...new Set(toolNamesForScope(false).map((n) => n.replace(prefix, '')))].sort();
    const catalog = model.tools.map((t) => t.name).sort();
    expect(catalog).toEqual(registered);
  });

  it('names whoami as a read tool (#536)', () => {
    // The catalogue is derived from the same suffix lists the MCP server
    // registers from, so it gains and loses tools with the surface. Pinning the
    // whole array, not just a membership check, is what makes a tool arriving
    // untagged — or with the wrong scope tag — fail here.
    expect(model.tools).toEqual([{ name: 'whoami', needs: 'read' }]);
  });

  it('serves the MCP endpoint URL only when MCP is enabled', () => {
    expect(model.mcpUrl).toBe('https://board/mcp');
    const off = buildAgentsModel({ baseUrl: 'https://board/', mcpEnabled: false });
    expect(off.mcpUrl).toBeNull();
  });
});

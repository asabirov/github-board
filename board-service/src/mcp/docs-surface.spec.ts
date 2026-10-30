import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HUMAN_WRITE_SUFFIXES, READ_SUFFIXES, TOOL_PREFIXES } from './overview-tools';

/**
 * Cross-package drift guard (#536). The /docs page describes the MCP surface
 * from a hand-kept list in the frontend, because the two packages have separate
 * lockfiles and cannot import from each other (`api.ts` redeclares `AgentTool`
 * rather than importing it). A hand-kept list drifts; a discovered one cannot.
 *
 * So this test reads the frontend's docs data off disk and asserts every
 * registered tool appears in it. It lives in board-service because that is where
 * the tool list is authoritative — the frontend copy is the derived one. Single
 * repo, so the path resolves in CI exactly as it does locally.
 *
 * The precedent is `mcp-rest-parity.spec.ts`, which reads controller sources off
 * disk for the same reason.
 */

const DOCS_DATA = join(__dirname, '../../../board-frontend/src/docs/docs-data.ts');

describe('the /docs MCP list cannot drift from the real surface', () => {
  const source = readFileSync(DOCS_DATA, 'utf8');

  it('reads the frontend docs data (the path still resolves)', () => {
    // If this fails, the frontend moved and the guard below went quiet rather
    // than red — the failure mode a drift guard must not have.
    expect(source).toContain('MCP_TOOLS');
  });

  it('every registered tool appears in the /docs data', () => {
    const suffixes = [...READ_SUFFIXES, ...HUMAN_WRITE_SUFFIXES] as readonly string[];
    const names = suffixes.flatMap((s) => TOOL_PREFIXES.map((p) => `${p}_${s}`));
    // A substring check is enough; this is a guard, not a parser.
    const missing = names.filter((n) => !source.includes(n));
    expect(missing, `add these tools to ${DOCS_DATA}`).toEqual([]);
  });
});

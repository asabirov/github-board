import { describe, it, expect } from 'vitest';
import { parseAgentTokens, matchAgentToken } from './agent-tokens';
import { configValidationSchema } from '../config/config.schema';

/** The settings every deployment must name since #1175, so a case about token
 *  names is not answered by an unrelated key's absence. */
const NAMED = { GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board', ISSUES_SOURCE: 'fixture' };

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

describe('parseAgentTokens', () => {
  it('parses comma-separated name:secret pairs', () => {
    const m = parseAgentTokens(`octocat-cli:${HEX_A},overview-cron:${HEX_B}`);
    expect(m.get('octocat-cli')).toBe(HEX_A);
    expect(m.get('overview-cron')).toBe(HEX_B);
    expect(m.size).toBe(2);
  });

  it('returns an empty map for empty input', () => {
    expect(parseAgentTokens('').size).toBe(0);
    expect(parseAgentTokens('  ').size).toBe(0);
  });

  it('throws on a secret that is not 64 hex chars', () => {
    expect(() => parseAgentTokens('bad:deadbeef')).toThrow(/64 hex/);
  });

  it('throws on a missing name', () => {
    expect(() => parseAgentTokens(`:${HEX_A}`)).toThrow(/name/);
  });

  it('throws on duplicate names', () => {
    expect(() => parseAgentTokens(`a:${HEX_A},a:${HEX_B}`)).toThrow(/duplicate/i);
  });

  /**
   * #525. The name is not decoration: `jwt-auth.guard` writes it verbatim into
   * the actor's address as `agent:<name>`. A name carrying an `@` produced
   * `agent:claude@ci` — an address shaped like a person's — so the shape of a
   * string somebody typed into an environment variable decided what the caller
   * was. The refusal names the entry so a boot failure says which one to fix.
   */
  describe('a name that would make the actor read as a person (#525)', () => {
    it('refuses a name containing @, naming the entry and the reason', () => {
      const parse = () => parseAgentTokens(`claude@ci:${HEX_A}`);
      expect(parse).toThrow(/"claude@ci"/);
      expect(parse).toThrow(/letters, digits/);
      expect(parse).toThrow(/agent:<name>/);
    });

    it('refuses the offending entry even when a well-formed one sits beside it', () => {
      expect(() => parseAgentTokens(`ci-bot:${HEX_A},claude@ci:${HEX_B}`)).toThrow(/"claude@ci"/);
    });

    it('refuses every other character that is not a letter, digit, underscore or hyphen', () => {
      for (const name of ['ci bot', 'ci.bot', 'ci/bot', 'ci+bot', 'ci\nbot', 'ci*bot', 'сi-bot']) {
        expect(() => parseAgentTokens(`${name}:${HEX_A}`)).toThrow(/BOARD_AGENT_TOKENS name/);
      }
    });

    it('keeps well-formed names working unchanged', () => {
      const m = parseAgentTokens(`octocat-cli:${HEX_A},CI_bot2:${HEX_B}`);
      expect([...m.keys()]).toEqual(['octocat-cli', 'CI_bot2']);
    });

    /**
     * The class is exactly the one `config/config.schema.ts` already enforces on
     * `BOARD_AGENT_TOKENS`, so no value passes one gate and fails the other.
     */
    it('agrees with the env schema on what a name may be', () => {
      for (const raw of [`ci-bot:${HEX_A}`, `CI_bot2:${HEX_A}`]) {
        expect(configValidationSchema.validate({ ...NAMED, BOARD_AGENT_TOKENS: raw }).error).toBeUndefined();
        expect(() => parseAgentTokens(raw)).not.toThrow();
      }
      for (const raw of [`claude@ci:${HEX_A}`, `ci.bot:${HEX_A}`, `ci bot:${HEX_A}`]) {
        expect(configValidationSchema.validate({ ...NAMED, BOARD_AGENT_TOKENS: raw }).error).toBeDefined();
        expect(() => parseAgentTokens(raw)).toThrow();
      }
    });
  });
});

describe('matchAgentToken', () => {
  const tokens = parseAgentTokens(`octocat-cli:${HEX_A},overview-cron:${HEX_B}`);

  it('returns the agent name for a matching secret', () => {
    expect(matchAgentToken(tokens, HEX_A)).toBe('octocat-cli');
    expect(matchAgentToken(tokens, HEX_B)).toBe('overview-cron');
  });

  it('returns null for an unknown secret', () => {
    expect(matchAgentToken(tokens, 'c'.repeat(64))).toBeNull();
  });

  it('returns null for a wrong-length candidate (e.g. a session JWT)', () => {
    expect(matchAgentToken(tokens, 'eyJhbGciOi.header.payload')).toBeNull();
  });

  it('returns null when no tokens are configured', () => {
    expect(matchAgentToken(new Map(), HEX_A)).toBeNull();
  });
});

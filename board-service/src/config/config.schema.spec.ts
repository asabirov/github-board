import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { configValidationSchema } from './config.schema';

/**
 * The two settings every deployment must name since #1175, filled in by
 * `validate` below so a case about one rule is not answered by another key's
 * absence. `GITHUB_ORGS` and `FEEDBACK_REPO` carried defaults until then, and
 * the defaults named an organisation and a repository that were both renamed
 * without this repository being told. `required-settings.spec.ts` owns the
 * refusals themselves; nothing here is about them.
 */
const NAMED = {
  GITHUB_ORGS: 'acme',
  FEEDBACK_REPO: 'acme/board',
};

/** The schema, asked about the env under test on a board that has named those
 *  two. An env of its own always wins, so a case may still drop one. */
const validate = (env: Record<string, unknown> = {}, options?: Parameters<typeof configValidationSchema.validate>[1]) =>
  configValidationSchema.validate({ ...NAMED, ...env }, options);

describe('config schema — defaults', () => {
  it('applies defaults on an empty env', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.CORS_ORIGIN).toBe('*');
    expect(value.DEV_USER_EMAIL).toBe('dev@example.com');
  });

  it('accepts a provided value over the default', () => {
    const { value, error } = validate({ CORS_ORIGIN: 'https://board' });
    expect(error).toBeUndefined();
    expect(value.CORS_ORIGIN).toBe('https://board');
  });
});

/**
 * `FEEDBACK_LABELS` decides which issues carry somebody else's words (#497), so
 * a value that names no label switches that control off while the form goes on
 * filing submissions. The empty string was already rejected; these are the
 * values that used to validate clean and parse to nothing.
 */
describe('config schema — FEEDBACK_LABELS must name a label (#497)', () => {
  for (const blank of ['', '   ', ',', ' , ', ',,']) {
    it(`rejects ${JSON.stringify(blank)}`, () => {
      const { error } = validate({ FEEDBACK_LABELS: blank });
      expect(error?.message).toMatch(/FEEDBACK_LABELS/);
    });
  }

  it('accepts one label, several labels, and any casing', () => {
    for (const ok of ['feedback', 'feedback,from-form', 'Feedback, From-Form']) {
      const { error } = validate({ FEEDBACK_LABELS: ok });
      expect(error).toBeUndefined();
    }
  });

  it('defaults to `feedback` when unset', () => {
    expect(validate({}).value.FEEDBACK_LABELS).toBe('feedback');
  });
});

/**
 * Turning MCP on requires a real store for the grants it issues (#456). Without
 * this rule the insecure mode is the default: `IDENTITY_SOURCE` falls back to
 * `fixture`, so an authorization server could run on in-memory state where every
 * restart silently invalidates every token it has minted.
 *
 * Two things this suite states rather than inherits. Values are strings, because
 * Joi validates `process.env` and a test written with JavaScript booleans
 * exercises a different coercion path. And the options are declared, because
 * `app.module.ts` passes `{ abortEarly: false }` as Joi library options. The `fixture`
 * case reports `any.only` AND `any.invalid`, so both keys carry the same text and
 * Joi collapses them in the direct validation message tested here; Nest's
 * Standard Schema adapter reports each detail on its own line at boot.
 */
describe('config schema — BOARD_MCP_ENABLED requires IDENTITY_SOURCE=db (#456)', () => {
  const OPTIONS = { abortEarly: false };
  const IDENTITY_MESSAGE = 'IDENTITY_SOURCE must be db when BOARD_MCP_ENABLED=true';
  // What the file's other MCP-on rules already demand, so a row that should be
  // accepted is not rejected by BOARD_SESSION_SECRET or DATABASE_URL instead.
  const mcpOn = {
    BOARD_MCP_ENABLED: 'true',
    BOARD_SESSION_SECRET: 'a-real-session-secret',
    DATABASE_URL: 'postgresql://board:board@localhost:5432/board',
  };

  it("refuses IDENTITY_SOURCE='fixture'", () => {
    const { error } = validate({ ...mcpOn, IDENTITY_SOURCE: 'fixture' }, OPTIONS);
    expect(error?.details.map((d) => d.type)).toEqual(['any.only', 'any.invalid']);
    expect(error?.message).toBe(IDENTITY_MESSAGE);
  });

  it("accepts IDENTITY_SOURCE='db'", () => {
    const { error, value } = validate({ ...mcpOn, IDENTITY_SOURCE: 'db' }, OPTIONS);
    expect(error).toBeUndefined();
    expect(value.IDENTITY_SOURCE).toBe('db');
  });

  // The likeliest case in a real deployment: nobody sets IDENTITY_SOURCE at all,
  // and the `fixture` default would otherwise carry an MCP server on no database.
  it('refuses an absent IDENTITY_SOURCE, so the fixture default cannot apply', () => {
    const { error } = validate(mcpOn, OPTIONS);
    expect(error?.details.map((d) => d.type)).toEqual(['any.required']);
    expect(error?.message).toBe(IDENTITY_MESSAGE);
  });

  it("leaves IDENTITY_SOURCE='fixture' alone when MCP is off", () => {
    const env = { BOARD_MCP_ENABLED: 'false', IDENTITY_SOURCE: 'fixture' };
    const { error, value } = validate(env, OPTIONS);
    expect(error).toBeUndefined();
    expect(value.IDENTITY_SOURCE).toBe('fixture');
  });
});

/**
 * The same lock on the other setting that cannot run without a database (#774).
 *
 * Board writes Github under ONE shared credential, so the audit trail is the only
 * thing that says which person a write belongs to. That trail follows
 * IDENTITY_SOURCE and nothing else — `audit.module.ts` wires
 * `DisabledAuditRepository` on any value but `db`, whose `record` is a
 * `logger.debug` dropping `targetType`, `targetId` and `summary` and whose `list`
 * returns `[]`. So GITHUB_WRITE_ENABLED=true on the `fixture` DEFAULT was a board
 * making every audited write and recording none, showing an operator the "No
 * audit events yet" an idle board shows.
 *
 * Same shape as the MCP suite above and for the same reasons: string values,
 * because Joi validates `process.env`; declared options, because `app.module.ts`
 * boots with `{ abortEarly: false }`.
 */
describe('config schema — GITHUB_WRITE_ENABLED requires IDENTITY_SOURCE=db (#774)', () => {
  const OPTIONS = { abortEarly: false };
  const WRITE_MESSAGE = 'IDENTITY_SOURCE must be db when GITHUB_WRITE_ENABLED=true';
  // Writes on and nothing else, so a row that should be accepted is not rejected
  // by some other rule instead. `BOOT_ALERT_REPO` rides along for that reason:
  // since #1175 a board that can write has to name where a bad boot reports, and
  // that refusal is `required-settings.spec.ts`'s subject rather than this
  // suite's.
  const writesOn = {
    GITHUB_WRITE_ENABLED: 'true',
    BOOT_ALERT_REPO: 'acme/board',
    BOOT_ALERT_ASSIGNEE: 'on-call',
  };

  it("refuses IDENTITY_SOURCE='fixture'", () => {
    const { error } = validate({ ...writesOn, IDENTITY_SOURCE: 'fixture' }, OPTIONS);
    expect(error?.details.map((d) => d.type)).toEqual(['any.only', 'any.invalid']);
    expect(error?.message).toBe(WRITE_MESSAGE);
  });

  // THE CASE THE ISSUE WAS FILED ABOUT. Nobody sets IDENTITY_SOURCE — it is not
  // in `.env.example` next to the write flag and it has a default — so the board
  // came up on `fixture` with writes on and said nothing.
  it('refuses an absent IDENTITY_SOURCE, so the fixture default cannot apply', () => {
    const { error } = validate(writesOn, OPTIONS);
    expect(error?.details.map((d) => d.type)).toEqual(['any.required']);
    expect(error?.message).toBe(WRITE_MESSAGE);
  });

  it("accepts IDENTITY_SOURCE='db'", () => {
    const env = { ...writesOn, IDENTITY_SOURCE: 'db', DATABASE_URL: 'postgresql://board:board@localhost:5432/board' };
    const { error, value } = validate(env, OPTIONS);
    expect(error).toBeUndefined();
    expect(value.IDENTITY_SOURCE).toBe('db');
  });

  it("leaves IDENTITY_SOURCE='fixture' alone when writes are off", () => {
    const env = { GITHUB_WRITE_ENABLED: 'false', IDENTITY_SOURCE: 'fixture' };
    const { error, value } = validate(env, OPTIONS);
    expect(error).toBeUndefined();
    expect(value.IDENTITY_SOURCE).toBe('fixture');
  });

  // A `db` board still needs somewhere to put the trail, and the DATABASE_URL
  // rule is what says so. Without this the coupling could be satisfied by a
  // config that reaches the same silence one layer down.
  it('carries DATABASE_URL with it: writes on and db with no URL is still refused', () => {
    const { error } = validate({ ...writesOn, IDENTITY_SOURCE: 'db' }, OPTIONS);
    expect(error?.message).toMatch(/DATABASE_URL must be set when IDENTITY_SOURCE=db/);
  });

  // Both locks on at once. Joi reports the LAST matching `.when()`, so the
  // operator reads the write message rather than the MCP one — pinned here
  // because it is a fact about Joi's merge order, not about either rule, and a
  // reader of either suite would otherwise expect their own message.
  it('reports the write message when MCP is on too, the remedy being the same', () => {
    const env = {
      ...writesOn,
      BOARD_MCP_ENABLED: 'true',
      BOARD_SESSION_SECRET: 'a-real-session-secret',
      DATABASE_URL: 'postgresql://board:board@localhost:5432/board',
      IDENTITY_SOURCE: 'fixture',
    };
    const { error } = validate(env, OPTIONS);
    expect(error?.message).toBe(WRITE_MESSAGE);
  });
});

/**
 * The twin lock, closing a gap that predates #456 rather than one it introduces.
 * `jwt-auth.guard.ts` short-circuits to a stub user and returns true before
 * anything else runs, so `BOARD_MCP_ENABLED=true` with `AUTH_DISABLED=true` is an
 * MCP endpoint with no authentication at all — and no grant check either, once
 * one exists.
 */
describe('config schema — AUTH_DISABLED cannot be true while MCP is on (#456)', () => {
  const OPTIONS = { abortEarly: false };
  const mcpOn = {
    BOARD_MCP_ENABLED: 'true',
    IDENTITY_SOURCE: 'db',
    BOARD_SESSION_SECRET: 'a-real-session-secret',
    DATABASE_URL: 'postgresql://board:board@localhost:5432/board',
  };

  it('refuses AUTH_DISABLED=true', () => {
    const { error } = validate({ ...mcpOn, AUTH_DISABLED: 'true' }, OPTIONS);
    expect(error?.details.map((d) => d.type)).toEqual(['any.only']);
    expect(error?.message).toBe('AUTH_DISABLED must be false when BOARD_MCP_ENABLED=true');
  });

  it('accepts AUTH_DISABLED=false', () => {
    const { error, value } = validate({ ...mcpOn, AUTH_DISABLED: 'false' }, OPTIONS);
    expect(error).toBeUndefined();
    expect(value.AUTH_DISABLED).toBe(false);
  });

  it('leaves AUTH_DISABLED=true alone when MCP is off', () => {
    const { error, value } = validate({ BOARD_MCP_ENABLED: 'false', AUTH_DISABLED: 'true' }, OPTIONS);
    expect(error).toBeUndefined();
    expect(value.AUTH_DISABLED).toBe(true);
  });
});

/**
 * The other half of #774, and the one the first round missed. `IDENTITY_SOURCE=db`
 * buys a trail that RECORDS; this buys a trail that records the RIGHT NAME.
 *
 * With `AUTH_DISABLED=true` the guard never authenticates anybody:
 * `jwt-auth.guard.ts` stamps `req.user = { sub: 'dev-user', email: DEV_USER_EMAIL }`
 * and returns true. So writes-on plus db plus auth-off passed the round-one rule
 * cleanly and gave a board with no authentication on any route, every write going
 * out on the one shared Github credential, and `PrismaAuditRepository` recording
 * all of them under `dev@example.com`. That is worse than the empty log this
 * issue was filed on: an empty log is ambiguous and invites the question, a full
 * one naming a person is believed.
 *
 * Same shape as the two suites above and for the same reasons: string values,
 * because Joi validates `process.env`; declared options, because `app.module.ts`
 * boots with `{ abortEarly: false }`.
 */
describe('config schema — AUTH_DISABLED cannot be true while Github writes are on (#774)', () => {
  const OPTIONS = { abortEarly: false };
  const AUTH_MESSAGE = 'AUTH_DISABLED must be false when GITHUB_WRITE_ENABLED=true';
  // Everything a writes-on board already needs, so a row that is refused here is
  // refused for AUTH_DISABLED and not for one of #774's round-one rules.
  const writesOn = {
    GITHUB_WRITE_ENABLED: 'true',
    IDENTITY_SOURCE: 'db',
    DATABASE_URL: 'postgresql://board:board@localhost:5432/board',
    // #1175: a board that can write names where a bad boot reports.
    BOOT_ALERT_REPO: 'acme/board',
    BOOT_ALERT_ASSIGNEE: 'on-call',
  };

  // THE COMBINATION THE REVIEW FOUND. Every round-one rule is satisfied.
  it('refuses AUTH_DISABLED=true even with IDENTITY_SOURCE=db and a DATABASE_URL', () => {
    const { error } = validate({ ...writesOn, AUTH_DISABLED: 'true' }, OPTIONS);
    expect(error?.details.map((d) => d.type)).toEqual(['any.only']);
    expect(error?.message).toBe(AUTH_MESSAGE);
  });

  it('accepts AUTH_DISABLED=false', () => {
    const { error, value } = validate({ ...writesOn, AUTH_DISABLED: 'false' }, OPTIONS);
    expect(error).toBeUndefined();
    expect(value.AUTH_DISABLED).toBe(false);
  });

  // The default is the shipped case: nobody sets this key in production, and the
  // rule must not turn an unset key into a refused boot.
  it('accepts an absent AUTH_DISABLED, which defaults to false', () => {
    const { error, value } = validate(writesOn, OPTIONS);
    expect(error).toBeUndefined();
    expect(value.AUTH_DISABLED).toBe(false);
  });

  it('leaves AUTH_DISABLED=true alone when writes are off', () => {
    const env = { GITHUB_WRITE_ENABLED: 'false', AUTH_DISABLED: 'true' };
    const { error, value } = validate(env, OPTIONS);
    expect(error).toBeUndefined();
    expect(value.AUTH_DISABLED).toBe(true);
  });

  // Both locks on this key at once. Joi concatenates the matched `.when()`
  // branches and reports the LAST one, so the operator reads the write message
  // rather than the MCP one — pinned because it is a fact about joi's merge
  // order, not about either rule, and because the MCP suite above would
  // otherwise expect its own message here. The remedy is identical either way.
  it('reports the write message when MCP is on too, the remedy being the same', () => {
    const env = {
      ...writesOn,
      BOARD_MCP_ENABLED: 'true',
      BOARD_SESSION_SECRET: 'a-real-session-secret',
      AUTH_DISABLED: 'true',
    };
    const { error } = validate(env, OPTIONS);
    expect(error?.message).toBe(AUTH_MESSAGE);
  });
});

/**
 * What an operator reads when they get this key wrong (#774). `1` is the common
 * container idiom and this is the key #774 makes them touch, so joi's default
 * `"GITHUB_WRITE_ENABLED" must be a boolean` — which says nothing about the two
 * keys it is now coupled to — is replaced.
 *
 * The values stay REFUSED. Accepting `1`/`yes`/`on` here alone would boot on
 * `GITHUB_WRITE_ENABLED=1` while still refusing `BOARD_MCP_ENABLED=1` one screen
 * away, and accepting them schema-wide would turn `AUTH_DISABLED=1` from a
 * refused boot into a board with no authentication.
 */
describe('config schema — a non-boolean GITHUB_WRITE_ENABLED names the coupling (#774)', () => {
  for (const bad of ['1', 'yes', 'on', '', '0', 'off']) {
    it(`refuses ${JSON.stringify(bad)} and says what true would require`, () => {
      const { error } = validate({ GITHUB_WRITE_ENABLED: bad });
      expect(error?.details.map((d) => d.type)).toEqual(['boolean.base']);
      expect(error?.message).toMatch(/must be `true` or `false`/);
      expect(error?.message).toMatch(/IDENTITY_SOURCE=db and AUTH_DISABLED=false/);
    });
  }

  it('still accepts the two values it names', () => {
    for (const ok of ['false', 'true']) {
      const env = {
        GITHUB_WRITE_ENABLED: ok,
        IDENTITY_SOURCE: 'db',
        DATABASE_URL: 'postgresql://board:board@localhost:5432/board',
        // #1175: required once the value above is `true`, harmless when it is not.
        BOOT_ALERT_REPO: 'acme/board',
        BOOT_ALERT_ASSIGNEE: 'on-call',
      };
      expect(validate(env, { abortEarly: false }).error).toBeUndefined();
    }
  });
});

/**
 * The capability kill-switch (#584). `GITHUB_CAPABILITIES_DENY` names the
 * capabilities the board must refuse itself, and a name that matches nothing
 * switches off nothing — quietly, which is worse than having no kill-switch at
 * all. It is validated here rather than in the provider factory so the failure
 * NAMES the env key, the way every other bad config value on this board fails.
 */
describe('config schema — GITHUB_CAPABILITIES_DENY names real capabilities (#584)', () => {
  for (const typo of ['repo.dry', 'issue.labels,repo.dry', 'ISSUE.LABELS']) {
    it(`rejects ${JSON.stringify(typo)}, naming the key`, () => {
      const { error } = validate({ GITHUB_CAPABILITIES_DENY: typo });
      expect(error?.message).toMatch(/GITHUB_CAPABILITIES_DENY/);
      expect(error?.message).toMatch(/no such capability/);
    });
  }

  it('accepts one capability, several, and surrounding whitespace', () => {
    for (const ok of ['repo.dri', 'repo.dri,issue.labels', ' repo.dri , issue.state ']) {
      const { error } = validate({
        GITHUB_CAPABILITIES_DENY: ok,
        CAPABILITY_GUARD_ENFORCING: 'true', // …which a deny list now requires, below
      });
      expect(error).toBeUndefined();
    }
  });

  it('refuses to boot on a deny list the guard would not act on', () => {
    // The kill-switch that is not one. With the guard reporting rather than
    // refusing, an operator can name a capability, watch /api/auth/me answer
    // `refused`, watch the UI hide the control — and the write still lands,
    // because the guard logs and returns true. A switch that quietly switches
    // off nothing is worse than no switch, so the mismatch stops the boot.
    //
    // In the SCHEMA and not in a provider factory: a factory that throws aborts
    // NestFactory.create before reportBootErrors can file anything, and a Joi
    // error names the env key the way every other bad value on this board does.
    //
    // Both rows SET the key, in the two shapes it arrives in. An absent key used
    // to be a row here and is now the opposite case — since task 8 the default
    // enforces, so unset means enforcing, and it is asserted as ACCEPTED in the
    // sibling test below. Leaving `{}` in this loop would have asserted a
    // refusal the schema no longer issues.
    for (const off of [{ CAPABILITY_GUARD_ENFORCING: 'false' }, { CAPABILITY_GUARD_ENFORCING: false }]) {
      const { error } = validate({
        GITHUB_CAPABILITIES_DENY: 'repo.dri',
        ...off,
      });
      expect(error?.message).toMatch(/GITHUB_CAPABILITIES_DENY/);
      expect(error?.message).toMatch(/CAPABILITY_GUARD_ENFORCING/);
    }
  });

  it('accepts the same deny list once the guard enforces, set or defaulted', () => {
    // Joi validates `process.env`, where every value is a string, and a spec
    // that only passed the boolean would pass against a check no deployment can
    // satisfy. The third row sets nothing at all, which since task 8 is the
    // enforcing case: a deployment that names a deny list and touches no other
    // key boots, where before task 8 it was refused.
    for (const on of [
      { CAPABILITY_GUARD_ENFORCING: 'true' },
      { CAPABILITY_GUARD_ENFORCING: true },
      {},
    ]) {
      const { error } = validate({
        GITHUB_CAPABILITIES_DENY: 'repo.dri',
        ...on,
      });
      expect(error).toBeUndefined();
    }
  });

  it('still names the typo first when both are wrong', () => {
    // "Both" needs the flag spelled out since task 8: with the default enforcing,
    // a bare typo is only ONE thing wrong, and this would stop being the test its
    // name claims.
    const { error } = validate({
      GITHUB_CAPABILITIES_DENY: 'repo.dry',
      CAPABILITY_GUARD_ENFORCING: 'false',
    });
    expect(error?.message).toMatch(/no such capability/);
  });

  it('accepts empty and whitespace-only — a deny list naming nothing denies nothing', () => {
    // Unlike FEEDBACK_LABELS, a value parsing to nothing is the ordinary state
    // here: denying nothing is what this ships with, and it stays legal in both
    // modes because there is no switch for it to switch off quietly.
    for (const blank of ['', '   ', ',', ' , ']) {
      const { error } = validate({ GITHUB_CAPABILITIES_DENY: blank });
      expect(error).toBeUndefined();
    }
  });

  it('defaults to denying nothing, and to refusing rather than reporting', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.GITHUB_CAPABILITIES_DENY).toBe('');
    // Task 8 flipped this, and this line is what holds it flipped: a deployment
    // that sets nothing gets a guard that refuses, not one that logs.
    expect(value.CAPABILITY_GUARD_ENFORCING).toBe(true);
  });

  it('takes CAPABILITY_GUARD_ENFORCING from the environment as the string it arrives as', () => {
    // Joi validates `process.env`, where every value is a string.
    expect(
      validate({ CAPABILITY_GUARD_ENFORCING: 'true' }).value
        .CAPABILITY_GUARD_ENFORCING,
    ).toBe(true);
  });
});

/**
 * The write credential (#584). The seam is through: `buildOctokitClient` takes a
 * purpose, and the three Github writes that build their own client pass
 * `'write'`. So a value on this key is now a configuration the board honours,
 * and the schema must accept it — a rule that refuses to boot when somebody
 * separates the two credentials is the thing that would leave them
 * inseparable.
 *
 * These tests replace the pair that asserted the opposite while the key was
 * only a seam.
 */
describe('config schema — GITHUB_WRITE_TOKEN (#584)', () => {
  it('accepts a set token, because separating the two credentials is the point', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const { error, value } = validate({ GITHUB_WRITE_TOKEN: token });
    expect(error).toBeUndefined();
    expect(value.GITHUB_WRITE_TOKEN).toBe(token);
  });

  it('asserts no shape, because Github issues five kinds of credential', () => {
    for (const token of ['github_pat_11ABCDE_' + 'x'.repeat(59), 'gho_' + 'z'.repeat(36), 'a']) {
      expect(validate({ GITHUB_WRITE_TOKEN: token }).error).toBeUndefined();
    }
  });

  it('unset and empty both mean "use GITHUB_TOKEN", which is every deployment today', () => {
    for (const env of [{}, { GITHUB_WRITE_TOKEN: '' }]) {
      const { error, value } = validate(env);
      expect(error).toBeUndefined();
      expect(value.GITHUB_WRITE_TOKEN).toBe('');
    }
  });

  it('never reaches the boot log, even when a neighbouring key fails validation', () => {
    // Nest prints the whole validation error when the boot dies, so a rule that
    // echoed this value would put the write credential in the log of every
    // failed boot.
    const { error } = validate({
      GITHUB_WRITE_TOKEN: 'ghp_' + 'a'.repeat(36),
      CAPABILITY_GUARD_ENFORCING: 'off',
    });
    expect(error?.message).toMatch(/CAPABILITY_GUARD_ENFORCING/);
    expect(error?.message).not.toMatch(/aaaa/);
  });
});

/**
 * A malformed agent-token list must not print the well-formed ones (#584, PR
 * #609 security re-review). Joi's default `string.pattern.base` message
 * interpolates the offending VALUE, and the value of this key is the whole
 * list — so one fatted colon on a second token would put every other agent's
 * 64-hex bearer secret into the boot failure, and into the platform deploy log
 * that keeps it. The rule is checked here rather than trusted, because the
 * thing that stops it is one `.message()` call a tidy-up could drop.
 */
describe('config schema — a bad BOARD_AGENT_TOKENS never echoes the good secrets (#584)', () => {
  const SECRET_A = 'a1b2c3d4'.repeat(8); // 64 hex, well-formed
  const SECRET_B = 'f00dcafe'.repeat(8);
  // Second entry missing its colon — the realistic operator slip.
  const MALFORMED = `agent-a:${SECRET_A},agent-b${SECRET_B}`;

  it('the fixture really does carry a 64-hex secret, so the negative below discriminates', () => {
    expect(SECRET_A).toHaveLength(64);
    expect(MALFORMED).toMatch(/[0-9a-fA-F]{64}/);
  });

  for (const options of [undefined, { abortEarly: false }]) {
    it(`fails validation and names the key, with no secret in the message (${JSON.stringify(options)})`, () => {
      const { error } = validate({ BOARD_AGENT_TOKENS: MALFORMED }, options);
      expect(error).toBeDefined();
      expect(error?.message).toMatch(/BOARD_AGENT_TOKENS/);
      // The whole point. Drop the `.message()` on the pattern and this dies.
      expect(error?.message).not.toMatch(/[0-9a-fA-F]{64}/);
      expect(error?.message).not.toContain(SECRET_A);
    });
  }

  it('still accepts the lists it accepted before — the rule itself is unchanged', () => {
    for (const ok of ['', `agent-a:${SECRET_A}`, `agent-a:${SECRET_A},agent-b:${SECRET_B}`]) {
      expect(validate({ BOARD_AGENT_TOKENS: ok }).error).toBeUndefined();
    }
  });
});

describe('config schema — PROJECTS_CACHE_TTL_MS has a floor (#713)', () => {
  const ttlError = (v: unknown) => validate({ PROJECTS_CACHE_TTL_MS: v }).error;

  it('refuses the values that switch the retiree fallback off', () => {
    // Strings, because Joi validates `process.env` and that is the coercion
    // path an operator's value actually takes.
    for (const off of ['0', '-1', '1', '30000']) {
      expect(ttlError(off)?.message, off).toContain('PROJECTS_CACHE_TTL_MS');
    }
  });

  it('accepts the floor itself and the default above it', () => {
    for (const ok of ['60000', '300000', '600000']) {
      expect(ttlError(ok), ok).toBeUndefined();
    }
  });

  it('still defaults to five minutes when unset', () => {
    expect(validate({}).value.PROJECTS_CACHE_TTL_MS).toBe(300000);
  });
});

/**
 * The Github webhook store (#1007, V5) is off unless its secret is set, and the
 * secret brings the store's own database with it. The URL alone does nothing.
 */
describe('config schema — the Github webhook store (#1007, V5)', () => {
  const SECRET = 'a-webhook-secret-twenty-plus';
  const STORE = 'postgresql://board:board@board-store-pg:5432/board_store';

  it('is off by default', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.GITHUB_WEBHOOK_SECRET).toBe('');
    expect(value.GITHUB_STORE_DATABASE_URL).toBe('');
    expect(value.ISSUES_STORE_MAX_AGE_MS).toBe(3_600_000);
  });

  it('refuses a secret shorter than twenty characters', () => {
    const { error } = validate({ GITHUB_WEBHOOK_SECRET: 'short', GITHUB_STORE_DATABASE_URL: STORE });
    expect(error?.message).toMatch(/GITHUB_WEBHOOK_SECRET/);
  });

  // Twenty characters was a length check and nothing else, so twenty spaces was
  // a valid key to the one public write endpoint on the service (#1070).
  it('refuses a secret made of whitespace, however long', () => {
    const { error } = validate({ GITHUB_WEBHOOK_SECRET: ' '.repeat(24), GITHUB_STORE_DATABASE_URL: STORE });
    expect(error?.message).toMatch(/GITHUB_WEBHOOK_SECRET must be at least 20 characters with no whitespace/);
  });

  it('refuses a secret with whitespace inside it, which a copied value carries', () => {
    const { error } = validate({ GITHUB_WEBHOOK_SECRET: 'a-webhook-secret twenty-plus', GITHUB_STORE_DATABASE_URL: STORE });
    expect(error?.message).toMatch(/GITHUB_WEBHOOK_SECRET/);
  });

  it('refuses the secret without the store URL', () => {
    const { error } = validate({ GITHUB_WEBHOOK_SECRET: SECRET });
    expect(error?.message).toMatch(/GITHUB_STORE_DATABASE_URL must be set/);
  });

  it('takes the secret with the store URL, and the URL alone', () => {
    expect(validate({ GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_STORE_DATABASE_URL: STORE }).error).toBeUndefined();
    expect(validate({ GITHUB_STORE_DATABASE_URL: STORE }).error).toBeUndefined();
  });

  it('keeps the store max age between a minute and a day', () => {
    expect(validate({ ISSUES_STORE_MAX_AGE_MS: 86_400_001 }).error?.message).toMatch(/ISSUES_STORE_MAX_AGE_MS/);
    expect(validate({ ISSUES_STORE_MAX_AGE_MS: 59_999 }).error?.message).toMatch(/ISSUES_STORE_MAX_AGE_MS/);
    expect(validate({ ISSUES_STORE_MAX_AGE_MS: 86_400_000 }).error).toBeUndefined();
  });
});

/**
 * Declaring a key that was read with a call-site default must not take an
 * operator's switch away with it (#1244 review).
 *
 * `BOOT_ALERT_LABEL`, `BOOT_ALERT_ASSIGNEE` and `APP_VERSION` were read off
 * `ConfigService` with a fallback and declared nowhere, so `allowUnknown` passed
 * whatever the environment held straight through — the empty string included.
 * Declaring them moved the same defaults to where boot validation can see them,
 * which is the point of #1183; a bare `Joi.string()` would also have started
 * REFUSING a value all three already had a meaning for, and the report called
 * the change behaviour-neutral.
 *
 * `BOOT_ALERT_LABEL=` is the one that matters. `boot-alert.notifier.ts` trims
 * the label and returns before writing anything when it is empty, so the empty
 * string is how an operator turns boot alerting off without turning writes off.
 * Refusing it would have removed that switch at the boot the alert exists to
 * report on, and left it reachable only as a string of spaces.
 */
describe('config schema — declaring a key keeps the empty string it already meant (#1244 review)', () => {
  it('takes an empty BOOT_ALERT_LABEL, the off switch for boot alerting', () => {
    const { value, error } = validate({ BOOT_ALERT_LABEL: '' });
    expect(error).toBeUndefined();
    expect(value.BOOT_ALERT_LABEL).toBe('');
  });

  it('takes an empty BOOT_ALERT_ASSIGNEE, which files the report unassigned', () => {
    const { value, error } = validate({ BOOT_ALERT_ASSIGNEE: '' });
    expect(error).toBeUndefined();
    expect(value.BOOT_ALERT_ASSIGNEE).toBe('');
  });

  it('takes an empty APP_VERSION, which both readers already answer null for', () => {
    const { value, error } = validate({ APP_VERSION: '' });
    expect(error).toBeUndefined();
    expect(value.APP_VERSION).toBe('');
  });

  it('still applies the default when the key is absent rather than empty', () => {
    const { value } = validate({});
    expect(value.BOOT_ALERT_LABEL).toBe('boot-error');
    expect(value.BOOT_ALERT_ASSIGNEE).toBeUndefined();
    expect(value.APP_VERSION).toBeUndefined();
  });

  /**
   * The fourth declaration is the one that does change behaviour, and on
   * purpose. `PROJECTS_LAST_GOOD_MAX_MS=` used to reach
   * `config.get<number>(...)` as the string it was — present, so the call-site
   * default did not apply — and be compared against an age in milliseconds.
   * There is no operator meaning to keep here: an empty value was never a
   * number, and the whole reason to declare the key was that it arrives as one.
   */
  it('refuses an empty PROJECTS_LAST_GOOD_MAX_MS, which was never a number', () => {
    expect(validate({ PROJECTS_LAST_GOOD_MAX_MS: '' }).error?.message).toMatch(/PROJECTS_LAST_GOOD_MAX_MS/);
    expect(validate({ PROJECTS_LAST_GOOD_MAX_MS: '600000' }).value.PROJECTS_LAST_GOOD_MAX_MS).toBe(600000);
  });
});

describe('boot alert recipient configuration (#1247)', () => {
  const enabled = {
    GITHUB_WRITE_ENABLED: 'true', IDENTITY_SOURCE: 'db', AUTH_DISABLED: 'false',
    DATABASE_URL: 'postgresql://board:board@localhost:5432/board',
    BOOT_ALERT_REPO: 'sample-owner/alerts',
  };

  it('refuses startup with an actionable error when no recipient is configured', () => {
    const { error } = validate(enabled, { abortEarly: false });
    expect(error?.details).toHaveLength(1);
    expect(error?.message).toContain('BOOT_ALERT_ASSIGNEE is not set');
    expect(error?.message).toContain('cannot assign boot alerts');
    expect(error?.message).toContain('Set BOOT_ALERT_ASSIGNEE');
  });

  it('terminates a real ConfigModule startup and prints the missing-recipient error', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
      const { ConfigModule } = require('@nestjs/config');
      const { configValidationSchema } = require('./src/config/config.schema');
      ConfigModule.forRoot({ ignoreEnvFile: true, validationSchema: configValidationSchema,
        validationOptions: { abortEarly: false } });
    `], {
      cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 15000,
      env: { ...NAMED, ...enabled },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Config validation error: BOOT_ALERT_ASSIGNEE');
    expect(result.stderr).toContain('cannot assign boot alerts');
    expect(result.stderr).toContain('Set BOOT_ALERT_ASSIGNEE');
  });

  it.each(['', '   '])('allows disabled alerting with label %j and no recipient', (label) => {
    expect(validate({ ...enabled, BOOT_ALERT_LABEL: label }).error).toBeUndefined();
  });

  it.each(['on-call', '', '   '])('preserves an explicitly configured assignee %j', (assignee) => {
    const { value, error } = validate({ ...enabled, BOOT_ALERT_ASSIGNEE: assignee });
    expect(error).toBeUndefined();
    expect(value.BOOT_ALERT_ASSIGNEE).toBe(assignee);
  });
});

describe('config schema — GitHub sign-in allow list', () => {
  it('defaults to admitting every GitHub user', () => {
    const { value, error } = validate();
    expect(error).toBeUndefined();
    expect(value.BOARD_ALLOWED_GITHUB).toBe('');
  });

  it('accepts plain logins, numeric ids and org: entries', () => {
    const { value, error } = validate({ BOARD_ALLOWED_GITHUB: 'octocat, 12345, org:acme, Org:Other' });
    expect(error).toBeUndefined();
    expect(value.BOARD_ALLOWED_GITHUB).toBe('octocat, 12345, org:acme, Org:Other');
  });

  it('refuses an entry that is not a GitHub login', () => {
    for (const bad of ['bad login', 'org:', 'a/b', '../evil']) {
      expect(validate({ BOARD_ALLOWED_GITHUB: bad }).error?.message).toMatch(/BOARD_ALLOWED_GITHUB/);
    }
  });
});

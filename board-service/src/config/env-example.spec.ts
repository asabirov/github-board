import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { configValidationSchema } from './config.schema';

/**
 * `.env.example` is what a fresh checkout copies, so it is the only place a
 * newcomer learns which settings exist and which values make the service run
 * without credentials. The schema is where those settings are actually
 * declared. Nothing kept the two in step, and both halves drifted (#502):
 * `ISSUES_SOURCE` and `DELIVERY_SOURCE` were declared with a `github` default
 * and never written down, so an unedited copy produced a service calling Github
 * with no credentials — empty stat tiles, no Throughput, no Oldest open, no unit
 * queue, and a 500 on any issue page — while the file still listed six settings
 * (`OKR_SOURCE`, `ROADMAP_UPDATES_SOURCE`, `SYNC_INTERVAL_MS`, `OAUTH_ISSUER`,
 * `OAUTH_TOKEN_AUDIENCE`, `OAUTH_JWKS_URI`) that no code had read since the OKR
 * machine and the auth.example.com flow were removed.
 *
 * The one-time fix would drift again the next time a source is added, so the
 * three checks below are the part worth keeping. Together they say: the file
 * describes settings that exist, it names every source toggle, and a copy of it
 * asks nothing of Github.
 */

const EXAMPLE_PATH = join(__dirname, '../../.env.example');

/** The `KEY=value` pairs in `.env.example`, comments and blanks dropped, quotes
 *  stripped the way dotenv strips them. Deliberately small: the example file is
 *  flat, single-line assignments, and a parser that understands more than the
 *  file contains would only hide a malformed line. */
function parseEnvExample(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(EXAMPLE_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    expect(eq, `\`${line}\` is not a KEY=value assignment`).toBeGreaterThan(0);
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Every key the schema declares. */
function schemaKeys(): string[] {
  return Object.keys(configValidationSchema.describe().keys);
}

/** A source toggle is any setting whose name ends in `_SOURCE`: the switch that
 *  chooses between a live backing service and the local fixture. `fixture` is a
 *  valid value for every one of them, which is what makes the whole app runnable
 *  offline — and what the last check below pins. */
const isSourceToggle = (key: string) => key.endsWith('_SOURCE');

describe('.env.example agrees with the config schema (#502)', () => {
  it('describes only settings the service actually reads', () => {
    const known = new Set(schemaKeys());
    const stale = Object.keys(parseEnvExample()).filter((key) => !known.has(key));
    expect(stale, 'these keys are in .env.example but not in the schema — dead settings').toEqual([]);
  });

  it('names every source toggle the schema declares', () => {
    const documented = new Set(Object.keys(parseEnvExample()));
    const missing = schemaKeys().filter(isSourceToggle).filter((key) => !documented.has(key));
    expect(missing, 'these toggles are discoverable only in the Joi schema').toEqual([]);
  });

  it('boots credential-less when copied unedited: every source reads a fixture', () => {
    // allowUnknown mirrors how ConfigModule validates the real env, so a stale
    // key fails the check above rather than this one.
    const { value, error } = configValidationSchema.validate(parseEnvExample(), { allowUnknown: true });
    expect(error).toBeUndefined();

    const live = Object.keys(value)
      .filter(isSourceToggle)
      .filter((key) => value[key] !== 'fixture')
      .map((key) => `${key}=${value[key]}`);
    expect(live, 'a copy of .env.example would reach for credentials here').toEqual([]);
  });
});

// Retirement must leave local startup independent of the removed vendor (#852).
it('does not synthesize retired vendor settings for fixture startup', () => {
  const { value, error } = configValidationSchema.validate(parseEnvExample(), { allowUnknown: true });
  expect(error).toBeUndefined();
  for (const key of ['BOARD_DATA_SOURCE', 'POSTHOG_HOST', 'POSTHOG_PROJECT_ID', 'POSTHOG_API_KEY']) {
    expect(value).not.toHaveProperty(key);
  }
  expect(value.ISSUES_SOURCE).toBe('fixture');
  expect(value.BOARD_ALLOWED_GITHUB).toBe('');
});

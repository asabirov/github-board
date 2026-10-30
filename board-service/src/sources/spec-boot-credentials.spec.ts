import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A spec that boots the real AppModule must hold no live Github credential
 * (#756 review).
 *
 * WHAT WENT WRONG. `required-scopes.integration.spec.ts` blanked
 * GITHUB_TOKEN, GITHUB_APP_ID, GITHUB_PRIVATE_KEY and GITHUB_INSTALLATION_ID
 * under the banner "so boot never touches the network" — and not
 * GITHUB_WRITE_TOKEN, which `github-client.ts` reads FIRST for purpose
 * 'write'. #756 then hung a boot hook off AdminModule that asks Github
 * `GET /user` under exactly that credential. `GITHUB_WRITE_ENABLED=false` does
 * not stop it: the service REPORTS that flag, it does not obey it. So a
 * developer with a machine-user token in a local `.env` made a live call under
 * the production write credential every time they ran that file. CI, which has
 * no such variable, was unaffected — which is why nothing went red.
 *
 * WHY A SCAN AND NOT A COMMENT. The list of blanked variables is a thing to
 * keep in sync with the list of variables the boot path reads, in every spec
 * that boots the whole app, forever. That is the shape a check exists for. A
 * new integration spec pasted from an old one now fails here by name rather
 * than by making a request somebody has to notice on Github's audit log.
 */

const SRC = join(__dirname, '..');

/** Every spec file under `src/`, both lanes: `*.spec.ts` and `*.db-spec.ts`. */
function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...specFiles(full));
    else if (/\.(db-)?spec\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** A real import of the app module — `import('../app.module')` or
 *  `from '../app.module'`, with an optional `.js` extension.
 *  `capability/writes-enveloped.spec.ts` writes '/synthetic/app.module.ts'
 *  as a KEY in an in-memory file map and boots
 *  nothing, so matching an import and not the bare string is the difference
 *  between a guard and a nuisance. */
const BOOTS_APP = /(?:import\(|from\s+)['"][^'"]*\/app\.module(?:\.js)?['"]/;

/** Every credential the boot path can spend. GITHUB_WRITE_TOKEN is the one this
 *  spec was written for; the rest were already blanked by hand and belong here
 *  so that stays true. */
const CREDENTIALS = [
  'GITHUB_USER_APP_CLIENT_ID',
  'GITHUB_USER_APP_CLIENT_SECRET',
  'BOARD_CREDENTIAL_KEY',
  'GITHUB_WRITE_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_PRIVATE_KEY',
  'GITHUB_INSTALLATION_ID',
];

describe('a spec that boots the real AppModule blanks every Github credential (#756)', () => {
  const booting = specFiles(SRC)
    // This file QUOTES the import it looks for, in the comment above, and boots
    // nothing. Nothing else in the tree mentions app.module without importing it.
    .filter((f) => !f.endsWith('spec-boot-credentials.spec.ts'))
    .filter((f) => BOOTS_APP.test(readFileSync(f, 'utf8')));

  it('finds the specs that boot it — a scan that matches nothing guards nothing', () => {
    expect(booting.map((f) => relative(SRC, f)).sort()).toEqual([
      'auth/github-first-load.integration.db-spec.ts',
      'auth/github-request.integration.db-spec.ts',
      'auth/required-scopes.integration.spec.ts',
      'freshness/write-freshness.integration.db-spec.ts',
      'github-store/webhook.integration.db-spec.ts',
    ]);
  });

  for (const file of booting) {
    const name = relative(SRC, file);
    it(`${name} blanks all of them before the import`, () => {
      const text = readFileSync(file, 'utf8');
      // Before the import, because `process.env` is read while AppModule's
      // ConfigModule loads — a line after it is a line too late.
      const importedAt = text.search(BOOTS_APP);
      for (const key of CREDENTIALS) {
        const assignment = new RegExp(`process\\.env\\.${key}\\s*=\\s*['"]['"]`);
        const at = text.search(assignment);
        expect(at, `${name} must set process.env.${key} = ''`).toBeGreaterThanOrEqual(0);
        expect(at, `${name} must blank ${key} BEFORE it imports app.module`).toBeLessThan(importedAt);
      }
    });
  }
});

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Which databases the container migrates before it serves (#1158 review, B1).
 *
 * The store migration used to run only when GITHUB_STORE_DATABASE_URL and
 * GITHUB_WEBHOOK_SECRET were BOTH set, and two features share that database
 * behind two different switches. The webhook receiver wants both, but
 * `github-destination-bootstrap.ts` reads the URL alone. A board with the URL
 * and no secret then booted against an unmigrated store, and nothing refused
 * that configuration.
 *
 * This runs the real entrypoint under `sh` against stub binaries rather than
 * matching its text, because what went wrong was a CONDITION and a regex over
 * one proves nothing about which branch a shell takes. `prisma` records the
 * `DATABASE_URL` it was handed, and `node` stands in for the server so the
 * final `exec` returns.
 */
const ENTRYPOINT = join(__dirname, '..', 'docker-entrypoint.sh');

/** Runs the entrypoint in a throwaway tree and returns the URL each
 *  `prisma migrate deploy` was invoked with, in order. */
function migratedUrls(env: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'board-entrypoint-'));
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  const log = join(dir, 'migrations.log');
  const stub = (body: string) => `#!/bin/sh\n${body}\n`;
  writeFileSync(join(dir, 'node_modules', '.bin', 'prisma'), stub(`echo "$DATABASE_URL" >> ${JSON.stringify(log)}`));
  chmodSync(join(dir, 'node_modules', '.bin', 'prisma'), 0o755);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'node'), stub('echo "served"'));
  chmodSync(join(dir, 'bin', 'node'), 0o755);
  writeFileSync(log, '');
  copyFileSync(ENTRYPOINT, join(dir, 'entrypoint.sh'));
  execFileSync('sh', ['entrypoint.sh'], {
    cwd: dir,
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, DATABASE_URL: 'postgresql://identity/db', ...env },
    encoding: 'utf8',
  });
  return readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

describe('docker-entrypoint.sh', () => {
  it('migrates the store database on the URL alone, with no webhook secret', () => {
    expect(migratedUrls({ GITHUB_STORE_DATABASE_URL: 'postgresql://store/db' })).toEqual([
      'postgresql://identity/db',
      'postgresql://store/db',
    ]);
  });

  it('still migrates it when the webhook receiver is switched on too', () => {
    const urls = migratedUrls({
      GITHUB_STORE_DATABASE_URL: 'postgresql://store/db',
      GITHUB_WEBHOOK_SECRET: 'a-webhook-secret-long-enough',
    });
    expect(urls).toEqual(['postgresql://identity/db', 'postgresql://store/db']);
  });

  it('migrates only the identity database when no store URL is set', () => {
    expect(migratedUrls({})).toEqual(['postgresql://identity/db']);
    expect(migratedUrls({ GITHUB_WEBHOOK_SECRET: 'a-webhook-secret-long-enough' })).toEqual(['postgresql://identity/db']);
  });
});

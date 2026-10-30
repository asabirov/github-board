import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript-api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { buildOctokitClient, tokenFor } from './github-client';

/** The factory is read through the ARGUMENT it constructs Octokit with, never
 *  through the instance: Octokit does not publish the `auth` it was built with,
 *  and a test that reached into it would break on the library's next minor. */
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn(function () { return { hook: { wrap: vi.fn() } }; }) }));
const builtWith = () => vi.mocked(Octokit).mock.calls.at(-1)?.[0] as Record<string, unknown>;

/**
 * The write seam (#584, item 7 of the definition of done).
 *
 * Everything here asks `tokenFor`, never an Octokit instance: Octokit does not
 * expose the `auth` it was built with, and a test that reached for it would
 * break on the library's next minor.
 */
const cfg = (env: Record<string, string>) =>
  ({ get: (k: string, d?: unknown) => env[k] ?? d }) as unknown as ConfigService;

describe('tokenFor', () => {
  it('a write client prefers GITHUB_WRITE_TOKEN when it is set', () => {
    expect(tokenFor(cfg({ GITHUB_TOKEN: 'ghp_read', GITHUB_WRITE_TOKEN: 'ghp_write' }), 'write')).toBe(
      'ghp_write',
    );
  });

  it('a write client falls back to GITHUB_TOKEN when it is not — every deployment today', () => {
    expect(tokenFor(cfg({ GITHUB_TOKEN: 'ghp_read' }), 'write')).toBe('ghp_read');
  });

  it('an empty GITHUB_WRITE_TOKEN is unset, not a credential', () => {
    // The value every deployment carries once the key is in the schema with a
    // `''` default: present in the env, and meaning "use GITHUB_TOKEN". Reading
    // it as a credential would authenticate every write as nobody.
    expect(tokenFor(cfg({ GITHUB_TOKEN: 'ghp_read', GITHUB_WRITE_TOKEN: '' }), 'write')).toBe('ghp_read');
  });

  it('a READ client never reaches for the write token', () => {
    // The half that makes the seam a separation rather than a second name for
    // the same thing. Without it, setting GITHUB_WRITE_TOKEN would hand every
    // one of the fifteen read paths the write credential — the exact widening
    // this issue exists to make unnecessary.
    expect(tokenFor(cfg({ GITHUB_TOKEN: 'ghp_read', GITHUB_WRITE_TOKEN: 'ghp_write' }), 'read')).toBe(
      'ghp_read',
    );
  });
});

/**
 * `tokenFor` above is the decision; this is the factory ACTING on it, and until
 * PR #609's review it had no test at all — the suite imported `tokenFor` and
 * never called `buildOctokitClient`. Two mutations survived all 1824 tests and
 * `tsc --noEmit`: pinning the call to `tokenFor(config, 'read')`, and deleting
 * the `if (token)` branch outright. That line IS the seam.
 */
describe('buildOctokitClient', () => {
  beforeEach(() => vi.mocked(Octokit).mockClear());

  it('a write client is constructed with the WRITE token', () => {
    buildOctokitClient(cfg({ GITHUB_TOKEN: 'ghp_read', GITHUB_WRITE_TOKEN: 'ghp_write' }), 'write');
    expect(builtWith()).toEqual({ auth: 'ghp_write' });
  });

  it('a read client is constructed with the READ token, with both set', () => {
    // The half that makes the seam a separation. Pin the factory to `'read'` and
    // the test above dies; pin it to `'write'` and this one does.
    buildOctokitClient(cfg({ GITHUB_TOKEN: 'ghp_read', GITHUB_WRITE_TOKEN: 'ghp_write' }), 'read');
    expect(builtWith()).toEqual({ auth: 'ghp_read' });
  });

  it('the default purpose is read — what fifteen silent call sites are asking for', () => {
    buildOctokitClient(cfg({ GITHUB_TOKEN: 'ghp_read', GITHUB_WRITE_TOKEN: 'ghp_write' }));
    expect(builtWith()).toEqual({ auth: 'ghp_read' });
  });

  it('falls back to the App strategy when there is no token at all', () => {
    // The `if (token)` branch's other side. Delete the branch and this passes
    // while the three above die; keep only this one and the branch can go
    // unnoticed — which is the state the suite was in.
    buildOctokitClient(
      cfg({ GITHUB_APP_ID: '42', GITHUB_PRIVATE_KEY: 'a\\nb', GITHUB_INSTALLATION_ID: '7' }),
      'write',
    );
    expect(builtWith()).toEqual({
      authStrategy: createAppAuth,
      // The `\n`-escape is undone here so every caller behaves identically.
      auth: { appId: '42', privateKey: 'a\nb', installationId: 7 },
    });
  });
});

/**
 * The census (#584). `tokenFor` above proves the two purposes resolve to
 * different tokens; nothing there notices if a call site stops asking for the
 * write one. Reverting `setDri` to the read default breaks no unit test, no
 * typecheck and no boot — it only means that on the day the two credentials
 * differ, that write goes out under the read one and nobody finds out until
 * Github refuses it.
 *
 * So this reads the source. It asserts the SET of writing call sites rather
 * than a count, which fails in both directions that matter: a write that
 * quietly reverts to reading, and a new write client that never declared
 * itself.
 */
const SRC = join(__dirname, '..');

/**
 * Every `buildOctokitClient(…)` call in src/, as `<file>#<enclosing function>`.
 *
 * `stated` is whether the site passed a purpose ARGUMENT, which is not the same
 * question as what purpose it resolves to — a silent site resolves to `'read'`
 * off the signature's default, and the count of silent sites is what that
 * default is load-bearing for. Recording the two separately is what lets the
 * count below be measured rather than described in a comment that drifts.
 */
function callSites(): { where: string; purpose: string; stated: boolean }[] {
  const out: { where: string; purpose: string; stated: boolean }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) visit(full);
    }
  };
  const visit = (file: string): void => {
    const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const enclosing = (node: ts.Node): string => {
      for (let n: ts.Node | undefined = node; n; n = n.parent) {
        if (
          (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isPropertyDeclaration(n)) &&
          n.name
        )
          return n.name.getText(src);
      }
      return '<module>';
    };
    const scan = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'buildOctokitClient'
      ) {
        const arg = node.arguments[1];
        out.push({
          // The default IS 'read' — see `buildOctokitClient`'s signature.
          purpose: arg && ts.isStringLiteral(arg) ? arg.text : 'read',
          stated: Boolean(arg && ts.isStringLiteral(arg)),
          where: `${relative(SRC, file)}#${enclosing(node)}`,
        });
      }
      ts.forEachChild(node, scan);
    };
    scan(src);
  };
  walk(SRC);
  return out;
}

/** What `buildOctokitClient` writes as its `purpose` default, from its own source. */
function declaredDefaultPurpose(): string | null {
  const file = join(__dirname, 'github-client.ts');
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let found: string | null = null;
  const scan = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'buildOctokitClient') {
      const param = node.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === 'purpose');
      const init = param?.initializer;
      found = init && ts.isStringLiteral(init) ? init.text : null;
    }
    ts.forEachChild(node, scan);
  };
  scan(src);
  return found;
}

describe('the write purpose, at the call sites', () => {
  it('defaults to read, which is what every silent call site is asking for', () => {
    // The census below reads arguments, and the silent sites pass none — so
    // every one of them means whatever this default says. Flip it to 'write'
    // and each of them quietly takes the write credential, with no argument
    // anywhere in the tree changed to say so.
    expect(declaredDefaultPurpose()).toBe('read');

    // MEASURED, not described: how many sites that default is speaking for.
    // The number was fifteen until #625 split the issue-detail client, which
    // added a `'write'` site and made the read half state its purpose out loud
    // — so fourteen sites are silent now. #647's boot per-org read is the
    // sixteenth that resolves to read, and it STATES `'read'`, which is why the
    // silent count below did not move. A count in a sentence would have gone
    // stale here without failing.
    // #1167's rename ask is the eighteenth that resolves to read, and it
    // STATES `'read'` as the boot per-org read does, so the silent count holds
    // at fourteen for the fourth issue running. The #1450 feedback-removal slice
    // took one silent site away with its module, so the counts are one lower.
    // The removal of the account feedback form (#1450) took three more sites:
    // one silent read, one stated read and one write.
    const sites = callSites();
    expect(sites.filter((c) => !c.stated)).toHaveLength(12);
    expect(sites.filter((c) => c.purpose === 'read')).toHaveLength(15);
    expect(sites).toHaveLength(19);
  });

  it('is passed by the three mutation clients and startup destination verification', () => {
    const writers = callSites()
      .filter((c) => c.purpose === 'write')
      .map((c) => c.where)
      .sort();
    // A SET, not a count, so it fails in both directions that matter: a write
    // that quietly reverts to the read default, and a new write client that
    // never declared itself. `#writeOctokit` is the issue-detail source's write
    // half (#625) — one call site carrying nine of the board's thirteen Github
    // mutations, where before the split those nine rode the read client.
    expect(writers).toEqual([
      'boot-alert/boot-alert.notifier.ts#file',
      'config/github-destination-bootstrap.ts#start',
      'issue-detail/github-issue-detail.source.ts#writeOctokit',
      'repos/github-repos.source.ts#setDri',
    ]);
  });

  it('leaves every other client on the read default', () => {
    const sites = callSites();
    // Guards the assertion above against a walk that found nothing: a census of
    // an empty set is not a census.
    expect(sites.length).toBeGreaterThan(10);
    expect(sites.filter((c) => c.purpose !== 'write' && c.purpose !== 'read')).toEqual([]);
    // The issue-detail source's two halves, both of them, named together (#625).
    // Asserting only the write half would let the read half follow it onto the
    // write credential without a word — which is the failure the split exists to
    // prevent in the other direction, and the reason `write-credential.spec.ts`
    // measures the read path in the same run.
    const purposes = sites.map((c) => `${c.where}:${c.purpose}`);
    expect(purposes).toContain('issue-detail/github-issue-detail.source.ts#octokit:read');
    expect(purposes).toContain('issue-detail/github-issue-detail.source.ts#writeOctokit:write');
  });
});

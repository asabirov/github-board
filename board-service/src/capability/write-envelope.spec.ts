import { describe, expect, it } from 'vitest';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { cfg } from './capability-testing.contract';
import { CapabilityRegistry } from './capability.registry';
import { guardWrite } from './write-envelope';
import type { OwnerWritability } from '../repos/repo.types';

/** A registry that has learned nothing. `state()` answers `unknown` for
 *  everything and `unknown` refuses nothing, so it changes no rung below — it is
 *  here because `registry` and `capability` are REQUIRED now (#584): a route
 *  that forgets either one no longer compiles. */
const idle = new CapabilityRegistry(cfg());
const issueEnv = {
  allowedOwners: ['acme'],
  writesEnabled: true,
  registry: idle,
  capability: 'issue.state' as const,
};
const repoEnv = {
  ...issueEnv,
  capability: 'repo.dri' as const,
  allowed: ['octocat', 'IvanRoslov'],
  writability: 'writable' as const,
};

describe('guardWrite (#584) — the one envelope, both subjects', () => {
  it('parses and returns the issue number', () => {
    expect(
      guardWrite({ kind: 'issue', owner: 'acme', repo: 'board', name: '42', email: 'a@x.io' }, issueEnv),
    ).toBe(42);
  });

  it('returns null for a repo subject', () => {
    expect(
      guardWrite({ kind: 'repo', owner: 'acme', name: 'board', login: 'octocat', email: 'a@x.io' }, repoEnv),
    ).toBeNull();
  });

  it('answers the owner-pin FIRST, even when the name is also wrong', () => {
    // The rung the inline copy in `close` got backwards. 404, never 400 — a 400
    // here tells an off-org caller that the number was the problem, which says
    // the org was not.
    expect(() =>
      guardWrite({ kind: 'issue', owner: 'someoneelse', repo: 'board', name: 'x', email: 'a@x.io' }, issueEnv),
    ).toThrow(NotFoundException);
  });

  it('refuses an unreadable schema BEFORE judging the login against it', () => {
    // #577's sixth review round, encoded. `allowed` is empty because the read
    // failed, so judging a valid login against it would refuse it for a reason
    // the board invented. `unreadable` is the state a failed read produces since
    // #649; `unknown` (the row read, its one value unrecognised) and `absent`
    // (no such property) reach the same empty list by different roads and must
    // answer before it too.
    for (const writability of ['unreadable', 'unknown'] as const) {
      expect(() =>
        guardWrite(
          { kind: 'repo', owner: 'acme', name: 'board', login: 'octocat', email: 'a@x.io' },
          { ...repoEnv, allowed: [], writability },
        ),
      ).toThrow(BadGatewayException);
    }
    expect(() =>
      guardWrite(
        { kind: 'repo', owner: 'acme', name: 'board', login: 'octocat', email: 'a@x.io' },
        { ...repoEnv, allowed: [], writability: 'absent' },
      ),
    ).toThrow(ForbiddenException);
  });

  it('a repo name that is a path is refused as a name, not resolved', () => {
    for (const bad of ['../x', 'a/b', '.', '..', 'a%2e%2e']) {
      expect(() =>
        guardWrite({ kind: 'repo', owner: 'acme', name: bad, login: null, email: 'a@x.io' }, repoEnv),
      ).toThrow(BadRequestException);
    }
  });

  it('an ABSENT login on a repo subject is refused exactly as today', () => {
    // The old `guardRepoWrite` ran `login !== null && !allowed.includes(login)`,
    // so an empty body — `body.login === undefined` — 400s today. A merged
    // envelope that skipped the rung when `login === undefined` would silently
    // start accepting an empty body. The rung runs for every repo subject.
    expect(() =>
      guardWrite({ kind: 'repo', owner: 'acme', name: 'board', email: 'a@x.io' }, repoEnv),
    ).toThrow(BadRequestException);
  });

  // #584, PR #609 review — the issue branch's `repo` was checked by nothing
  // while it reached the capability target key, the log line and the 404 body.
  // The repo branch has validated `name` since #558; this is the same rung and
  // the same 400, so neither branch is the soft one.
  it('400s an issue subject whose repo is a path rather than a name', () => {
    for (const repo of ['.', '..', 'a/../b', 'a\\b', '%2e%2e', 'a?b', 'a#b', '']) {
      expect(
        () => guardWrite({ kind: 'issue', owner: 'acme', repo, name: '42', email: 'a@x.io' }, issueEnv),
        `repo ${JSON.stringify(repo)} was accepted`,
      ).toThrow(BadRequestException);
    }
  });

  it('still accepts the repo names the issue routes are actually called with', () => {
    for (const repo of ['board', 'board', 'acme-ui', 'acme_platform', 'a.b-c_d']) {
      expect(
        guardWrite({ kind: 'issue', owner: 'acme', repo, name: '42', email: 'a@x.io' }, issueEnv),
      ).toBe(42);
    }
  });

  it('skips the repo-only rungs for an issue subject rather than defaulting them', () => {
    // `writability` absent must not read as `unknown` and 502 every issue write.
    expect(
      guardWrite({ kind: 'issue', owner: 'acme', repo: 'board', name: '7', email: 'a@x.io' }, issueEnv),
    ).toBe(7);
  });

  it('refuses a TARGET-scoped capability refusal, which the guard could not see', () => {
    const registry = new CapabilityRegistry(cfg());
    registry.recordRefusal(
      'repo.dri',
      { reason: 'not-permitted', message: 'no', status: 403, retryable: false, scope: 'target' },
      'acme/locked',
    );
    const env = { ...repoEnv, registry, capability: 'repo.dri' as const };
    expect(() =>
      guardWrite({ kind: 'repo', owner: 'acme', name: 'locked', login: 'octocat', email: 'a@x.io' }, env),
    ).toThrow(ForbiddenException);
    // …and the repo NEXT TO IT is untouched, which is the whole point of scoping.
    expect(
      guardWrite({ kind: 'repo', owner: 'acme', name: 'other', login: 'octocat', email: 'a@x.io' }, env),
    ).toBeNull();
  });

  it('refuses a target-scoped refusal on an ISSUE subject too, keyed on owner/REPO', () => {
    // The rung's other half, and the one an earlier draft shipped as a silent
    // no-op: with only the `kind: 'repo'` case above, a rung that built its issue
    // target out of the issue NUMBER would pass every test in this file while
    // enforcing nothing on nine of the eleven Github writes. This test is the
    // only thing standing between that bug and production.
    const registry = new CapabilityRegistry(cfg());
    registry.recordRefusal(
      'issue.state',
      { reason: 'not-permitted', message: 'no', status: 403, retryable: false, scope: 'target' },
      'acme/board', // owner/REPO — what the producers record
    );
    const env = { ...issueEnv, registry, capability: 'issue.state' as const };
    expect(() =>
      guardWrite({ kind: 'issue', owner: 'acme', repo: 'board', name: '42', email: 'a@x.io' }, env),
    ).toThrow(ForbiddenException);
    // …and a DIFFERENT repo in the same org is untouched, so this is scoping and
    // not a rung that refuses every issue write.
    expect(
      guardWrite({ kind: 'issue', owner: 'acme', repo: 'roadmap', name: '42', email: 'a@x.io' }, env),
    ).toBe(42);
  });

  // ## The rung survives a re-cased path (#584, PR #609 review)
  //
  // Both reviewers found this independently and one executed it. The owner-pin
  // compares `.toLowerCase()`, so `Acme/locked` walks past it; the target
  // key was built raw and looked up in a `Map`, which compares exactly, so the
  // refusal recorded for `acme/locked` was missed — and Github resolves
  // owners and repos case-insensitively, so both requests reach the SAME
  // repository. Every fixture in this file was lowercase, which is why 1824
  // tests missed it. `targetKey` normalises the target half now.
  it('refuses a re-cased path a refusal was recorded for — repo subject', () => {
    const registry = new CapabilityRegistry(cfg());
    registry.recordRefusal(
      'repo.dri',
      { reason: 'not-permitted', message: 'no', status: 403, retryable: false, scope: 'target' },
      'acme/locked',
    );
    const env = { ...repoEnv, registry, capability: 'repo.dri' as const };
    for (const [owner, name] of [
      ['Acme', 'locked'],
      ['acme', 'Locked'],
      ['ACME', 'LOCKED'],
    ]) {
      expect(() =>
        guardWrite({ kind: 'repo', owner, name, login: 'octocat', email: 'a@x.io' }, env),
        `${owner}/${name} walked past the rung`,
      ).toThrow(ForbiddenException);
    }
    // …and a repo that merely differs in case from NOTHING recorded is still
    // untouched, so this is normalisation and not a rung that refuses everything.
    expect(
      guardWrite({ kind: 'repo', owner: 'Acme', name: 'Other', login: 'octocat', email: 'a@x.io' }, env),
    ).toBeNull();
  });

  it('refuses a re-cased path a refusal was recorded for — issue subject', () => {
    const registry = new CapabilityRegistry(cfg());
    registry.recordRefusal(
      'issue.state',
      { reason: 'not-permitted', message: 'no', status: 403, retryable: false, scope: 'target' },
      'acme/board',
    );
    const env = { ...issueEnv, registry, capability: 'issue.state' as const };
    for (const [owner, repo] of [
      ['Acme', 'board'],
      ['acme', 'Board'],
      ['ACME', 'BOARD'],
    ]) {
      expect(() => guardWrite({ kind: 'issue', owner, repo, name: '42', email: 'a@x.io' }, env), `${owner}/${repo} walked past the rung`).toThrow(
        ForbiddenException,
      );
    }
    expect(guardWrite({ kind: 'issue', owner: 'Acme', repo: 'Roadmap', name: '42', email: 'a@x.io' }, env)).toBe(
      42,
    );
  });

  // ## The fold and the repo rung are load-bearing TOGETHER (#584, PR #609
  //    re-review)
  //
  // `targetKey` lowercases the target half, and across `0x80`-`0x10FFFF`
  // exactly one code point lowercases into Github's repo charset: U+212A KELVIN
  // SIGN, which folds to ASCII `k`. Two DIFFERENT repositories therefore
  // collapse onto one key — unless the name rung refuses the non-ASCII spelling
  // before it ever reaches the registry, which is what `isRepoName` does on
  // BOTH branches. The two landed in one commit by scheduling; this test is
  // what says they cannot be separated. Delete either `isRepoName` call and it
  // dies: the request stops answering 400 and starts answering the OTHER
  // repository's 403.
  it('a repo name that folds onto another target is refused as a name, never keyed onto it', () => {
    const registry = new CapabilityRegistry(cfg());
    const refusal = {
      reason: 'not-permitted' as const,
      message: 'no',
      status: 403,
      retryable: false,
      scope: 'target' as const,
    };
    registry.recordRefusal('issue.state', refusal, 'acme/kit');
    registry.recordRefusal('repo.dri', refusal, 'acme/kit');
    // Written as an escape on purpose: a raw non-ASCII byte in a fixture is a
    // thing an editor, a lint --fix or a copy-paste can silently normalise away,
    // and this test would then pass for the wrong reason.
    const kelvin = '\u212Ait'; // U+212A KELVIN SIGN, then `it`
    // Measured, not asserted: this is the whole reason the rung is load-bearing.
    expect(kelvin.toLowerCase()).toBe('kit');
    expect(kelvin).not.toBe('Kit');
    // 400 — the name rung — and NOT the 403 the ASCII repo next door holds.
    expect(() =>
      guardWrite({ kind: 'issue', owner: 'acme', repo: kelvin, name: '42', email: 'a@x.io' }, { ...issueEnv, registry }),
    ).toThrow(BadRequestException);
    expect(() =>
      guardWrite({ kind: 'repo', owner: 'acme', name: kelvin, login: 'octocat', email: 'a@x.io' }, { ...repoEnv, registry }),
    ).toThrow(BadRequestException);
  });

  // The other half of the same key. A refusal recorded under one casing and a
  // success recorded under another used to leave a stale 403 for the whole TTL —
  // the write landed, and the board went on refusing the next one.
  it('a success under one casing clears a refusal held under another', () => {
    const registry = new CapabilityRegistry(cfg());
    registry.recordRefusal(
      'repo.dri',
      { reason: 'not-permitted', message: 'no', status: 403, retryable: false, scope: 'target' },
      'acme/locked',
    );
    registry.recordSuccess('repo.dri', 'Acme/Locked');
    expect(
      guardWrite({ kind: 'repo', owner: 'acme', name: 'locked', login: 'octocat', email: 'a@x.io' }, {
        ...repoEnv,
        registry,
        capability: 'repo.dri',
      }),
    ).toBeNull();
  });

  // ## Reporting mode is one switch, not one per layer (#604)
  //
  // `CAPABILITY_GUARD_ENFORCING=false` is the documented rollback, and
  // `config.schema.ts` promises in as many words that it puts the board back
  // into reporting mode — every refusal logged, every write still landing. A
  // target rung that threw regardless would make that promise false for the
  // half of the capability check the guard cannot do.
  it('reporting mode lets a refused TARGET through, on both subjects', () => {
    const registry = new CapabilityRegistry(cfg());
    const refusal = {
      reason: 'not-permitted' as const,
      message: 'no',
      status: 403,
      retryable: false,
      scope: 'target' as const,
    };
    registry.recordRefusal('repo.dri', refusal, 'acme/locked');
    registry.recordRefusal('issue.state', refusal, 'acme/board');
    expect(
      guardWrite(
        { kind: 'repo', owner: 'acme', name: 'locked', login: 'octocat', email: 'a@x.io' },
        { ...repoEnv, registry, capability: 'repo.dri', enforcing: false },
      ),
    ).toBeNull();
    expect(
      guardWrite(
        { kind: 'issue', owner: 'acme', repo: 'board', name: '42', email: 'a@x.io' },
        { ...issueEnv, registry, capability: 'issue.state', enforcing: false },
      ),
    ).toBe(42);
  });

  it('an env carrying no `enforcing` at all still refuses — the default is closed', () => {
    // The other half of the switch, and the one worth a test of its own: an env
    // this rung cannot read must not read as reporting mode. Flip the default to
    // `false` and this dies while every other test in the file stays green.
    const registry = new CapabilityRegistry(cfg());
    registry.recordRefusal(
      'repo.dri',
      { reason: 'not-permitted', message: 'no', status: 403, retryable: false, scope: 'target' },
      'acme/locked',
    );
    expect(() =>
      guardWrite({ kind: 'repo', owner: 'acme', name: 'locked', login: 'octocat', email: 'a@x.io' }, {
        ...repoEnv,
        registry,
        capability: 'repo.dri',
      }),
    ).toThrow(ForbiddenException);
  });

  it('carries the refusal reason and the authorize URL out to the client', () => {
    // The body shape `refusalToHttp` and `CapabilityGuard` both send, so the
    // frontend's `describeEditFailure` reads this refusal exactly as it reads
    // theirs — including the `not-permitted-yet` link, which is the one refusal
    // a person can fix themselves.
    const registry = new CapabilityRegistry(cfg());
    registry.recordRefusal(
      'repo.dri',
      {
        reason: 'not-permitted-yet',
        message: 'Single sign-on is required.',
        status: 403,
        retryable: false,
        scope: 'target',
        authorizeUrl: 'https://github.com/orgs/acme/sso',
      },
      'acme/locked',
    );
    try {
      guardWrite({ kind: 'repo', owner: 'acme', name: 'locked', login: 'octocat', email: 'a@x.io' }, {
        ...repoEnv,
        registry,
        capability: 'repo.dri',
      });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual({
        message: 'Single sign-on is required.',
        reason: 'not-permitted-yet',
        authorizeUrl: 'https://github.com/orgs/acme/sso',
      });
    }
  });
});

// Everything the two envelopes this one replaces asserted, kept whole. Nothing
// below is new; it is `issue-mutations.spec.ts` and `repo-write.spec.ts` moved
// onto the merged function, so the merge cannot quietly drop a rung.
describe('guardWrite — the issue rungs it inherits (#384)', () => {
  const issue = (owner: string, name: string, email: string | undefined) =>
    ({ kind: 'issue', owner, repo: 'board', name, email }) as const;

  it('returns the number when the envelope passes', () => {
    expect(guardWrite(issue('acme', '42', 'a@x.io'), issueEnv)).toBe(42);
  });
  it('404s an owner outside the mirrored org (no info leak)', () => {
    expect(() => guardWrite(issue('someoneelse', '42', 'a@x.io'), issueEnv)).toThrow(NotFoundException);
  });
  it('400s a non-positive issue number', () => {
    expect(() => guardWrite(issue('acme', 'x', 'a@x.io'), issueEnv)).toThrow(BadRequestException);
  });
  it('503s when writes are disabled', () => {
    expect(() => guardWrite(issue('acme', '42', 'a@x.io'), { ...issueEnv, writesEnabled: false })).toThrow(
      ServiceUnavailableException,
    );
  });
  it('401s without a session email', () => {
    expect(() => guardWrite(issue('acme', '42', undefined), issueEnv)).toThrow(UnauthorizedException);
  });
});

describe('guardWrite — the repo rungs it inherits (#558)', () => {
  const repo = (owner: string, name: string, login: string | null, email: string | undefined) =>
    ({ kind: 'repo', owner, name, login, email }) as const;

  it('passes (returns null) when the envelope is satisfied', () => {
    expect(guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), repoEnv)).toBeNull();
  });

  it('passes with a null login — clearing the owner is a valid write', () => {
    expect(guardWrite(repo('acme', 'board', null, 'a@x.io'), repoEnv)).toBeNull();
  });

  it('404s an owner outside the mirrored org (no info leak), even with every other field invalid', () => {
    expect(() =>
      guardWrite(repo('someoneelse', '', 'not-a-real-login', undefined), { ...repoEnv, writesEnabled: false }),
    ).toThrow(NotFoundException);
  });

  it('400s an empty repo name', () => {
    expect(() => guardWrite(repo('acme', '', 'octocat', 'a@x.io'), repoEnv)).toThrow(BadRequestException);
  });

  it('400s a repo name containing a slash', () => {
    expect(() => guardWrite(repo('acme', 'foo/bar', 'octocat', 'a@x.io'), repoEnv)).toThrow(
      BadRequestException,
    );
  });

  // This write moved from a JSON body VALUE to a URL PATH SEGMENT, so a name
  // that means something to a path resolver is a new exposure class. Nothing
  // mutates today — both normalise to a 404 — but the rung has to match where
  // the string now goes.
  it('400s a repo name that is a path segment rather than a name', () => {
    for (const name of ['.', '..', 'a/../b', 'a\\b', '%2e%2e', 'a?b', 'a#b']) {
      expect(() => guardWrite(repo('acme', name, 'octocat', 'a@x.io'), repoEnv)).toThrow(BadRequestException);
    }
  });

  it('still accepts the repo names this org actually has', () => {
    for (const name of ['board', 'acme-ui', 'acme_platform', 'status', 'a.b-c_d']) {
      expect(guardWrite(repo('acme', name, 'octocat', 'a@x.io'), repoEnv)).toBeNull();
    }
  });

  it('the restricted refusal claims only the one thing restricted now means', () => {
    // `restricted` used to cover three definitive answers at once — the org
    // restricting the property, the property being gone, and the token not
    // being allowed to read it — so its message could name none of them. Two of
    // those have their own cases since #649, and `restricted` is now exactly
    // one answer: the org keeps the property to its owners. What it must still
    // never do is claim either of the other two, both of which have a different
    // fix and a different status.
    try {
      guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
        ...repoEnv,
        writability: 'restricted',
      });
      throw new Error('expected a refusal');
    } catch (err) {
      // Inherited from the deleted `repo-write.spec.ts` without this line, and
      // weakly vacuous without it: the sentinel above is caught by this same
      // `catch`, so the day `guardWrite` stops throwing on this rung the
      // assertion below reads the sentinel's own message and passes.
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as Error).message).not.toContain('organization owners');
      // Not `absent`'s message, and not `unreadable`'s.
      expect((err as Error).message).not.toContain('no dri property');
      expect((err as Error).message).not.toContain('could not be read');
    }
  });

  it('400s a login outside the allowed values', () => {
    expect(() => guardWrite(repo('acme', 'board', 'not-a-real-login', 'a@x.io'), repoEnv)).toThrow(
      BadRequestException,
    );
  });

  it('503s when writes are disabled', () => {
    expect(() =>
      guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
        ...repoEnv,
        writesEnabled: false,
      }),
    ).toThrow(ServiceUnavailableException);
  });

  it('401s without a session email', () => {
    expect(() => guardWrite(repo('acme', 'board', 'octocat', undefined), repoEnv)).toThrow(
      UnauthorizedException,
    );
  });

  // #577: the ladder used to pass a write the board had no permission to make
  // and let Github refuse it — which Github does with a 404 that looked like
  // nothing at all. A rung the board can check itself is a rung it must check.
  it('403s when the schema SAYS the property is restricted, before any write goes out', () => {
    expect(() =>
      guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
        ...repoEnv,
        writability: 'restricted',
      }),
    ).toThrow(ForbiddenException);
  });

  it('403s a clearing write too — a restricted property cannot be cleared either', () => {
    expect(() =>
      guardWrite(repo('acme', 'board', null, 'a@x.io'), { ...repoEnv, writability: 'restricted' }),
    ).toThrow(ForbiddenException);
  });

  // A schema the board could not READ is not a schema that said no. Refusing is
  // still right — the board will not send a write it cannot vouch for — but the
  // refusal must not claim the org restricted anything, and must not be
  // permanent, because a blip is the one case a retry fixes.
  it('502s — not 403s — when the schema could not be read at all', () => {
    // Both non-answers: `unreadable` is the read that never arrived, `unknown`
    // is the row that arrived carrying a value this board has no mapping for.
    // Neither says anything about the org's settings, and both are worth a
    // retry, so both are 502.
    for (const writability of ['unreadable', 'unknown'] as const) {
      expect(() =>
        guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
          ...repoEnv,
          writability,
        }),
      ).toThrow(BadGatewayException);
    }
  });

  // The rung #649 added. An org with no `dri` property answered 502 before it —
  // a retry-shaped status for a condition no retry alters, and the message sent
  // whoever read it looking for a permission that was never the problem.
  it('403s — not 502s — when the org has no dri property at all, and SAYS so', () => {
    try {
      guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
        ...repoEnv,
        writability: 'absent',
      });
      throw new Error('expected a refusal');
    } catch (err) {
      // Status alone would still pass if `absent` were folded back into the
      // `restricted` case, which is also a 403 — and that collapse would tell a
      // person Github forbids the write when the truth is there is nothing to
      // write to. The message is the half that discriminates, and it is what
      // caught exactly that mutation. (Ordering cannot do it any more: the rung
      // is a switch, so each state matches one case wherever it sits.)
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as Error).message).toContain('no dri property');
      expect((err as Error).message).toContain('acme');
      // Not the read-failed message, and not the restricted one.
      expect((err as Error).message).not.toContain('could not be read');
      expect((err as Error).message).not.toContain('does not allow');
    }
  });

  it('403s a clearing write on an absent property too', () => {
    // Nothing to clear either: the property does not exist to hold a value.
    expect(() =>
      guardWrite(repo('acme', 'board', null, 'a@x.io'), { ...repoEnv, writability: 'absent' }),
    ).toThrow(ForbiddenException);
  });

  it('does not claim the property is restricted when it never read the property', () => {
    for (const writability of ['unreadable', 'unknown'] as const) {
      try {
        guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
          ...repoEnv,
          writability,
        });
        throw new Error('expected a refusal');
      } catch (err) {
        // Same weak vacuity as the `restricted` test above, same fix: without
        // this line the sentinel satisfies both assertions on its own.
        expect(err).toBeInstanceOf(BadGatewayException);
        expect((err as Error).message).not.toContain('restricted');
        expect((err as Error).message).not.toContain('organization owners');
        // And it must not report the property missing either — a read that did
        // not arrive knows nothing about whether the property is there.
        expect((err as Error).message).not.toContain('no dri property');
      }
    }
  });

  // An unread schema yields no allowed values either, so judging the login
  // against that empty list would refuse it for a reason the board also made up.
  // `absent` carries the same empty list for its own reason.
  it('answers an unreadable schema before judging the login against its values', () => {
    expect(() =>
      guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
        ...repoEnv,
        allowed: [],
        writability: 'unreadable',
      }),
    ).toThrow(BadGatewayException);
    expect(() =>
      guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
        ...repoEnv,
        allowed: [],
        writability: 'absent',
      }),
    ).toThrow(ForbiddenException);
  });

  it('the write switch answers before the absent property does', () => {
    // Same ordering the `restricted` case below asserts: the board's own switch
    // is a fact about the board, and it is checked before anything it read from
    // Github.
    expect(() =>
      guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
        ...repoEnv,
        writesEnabled: false,
        writability: 'absent',
      }),
    ).toThrow(ServiceUnavailableException);
  });

  it('refuses a writability state no rung names, rather than letting it write', () => {
    // The ladder's default, asserted from the other side of the compiler.
    //
    // Until the #649 security review this rung was a chain of `if`s that named
    // the refusing states and fell through to the write, so `writable` passed
    // by matching NOTHING — and a sixth member of `OwnerWritability` would have
    // passed the same way, refusing nothing and logging nothing. The union grew
    // from three states to five on this branch, one commit before the switch.
    //
    // The switch that replaced it makes this unreachable: adding a state to the
    // union now fails to compile (`TS2322`, the `never` binding in `default`),
    // which is why reaching it here takes a cast. The cast is the point — it is
    // the only way to ask what the code does if a state ever slips past the
    // compiler, and the answer has to be "refuses", not "writes".
    const undecided = 'a-state-nobody-decided-about' as OwnerWritability;
    expect(() =>
      guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
        ...repoEnv,
        writability: undecided,
      }),
    ).toThrow(BadGatewayException);
  });

  it('the happy path is untouched: a readable, writable property still writes', () => {
    // The one case that must NOT have moved. Every state above refuses; this is
    // the state that lets the write out, and a five-state ladder that refused
    // here would have taken the feature away rather than sharpened it.
    expect(guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), repoEnv)).toBeNull();
    expect(guardWrite(repo('acme', 'board', null, 'a@x.io'), repoEnv)).toBeNull();
  });

  it('the board’s own write switch answers before the property’s permission does', () => {
    expect(() =>
      guardWrite(repo('acme', 'board', 'octocat', 'a@x.io'), {
        ...repoEnv,
        writesEnabled: false,
        writability: 'restricted',
      }),
    ).toThrow(ServiceUnavailableException);
  });

  // A fail-closed envelope is only fail-closed if it is right for the RIGHT
  // reason even when several things are wrong at once — an off-org owner must
  // never fall through to a "friendlier" later check.
  it('a bad owner AND writes disabled together still yields 404, not 503', () => {
    expect(() =>
      guardWrite(repo('someoneelse', 'board', 'octocat', 'a@x.io'), {
        ...repoEnv,
        writesEnabled: false,
      }),
    ).toThrow(NotFoundException);
  });
});

/**
 * The owner pin as an ALLOW-LIST (#649, plan #618 task 7). One org became a set,
 * and membership replaced equality — everything outside the set is refused with
 * the same 404 it always was, because the list can only ever be narrower than
 * what the credential itself can reach.
 */
describe('guardWrite — the owner pin is a set (#649)', () => {
  const pair = { ...repoEnv, allowedOwners: ['acme', 'globex'] };
  const repo = (owner: string) =>
    ({ kind: 'repo', owner, name: 'board', login: 'octocat', email: 'a@x.io' }) as const;

  it('admits every org in the configured set', () => {
    // The positive control. Without it every refusal below would still pass
    // against a pin that refused unconditionally.
    for (const owner of ['acme', 'globex']) {
      expect(guardWrite(repo(owner), pair), owner).toBeNull();
    }
  });

  it('matches a member of the set case-insensitively, because Github does', () => {
    expect(guardWrite(repo('Globex'), pair)).toBeNull();
  });

  it('refuses an owner outside the configured set', () => {
    expect(() => guardWrite(repo('someoneelse'), pair)).toThrow(NotFoundException);
  });

  it('refuses an owner outside the set even when it is a real org', () => {
    // `selgeo` exists on Github and this board's token may well reach it. What
    // decides is the allow-list, never whether the org is real.
    expect(() => guardWrite(repo('selgeo'), pair)).toThrow(NotFoundException);
  });

  it('refuses every owner when the configured set is empty', () => {
    // Fail-closed by rule, not by luck: an operator who turned a surface off
    // must not thereby remove the check. `some()` on an empty list is false, and
    // that is the direction this rung has to fall.
    const off = { ...repoEnv, allowedOwners: [] as string[] };
    for (const owner of ['acme', 'globex', 'someoneelse']) {
      expect(() => guardWrite(repo(owner), off), owner).toThrow(NotFoundException);
    }
  });

  it('names the TARGET org in the absent message, not the configured one', () => {
    // The accident this replaces: while the pin was one org, `subject.owner` was
    // equal to it by the time this rung ran, so interpolating either read the
    // same. With a set they diverge, and only the target is the org the write
    // was aimed at.
    try {
      guardWrite(repo('globex'), { ...pair, writability: 'absent' });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as Error).message).toContain('globex');
      expect((err as Error).message).not.toContain('acme');
    }
  });

  it('the pin still answers FIRST, ahead of every other broken field', () => {
    expect(() =>
      guardWrite({ kind: 'repo', owner: 'selgeo', name: '', login: 'nope', email: undefined }, {
        ...pair,
        writesEnabled: false,
        writability: 'restricted',
      }),
    ).toThrow(NotFoundException);
  });
});

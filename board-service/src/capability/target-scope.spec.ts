import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, Logger } from '@nestjs/common';
import { cfg } from './capability-testing.contract';
import { CapabilityRegistry } from './capability.registry';
import type { Refusal } from './github-refusal';
import { guardWrite } from './write-envelope';

/**
 * The gap between what `snapshot()` reports and what the board enforces (#626).
 *
 * `snapshot()` is credential-wide by construction: a target-scoped entry answers
 * a question no client asked, and there is no bounded way to report all of them.
 * That used to be an assertion in prose above the method — that the refusals it
 * omits are enforced by the write envelope instead. This suite is that assertion,
 * run: the same refusal is invisible to the report AND stops the write, on the
 * target it was learned for and on no other.
 *
 * Both halves matter. Without (a) the report could quietly start carrying
 * target-scoped verdicts and darken every repo over one; without (b) the
 * omission would be a hole rather than a division of labour.
 */
const refusal: Refusal = {
  reason: 'not-permitted',
  message: 'The board may not label issues in this repository',
  status: 403,
  retryable: false,
  scope: 'target',
};

/** A registry that has learned the refusal above for ONE repo. */
function learnedForOneRepo(target: string): CapabilityRegistry {
  const registry = new CapabilityRegistry(cfg());
  registry.recordRefusal('issue.labels', refusal, target);
  return registry;
}

const envFor = (registry: CapabilityRegistry) => ({
  allowedOwners: ['acme'],
  writesEnabled: true,
  registry,
  capability: 'issue.labels' as const,
  enforcing: true,
});

describe('a target-scoped refusal is enforced where it is not reported (#626)', () => {
  it('does not appear in snapshot(), which is credential-wide', () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = learnedForOneRepo('acme/board');

    // The registry HOLDS it — asserted first, so the `unknown` below is the
    // snapshot declining to report a live entry rather than an entry that was
    // never recorded.
    expect(registry.state('issue.labels', 'acme/board').state).toBe('refused');
    expect(registry.snapshot()['issue.labels']).toBe('unknown');
    // …and no other capability picked it up either.
    expect(Object.values(registry.snapshot())).not.toContain('refused');
    vi.restoreAllMocks();
  });

  it('stops guardWrite for that target, and leaves another target untouched', () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const env = envFor(learnedForOneRepo('acme/board'));

    expect(() =>
      guardWrite({ kind: 'issue', owner: 'acme', repo: 'board', name: '42', email: 'a@x.io' }, env),
    ).toThrow(ForbiddenException);

    // The same registry, the same capability, a different repo: the write goes
    // through and answers with its issue number. A refusal believed wider than
    // the thing it was learned about would redden this line.
    expect(
      guardWrite({ kind: 'issue', owner: 'acme', repo: 'kit', name: '42', email: 'a@x.io' }, env),
    ).toBe(42);
    vi.restoreAllMocks();
  });

  it('the report and the enforcement disagree about nothing the report can see', () => {
    // The division of labour stated as one assertion: what `/api/auth/me` ships
    // is `snapshot()`, and it says `unknown` for a capability the envelope is
    // actively refusing on one target. `unknown` refuses nothing, which is why
    // the envelope — the only rung holding the owner and the repo — has to be
    // where that refusal lands.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = learnedForOneRepo('acme/board');
    const env = envFor(registry);

    expect(registry.snapshot()['issue.labels']).toBe('unknown');
    expect(() =>
      guardWrite({ kind: 'issue', owner: 'acme', repo: 'board', name: '7', email: 'a@x.io' }, env),
    ).toThrow(ForbiddenException);
    vi.restoreAllMocks();
  });
});

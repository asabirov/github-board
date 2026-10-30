import { describe, expect, it } from 'vitest';
import { learnRefusal } from './learn-refusal';
import type { RefusalRecorder } from './learn-refusal';
import type { Refusal } from './github-refusal';

/** A registry stand-in that records what it was taught, and nothing more. Task 4
 *  builds the real one; what a refusal needs of it is one method. */
const recorder = () => {
  const calls: { cap: string; reason: string; target?: string }[] = [];
  const reg: RefusalRecorder = {
    recordRefusal: (cap, r, target) => calls.push({ cap, reason: r.reason, target }),
  };
  return { calls, reg };
};

const notFound = (): Refusal => ({
  reason: 'not-found',
  message: 'gone',
  status: 404,
  retryable: false,
  scope: 'none',
});

describe('learnRefusal — the re-read that earns a 404', () => {
  it('a 404 whose target re-reads becomes not-permitted, keyed on that target', async () => {
    const { calls, reg } = recorder();
    const out = await learnRefusal({
      registry: reg,
      capability: 'repo.dri',
      target: 'acme/board',
      refusal: notFound(),
      reread: async () => true,
    });
    expect(out.reason).toBe('not-permitted');
    expect(out.scope).toBe('target');
    expect(calls).toEqual([
      { cap: 'repo.dri', reason: 'not-permitted', target: 'acme/board' },
    ]);
  });

  it('a 404 whose target does NOT re-read stays not-found and teaches nothing', async () => {
    // The denial of service, as a test. Any signed-in person can name a repo that
    // does not exist; before the re-read, doing so refused that capability for
    // every user for fifteen minutes.
    const { calls, reg } = recorder();
    const out = await learnRefusal({
      registry: reg,
      capability: 'repo.dri',
      target: 'acme/does-not-exist',
      refusal: notFound(),
      reread: async () => false,
    });
    expect(out.reason).toBe('not-found');
    expect(calls).toEqual([]);
  });

  it('a re-read that throws teaches nothing either', async () => {
    const { calls, reg } = recorder();
    await learnRefusal({
      registry: reg,
      capability: 'repo.dri',
      target: 'acme/board',
      refusal: notFound(),
      reread: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(calls).toEqual([]);
  });

  it('a refusal that is not a 404 is recorded as classified, with no re-read at all', async () => {
    const { calls, reg } = recorder();
    let reread = 0;
    await learnRefusal({
      registry: reg,
      capability: 'issue.state',
      target: 'acme/board',
      refusal: { reason: 'not-permitted', message: 'no', status: 403, retryable: false, scope: 'target' },
      reread: async () => {
        reread += 1;
        return true;
      },
    });
    expect(reread).toBe(0); // the failure path pays for the 404 case ONLY
    expect(calls).toEqual([
      { cap: 'issue.state', reason: 'not-permitted', target: 'acme/board' },
    ]);
  });
});

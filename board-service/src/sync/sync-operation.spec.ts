import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYNC_SOURCES, SYNC_WAIT_MAX_MS, SyncOperations, type SyncOutcome } from './sync-operation';
import { githubContext, githubPrincipal, type GithubPrincipal } from '../auth/github-principal';
import { GithubQuotaCooldownError } from '../sources/github-quota';

const deferred = () => {
  let resolve!: (value?: SyncOutcome) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<SyncOutcome | void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function make() {
  const log = { log: vi.fn(), warn: vi.fn() };
  const store = new SyncOperations(log);
  const tasks = Object.fromEntries(SYNC_SOURCES.map((key) => [key, deferred()])) as Record<typeof SYNC_SOURCES[number], ReturnType<typeof deferred>>;
  const refreshes = Object.fromEntries(SYNC_SOURCES.map((key) => [key, vi.fn(() => tasks[key].promise)])) as Record<typeof SYNC_SOURCES[number], ReturnType<typeof vi.fn<() => Promise<SyncOutcome | void>>>>;
  const after = vi.fn();
  const start = (owner = 'viewer') => store.start(owner, refreshes, after);
  return { store, tasks, refreshes, after, start, log };
}
afterEach(() => { vi.useRealTimers(); });

describe('manual sync progress', () => {
  it('runs exactly four reads concurrently, deduplicates a repeated press and retains independent outcomes', async () => {
    const h = make();
    const initial = h.start();
    expect(h.start().operationId).toBe(initial.operationId);
    expect(Object.values(h.refreshes).every((f) => f.mock.calls.length === 1)).toBe(true);
    expect(Object.values(initial.sources).every((s) => s.state === 'running')).toBe(true);
    h.tasks.issues.resolve();
    h.tasks.projects.reject(new Error('provider-secret'));
    await settle();
    const mid = h.store.get(initial.operationId, 'viewer');
    expect(mid.state).toBe('running');
    expect(mid.sources.issues.state).toBe('succeeded');
    expect(mid.sources.projects.state).toBe('failed');
    expect(mid.sources.repos.state).toBe('running');
    expect(JSON.stringify(mid)).not.toContain('provider-secret');
    // The reason stays out of the payload and goes to the log, the one place
    // production can later say why a part failed (#976).
    expect(h.log.warn).toHaveBeenCalledWith(`sync ${initial.operationId} projects failed: provider-secret`);
    for (const key of SYNC_SOURCES) h.tasks[key].resolve();
    await settle();
    const final = h.store.get(initial.operationId, 'viewer');
    expect(final.state).toBe('partial');
    expect(final.syncedAt).toBeUndefined();
    expect(final.finishedAt).toBeTruthy();
    expect(h.after).not.toHaveBeenCalled();
    expect(h.log.log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(
      `^sync ${initial.operationId} partial in \\d+ ms: issues succeeded, issueBuckets succeeded, projects failed, repos succeeded$`)));
  });

  it('names a Github quota refusal in the log by when it lifts', async () => {
    const h = make(); const first = h.start();
    const retryAt = Date.now() + 30 * 60_000;
    h.tasks.issueBuckets.reject(new GithubQuotaCooldownError(retryAt));
    await settle();
    expect(h.log.warn).toHaveBeenCalledWith(`sync ${first.operationId} issueBuckets failed: Github quota is cooling down until ${new Date(retryAt).toISOString()}`);
    for (const key of SYNC_SOURCES) h.tasks[key].resolve();
  });

  it('keeps a failure to one short line in the log', async () => {
    const h = make(); const first = h.start();
    h.tasks.issues.reject(new Error(`${'x'.repeat(300)}\n<html><body>502 Bad Gateway</body></html>`));
    await settle();
    expect(h.log.warn).toHaveBeenCalledWith(`sync ${first.operationId} issues failed: ${'x'.repeat(200)}...`);
    for (const key of SYNC_SOURCES) h.tasks[key].resolve();
  });

  it('advances success only after all four healthy outcomes and returns isolated snapshots', async () => {
    const h = make(); const first = h.start();
    first.sources.issues.state = 'failed';
    expect(h.store.get(first.operationId, 'viewer').sources.issues.state).toBe('running');
    for (const key of SYNC_SOURCES) h.tasks[key].resolve();
    await settle();
    const final = h.store.get(first.operationId, 'viewer');
    expect(final.state).toBe('succeeded');
    expect(final.syncedAt).toBe(final.finishedAt);
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.start().operationId).not.toBe(first.operationId);
  });

  it('does not promote fulfilled but degraded coverage to global success', async () => {
    const h = make(); const first = h.start();
    for (const key of SYNC_SOURCES) h.tasks[key].resolve(key === 'projects' ? 'degraded' : 'succeeded');
    await settle();
    const final = h.store.get(first.operationId, 'viewer');
    expect(final.sources.projects.state).toBe('degraded');
    expect(final.state).toBe('partial');
    expect(final.syncedAt).toBeUndefined();
  });

  it('makes unknown and other-owner progress equally unavailable', () => {
    const h = make(); const first = h.start();
    for (const [id, owner] of [[first.operationId, 'other'], ['missing', 'viewer']]) {
      expect(() => h.store.get(id, owner)).toThrow('Sync progress unavailable.');
    }
  });

  // #976. A run once died with the access check it was pressed under, after 40
  // to 60 s, and a second press found the dead record and failed too.
  it('keeps a slow run readable past a minute, and a second press rejoins it', () => {
    vi.useFakeTimers(); const h = make(); const first = h.start();
    expect(Date.parse(first.expiresAt) - Date.parse(first.startedAt)).toBe(SYNC_WAIT_MAX_MS);
    vi.advanceTimersByTime(90_000);
    expect(h.store.get(first.operationId, 'viewer').state).toBe('running');
    expect(h.start().operationId).toBe(first.operationId);
    expect(Object.values(h.refreshes).every((f) => f.mock.calls.length === 1)).toBe(true);
  });

  it('bounds running records and frees settled records after their retention period', async () => {
    vi.useFakeTimers(); const h = make();
    for (let i = 0; i < 128; i++) h.start(`viewer-${i}`);
    expect(() => h.start('overflow')).toThrow('Sync is busy.');
    for (const key of SYNC_SOURCES) h.tasks[key].resolve();
    await settle(); vi.advanceTimersByTime(5 * 60_000);
    expect(h.start('overflow').state).toBe('running');
  });

  // Finished runs are kept five minutes since #976, so a person pressing again
  // and again must not keep one slot per press.
  it('holds one slot for a person however often they press', async () => {
    const h = make();
    for (const key of SYNC_SOURCES) h.tasks[key].reject(new Error('refused'));
    for (let press = 0; press < 200; press++) { h.start(); await settle(); }
    expect(h.start('colleague').state).toBe('running');
  });

  it('bounds an unresponsive operation without turning late results into success', async () => {
    vi.useFakeTimers(); const h = make(); const initial = h.start();
    vi.advanceTimersByTime(SYNC_WAIT_MAX_MS);
    const interrupted = h.store.get(initial.operationId, 'viewer');
    expect(interrupted.state).toBe('interrupted');
    expect(Object.values(interrupted.sources).every((s) => s.state === 'unknown')).toBe(true);
    expect(h.log.warn).toHaveBeenCalledWith(`sync ${initial.operationId} interrupted after ${SYNC_WAIT_MAX_MS} ms; still running: ${SYNC_SOURCES.join(', ')}`);
    const next = h.start();
    expect(next.operationId).not.toBe(initial.operationId);
    // The new press replaced the person's finished run.
    expect(() => h.store.get(initial.operationId, 'viewer')).toThrow('Sync progress unavailable.');
    for (const key of SYNC_SOURCES) h.tasks[key].resolve();
    await settle();
    expect(h.after).toHaveBeenCalledTimes(1); // only the replacement, never the timed-out operation
    expect(h.log.log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^sync ${initial.operationId} settled in \\d+ ms, after it was interrupted$`)));
  });

  it('retains the original person across detached awaits without falling back to deployment context', async () => {
    const principal = { key: 'visibility', token: 'runtime-secret', cache: new WeakMap() } as GithubPrincipal;
    const release = deferred(); const seen: unknown[] = [];
    const callbacks = Object.fromEntries(SYNC_SOURCES.map((key) => [key, async () => {
      await release.promise; seen.push(githubPrincipal());
    }])) as Record<typeof SYNC_SOURCES[number], () => Promise<void>>;
    const store = new SyncOperations({ log: vi.fn(), warn: vi.fn() });
    const first = githubContext.run({ principal, boardSub: 'viewer' }, () => store.start('viewer', callbacks, () => seen.push(githubPrincipal())));
    expect(githubPrincipal()).toBeUndefined();
    release.resolve(); await settle();
    expect(seen).toHaveLength(5);
    expect(seen.every((p) => p === principal)).toBe(true);
    expect(JSON.stringify(store.get(first.operationId, 'viewer'))).not.toContain('runtime-secret');
  });
});

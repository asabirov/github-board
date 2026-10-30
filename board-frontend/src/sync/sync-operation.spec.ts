import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeSync, SYNC_DEADLINE_GRACE_MS, SYNC_READ_RETRIES, SYNC_REQUEST_MS, SYNC_SOURCES, waitForSyncPoll, type SyncOperation } from './sync-operation';
const operation = (state: SyncOperation['state'], expiresInMs = 120_000): SyncOperation => ({
  operationId: 'one', state, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  sources: Object.fromEntries(SYNC_SOURCES.map((key) => [key, { state: state === 'running' ? 'running' : 'succeeded' }])) as SyncOperation['sources'],
});
const refusal = (status: number) => Object.assign(new Error(`sync ${status}`), { status });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('observing server-owned sync', () => {
  it('reports only returned states and stops at a terminal outcome', async () => {
    const initial = operation('running'); const final = operation('partial'); final.sources.projects.state = 'failed';
    const read = vi.fn().mockResolvedValueOnce(final); const report = vi.fn(); const pause = vi.fn().mockResolvedValue(undefined);
    const result = await observeSync(async () => initial, read, report, new AbortController().signal, pause);
    expect(report.mock.calls.map(([value]) => value)).toEqual([initial, final]);
    expect(result).toBe(final); expect(read).toHaveBeenCalledTimes(1); expect(pause).toHaveBeenCalledTimes(1);
  });
  it('does not fabricate failed source rows when the operation cannot be read', async () => {
    const initial = operation('running'); const report = vi.fn(); const read = vi.fn(async () => { throw refusal(404); });
    await expect(observeSync(async () => initial, read, report, new AbortController().signal, async () => {})).rejects.toThrow('sync 404');
    expect(report.mock.calls).toEqual([[initial]]);
    expect(read).toHaveBeenCalledTimes(1); // a 404 is an answer, not asked again
  });
  // #976. A progress read can meet a slow or refused access check, which the
  // server answers 503 "retry". That is one failed read, not a failed run.
  it('asks again after a network failure or a 5xx, and carries on', async () => {
    const initial = operation('running'); const final = operation('succeeded'); const report = vi.fn();
    const read = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(refusal(503)).mockResolvedValueOnce(final);
    expect(await observeSync(async () => initial, read, report, new AbortController().signal, async () => {})).toBe(final);
    expect(read).toHaveBeenCalledTimes(3);
    expect(report.mock.calls.map(([value]) => value)).toEqual([initial, final]);
  });
  it('gives up after a few failed reads in a row', async () => {
    const read = vi.fn(async () => { throw refusal(503); });
    await expect(observeSync(async () => operation('running'), read, vi.fn(), new AbortController().signal, async () => {})).rejects.toThrow('sync 503');
    expect(read).toHaveBeenCalledTimes(SYNC_READ_RETRIES + 1);
  });
  it('does not poll or report after observation is aborted', async () => {
    const controller = new AbortController(); const read = vi.fn(); const report = vi.fn();
    await expect(observeSync(async () => operation('running'), read, report, controller.signal, async () => controller.abort())).rejects.toThrow('Sync observation stopped');
    expect(read).not.toHaveBeenCalled(); expect(report).toHaveBeenCalledTimes(1);
  });
  it('bounds an unanswered initial POST without inventing source outcomes', async () => {
    vi.useFakeTimers(); const report = vi.fn(); const read = vi.fn(); let requestSignal: AbortSignal | undefined;
    const start = (signal: AbortSignal) => { requestSignal = signal; return new Promise<SyncOperation>(() => {}); };
    const pending = observeSync(start, read, report, new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow('Sync observation stopped');
    await vi.advanceTimersByTimeAsync(SYNC_REQUEST_MS); await rejected;
    expect(requestSignal?.aborted).toBe(true); expect(read).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops a run the server still calls running well past its own deadline', async () => {
    const read = vi.fn();
    await expect(observeSync(async () => operation('running', -SYNC_DEADLINE_GRACE_MS - 1000), read, vi.fn(), new AbortController().signal, async () => {}))
      .rejects.toThrow('Sync observation stopped');
    expect(read).not.toHaveBeenCalled();
  });
  // #976. A hidden tab pauses its reads. Nothing counts down meanwhile, so a
  // run that finished while nobody looked is read as finished on return.
  it('lets a long pause pass without ending the watch', async () => {
    vi.useFakeTimers(); let resume!: () => void; const final = operation('succeeded');
    const pending = observeSync(async () => operation('running'), async () => final, vi.fn(), new AbortController().signal,
      () => new Promise<void>((resolve) => { resume = resolve; }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
    resume();
    expect(await pending).toBe(final);
  });
  it('pauses while hidden, resumes when visible, and cleans up on abort', async () => {
    vi.useFakeTimers(); const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' }); vi.stubGlobal('document', doc);
    const controller = new AbortController(); const done = vi.fn(); const wait = waitForSyncPoll(controller.signal).then(done);
    await vi.advanceTimersByTimeAsync(5000); expect(done).not.toHaveBeenCalled();
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); await wait; expect(done).toHaveBeenCalledTimes(1);
    const next = waitForSyncPoll(controller.signal); const rejected = expect(next).rejects.toThrow('Sync observation stopped'); controller.abort(); await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});

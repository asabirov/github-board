import { ApiError } from '../api/core';
import { currentPayloadGeneration, currentSensitiveGeneration } from '../cache/payload-cache';
import { currentReadRefusalEpoch } from '../cache/read-cache';
import { transientFailure } from '../projects/projects-last-good';

const cooldowns = new Map<string, number>();

/** Each attempt applies its saved-copy decision before rejecting for a retry. */
export async function retryOverviewRead<T>(read: () => Promise<T>, path: string, code: string, signal: AbortSignal, retryWhile: () => boolean = () => true): Promise<T> {
  const generation = currentPayloadGeneration();
  const sensitive = currentSensitiveGeneration();
  const refusal = currentReadRefusalEpoch(path);
  const key = JSON.stringify([path, generation, sensitive, refusal]);
  const current = () => !signal.aborted && generation === currentPayloadGeneration()
    && sensitive === currentSensitiveGeneration() && refusal === currentReadRefusalEpoch(path);
  const wait = async (until: number) => {
    while (current() && Date.now() < until) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(30000, until - Date.now()));
        signal.addEventListener('abort', done, { once: true });
      });
    }
  };
  if (!current()) throw new DOMException('Read cancelled', 'AbortError');
  if ((cooldowns.get(key) ?? 0) > Date.now()) {
    await wait(cooldowns.get(key)!);
    if (!current()) throw new DOMException('Read cancelled', 'AbortError');
  }
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (error) {
      if (!current() || !retryWhile() || !transientFailure(error, code)) throw error;
      const hinted = error instanceof ApiError ? error.retryAt ?? 0 : 0;
      if (hinted > Date.now()) {
        for (const [entry, deadline] of cooldowns) if (deadline <= Date.now()) cooldowns.delete(entry);
        cooldowns.set(key, hinted);
      }
      await wait(Math.max(Date.now() + Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)), hinted));
      if (!current() || !retryWhile()) throw error;
    }
  }
}

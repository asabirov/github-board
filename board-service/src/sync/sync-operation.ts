import { randomUUID } from 'node:crypto';
import { Logger, NotFoundException, ServiceUnavailableException, type LoggerService } from '@nestjs/common';
import { quotaCooldownNote, quotaRetryAt } from '../sources/github-quota';

export const SYNC_SOURCES = ['issues', 'issueBuckets', 'projects', 'repos'] as const;
export type SyncSource = typeof SYNC_SOURCES[number];
export type SyncOutcome = 'succeeded' | 'degraded' | 'skipped';
export type SyncSourceState = 'pending' | 'running' | SyncOutcome | 'failed' | 'unknown';
export interface SyncOperation {
  operationId: string;
  state: 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
  startedAt: string;
  /** When the server stops waiting for the run and calls it interrupted. The
   *  run's own bound since #976, not the access check it was pressed under. A tab
   *  built before #976 stops watching here. */
  expiresAt: string;
  finishedAt?: string;
  syncedAt?: string;
  sources: Record<SyncSource, { state: SyncSourceState; startedAt?: string; finishedAt?: string }>;
}
interface HeldOperation { owner: string; operation: SyncOperation }
type Refreshes = Record<SyncSource, () => Promise<SyncOutcome | void>>;
const TERMINAL_TTL = 5 * 60_000;
const CAPACITY = 128;
export const SYNC_WAIT_MAX_MS = 120_000;

/** Why a part failed, as one short log line. A Github 5xx page or a multi-line
 *  GraphQL error must not land in the log whole. */
function failureNote(err: unknown): string {
  const retryAt = quotaRetryAt(err);
  if (retryAt !== undefined) return quotaCooldownNote(retryAt);
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'a rejection that is not an Error';
  const line = message.split('\n', 1)[0].trim();
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

/**
 * Process-local progress only. Running records remain owned until every source
 * settles.
 *
 * A run lives until its four reads settle or `SYNC_WAIT_MAX_MS` passes, and not
 * one moment less (#976). It used to die with the Github access check it was
 * pressed under, 40 to 60 s later, so any sync slower than that could only end
 * as "Sync progress unavailable", and a second press while it still ran failed
 * the same way. That bound protected nothing: every read of a run is authorized
 * by that request's own check, and the owner carries the person's visibility
 * key, so somebody whose access changed still cannot read it. The key also moves
 * on a reconnect or a refreshed credential, so a run crossing one of those reads
 * as unavailable, and the next press starts a new one.
 *
 * A person's new press replaces their finished runs. They only ever read their
 * latest, and runs kept for five minutes after finishing would otherwise let one
 * person pressing again and again fill the slots everybody shares.
 *
 * Nothing but this class says why a part failed, so it says it in the log: one
 * line per failed part and one when the run ends, with how long it took.
 */
export class SyncOperations {
  private readonly records = new Map<string, HeldOperation>();
  constructor(private readonly logger: Pick<LoggerService, 'log' | 'warn'> = new Logger(SyncOperations.name)) {}

  start(owner: string, refreshes: Refreshes, afterSuccess: () => void): SyncOperation {
    this.prune();
    const held = [...this.records].filter(([, record]) => record.owner === owner);
    const active = held.find(([, record]) => record.operation.state === 'running');
    if (active) return this.read(active[1], owner);
    for (const [id] of held) this.records.delete(id);
    if (this.records.size >= CAPACITY) throw new ServiceUnavailableException('Sync is busy. Try again later.');
    const started = Date.now();
    const operation: SyncOperation = {
      operationId: randomUUID(), state: 'running', startedAt: new Date(started).toISOString(), expiresAt: new Date(started + SYNC_WAIT_MAX_MS).toISOString(),
      sources: Object.fromEntries(SYNC_SOURCES.map((key) => [key, { state: 'pending' }])) as SyncOperation['sources'],
    };
    const record = { owner, operation };
    this.records.set(operation.operationId, record);
    const timeout = setTimeout(() => {
      if (operation.state !== 'running') return;
      const unsettled = SYNC_SOURCES.filter((key) => ['pending', 'running'].includes(operation.sources[key].state));
      for (const key of unsettled) operation.sources[key].state = 'unknown';
      operation.state = 'interrupted';
      operation.finishedAt = new Date().toISOString();
      this.logger.warn(`sync ${operation.operationId} interrupted after ${SYNC_WAIT_MAX_MS} ms; still running: ${unsettled.join(', ')}`);
    }, SYNC_WAIT_MAX_MS);
    timeout.unref();
    // Async callbacks inherit the request's principal. Nothing is scheduled in a deployment context.
    void Promise.all(SYNC_SOURCES.map(async (key) => {
      const source = operation.sources[key];
      source.state = 'running';
      source.startedAt = new Date().toISOString();
      let outcome: SyncSourceState;
      try { outcome = (await refreshes[key]()) ?? 'succeeded'; }
      catch (err) {
        outcome = 'failed';
        this.logger.warn(`sync ${operation.operationId} ${key} failed: ${failureNote(err)}`);
      }
      if (operation.state !== 'running') return;
      source.state = outcome;
      source.finishedAt = new Date().toISOString();
    })).then(() => {
      clearTimeout(timeout);
      if (operation.state !== 'running') {
        // How long a run really takes, even one past the bound.
        this.logger.log(`sync ${operation.operationId} settled in ${Date.now() - started} ms, after it was interrupted`);
        return;
      }
      const outcomes = Object.values(operation.sources).map((s) => s.state);
      operation.state = outcomes.every((s) => s === 'succeeded' || s === 'skipped') ? 'succeeded'
        : outcomes.every((s) => s === 'failed') ? 'failed' : 'partial';
      operation.finishedAt = new Date().toISOString();
      this.logger.log(`sync ${operation.operationId} ${operation.state} in ${Date.now() - started} ms: ${SYNC_SOURCES.map((key) => `${key} ${operation.sources[key].state}`).join(', ')}`);
      if (operation.state === 'succeeded') {
        operation.syncedAt = operation.finishedAt;
        afterSuccess();
      }
    }).catch(() => { /* Background follow-up does not rewrite the four settled outcomes. */ });
    return this.read(record, owner);
  }

  get(id: string, owner: string): SyncOperation {
    this.prune();
    return this.read(this.records.get(id), owner);
  }

  private read(record: HeldOperation | undefined, owner: string): SyncOperation {
    if (!record || record.owner !== owner) throw new NotFoundException('Sync progress unavailable.');
    return structuredClone(record.operation);
  }

  private prune(): void {
    for (const [id, record] of this.records) {
      const finished = record.operation.finishedAt;
      if (finished && Date.now() - Date.parse(finished) >= TERMINAL_TTL) this.records.delete(id);
    }
  }
}

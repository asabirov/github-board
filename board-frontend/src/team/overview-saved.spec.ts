/**
 * When a failed Overview read may recall the saved queue or metrics, and when it
 * forgets them (#1046). Pure functions over a fake store: the suite has no DOM
 * and runs no effect, so the tiles drawing a copy are checked
 * in a browser, not here.
 *
 * The rule is `recallSaved`'s, specified in `projects-last-good.spec.ts`. What
 * is pinned here is the part these two reads own: the 503 that may draw their
 * copies is the one board-api codes `issues_not_now`, and no other.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/core';
import type { IssueMetrics, OrgQueue } from '../api/issues';
import type { ProjectSummary } from '../api/projects';
import { setResponseIdentity } from '../auth/response-deadline';
import { claimFor, ORG_QUEUE_KEY, orgScopedKey, readSaved, setPayloadStore, type PayloadStore } from '../cache/payload-cache';
import {
  ACCESS_NOT_NOW_CODE, PROJECTS_NOT_NOW_CODE, SAVED_COPY_MAX_AGE_MS, saveProjects, savedProjects,
} from '../projects/projects-last-good';
import { ISSUES_NOT_NOW_CODE, recallMetrics, recallQueue, saveMetrics, saveQueue } from './overview-saved';

/** The 503 board-api answers when the issue ingest lost its scope to quota. */
const notNow = () => new ApiError(503, 'org-issues 503', undefined, undefined,
  'issue metrics: GitHub quota is cooling down until 2026-09-11T13:00:00.000Z', ISSUES_NOT_NOW_CODE);

class MapStore implements PayloadStore {
  readonly map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const now = new Date().toISOString();
const QUEUE = { updatedAt: now, issues: [] } as OrgQueue;
const METRICS = { updatedAt: now, computedAt: now } as unknown as IssueMetrics;
const BOARDS = [{ number: 7, name: 'Delivery' }] as unknown as ProjectSummary[];
const offline = () => new TypeError('Failed to fetch');
/** A snapshot the service took just past the ceiling, saved a moment ago. */
const stale = () => new Date(Date.now() - SAVED_COPY_MAX_AGE_MS - 60_000).toISOString();

beforeEach(() => {
  setPayloadStore(new MapStore());
  claimFor('octocat@example.com');
});

afterEach(() => {
  setPayloadStore(undefined);
  setResponseIdentity(null, false);
});

describe('the Overview tiles recall a saved copy (#1046)', () => {
  it('on a dropped connection, for the org it was saved for and no other', () => {
    saveQueue('acme', QUEUE);
    saveMetrics('acme', METRICS);
    expect(recallQueue('acme', offline())?.value).toEqual(QUEUE);
    expect(recallMetrics('acme', offline())?.value).toEqual(METRICS);
    expect(recallQueue('globex', offline())).toBeNull();
    expect(recallQueue(null, offline())).toBeNull();
  });

  it('stamped with the org it was recalled for, which is what `drawable` checks', () => {
    saveQueue('acme', QUEUE);
    expect(recallQueue('acme', offline())?.org).toBe('acme');
  });

  /**
   * #1066. The auth layer's five transient 503s carry one shared code, thrown
   * before any read has run, so the tiles take it beside their own — a
   * credential refresh in flight on another instance is not a verdict about
   * this reader's issues, and it used to blank these tiles and delete their
   * copies exactly as a withdrawal would.
   */
  it('on the 503 the auth layer codes access_not_now, whatever it says', () => {
    expect(ACCESS_NOT_NOW_CODE).toBe('access_not_now');
    saveQueue('acme', QUEUE);
    saveMetrics('acme', METRICS);
    const authNotNow = () => new ApiError(503, 'org-issues 503', undefined, undefined,
      'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.', ACCESS_NOT_NOW_CODE);
    expect(recallQueue('acme', authNotNow())?.value).toEqual(QUEUE);
    expect(recallMetrics('acme', authNotNow())?.value).toEqual(METRICS);
    // Still there, which is the tiles not emptying on the next poll either.
    expect(recallQueue('acme', notNow())?.value).toEqual(QUEUE);
  });

  it('on the 503 board-api codes issues_not_now, a quota cooldown', () => {
    // Every check in this file builds its 503 from the same constant it tests,
    // so a typo there would agree with itself and turn the feature off.
    expect(ISSUES_NOT_NOW_CODE).toBe('issues_not_now');
    saveQueue('acme', QUEUE);
    saveMetrics('acme', METRICS);
    expect(recallQueue('acme', notNow())?.value).toEqual(QUEUE);
    expect(recallMetrics('acme', notNow())?.value).toEqual(METRICS);
  });
});

describe('a failure that may not fall back on a copy forgets it', () => {
  it('a 401, so the next dropped connection finds nothing', () => {
    saveQueue('acme', QUEUE);
    expect(recallQueue('acme', new ApiError(401, 'unauthenticated'))).toBeNull();
    expect(recallQueue('acme', offline())).toBeNull();
  });

  // #1042 round 3: a refusal takes every saved copy, not the refused read's
  // alone. The union queue `/team` draws holds acme's issues too, and the
  // Projects rollup's copies go in the same walk.
  it('a 403 on one read, and every other saved copy with it', () => {
    saveQueue('acme', QUEUE);
    saveMetrics('acme', METRICS);
    saveQueue(null, QUEUE);
    saveProjects('acme', BOARDS);
    expect(recallMetrics('acme', new ApiError(403, 'forbidden'))).toBeNull();
    expect(recallMetrics('acme', offline())).toBeNull();
    expect(recallQueue('acme', offline())).toBeNull();
    expect(recallQueue(null, notNow())).toBeNull();
    expect(savedProjects('acme', offline())).toBeNull();
  });

  it('and a refusal on the Projects rollup takes these too', () => {
    saveQueue('acme', QUEUE);
    saveMetrics(null, METRICS);
    expect(savedProjects('acme', new ApiError(403, 'forbidden'))).toBeNull();
    expect(recallQueue('acme', offline())).toBeNull();
    expect(recallMetrics(null, offline())).toBeNull();
  });

});

/**
 * #1395. These four were on the forgetting side and are the reason the Overview
 * tiles emptied: the code told a quota cooldown from a withdrawal, and
 * everything the code did not recognise was read as a withdrawal. But an
 * uncoded 503 is what the expiry interceptor answers when a cold read outlives
 * its 60-second access window, which is the common case on this very read — and
 * a code belonging to a different read, or on a 500, says only that this answer
 * is not a cooldown. None of them says this reader may not see their queue.
 *
 * They keep the copy now, marked stale, and the tiles stay up. What the code
 * still decides is whether to try again (`transientFailure`).
 */
describe('a failure the code does not recognise is not a refusal (#1395)', () => {
  it.each([
    ['a 503 with no code, the expiry interceptor’s', () =>
      new ApiError(503, 'org-issues 503', undefined, undefined, 'GitHub access needs rechecking before this view can be shown; retry')],
    ['the Projects code, which this read’s server never sends', () =>
      new ApiError(503, 'org-issues 503', undefined, undefined, 'x', PROJECTS_NOT_NOW_CODE)],
    ['this read’s code on a status other than 503', () =>
      new ApiError(500, 'org-issues 500', undefined, undefined, 'x', ISSUES_NOT_NOW_CODE)],
    ['a 502 carrying board-api’s own message', () =>
      new ApiError(502, 'org-issues 502', undefined, undefined, 'GitHub could not be reached')],
  ])('%s, and the copy is still there for the next read', (_what, failure) => {
    saveQueue('acme', QUEUE);
    saveMetrics('acme', METRICS);
    expect(recallQueue('acme', failure())?.value).toEqual(QUEUE);
    expect(recallMetrics('acme', failure())?.value).toEqual(METRICS);
    expect(recallQueue('acme', notNow())?.value).toEqual(QUEUE);
    expect(recallMetrics('acme', notNow())?.value).toEqual(METRICS);
  });
});

// Caddy stands in front of every `/api` read, so a board-api deploy reaches
// these two as the same empty 502 it gives the Projects rollup (#1042 round 3).
describe('a 502 with nothing from board-api in it is a deploy, and draws the copy', () => {
  it('for the queue and the metrics, and keeps both on the disk', () => {
    saveQueue('acme', QUEUE);
    saveMetrics('acme', METRICS);
    const deploy = () => new ApiError(502, 'org-issues 502');
    expect(recallQueue('acme', deploy())?.value).toEqual(QUEUE);
    expect(recallMetrics('acme', deploy())?.value).toEqual(METRICS);
    expect(recallQueue('acme', notNow())?.value).toEqual(QUEUE);
  });
});

describe('a copy whose data is past the ceiling is deleted, however recently it was saved', () => {
  // board-api answers from its own stale cache, and the save is stamped when it
  // is made; the snapshot's `updatedAt` is what dates the data.
  it('the queue', () => {
    saveQueue('acme', { updatedAt: stale(), issues: [] } as OrgQueue);
    expect(recallQueue('acme', offline())).toBeNull();
    expect(readSaved(orgScopedKey(ORG_QUEUE_KEY, 'acme'), Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it('the metrics', () => {
    saveMetrics('acme', { updatedAt: stale(), computedAt: now } as unknown as IssueMetrics);
    expect(recallMetrics('acme', offline())).toBeNull();
  });
});

describe('a copy of the wrong shape is deleted, not drawn', () => {
  it('a queue with no issue list', () => {
    saveQueue('acme', { updatedAt: 'x', issues: 'none' } as unknown as OrgQueue);
    expect(recallQueue('acme', offline())).toBeNull();
    expect(readSaved(orgScopedKey(ORG_QUEUE_KEY, 'acme'), Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

it('keeps fallback metric copies separate for each viewer time zone', () => {
  const berlin = { ...METRICS, timeZone: 'Europe/Berlin', closedDays: [0, 1] };
  const la = { ...METRICS, timeZone: 'America/Los_Angeles', closedDays: [1, 0] };
  saveMetrics('acme', berlin, berlin.timeZone);
  expect(recallMetrics('acme', offline(), la.timeZone)).toBeNull();
  saveMetrics('acme', la, la.timeZone);
  expect(recallMetrics('acme', offline(), berlin.timeZone)?.value).toEqual(berlin);
  expect(recallMetrics('acme', offline(), la.timeZone)?.value).toEqual(la);
});

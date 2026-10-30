/**
 * The copy in `close-reason.ts`, pinned to the original it was copied from
 * (#1014).
 *
 * Two packages, two tsconfigs, no imports between them — so the predicate the
 * board counts closes by exists twice, and the failure this file exists to catch
 * is the pair drifting: board-api stops counting a reason, board-web keeps
 * listing it in the drill-in behind the very tile that stopped counting it, and
 * nothing is red. The service file is read as TEXT rather than imported, which
 * is `fonts-import.spec.ts`'s trick for the same shape of problem: the module
 * graph cannot reach across the package boundary, and the bytes can.
 */
import { describe, expect, it } from 'vitest';
// The package carries no node types, so every spec reaching the filesystem says
// so the same way — see `App.spec.ts`, `head.spec.ts` and `fonts-import.spec.ts`.
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readdirSync, readFileSync } from 'node:fs';
// @ts-expect-error node:path is untyped here; it exists in vitest's node env.
import { dirname, join, resolve } from 'node:path';
// @ts-expect-error node:url is untyped here; it exists in vitest's node env.
import { fileURLToPath } from 'node:url';
import { deliveredCloseAt, type CloseReason } from './close-reason';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = readFileSync(resolve(HERE, '../../board-service/src/issues-metrics/close-reason.ts'), 'utf8');
const MINE = readFileSync(resolve(HERE, 'close-reason.ts'), 'utf8');

const AT = '2026-09-09T12:00:00.000Z';

/** The named reasons in a `CloseReason` declaration, in the order written. Both
 *  files declare the union the same way, so one reader answers for both. */
function unionOf(source: string): string[] {
  const declared = source.match(/export type CloseReason =([^;]+);/);
  return [...(declared?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** The reasons the SERVICE's `deliveredCloseAt` refuses, read off its body. A
 *  reason added to that line — or one taken off it — lands here. */
function refusedByService(): string[] {
  const body = SERVICE.match(/export function deliveredCloseAt[\s\S]*?\n}/)?.[0] ?? '';
  return [...body.matchAll(/i\.stateReason === '([a-z_]+)'/g)].map((m) => m[1]!);
}

describe('the frontend close predicate against board-service (#1014)', () => {
  it('reads the service file it claims to mirror', () => {
    // The three regexes below are the whole pin, so a rename that makes them all
    // match nothing would leave this file green while proving nothing at all.
    expect(unionOf(SERVICE).length).toBeGreaterThan(0);
    expect(refusedByService()).toEqual(['not_planned', 'duplicate']);
  });

  it('declares the same reasons the service does', () => {
    expect(unionOf(MINE)).toEqual(unionOf(SERVICE));
  });

  it('counts and refuses exactly what the service counts and refuses', () => {
    const refused = refusedByService();
    for (const reason of unionOf(SERVICE)) {
      const got = deliveredCloseAt({ closedAt: AT, stateReason: reason as CloseReason });
      expect([reason, got]).toEqual([reason, refused.includes(reason) ? null : AT]);
    }
  });

  it('counts a close whose reason nobody told us — the direction that must never invert', () => {
    // Unknown counts, deliberately: #1014 stops counting closes somebody marked
    // abandoned, not closes we cannot classify. Absent is the same answer here
    // for the deploy-window reason `close-reason.ts` gives, and there is no
    // `null` on the service's refusal line for this to disagree with.
    expect(refusedByService()).not.toContain('null');
    expect(deliveredCloseAt({ closedAt: AT, stateReason: null })).toBe(AT);
    expect(deliveredCloseAt({ closedAt: AT })).toBe(AT);
  });

  it('refuses a row that never closed, before any reason is consulted', () => {
    expect(deliveredCloseAt({ closedAt: null, stateReason: 'completed' })).toBeNull();
    expect(deliveredCloseAt({ stateReason: 'completed' })).toBeNull();
  });
});

/** Every `.ts`/`.tsx` under `src`, relative to it. */
function sources(dir = HERE): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry: { name: string; isDirectory(): boolean }) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path.slice(HERE.length + 1)] : [];
  });
}

describe('one definition of a delivered close on this side (#1014)', () => {
  it('is named in one source file and nowhere else', () => {
    // The failure this catches is a fourth definition: someone counting closes
    // in a new surface, reaching for `stateReason !== 'not_planned'` inline, and
    // getting `duplicate` or the unknown case wrong where nothing compares the
    // two. Specs are exempt — they build rows with a reason on purpose — and
    // prose elsewhere says "not-planned" with a hyphen so this stays a search
    // for the code and not for the argument.
    const naming = sources().filter((f) => !/\.spec\.tsx?$/.test(f) && readFileSync(join(HERE, f), 'utf8').includes('not_planned'));
    expect(naming).toEqual(['close-reason.ts']);
  });

  it('catches the spelling that reads naturally and inverts the rule', () => {
    // `stateReason === 'completed'` is the FIRST thing anyone writes for "did
    // this ship?", and it is the one phrasing that quietly flips the unknown
    // case: a close we were told nothing about counts here and would not count
    // there. Grepping only `not_planned` never saw it, which made the pin above
    // green against the very mistake it was written for. Both reason literals
    // are searched now, so any file naming either has to be this one.
    const reasons = /'(completed|not_planned|duplicate)'/;
    const naming = sources().filter((f) => !/\.spec\.tsx?$/.test(f) && reasons.test(readFileSync(join(HERE, f), 'utf8')));
    expect(naming).toEqual(['close-reason.ts']);
  });
});

describe('the pin catches a fourth definition however it is spelled (#1014)', () => {
  it('would fire on the natural “did it ship?” phrasing written into a real source file', () => {
    // A pin that cannot be shown to fail is not a pin. This writes the exact
    // mistake into the file list the test reads and asserts the test's own rule
    // rejects it, without touching the tree.
    const offender = "export const shipped = (i: ViewerIssue) => i.closedAt != null && i.stateReason === 'completed';";
    const reasons = /'(completed|not_planned|duplicate)'/;
    expect(reasons.test(offender)).toBe(true);
    // …and the older rule, which only looked for the abandonment literal, did not.
    expect(offender.includes('not_planned')).toBe(false);
  });
});

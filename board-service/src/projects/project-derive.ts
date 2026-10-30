import type { PersonalIssueType } from '../issues-metrics/issues-metrics.types';
import type { ProjectStatus } from './project.types';

/** Coarse work type from an issue's label names (#376) — the same taxonomy the
 *  personal queue derives (`bug` > `feedback` > `feature` > chore), so grouping
 *  an issue by type reads identically on the Project page and in the queue. */
export function deriveIssueType(labelNames: string[]): PersonalIssueType {
  const s = new Set(labelNames.map((l) => l.toLowerCase()));
  if (s.has('bug')) return 'bug';
  if (s.has('feedback')) return 'feedback';
  if (s.has('enhancement') || s.has('feature')) return 'feature';
  return 'chore';
}

/**
 * Pure derivation helpers shared by the fixture and GitHub Projects sources.
 * Side-effect free so they unit-test directly, without a client.
 */

/** A short "2h ago" / "3d ago" / "5mo ago" phrase from an ISO time and a now-ms. */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Which GitHub Projects belong on board's Projects surface — shared by both
 * sources so the fixture and GitHub behave identically. Two kinds are dropped:
 * - auto-named personal boards ("…'s untitled project") — noise on a team rollup;
 * - the org-wide **"Acme"** umbrella (#202) — the catch-all, not a focused board.
 * Dropping a board here removes it from the rollup AND the project-stacking join,
 * but never from issue counts: the Dashboard Issues block is a separate GitHub
 * search, not a projects join, so the umbrella's issues still count.
 */
export function isSurfacedProjectName(name: string): boolean {
  return !/untitled/i.test(name) && name.trim().toLowerCase() !== 'acme';
}

/** Completion = closed / (open + closed), as a 0–100 integer. 0 when empty. */
export function completionPct(open: number, closed: number): number {
  const total = open + closed;
  return total === 0 ? 0 : Math.round((closed / total) * 100);
}

const DAY = 24 * 3600 * 1000;

/**
 * A board's health, from its progress + recency:
 * - `active`       — something closed in the last 3 days.
 * - `just-started` — at most one issue closed so far, AND none abandoned.
 * - `stalled`      — open work but nothing closed in 45+ days.
 * - `in-progress`  — everything else (steady work underway).
 * Order matters: recency wins, then "barely begun", then staleness.
 *
 * `abandoned` is what keeps "barely begun" honest after #1014 (#1014). `closed`
 * counts delivery now, so a board that worked through ten issues and dropped
 * every one of them arrives here as `closed: 0` and used to chip "just-started"
 * — a claim about a board nobody had touched, made about one that had been
 * touched a great deal and got nowhere. Being told that work happened is enough
 * to refuse that word; which OTHER word it earns is left to the rules below, so
 * such a board reads `stalled` while it still holds open work and `in-progress`
 * once it does not.
 *
 * It does NOT re-enter any count. `closed`, the ring and the completion
 * denominator all stay delivery-only; this is the one place the board is allowed
 * to know that abandoned work exists, because "nothing has happened here" is the
 * single claim that abandoned work falsifies on its own.
 *
 * Optional, and absent means zero: every caller that has the figure passes it,
 * and one that does not is asserting nothing rather than asserting none.
 */
export function deriveProjectStatus(
  input: { open: number; closed: number; lastClosedAtISO: string | null; abandoned?: number },
  nowMs: number,
): ProjectStatus {
  const ageDays =
    input.lastClosedAtISO && !Number.isNaN(Date.parse(input.lastClosedAtISO))
      ? (nowMs - Date.parse(input.lastClosedAtISO)) / DAY
      : Infinity;
  if (ageDays <= 3) return 'active';
  if (input.closed <= 1 && !input.abandoned) return 'just-started';
  if (input.open > 0 && ageDays > 45) return 'stalled';
  return 'in-progress';
}

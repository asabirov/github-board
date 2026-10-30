// The coarse work-type taxonomy (#206), on its own so the two peer VMs that
// need it — personal-issues.vm.ts and issues-metrics.vm.ts — can both import it
// without one reaching sideways into the other.

/** Coarse work type, derived from an issue's labels (#206 personal queue).
 *  Mirrors the buckets taxonomy: label `bug` → bug, `feedback` → feedback,
 *  `enhancement`/`feature` → feature, everything else → chore. */
export type PersonalIssueType = 'bug' | 'feedback' | 'feature' | 'chore';

/** Coarse type from labels — same taxonomy as the buckets surface. `bug` wins
 *  over `feedback` over `feature` so a bug labelled `enhancement` still triages
 *  as a bug. Total: every label set answers, `chore` being the fallback, which
 *  is what lets the four per-type day series partition the `closed` one. */
export function deriveType(labels: string[]): PersonalIssueType {
  const s = new Set(labels.map((l) => l.toLowerCase()));
  if (s.has('bug')) return 'bug';
  if (s.has('feedback')) return 'feedback';
  if (s.has('enhancement') || s.has('feature')) return 'feature';
  return 'chore';
}

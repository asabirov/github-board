/**
 * The one canonical dashboard block header (#302, unified in #337). Every section
 * on Your work and Unit — Projects, Throughput, Oldest open, Crew, the
 * queues — leads with this exact treatment, so the page reads as a single system
 * instead of near-misses. Two headers were dropped as redundant rather than
 * restyled: the Issues band's title (#335 — the counts name themselves) and
 * Throughput's "Per member" sub-label (#338 — the avatar rows speak for themselves).
 *
 * The rule (chosen from prototype variants):
 *   • Label   — sentence case, 12.5px, semibold, text-secondary. NOT uppercase:
 *               an uppercased micro-label reads as eyebrow-kicker slop. Nothing
 *               checks that. The ai-slop-detector's `eyebrow-kicker` is a rule
 *               of its visual pack, which reads markup and never a component,
 *               so this one is kept by whoever is looking (#731). What CI does
 *               enforce over source is one rule about comment shape, and
 *               docs/comments.md says which.
 *   • Meta    — optional, right-aligned, 11.5px tabular text-tertiary. A count +
 *               noun ("6 aging", "3 members", "12 open") or a descriptor
 *               ("last 7 days"). Never a middot chain.
 *   • Connective — none. Plain gap; no hairline rule. Spacing separates the
 *               header from its content (house style: reserve lines for meaning).
 *   • Spacing — a uniform 12px (mb-3) to the block's content.
 *
 * `right` carries an interactive control (e.g. the queue's stack-by toggle) after
 * the meta, so the count still sits on the right like every other block's meta.
 */
import { ReactNode } from 'react';

/** The shared label class — the header's own label uses it; also available for a
 *  nested sub-label that isn't a full block header, should one be needed. */
export const BLOCK_LABEL = 'text-[12.5px] font-semibold tracking-[-0.005em] text-dim';

/** The shared right-side meta class. */
export const BLOCK_META = 'text-[11.5px] tabular-nums text-muted';

export function BlockHeader({
  label,
  labelId,
  meta,
  right,
  className = '',
}: {
  label: ReactNode;
  /** An id on the label, for a block that names ITSELF with it — a `<section>`
   *  carrying `aria-labelledby={labelId}` becomes a region a screen reader can
   *  reach and skip by, instead of an ignored wrapper with a loose word above
   *  its figure. `aria-labelledby` and not a repeated `aria-label`, so the
   *  region and the thing a sighted reader sees cannot drift apart. */
  labelId?: string;
  /** Right-aligned meta — a count+noun or a short descriptor. */
  meta?: ReactNode;
  /** Right-aligned interactive control, rendered after the meta. */
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-3 flex items-center justify-between gap-3 ${className}`}>
      <span className={BLOCK_LABEL} id={labelId}>{label}</span>
      {(meta != null || right != null) && (
        <span className="flex flex-none items-center gap-3">
          {meta != null && <span className={BLOCK_META}>{meta}</span>}
          {right}
        </span>
      )}
    </div>
  );
}

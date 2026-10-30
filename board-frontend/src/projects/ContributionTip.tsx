/**
 * The hover reading of the segmented ring's colours (#454).
 *
 * `ContributionTip` is the exact split for one board — every run's colour with
 * its count, plus what's still open, so the ring's percentage and its runs can
 * be reconciled without leaving the row.
 *
 * It is also where the ring's identity now lives. The standing legend under each
 * block came off with #477: a colour belongs to the person, not to the chart, so
 * the crew cards on Unit teach who is teal and who is rose and the ring below
 * simply spends what they taught. What the legend was still carrying — the names
 * — the hover carries, so identity never rests on the hue alone.
 */
import type { ContributionSegment } from './contributors';

const SWATCH = 'inline-block size-[9px] flex-none rounded-[3px]';

function Swatch({ color }: { color: string }) {
  return <span className={SWATCH} style={{ background: color }} aria-hidden="true" />;
}

const TIP_ROW = 'flex items-center gap-2 text-[12px]';

export function ContributionTip({ segments, open }: { segments: ContributionSegment[]; open: number }) {
  return (
    <div className="flex min-w-[150px] flex-col gap-1">
      {segments.map((s) => (
        <span key={s.key} className={TIP_ROW}>
          <Swatch color={s.color} />
          {s.label}
          <span className="ml-auto tabular-nums text-muted">{s.closed}</span>
        </span>
      ))}
      <span className={`${TIP_ROW} text-muted`}>
        Still open
        <span className="ml-auto tabular-nums">{open}</span>
      </span>
    </div>
  );
}

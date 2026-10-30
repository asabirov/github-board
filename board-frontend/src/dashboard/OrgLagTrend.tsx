import type { IssueMetrics } from '../api/issues';
import { ChartHint, ChartMark, ChartPoints, pointInside, type ChartPointer } from '../ui/chart-pointer';
import { weekAgoLabel } from './trend-chart';

export type LagComparison = NonNullable<IssueMetrics['ttc']['comparison']>;
const W = 300;
const H = 82;
const PAD = 8;

/**
 * THE WEEK MARKER, in SCREEN pixels, for the reason `ui/chart-pointer.tsx`'s
 * `DOT_PX` gives: this svg is `preserveAspectRatio="none"`, so an `r` is
 * stretched by whatever the chart is stretched by and the marker is a lozenge
 * rather than a dot (#1171). This card is the narrow third of the pulse row, so
 * it was squashed the OTHER way from Throughput beside it — measured on the
 * built page by `scripts/measure-chart-dots.mjs`, `r 2.7` came out 1.80 x 5.40
 * px at 900, 2.60 x 5.40 at 1280, 3.60 x 5.40 at 1440 and 5.10 x 5.40 at 1920.
 * That last one is 0.94:1 and passes the guard, which is the whole reason a
 * radius cannot be trusted here: it is the same code at four widths.
 *
 * 5.4 is twice that radius, and this chart draws its 82-unit viewBox into an
 * 82px box, so the drawn height does not move at all — only the width, which is
 * the defect.
 */
const DOT_PX = 5.4;
const issueCount = (n: number) => `${n} ${n === 1 ? 'issue' : 'issues'}`;

export function lagDays(value: number): string {
  return value > 0 && value < 0.05 ? '<0.1' : value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

const dayAmount = (value: number) => {
  const amount = lagDays(value);
  return `${amount} ${amount === '1' ? 'day' : 'days'}`;
};

/** Each point is a full 90-day cohort ending at its sampled date. */
export function lagInterval(rolling: NonNullable<LagComparison['rolling']>, i: number): string {
  const week = rolling[i];
  const when = weekAgoLabel(rolling.length - 1 - i);
  return week.meanDays === null ? `${when}, nothing closed` : `${when}, ${dayAmount(week.meanDays)} over ${issueCount(week.n)}`;
}

export function OrgLagTrend({ rolling, mark, read, onPoint }: { rolling: NonNullable<LagComparison['rolling']> } & ChartPointer & { onPoint: (index: number | null) => void }) {
  const at = pointInside(mark, rolling.length);
  const selected = pointInside(read, rolling.length) ?? rolling.length - 1;
  const max = Math.max(1, ...rolling.map((week) => week.meanDays ?? 0));
  const ceiling = Math.max(1, Math.ceil(max));
  const x = (i: number) => PAD + i * (W - 2 * PAD) / Math.max(1, rolling.length - 1);
  const y = (days: number) => H - PAD - days / ceiling * (H - 2 * PAD);
  let connected = false;
  const path = rolling.map((week, i) => {
    if (week.meanDays === null) { connected = false; return ''; }
    const command = connected ? 'L' : 'M';
    connected = true;
    return `${command}${x(i)},${y(week.meanDays)}`;
  }).join(' ');
  if (!rolling.length) return null;
  const plot = (
    <div className="relative h-[82px] w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-full w-full overflow-visible" preserveAspectRatio="none" role="img" aria-label="Weekly mean time to close. Empty intervals are gaps.">
        <line data-chart-decoration="grid" x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
        <path data-lag-series="rolling" d={path} fill="none" stroke="var(--chart-series)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {rolling.map((week, i) => week.meanDays === null || i === at ? null : (
          <line
            key={week.startAt}
            data-dot="rolling"
            x1={x(i)}
            x2={x(i)}
            y1={y(week.meanDays)}
            y2={y(week.meanDays)}
            stroke="var(--chart-series)"
            strokeWidth={DOT_PX}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {at !== null && rolling[at].meanDays !== null && <ChartMark treatment="halo-dot" x={x(at)} height={H} y={y(rolling[at].meanDays)} column={{ i: at, count: rolling.length, width: W }} colour="var(--chart-series)" />}
      </svg>
      <ChartPoints count={rolling.length} at={at} onPoint={onPoint} label={(i) => lagInterval(rolling, i)} />
    </div>
  );
  return (
    <div className="min-w-0 max-w-[390px] flex-1">
      <ChartHint label={lagInterval(rolling, selected)} side="bottom">{plot}</ChartHint>
    </div>
  );
}

/** The comparison uses the previous 90-day window. */
export const LAG_AGAINST = '90 days';

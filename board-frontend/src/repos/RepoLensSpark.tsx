import { ChartGuide, ChartHint, ChartMark, ChartPoints, useChartPointer } from '../ui/chart-pointer';
import { smoothPath } from '../ui/smooth-path';
import { plural, usd, type RepoMetric } from './repos-vm';

/** A zero-based weekly trend. Missing windows break the line instead of becoming zero. */
export function RepoLensSpark({ metric }: { metric: RepoMetric }) {
  const { series, lens } = metric;
  const { mark, read, point } = useChartPointer(series.length);
  if (!series.length) return <span className="block min-h-[26px] text-xs text-dim">
    {!metric.missing && 'History unavailable'}
  </span>;
  const max = Math.max(1, ...series.map(value => value ?? 0));
  const x = (i: number) => 3 + i * 144 / Math.max(1, series.length - 1);
  const y = (value: number) => 23 - value / max * 20;
  const segments: [number, number][][] = [];
  let segment: [number, number][] = [];
  for (let i = 0; i < series.length; i++) {
    if (series[i] === null) { if (segment.length) segments.push(segment); segment = []; }
    else segment.push([x(i), y(series[i]!)]);
  }
  if (segment.length) segments.push(segment);
  const label = (i: number) => `${i === series.length - 1 ? 'Trailing 7 days' : `${plural(series.length - 1 - i, 'week')} earlier`}: ${series[i] === null ? 'unavailable' : lens === 'ci-cost' ? `${usd(series[i]!)} net billed USD` : `${plural(series[i]!, 'PR')} opened`}`;
  return <ChartHint label={label(read ?? series.length - 1)} side="bottom"><span className="relative block h-[26px]" data-repo-trend={lens}>
    <svg viewBox="0 0 150 26" preserveAspectRatio="none" className="block h-[26px] w-full overflow-visible"
      role="img" aria-label={lens === 'ci-cost' ? 'Weekly CI cost in net billed USD' : 'Weekly PRs opened'}>
      {segments.map((points, i) => points.length === 1
        ? <line key={i} x1={points[0][0]} x2={points[0][0]} y1={points[0][1]} y2={points[0][1]} stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        : <path key={i} d={smoothPath(points)} fill="none" stroke="var(--accent)" strokeWidth="1.9" vectorEffect="non-scaling-stroke" />)}
      {mark !== null && series[mark] !== null && <>
        <ChartGuide x={x(mark)} height={26} />
        <ChartMark treatment="halo-dot" x={x(mark)} height={26} y={y(series[mark]!)} column={{ i: mark, count: series.length, width: 150 }} />
      </>}
    </svg>
    <ChartPoints count={series.length} label={label} onPoint={point} at={mark} />
  </span></ChartHint>;
}

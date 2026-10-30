/**
 * The board's one line-smoothing routine. It was private to the dashboard's
 * throughput chart (#357) until the repo map's tile sparkline (#558) needed the
 * same curve at a twentieth of the size — two copies of a smoothing constant is
 * how two charts start disagreeing about what a spike looks like, so it lives
 * here and both import it.
 */

/** Catmull-Rom → cubic-bezier smoothing: turns a series of points into a
 *  legible trend curve. Tension 1/6 gives a gentle wave without overshooting
 *  the data, so a spike still reads as a spike. */
export function smoothPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? pts[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

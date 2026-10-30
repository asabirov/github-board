/**
 * SCRATCH — preview-only (#658). Renders the design variants of the cockpit
 * strip, one under the other, on the board's own dark canvas and at the real
 * page rail's width. Nothing in the app imports this file.
 *
 * The BEFORE section went with `dashboard/Cockpit.tsx` (#666): the before/after
 * screenshots were taken at the base commit and are captured, and keeping a live
 * "before" renderer means keeping the replaced component alive to feed it.
 *
 * Same CSS `src/main.tsx` loads, same theme seed, and the same `.shell` grid the
 * app draws — an empty sidebar column so `shell-main` is the width it really is
 * beside the nav, which is what decides how wide a tile comes out.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from './ui/kit';
import '@apliteni/apliteni-ui/tokens';
import '@apliteni/apliteni-ui/accents';
import './app.css';
import { PAGE_RAIL } from './ui/PageHeading';
import {
  A, B, C, D, E, F, G, H, I, J, K,
  SpanCompare, ColourCompare,
  V3, V4,
} from './cockpit-variants';

try {
  if (localStorage.getItem('board_theme') === null) {
    localStorage.setItem('board_theme', 'dark');
  }
} catch {
  /* storage unavailable — the board is dark by default regardless */
}

function Section({ id, cap, children }: { id: string; cap: string; children: React.ReactNode }) {
  return (
    <section id={id} className="pt-6">
      <div className="mb-2 text-[11px] tabular-nums text-muted">{cap}</div>
      {children}
    </section>
  );
}

function Preview() {
  return (
    <TooltipProvider>
      <div className="shell">
        <aside className="side" />
        <div className="shell-main">
          <div className={`${PAGE_RAIL} pb-24 pt-4`}>
            <div className="mt-10 mb-1 text-[11px] text-muted">ONE ISSUES BLOCK — count now, today vs yesterday, open-per-day + closed-per-day</div>
            <Section id="e" cap="E"><E /></Section>
            <Section id="f" cap="F"><F /></Section>
            <Section id="g" cap="G"><G /></Section>
            <div className="mt-10 mb-1 text-[11px] text-muted">WHOLE-SURFACE ANSWERS — where closed-per-day lives (#666 vs #684)</div>
            <Section id="h" cap="H — both, stacked: the block keeps its closed spark AND the grid goes below"><H /></Section>
            <Section id="i" cap="I — division of labour: the block loses the closed spark, the grid owns it"><I /></Section>
            <Section id="j" cap="J — one block: headline, open-each-day, and the grid side by side"><J /></Section>
            <div className="mt-10 mb-1 text-[11px] text-muted">ARTUR&apos;S OWN SHAPE — three tiles, then the grid, filtered by type</div>
            <Section id="k" cap="K — Issues / Throughput / Releases, and the day grid across the rail"><K /></Section>
            <div className="mt-10 mb-1 text-[11px] text-muted">HOW FAR BACK THE GRID REACHES</div>
            <Section id="span" cap="SPAN"><SpanCompare /></Section>
            <div className="mt-10 mb-1 text-[11px] text-muted">WHAT COLOUR CARRIES THE COUNT</div>
            <Section id="colour" cap="COLOUR"><ColourCompare /></Section>
            <div className="mt-10 mb-1 text-[11px] text-muted">EARLIER ROUND — merge the two flow tiles, weekly</div>
            <Section id="a" cap="A"><A /></Section>
            <Section id="b" cap="B"><B /></Section>
            <Section id="c" cap="C"><C /></Section>
            <Section id="d" cap="D"><D /></Section>
            <div className="mt-12 mb-1 text-[11px] text-muted">REJECTED — kept for the record</div>
            <Section id="v3" cap="V3"><V3 /></Section>
            <Section id="v4" cap="V4"><V4 /></Section>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);

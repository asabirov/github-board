/**
 * SCRATCH — preview-only (#822). Today's issue list and three directions for it,
 * one under the other, on the board's own dark canvas and at the real page
 * rail's width. Nothing in the app imports this file.
 *
 * The TODAY panel is the real `ListView`, imported unmodified — that is what
 * makes the stack a comparison rather than four drawings. Every panel is handed
 * the same `RenderGroup[]`, in the same order, from `list-variants.tsx`.
 *
 * Same CSS `src/main.tsx` loads, same theme seed, and the same `.shell` grid the
 * app draws — an empty sidebar column so `shell-main` is the width it really is
 * beside the nav, which is what decides how wide a row comes out.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from './ui/kit';
import '@apliteni/apliteni-ui/tokens';
import '@apliteni/apliteni-ui/accents';
import './app.css';
import { PAGE_RAIL } from './ui/PageHeading';
import { ListView } from './issues-viewer/ListView';
import { GROUPS, VariantA, VariantB, VariantC } from './list-variants';

try {
  if (localStorage.getItem('board_theme') === null) {
    localStorage.setItem('board_theme', 'dark');
  }
} catch {
  /* storage unavailable — the board is dark by default regardless */
}

function Section({ id, cap, note, children }: {
  id: string; cap: string; note: string; children: React.ReactNode;
}) {
  return (
    <section id={id} className="pt-10">
      <div className="mb-3">
        <div className="text-[11px] font-medium text-muted">{cap}</div>
        <div className="mt-1 max-w-2xl text-[12.5px] text-dim">{note}</div>
      </div>
      {children}
    </section>
  );
}

/**
 * `?labels=off` draws every panel the way the app draws this list today: the
 * shared `IssueQueue` and the Project page pass `hideRowLabels` to
 * `IssuesViewer`, covering My work, Overview and Project lists —
 * so `LabelTags` reaches no screen at all right now. Labels-on is the reading of
 * a row with chips, which the component still supports and no page asks for; the
 * URL picks between them.
 */
const HIDE_LABELS = new URLSearchParams(window.location.search).get('labels') === 'off';

function Preview() {
  return (
    <TooltipProvider>
      <div className="shell">
        <aside className="side" />
        <div className="shell-main">
          <div className={`${PAGE_RAIL} pb-24 pt-6`}>
            <h1 className="text-[15px] font-semibold text-fg">Issue list: three directions</h1>
            <p className="mt-1 max-w-2xl text-[12.5px] text-dim">
              The same fifteen issues, grouped by type, in the same order in every panel. Age carries
              the only colour, on the thresholds the board already uses: amber past 60 days, red past
              90. Nothing in this set falls between 60 and 89, so the amber step never shows here.{' '}
              {HIDE_LABELS
                ? 'Label chips are off, as they are on every page that draws this list today.'
                : 'Label chips are on, which no page currently asks for.'}
            </p>
            <Section
              id="panel-today"
              cap="TODAY"
              note="The live ListView, whatever it currently draws. It was the panel the other three were proposed against; since A landed it is A, and this panel moves with the component rather than recording how it once looked."
            >
              <ListView groups={GROUPS} mayClose={false} mayAssign={false} hideLabels={HIDE_LABELS} />
            </Section>
            <Section
              id="panel-a"
              cap="A — RANK BY HEAT"
              note="Same row, same density. The age column takes one format and the heat colour; blocked and aging become small marks; #id leaves the title's side for a column of its own."
            >
              <VariantA groups={GROUPS} hideLabels={HIDE_LABELS} />
            </Section>
            <Section
              id="panel-b"
              cap="B — TWO-LINE ROW"
              note="The title keeps a line to itself and everything that qualifies it drops under it in small type. Roughly twice the row height, so half as many issues reach the fold."
            >
              <VariantB groups={GROUPS} hideLabels={HIDE_LABELS} />
            </Section>
            <Section
              id="panel-c"
              cap="C — LEFT RAIL"
              note="A stripe and a day count down the left edge carry the scan; the title is the only other thing at full strength, and everything right of it waits for the pointer."
            >
              <VariantC groups={GROUPS} hideLabels={HIDE_LABELS} />
            </Section>
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

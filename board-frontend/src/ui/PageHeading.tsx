/**
 * The one canonical page heading (#391, "T1"). Every page's identity is a single
 * large sans H1 — same size and weight as the issue page's title — and it is the
 * sole source of that identity. The breadcrumb above (PageCrumb) shows only the
 * ancestor path, never this heading's own name, so the page name is said once.
 *
 * Root pages (Your work, Unit, the Projects rollup, Docs, an Account/Admin
 * section) render this with no breadcrumb; deeper pages render the breadcrumb
 * (ancestors only) and then this. Tabular-nums off by default — a title is prose,
 * not figures; callers that need it (none today) can add it via className.
 */
import type { ReactNode } from 'react';
import { useOrgScope } from '../org-scope/OrgScopeProvider';

/** The canonical H1 classes — kept in one place so no page's heading can drift. */
export const PAGE_H1 =
  'text-[33px] font-[680] leading-[1.18] tracking-[-0.025em] text-fg max-[560px]:text-[26px]';

/**
 * A page's id, rendered inline in its H1 as the link out to Github (#425, #510).
 * The issue page settled the treatment — muted at rest, tabular figures, no ↗
 * glyph, underlines on hover — and a project board reuses it, so both surfaces
 * say "this is the thing's id, and it takes you to the source" the same way.
 * Lives here, beside PAGE_H1, because it is part of that one heading.
 */
export const H1_NUMBER_LINK = 'font-medium tabular-nums text-muted hover:text-fg text-link';

/**
 * The one app content rail (#390) — the horizontal measure every page's outer
 * column shares so the breadcrumb + H1 band keeps a single, stable left origin
 * across page types. It never jumps when navigating list ↔ issue because every
 * page centers the SAME max-width at the SAME inset; only vertical padding stays
 * per-page (compose it after this). List pages fill the rail; the issue page pins
 * its header to the rail and left-aligns a narrower reading column beneath it.
 *
 * The cap is `--grid-container-max` (#783), the container token. `src/app.css`
 * declares it `1440px` once at `:root` and no theme overrides it. Since #1450 it
 * lives there, and before that the old private kit's sheet declared it. It is
 * named as the variable and not as its value, so the rail moves when the token moves.
 *
 * `max-w-container` would read better, and `tailwind.config.ts` does ship it, as
 * the literal `1440px` under `theme.extend.maxWidth`. The rail keeps the variable
 * so that one declaration moves both. A `var()` with no fallback and no
 * declaration is an invalid declaration: a page drawn with no rail and no
 * warning, the same silent nothing README.md warns about under Frontend styling
 * for a class off the scale. So the variable is written out longhand, with a
 * fallback. Every entry point loads `app.css`, so the fallback is insurance and
 * not a live case. Neither the second copy of `1440px` nor the claim above is a
 * thing to keep in step by hand: `page-rail.spec.ts` reads the token out of
 * `app.css` and `maxWidth.container` out of `tailwind.config.ts`, and fails if
 * the fallback disagrees with the declaration or the class stops existing.
 *
 * PR #807's second commit wrote the opposite here, that the scale "carries no
 * `maxWidth` at all". The scale sits one level down, under `theme.extend`, which
 * is where a config puts an addition rather than a replacement. Reading
 * `theme` alone says a scale is absent when it is present, and the tell is that
 * the class draws anyway. Build and grep the CSS.
 *
 * It used to be a bare `1180px`, which is 260px narrower than the token. Nothing
 * below about 1428px of window changes: under that the content column is itself
 * narrower than 1180, so the sidebar and not the cap is what binds.
 */
export const PAGE_RAIL = 'mx-auto w-full max-w-[var(--grid-container-max,1440px)] px-6 max-[900px]:px-3';

/**
 * The same rail with the cap taken off (#819) — the whole of the well
 * `.shell-main` hands a page, at the rail's own gutter. For a surface measured
 * in columns rather than in words, where the room the cap leaves is room a
 * reader wanted: the Repos map is the only one today. At a 1920px window the
 * well is 1672px, so the rail spent 232px of it on margin and drew five tiles
 * where six fit; below 1688px the cap does not bind and this is the rail
 * exactly.
 *
 * No `mx-auto`: with nothing to centre it does nothing, and an inert class in a
 * width constant is the next reader working out what it centres.
 *
 * The old private kit had this layout and board never imported it. Its 7.1.6
 * exported `PageColumn`,
 * whose `width="full"` is `grid grid-cols-1 gap-5` and nothing else — no
 * horizontal inset at all, deliberately, because its own docblock says
 * `AppShell` spells that inset once for `main` and the top-bar row together.
 * Board draws its own shell and not `AppShell`, decided on 2026-09-01 and
 * argued at the top of `src/App.tsx`, so board's inset lives here instead.
 * Importing `PageColumn` would put the tiles flush against the window edge and
 * lay a `gap-5` grid over a page that already spaces itself.
 */
export const PAGE_WELL = 'w-full px-6 max-[900px]:px-3';

/**
 * The two inner measures (#450). A page whose content is prose, settings rows or a
 * form doesn't want the rail's full width — but it must not pick its own number,
 * or the app grows a private width per page (it had five). Keep the rail as the
 * outer column and left-align ONE of these inside it, so the breadcrumb and H1
 * still start at the rail's left edge:
 *
 *   PAGE_READING — reference prose, settings rows, tables and lists.
 *   PAGE_FORM    — a single-column form, where a shorter line is easier to fill.
 *
 * Left-aligned on purpose: re-centering inside the rail is what made the content
 * jump between pages.
 */
export const PAGE_READING = 'max-w-[812px]';
export const PAGE_FORM = 'max-w-[560px]';

/**
 * The org half of a narrowed heading (#714 review) — quieter, at the heading's
 * own size, so naming the scope costs no change of hierarchy.
 *
 * The reporter selected “for” for visible scoped headings (#972). Keep the
 * phrase accessible, with the scope at the heading’s size and quieter tone.
 */
const H1_SCOPE = 'font-[inherit] text-muted';

/**
 * A page's identity, and — on the four tabs an address can narrow — the org it
 * is narrowed to: `Overview for acme`.
 *
 * Read off the scope here rather than passed in by each page, for the reason
 * this file exists at all: four pages each building the string is four places to
 * forget it, and a fifth page would arrive with no scope in its heading and
 * nothing to notice. Outside a provider — a spec rendering a heading on its own
 * — `useOrgScope` answers the union, so every existing render is untouched.
 */
export function PageHeading({ children, className, showScope = true }: { children: ReactNode; className?: string; showScope?: boolean }) {
  const { org } = useOrgScope();
  return (
    <h1 className={className ? `${PAGE_H1} ${className}` : PAGE_H1}>
      {children}
      {showScope && org !== null && (
        <>
          <span className={H1_SCOPE}> for </span>
          <span className={H1_SCOPE}>{org}</span>
        </>
      )}
    </h1>
  );
}

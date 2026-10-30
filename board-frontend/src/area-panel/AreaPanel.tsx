/**
 * The area panel (#712) — Admin Hub, the Account pages and the API reference,
 * over the board rather than instead of it. Each used to replace the sidebar's
 * primary nav, leaving the `board.` wordmark as the only way back.
 *
 * Being open is a modal state and is kept as one: the board is `inert` (App),
 * focus wraps at both ends, and the page behind does not scroll. The history
 * entry is App's, because it outlives this component.
 */
import { useCallback, useEffect, useRef, type ReactNode, type SVGProps } from 'react';
import { RouteProvider } from '../route-ctx';
import { OrgScopeProvider } from '../org-scope/OrgScopeProvider';
import { ErrorBoundary, PAGE_FALLBACK } from '../ErrorBoundary';
import { AdminHub } from '../admin/AdminHub';
import { ADMIN_SECTIONS } from '../admin/sections';
import { GithubAccountView } from '../account/GithubAccountView';
import { AccountView } from '../account/AccountView';
import { OrganisationGoalsView } from '../goals/GoalSettings';
import { PreferencesView } from '../account/PreferencesView';
import { ACCOUNT_SECTIONS } from '../account/sections';
import { DocsPage } from '../docs/DocsPage';
import { DOC_SECTIONS } from '../docs/docs-data';
import { PANEL_SCROLL_ID, scrollToDocsSection, useDocsScrollSpy } from '../docs/docs-nav';
import { SessionNotice } from '../auth/SessionNotice';
import type { SessionView } from '../auth/session-state';
import { AREA_LABEL, type Panel } from './panel';

/** Lucide's `x`. Local rather than in `icons.tsx`: this is the panel's own
 *  control and nothing else draws it. Same 24-unit, currentColor convention. */
function CloseIcon({ size = 17, ...p }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/** One rail row. The same pill the sidebar's items use, so the panel's rail and
 *  the board's nav read as one family. */
function RailItem(
  { on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode },
) {
  return (
    <button
      type="button"
      className={`side-item${on ? ' side-item-on' : ''}`}
      onClick={onClick}
      aria-current={on}
    >
      {children}
    </button>
  );
}

/** The panel's whole left rail: the area's name, then its sections. */
function Rail({ panel, onOpen, activeDocsSection }: {
  panel: Panel;
  onOpen: (p: Panel) => void;
  activeDocsSection: string | null;
}) {
  const rail = useRef<HTMLElement>(null);
  const lit = panel.area === 'docs' ? activeDocsSection : panel.section;

  // Below 900px the rail is a horizontal strip, and the reference's nine rows
  // are 774px of it in a 390px window — so scroll-spy lights a row that is off
  // the side of the screen, and the highlight names a section the reader cannot
  // see. Keyed on the LIT row rather than run every render, so scrolling the
  // rail by hand is left alone until the answer it shows actually changes.
  //
  // By `scrollLeft` and not `scrollIntoView`: that one walks every scrollable
  // ancestor, so it would scroll the reference's body out from under the reader
  // to satisfy a rail row.
  useEffect(() => {
    const box = rail.current;
    if (!box || box.scrollWidth <= box.clientWidth) return;
    const on = box.querySelector<HTMLElement>('.side-item-on');
    if (!on) return;
    const left = on.offsetLeft - box.offsetLeft;
    const right = left + on.offsetWidth;
    const pad = 12;
    if (left < box.scrollLeft) box.scrollLeft = Math.max(0, left - pad);
    else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth + pad;
  }, [lit]);

  return (
    <nav className="area-panel-rail" aria-label={AREA_LABEL[panel.area]} ref={rail}>
      <div className="side-nav-label">{AREA_LABEL[panel.area]}</div>
      {panel.area === 'admin' && ADMIN_SECTIONS.map((s) => (
        <RailItem key={s.id} on={panel.section === s.id} onClick={() => onOpen({ area: 'admin', section: s.id })}>
          <span className="inline-flex items-center gap-[11px]"><s.Icon size={17} />{s.label}</span>
        </RailItem>
      ))}
      {panel.area === 'organisation' && <RailItem on onClick={() => {}}>Daily goal</RailItem>}
      {panel.area === 'account' && ACCOUNT_SECTIONS.map((s) => (
        <RailItem key={s.id} on={panel.section === s.id} onClick={() => onOpen({ area: 'account', section: s.id })}>
          <span className="inline-flex items-center gap-[11px]"><s.Icon size={17} />{s.label}</span>
        </RailItem>
      ))}
      {/* The reference is one page, so its rows are in-page anchors (a table of
          contents) and scroll rather than switch section; scroll-spy marks the
          one in view. No per-item icons — a jump-nav reads cleaner as labels. */}
      {panel.area === 'docs' && DOC_SECTIONS.map((s) => (
        <RailItem key={s.id} on={activeDocsSection === s.id} onClick={() => scrollToDocsSection(s.id)}>
          <span className="flex w-full items-center">
            {s.label}
            {s.count != null && (
              <span className="ml-auto text-[11.5px] tabular-nums text-muted">{s.count}</span>
            )}
          </span>
        </RailItem>
      ))}
    </nav>
  );
}

/** The section the panel is open on. Wrapped like every page App renders
 *  (#523): a malformed 200 degrades to the boundary rather than white-screening
 *  the board underneath. */
function Content({ panel, session, githubVerified, githubCheckFailed, org }: {
  panel: Panel; session: SessionView; githubVerified: boolean; githubCheckFailed: boolean; org: string | null;
}) {
  if (panel.area === 'admin') return <ErrorBoundary><AdminHub section={panel.section} /></ErrorBoundary>;
  if (panel.area === 'organisation') return <ErrorBoundary><OrganisationGoalsView org={org} /></ErrorBoundary>;
  if (panel.area === 'docs') return <ErrorBoundary><DocsPage /></ErrorBoundary>;
  // The one page here whose render walks a remote shape it did not build. The
  // boundary's own `null` drew this panel with a rail and an empty body, which
  // on the page that holds the disconnect control reads as a board with nothing
  // on it rather than as a render that failed (#892 review, M2).
  if (panel.section === 'github') return <ErrorBoundary fallback={PAGE_FALLBACK}><GithubAccountView github={session.kind === 'ready' ? session.me.github : undefined} verified={session.kind === 'ready' && githubVerified} checkFailed={githubCheckFailed} /></ErrorBoundary>;
  if (panel.section === 'account') return <ErrorBoundary><AccountView /></ErrorBoundary>;
  return <ErrorBoundary><PreferencesView /></ErrorBoundary>;
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Focus the panel's first or last control, whichever end the sentinel is at.
 *
 * It TRIES rather than picks: a control inside a `<fieldset disabled>` matches
 * the selector and carries no `disabled` attribute of its own, so the obvious
 * "focus element[0]" silently focuses nothing and drops the reader on `<body>`.
 * Falling back to the panel itself means the wrap always lands somewhere inside.
 *
 * `scan` and `fallback` are two elements and not one because the mount landing
 * and the Tab wrap want different subtrees (#741 review) — see the mount effect.
 */
function focusEdge(
  scan: HTMLElement | null,
  end: 'first' | 'last',
  fallback: HTMLElement | null = scan,
): void {
  if (!scan) return;
  const els = Array.from(scan.querySelectorAll<HTMLElement>(FOCUSABLE));
  for (const el of end === 'first' ? els : els.reverse()) {
    el.focus();
    if (document.activeElement === el) return;
  }
  fallback?.focus();
}

export function AreaPanel({ panel, session, githubVerified, githubCheckFailed = false, onSignIn, onClose, onOpen, org = null }: {
  panel: Panel;
  org?: string | null;
  /** The shell's session, so the panel can say when it dies (#741). */
  session: SessionView;
  /** Whether the server's Github access check behind the session still holds.
   *  Required and never defaulted: a caller that forgets it would draw one
   *  person's credential on an unchecked grant (#892 review, low 5). */
  githubVerified: boolean;
  /** That check answered with a fault. App owns the outcome and the retry. */
  githubCheckFailed?: boolean;
  onSignIn: () => void;
  onClose: () => void;
  onOpen: (p: Panel) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const activeDocsSection = useDocsScrollSpy(panel.area === 'docs');

  // Mount-only, and that is the point: `onClose` is not in the deps, so a
  // re-render cannot re-run this. It used to, and every re-render — pressing a
  // rail row, a session expiring mid-panel — yanked focus off whatever the
  // reader was on and back onto the container.
  //
  // THE FRAME AND NOT THE PANEL (#741 review). Opening a panel on an already
  // expired session put the notice first in the panel's markup, so the landing
  // moved off the X and onto "Sign in" — and `onSignIn` is `beginLogin`, which
  // sets `window.location.href`. A habitual Enter after opening then left the
  // document for Google. The frame starts below the notice, so the landing is
  // the X in every session state, expired or not. The wrap sentinels still ask
  // for the whole panel, so Tab off the end comes back to the notice, which is
  // where the eye starts.
  useEffect(() => {
    focusEdge(frame.current, 'first', box.current);
    // Again next frame: the account menu unmounts AFTER this effect runs and
    // blurs whatever it had, so a single focus here leaves the open panel with
    // focus on <body> and the next Tab back at the top of the board.
    const settle = requestAnimationFrame(() => focusEdge(frame.current, 'first', box.current));
    const scrollWas = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(settle);
      document.body.style.overflow = scrollWas;
    };
  }, []);

  // Escape, held in a ref so the listener is bound once whatever `onClose`'s
  // identity does.
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A kit layer opened INSIDE the panel — the person editor in Access, a
      // tooltip — dismisses itself on Escape by calling preventDefault, and
      // Radix never stops the event bubbling. Without this line one press shut
      // the editor AND the panel, dumping the reader on the board.
      if (e.defaultPrevented) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const wrapToLast = useCallback(() => focusEdge(box.current, 'last'), []);
  const wrapToFirst = useCallback(() => focusEdge(box.current, 'first'), []);

  return (
    // A union route, and its scope, for the panel alone: these surfaces are one
    // person's or one deployment's, so a board narrowed to an org must not put
    // that org in "Access & agents · acme". Outside the panel the shell's
    // own providers are untouched.
    <RouteProvider route={{ tab: 'dashboard' }}>
    <OrgScopeProvider>
      {/* Tab off either end comes back in. The board is `inert` while this is
          open (App), so without these the next Tab left the document for the
          browser's own chrome and the one after it re-entered at the top. */}
      <span tabIndex={0} aria-hidden="true" onFocus={wrapToLast} />
      {/* A div and not a button: the X inside the panel is the ONE close
          control, in the tab order and named, and a second identical one in
          front of it is what #712 exists to remove. This is the backdrop —
          click-to-dismiss, nothing to reach with a keyboard. `.area-scrim`
          keeps the arrow, as the kit's own dialog overlay does: a backdrop is
          the page behind the panel, not a control on it (#1023). */}
      <div className="area-scrim" onClick={onClose} />
      <div
        className="area-panel"
        role="dialog"
        aria-modal="true"
        aria-label={AREA_LABEL[panel.area]}
        ref={box}
        // -1: never a tab stop, but focusable, so the wrap above always has
        // somewhere to land even on a section whose controls are all disabled.
        tabIndex={-1}
      >
        {/* One element in both layouts rather than one per layout: below 900px
            this is a real header row with the area's name beside the X, and
            above it the name is hidden and the row floats in the corner. Two
            copies would mean two X buttons in the markup, which is the thing
            this issue is about. */}
        {/* #741. The board's own copy of this bar is inside `.shell-main`,
            which is `inert` while this panel is open and sits under the scrim
            at z-40 to the scrim's 41 — so with a panel up it is neither read
            out nor clickable, and the reader watches the panel start failing
            on 401s with no reason given anywhere. Raising it over the panel
            was tried and lifts the top bar with it, over the X; splitting the
            two sticky layers costs the hand-maintained `top` offset #512 was
            built to avoid. So the notice is drawn where the reader is looking
            instead. Inside the panel it is above the scrim and inside the
            focus wrap by construction, with no z-index for anyone to keep in
            step. This is the ONLY copy while a panel is open: App stops
            drawing the shell's while `panel !== null`, because `inert` kept
            that one out of the accessibility tree but not off the glass —
            at 1280 its button showed in the gutter beside the inset panel and
            pressing it hit the scrim and closed the panel. Closing the panel
            re-inserts it, so the reader still lands on a notice already up. */}
        <SessionNotice session={session} onSignIn={onSignIn} />
        {/* Everything the panel held before, in a positioned box of its own.
            The X is `position: absolute` in a corner, so its containing block
            decides whether it lands on the notice or under it — hanging it
            here rather than on the panel puts it below the bar without a
            number anyone has to maintain. */}
        <div className="area-panel-frame" ref={frame}>
        <div className="area-panel-head">
          <span className="area-panel-head-name">{AREA_LABEL[panel.area]}</span>
          <button
            type="button"
            className="area-panel-close"
            aria-label={`Close ${AREA_LABEL[panel.area]}`}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <Rail panel={panel} onOpen={onOpen} activeDocsSection={activeDocsSection} />
        <div className="area-panel-body" id={PANEL_SCROLL_ID}>
          <Content org={org} panel={panel} session={session} githubVerified={githubVerified} githubCheckFailed={githubCheckFailed} />
        </div>
        </div>
      </div>
      <span tabIndex={0} aria-hidden="true" onFocus={wrapToFirst} />
    </OrgScopeProvider>
    </RouteProvider>
  );
}

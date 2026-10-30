/**
 * The API reference's jump-nav plumbing (#343): scroll a section into view when
 * its rail row is clicked, and track which section is in view so the rail can
 * highlight it (scroll-spy) — the same active-item affordance the Admin Hub and
 * Account rails give, but driven by scroll position rather than by state.
 *
 * Both halves read the AREA PANEL's body (#712), not the window. The reference
 * used to be a page and the board scrolled at the window level; inside the panel
 * the section scrolls in its own box, and a spy still listening to `window`
 * would report the first section for ever.
 */
import { useEffect, useState } from 'react';

/** The panel's scrolling body. `area-panel/AreaPanel.tsx` puts it on the
 *  element; this file is the only reader, and the two must not drift. */
export const PANEL_SCROLL_ID = 'area-panel-body';

/** Smooth-scroll the reference to a section by id — inside its own box, since
 *  `scrollIntoView` scrolls the nearest scrollable ancestor. */
export function scrollToDocsSection(id: string): void {
  document.getElementById(`docs-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * The docs section currently in view. Active only while `on` (the reference is
 * the open area). Reports the LAST section whose top has passed a threshold
 * below the scroll box's own top — i.e. the one you are reading. Always resolves
 * a section (unlike an intersection band, which a short bottom section cannot
 * reach), so the rail always has an active item.
 */
export function useDocsScrollSpy(on: boolean): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!on) {
      setActive(null);
      return;
    }
    // The active line sits a little below the top of the scroll box.
    const THRESHOLD = 90;
    const compute = () => {
      const box = document.getElementById(PANEL_SCROLL_ID);
      if (!box) return;
      const sections = Array.from(box.querySelectorAll<HTMLElement>('[data-docs-section]'));
      if (sections.length === 0) return;
      // Offsets are measured against the BOX, not the viewport: the panel is
      // inset from the top of the screen, so a viewport-relative threshold
      // would sit inside the panel's own chrome rather than at its reading line.
      const top = box.getBoundingClientRect().top;
      let current = sections[0].getAttribute('data-docs-section');
      for (const s of sections) {
        if (s.getBoundingClientRect().top - top <= THRESHOLD) current = s.getAttribute('data-docs-section');
        else break;
      }
      setActive(current);
    };
    // The anchors render with DocsPage in the same commit; resolve next frame
    // AND after layout settles (the extra timeout catches the initial highlight
    // past the dev double-mount / first-paint reflow), then stay live on scroll.
    const raf = requestAnimationFrame(compute);
    const settle = setTimeout(compute, 100);
    const box = document.getElementById(PANEL_SCROLL_ID);
    box?.addEventListener('scroll', compute, { passive: true });
    window.addEventListener('resize', compute);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
      box?.removeEventListener('scroll', compute);
      window.removeEventListener('resize', compute);
    };
  }, [on]);
  return active;
}

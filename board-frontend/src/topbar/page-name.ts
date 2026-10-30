/** Accessible context for the compact phone menu. Page headings remain visible;
 * the icon-only v1 header no longer repeats them in its own row. */
import { TAB_LABEL, type Route } from '../route';

export function menuPageName(route: Route): string | null {
  switch (route.tab) {
    case 'dashboard':
    case 'team':
    case 'repos':
      return TAB_LABEL[route.tab];
    // A board names itself — its own name, its ring and its Github number all
    // live in that H1 — and since #785 a board page is the whole of this tab, so
    // there is no longer a case where the menu can speak for it. The menu cannot
    // be standing on a projects route with no board either way: nothing in the
    // nav offers one (#750) and `route.ts` resolves such a path to Your work.
    case 'projects':
      return null;
    case 'people':
    case 'issue':
    case 'repo':
      return null;
  }
}

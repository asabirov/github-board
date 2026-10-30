import { describe, expect, it } from 'vitest';
// Vite's `?raw`, the same reader App.spec.ts uses for the same reason: the suite
// runs `environment: 'node'` with no DOM, so what a file SAYS can be checked and
// what the browser then does cannot.
//
// One thing deliberately not tested here: that every rule the phone shell adds
// sits inside a `@media (max-width: 900px)` block, which is what makes "above
// 900px nothing moves" true. `app.css?raw` reads as an EMPTY string under this
// runner (vitest short-circuits CSS, so both `?raw` and `import.meta.glob`
// answer ''), and a test written against it passes while reading nothing. That
// claim is proven by a pixel diff of a 1280px screenshot instead.
import APP from '../App.tsx?raw';
import TOPBAR from './TopBar.tsx?raw';

describe('the phone row keeps what the four bands reached (#608)', () => {
  it('holds a menu, the search affordance and the sync stamp, in that order', () => {
    const menu = TOPBAR.indexOf('aria-controls=');
    const search = TOPBAR.indexOf('aria-label="Search the board"');
    const sync = TOPBAR.indexOf('<SyncStamp');
    expect([menu, search, sync].filter((i) => i === -1)).toEqual([]);
    expect(menu).toBeLessThan(search);
    expect(search).toBeLessThan(sync);
  });

  it('points aria-controls at the id the sheet actually carries', () => {
    // Two files, one string. A rename on either side silently breaks the
    // announcement that this button opens that panel, and nothing else notices.
    const controls = TOPBAR.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(APP).toContain(`id="${controls}"`);
  });

  it('can tell a present wiring from an absent one', () => {
    // Keeps the check above honest: `indexOf` on a string that is not there
    // returns -1, and a reader that found nothing anywhere would pass silently.
    expect(APP).not.toContain('id="no-such-panel"');
  });
});

describe('the sheet answers a keyboard (#608)', () => {
  it('carries an Escape close, focus into the sheet and focus back to the button', () => {
    // Only that the code is there. Whether it FIRES is a browser check — no
    // effect runs under this runner, so a dead handler would pass here.
    expect(APP).toContain("e.key !== 'Escape'");
    expect(APP).toContain('sheet.current?.focus()');
    expect(APP).toContain('menuButton.current?.focus()');
  });

  it('closes the sheet on every arrival, not just on a nav click', () => {
    // gotoPath (the account menu) and the back button both land in the route
    // effect rather than in navigate(), so the close has to live there.
    expect(APP).toMatch(/useEffect\(\(\) => \{ setMenuOpen\(false\); \}, \[route\]\)/);
  });
});

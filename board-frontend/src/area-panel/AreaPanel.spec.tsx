/**
 * The area panel (#712) — what it draws, and what it must NOT draw.
 *
 * Admin Hub, the Account pages and the API reference used to REPLACE the
 * sidebar's primary nav, and the only way back was the `board.` wordmark, which
 * looks like a wordmark. They are a panel over the board now, with one X.
 *
 * The suite has no DOM, so everything below is a claim about
 * markup. Escape, the scrim click, the pushed history entry and the scroll-spy
 * are behaviour and are proved in a browser, never here.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../ui/kit';
import { AreaPanel } from './AreaPanel';
import { AREA_LABEL, type Panel } from './panel';
import type { SessionView } from '../auth/session-state';
// node:fs and not `?raw`: vitest runs `css: false`, which stubs every
// stylesheet import to '' — App.spec.ts reads it the same
// way for the same reason. A guard reading '' passes while proving nothing.
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readFileSync } from 'node:fs';

const APP_CSS: string = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
import { ADMIN_SECTIONS } from '../admin/sections';
import { ACCOUNT_SECTIONS } from '../account/sections';
import { DOC_SECTIONS } from '../docs/docs-data';
// Vite's `?raw` rather than node:fs — the frontend package carries no node types.
import APP_SOURCE from '../App.tsx?raw';
import PANEL_SOURCE from './AreaPanel.tsx?raw';
import SIDE_ACCOUNT_SOURCE from '../SideAccount.tsx?raw';
import TOPBAR_SOURCE from '../topbar/TopBar.tsx?raw';

/** A label as it appears in markup — `&` comes back as `&amp;`. */
const escaped = (label: string) => label.replace(/&/g, '&amp;');

const ME = { email: 'ivan@example.com', isAdmin: false };
const LIVE: SessionView = { kind: 'ready', me: ME };
const DEAD: SessionView = { kind: 'expired', me: ME };

function draw(panel: Panel, session: SessionView = LIVE): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AreaPanel
        panel={panel}
        session={session}
        githubVerified={false}
        onSignIn={() => {}}
        onClose={() => {}}
        onOpen={() => {}}
      />
    </TooltipProvider>,
  );
}

/** Markers the BOARD's own chrome emits — none may appear inside the panel. */
const CHROME: Array<[string, string]> = [
  ['the wordmark', 'side-logo-mark'],
  ['the account block', 'side-acct'],
  ['the sync line', 'side-sync'],
  ['the top bar', '<header'],
];

describe('the panel carries one way out (#712)', () => {
  it.each(['admin', 'account', 'docs'] as const)('draws exactly one close control on %s', (area) => {
    const panel: Panel =
      area === 'admin' ? { area: 'admin', section: 'access' }
        : area === 'account' ? { area: 'account', section: 'github' }
          : { area: 'docs' };
    const html = draw(panel);
    // Two stacked panels with two identical X buttons is the confusion #712
    // exists to remove, so the count is the assertion and not the presence.
    expect(html.match(/area-panel-close/g)).toHaveLength(1);
  });

  it('names what the close control closes, so it reads as the way out at rest', () => {
    expect(draw({ area: 'admin', section: 'access' })).toContain(`aria-label="Close ${AREA_LABEL.admin}"`);
    expect(draw({ area: 'docs' })).toContain(`aria-label="Close ${AREA_LABEL.docs}"`);
  });
});

describe('the panel carries the area, and only the area (#712)', () => {
  it('rails the Admin Hub sections beside the section itself', () => {
    const html = draw({ area: 'admin', section: 'access' });
    expect(html).toContain(AREA_LABEL.admin);
    for (const s of ADMIN_SECTIONS) expect(html, s.id).toContain(s.label);
  });

  it('rails the Account sections beside the section itself', () => {
    const html = draw({ area: 'account', section: 'github' });
    expect(html).toContain(AREA_LABEL.account);
    for (const s of ACCOUNT_SECTIONS) expect(html, s.id).toContain(escaped(s.label));
    // The section's own content, not just its rail row: the status line is drawn
    // straight away, with no read to wait for. GitHub and not Preferences —
    // Preferences reads localStorage at render, and the suite has no browser.
    expect(html).toContain('Checking GitHub access…');
  });

  it('rails the API reference sections beside the reference itself', () => {
    const html = draw({ area: 'docs' });
    expect(html).toContain(AREA_LABEL.docs);
    for (const s of DOC_SECTIONS) expect(html, s.id).toContain(s.label);
    expect(html).toContain('data-docs-section');
  });

  it('lights the section the panel is on, and no other', () => {
    const html = draw({ area: 'account', section: 'github' });
    expect(html.match(/side-item-on/g)).toHaveLength(1);
    // The lit row is GitHub's: the marker sits in the same element as its label.
    expect(html).toMatch(/side-item-on[^>]*>(?:(?!<\/button>)[\s\S])*GitHub/);
  });
});

describe('the way out is reachable, and the only control (#712 review)', () => {
  it('names the area beside the X, which is what the phone header shows', () => {
    // Below 900px the panel is full-bleed: no radius, no shadow, no visible
    // scrim, no Escape key. The X is the ONLY way out there, so it gets a header
    // row of its own rather than floating over a rail label — it used to land
    // through the "P" of Preferences and take 30px of that row's hit zone.
    const html = draw({ area: 'admin', section: 'access' });
    expect(html).toContain('area-panel-head');
    expect(html).toMatch(/area-panel-head-name[^>]*>Admin hub</);
    // One element in both layouts: a second copy for the phone would be a second
    // X in the markup, which is the thing this issue exists to remove.
    expect(html.match(/class="area-panel-head"/g)).toHaveLength(1);
  });

  it('leaves the scrim out of the tab order — it is a backdrop, not a control', () => {
    // A second element labelled Close, in front of the X and reachable by Tab,
    // is the two-ways-out confusion again in a quieter form.
    const html = draw({ area: 'docs' });
    expect(html).toContain('<div class="area-scrim"');
    expect(html).not.toMatch(/<button[^>]*area-scrim/);
  });

  it('wraps focus at both ends, since the board behind is inert', () => {
    // App marks the board `inert` while this is open, so without these the next
    // Tab left the document entirely for the browser's own chrome.
    const html = draw({ area: 'account', section: 'github' });
    expect(html.match(/<span tabindex="0" aria-hidden="true">/g)).toHaveLength(2);
  });
});

describe('the board’s chrome stays on the board (#712)', () => {
  it('is asserting markers the shell really emits', () => {
    // Guards the sweep below: a mistyped needle is absent from every render and
    // would let the rule pass while proving nothing.
    const shell = APP_SOURCE + SIDE_ACCOUNT_SOURCE + TOPBAR_SOURCE;
    for (const [what, needle] of CHROME) expect(shell, what).toContain(needle);
  });

  it.each(CHROME)('draws no %s inside the panel', (_what, needle) => {
    for (const panel of [
      { area: 'admin', section: 'access' },
      { area: 'account', section: 'github' },
      { area: 'docs' },
    ] as Panel[]) {
      expect(draw(panel), needle).not.toContain(needle);
    }
  });
});

describe('a session that dies behind the panel says so, in the panel (#741)', () => {
  const GITHUB: Panel = { area: 'account', section: 'github' };

  it('says nothing while the session is live', () => {
    expect(draw(GITHUB)).not.toContain('session-bar');
  });

  it('tells the reader their session ended without making them close the panel first', () => {
    // The panel's own content starts failing on 401s at that moment, so a
    // reader with no notice sees things break and no reason why. #512 forbids
    // the other cure — swapping the tree for a gate would throw away
    // whatever the reader has half done in this very panel.
    const html = draw(GITHUB, DEAD);
    expect(html).toContain('Your session ended');
    expect(html).toContain('Nothing on this page is live until you sign in again');
  });

  it('puts the way back INSIDE the panel, which is the only place either hand can reach', () => {
    // `.shell-main` is `inert` and `.area-scrim` covers the viewport at z-41,
    // so a Sign in button anywhere else is neither clickable nor tabbable —
    // measured on the live board, `elementFromPoint` at its centre answered
    // `DIV.area-scrim`. Markup order is the claim here: the bar opens after
    // the panel's own container, so it is inside the focus wrap and above the
    // scrim by construction rather than by a z-index anyone has to maintain.
    const html = draw(GITHUB, DEAD);
    const panelAt = html.indexOf('class="area-panel"');
    const barAt = html.indexOf('session-bar');
    const wrapAt = html.lastIndexOf('<span tabindex="0" aria-hidden="true">');
    expect(panelAt).toBeGreaterThan(-1);
    expect(barAt).toBeGreaterThan(panelAt);
    expect(barAt).toBeLessThan(wrapAt);
    expect(html).toContain('Sign in');
  });

  it('is announced, so a reader who never looks up is still told', () => {
    expect(draw(GITHUB, DEAD)).toContain('role="alert"');
  });

  it('still draws exactly one close control while the notice is up', () => {
    // The fix that was tried and rejected raised `.shell-top-alert` above the
    // panel, and the top bar rose with it and covered the X. A notice that
    // costs the reader the way out is worse than the defect.
    expect(draw(GITHUB, DEAD).match(/area-panel-close/g)).toHaveLength(1);
    expect(draw(GITHUB, DEAD).match(/class="area-panel-head"/g)).toHaveLength(1);
  });

  it('is reading app.css, not an empty string', () => {
    // The rule below is absent from '' too, so without this it would agree
    // with an empty read about nothing and pass.
    expect(APP_CSS.length).toBeGreaterThan(1000);
    expect(APP_CSS).toContain('.area-panel-close {');
  });

  it('hangs the X off the frame below the notice, not off the panel', () => {
    // `.area-panel-head` is absolutely placed in a corner, so whichever box is
    // its containing block decides whether it lands ON the notice or under it.
    // `.area-panel` is `position: fixed`, so without a positioned frame in
    // between the X floats over the bar. Where it actually lands is a browser
    // question and `scripts/check-expired-panel.mjs` answers it; this only
    // holds the containing block in place.
    expect(APP_CSS).toMatch(/\.area-panel-frame\s*\{[^}]*position:\s*relative/);
  });

  it('is the ONLY notice while the panel is up, so the shell draws none behind it', () => {
    // The review's P1. `inert` and the scrim were the argument for leaving the
    // shell's copy in the markup: neither takes it off the glass. Measured in
    // Chrome at 1280, where the panel is inset, 46px of the shell's 65px bar
    // and the whole of its Sign in button sat in the right gutter — and
    // `elementFromPoint` at (1222, 32) answered `DIV.area-scrim`, whose handler
    // is `onClose`. A reader pressing the visible button lost their panel.
    // `scripts/check-expired-panel.mjs` counts the bars in a real browser; this
    // holds the condition that produces the count.
    expect(APP_SOURCE).toMatch(/\{!panel && <SessionNotice/);
  });

  it('lands the reader on the X and not on the way out of the document', () => {
    // The review's P2. With the notice first in the panel's markup, a mount
    // landing that asks the whole panel for its first control lands on Sign in,
    // and `onSignIn` is `beginLogin` — it sets `window.location.href`, so a
    // habitual Enter after opening leaves for Google. The landing scans the
    // FRAME, which starts below the notice; the wrap sentinels still ask for
    // the whole panel, so Tab off the end comes back to the notice.
    //
    // Markup order is what makes both true, and it is the half a static render
    // can hold. Where focus actually lands is a browser question and
    // `scripts/check-expired-panel.mjs` answers it, on a panel REOPENED while
    // the session is already dead — the only state where the notice is there
    // from the first frame.
    const html = draw(GITHUB, DEAD);
    expect(html.indexOf('session-bar')).toBeLessThan(html.indexOf('area-panel-frame'));
    expect(PANEL_SOURCE).toContain("focusEdge(frame.current, 'first', box.current)");
    expect(PANEL_SOURCE).toContain("const wrapToFirst = useCallback(() => focusEdge(box.current, 'first')");
    expect(PANEL_SOURCE).toContain("const wrapToLast = useCallback(() => focusEdge(box.current, 'last')");
  });

  it('is wired: App hands the panel the session and the way back', () => {
    // A component that can draw the notice and a shell that never passes it
    // one is the same defect with more code.
    expect(APP_SOURCE).toMatch(/<AreaPanel[^>]*session=\{session\}/s);
    expect(APP_SOURCE).toMatch(/<AreaPanel[^>]*onSignIn=\{beginLogin\}/s);
  });
});

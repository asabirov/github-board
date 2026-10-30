/**
 * The sidebar-header theme switch (#322). Board is dark-first, but a viewer can
 * flip to light from here — the control that #320 removed, restored next to the
 * `board.` wordmark where the DoD asks for it.
 *
 * Still a 2-way toggle, not the kit's 3-way light/dark/system cycle. #322 argued
 * that a "system" stop no one asked for is a mode to explain; #449 shows someone
 * did ask for it, so the board now HAS a system theme — it just isn't a stop in
 * this one-button cycle, where a third unlabelled state really is hard to read.
 * The place that names it is Preferences, where the three choices are visible and
 * labelled. Here the icon keeps naming the theme you'll switch TO — a sun while
 * dark, a moon while light.
 *
 * While the theme is `system` a click PINS: it leaves system and fixes the board
 * on the opposite of what's currently showing. The tooltip says so, because a
 * click that silently drops you out of "follow the OS" is the one state a
 * two-way toggle can't express on its own. Preferences reflects it at once, because
 * both read the one store in `theme.ts`.
 *
 * Quiet chrome by design: secondary ink, hover lifts to elevated — present but
 * never a call to action. (Tertiary read as invisible against the near-black
 * sidebar; secondary is the quietest weight that still reads in dark.)
 * `setTheme` writes `board_theme` and sets `data-theme` on `<html>`;
 * `startTheme` seeds the key to dark on a first visit so the default stays dark.
 */

import { MoonIcon, SunIcon } from './icons';
import { setTheme, useTheme } from './theme';
import { Tip } from './ui/Tip';

/** What a click will do, said in full — including that it leaves system. */
export function themeSwitchLabel(theme: string, next: 'light' | 'dark'): string {
  return theme === 'system'
    ? `Switch to ${next} theme and stop following the system`
    : `Switch to ${next} theme`;
}

export function ThemeSwitch() {
  // `resolvedTheme` follows an OS flip while the theme is system, which keeps the
  // icon and the tooltip honest.
  const { theme, resolvedTheme: showing } = useTheme();
  const next = showing === 'dark' ? 'light' : 'dark';
  const label = themeSwitchLabel(theme, next);

  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={() => setTheme(next)}
        aria-label={label}
        className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-lg text-dim transition-colors hover:bg-elevated hover:text-fg"
      >
        {showing === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      </button>
    </Tip>
  );
}

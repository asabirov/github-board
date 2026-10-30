/**
 * Account › Preferences (#346). Personal daily goal and per-device theme and
 * display timezone. Display settings persist client-side (localStorage): theme and accent
 * through `theme.ts` (same store the header switch writes), timezone through
 * `prefs.ts`. Theme offers Auto, Light and Dark (#449; Auto is stored as `system`
 * and follows the OS live), then one preview per accent (#1450). The timezone
 * shifts the board's absolute date-times (token expiry,
 * the audit log's exact timestamps, the ">7d" date fallback); relative times
 * ("3d", "Synced 5m ago") are durations from now, so they don't change.
 */

import { ReactNode } from 'react';
import { PageHeading, PAGE_READING } from '../ui/PageHeading';
import { GoalEditor } from '../goals/GoalSettings';
import { personalGoalPath } from '../goals/goals';
import { SettingsHelp } from './SettingsHelp';
import { ACCOUNT_LABEL } from './sections';
import { ACCENTS, setAccent, setTheme, useAccent, useTheme, type Accent, type ThemeChoice } from '../theme';
import { BLOCK } from '../ui/block';
import { ACCOUNT_RAIL } from './layout';
import {
  COMMON_TIMEZONES,
  setTimezone,
  systemTimezone,
  usePreferredTimezone,
} from './prefs';

const ROOT = ACCOUNT_RAIL;

/** Keep each control directly below its label at every width. */
function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={`${BLOCK} flex flex-col items-start gap-3 px-5 py-4`}>
      <div className="text-[13.5px] font-semibold text-fg">{label}</div>
      <div className="w-full min-w-0 flex-none">{children}</div>
    </div>
  );
}

const THEME_CHOICES = [
  { id: 'system', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
] as const;

// The selected mode is said by its label, in brand blue, on a brand tint that
// barely registers as a fill (1.23:1 against its track in dark, 1.05:1 in light).
// Artur picked that over a solid fill. So unselected labels sit at text-disabled,
// which differs from the lit label in lightness, not only in hue.
const SEG_TRACK = 'inline-flex rounded-lg bg-[var(--board-well)] p-0.5';
const SEG_BUTTON = 'cursor-pointer rounded-md px-3.5 py-1 text-[12.5px] transition-colors';
const SEG_ON = 'bg-accent-fill text-accent';
const SEG_OFF = 'text-muted hover:text-muted';

const ACCENT_LABEL = { nebula: 'Nebula', phoenix: 'Phoenix', ocean: 'Ocean', emerald: 'Emerald' } as const;

/** A small board with no words: rail, header bar and three cards, painted in one accent.
 *  The surfaces read the root tokens, so a preview follows the mode on screen. */
function AccentPreview({ accent }: { accent: Accent }) {
  return (
    <span className="theme-preview flex h-[72px] w-full overflow-hidden rounded-md bg-bg" data-accent={accent} aria-hidden="true">
      <span className="flex w-1/5 flex-col gap-1 bg-surface p-1.5">
        <span className="h-1.5 rounded-sm bg-[var(--preview-accent)]" />
        <span className="h-1.5 rounded-sm bg-[var(--board-well)]" />
        <span className="h-1.5 rounded-sm bg-[var(--board-well)]" />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 p-1.5">
        <span className="h-2 rounded-sm bg-surface" />
        <span className="grid flex-1 grid-cols-3 gap-1.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex flex-col justify-end rounded-sm bg-surface p-1">
              <span className="h-1 rounded-full bg-[var(--preview-accent)]" style={{ width: `${40 + i * 20}%` }} />
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

/** The mode control, then one preview per accent. A click restyles the board at once. */
export function ThemeOptions({ theme, accent }: { theme: ThemeChoice; accent: Accent }) {
  return (
    <div className="flex flex-col gap-3">
      <div className={`${SEG_TRACK} self-start`}>
        {THEME_CHOICES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setTheme(c.id)}
            aria-pressed={theme === c.id}
            className={`${SEG_BUTTON} ${theme === c.id ? SEG_ON : SEG_OFF}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {ACCENTS.map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => setAccent(a)}
            aria-pressed={accent === a}
            aria-label={ACCENT_LABEL[a]}
            title={ACCENT_LABEL[a]}
            className={`cursor-pointer rounded-lg border border-line p-1 outline-offset-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent ${accent === a ? 'outline outline-2 outline-accent' : ''}`}
          >
            <AccentPreview accent={a} />
          </button>
        ))}
      </div>
    </div>
  );
}

function ThemeControl() {
  // Selection tracks the stored choice, not what it resolves to: Auto is its own answer.
  const { theme } = useTheme();
  return <ThemeOptions theme={theme} accent={useAccent()} />;
}

function TimezoneControl() {
  const tz = usePreferredTimezone();
  const sys = systemTimezone();
  // The system zone is always offered (as the default), plus the curated list —
  // deduped so the browser's own zone isn't repeated in the body.
  const zones = COMMON_TIMEZONES.filter((z) => z !== sys);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <select
        aria-label="Timezone"
        value={tz}
        onChange={(e) => setTimezone(e.target.value)}
        className="h-9 cursor-pointer rounded-[9px] border border-line bg-[var(--board-well)] px-3 text-[13px] text-fg outline-none focus:border-accent"
      >
        <option value="">System ({sys})</option>
        {[sys, ...zones].map((z) => (
          <option key={z} value={z}>{z}</option>
        ))}
      </select>

    </div>
  );
}

export function PreferencesView() {
  return (
    <div className={ROOT}>
      {/* The settings column is left-aligned inside the rail (#450), so the
          breadcrumb and H1 keep the same left origin as every other page. */}
      <div className={PAGE_READING}>
        {/* The big H1 "Preferences" is the page identity (#391); the panel's
            rail says "Account" above it. */}
        <div className="mb-6 flex items-center gap-1"><PageHeading>{ACCOUNT_LABEL.preferences}</PageHeading><SettingsHelp label="Preferences" text="Theme and timezone stay on this device. Flame levels are saved to your account." /></div>
        <div className="flex flex-col gap-3">
          <Setting label="Theme">
            <ThemeControl />
          </Setting>
          <Setting label="Timezone">
            <TimezoneControl />
          </Setting>
          <Setting label="Flame levels">
            <GoalEditor path={personalGoalPath} />
          </Setting>
        </div>

      </div>
    </div>
  );
}

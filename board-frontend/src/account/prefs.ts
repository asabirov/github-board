/**
 * Client-side preferences (#346). Theme already persists via the kit's `useTheme`
 * (localStorage `board_theme`); this adds the display timezone (`board_timezone`)
 * the same way — per-device, no backend. An empty value means "system" (the
 * browser's zone). A tiny external store so any component rendering an absolute
 * date re-renders live when the timezone changes on the Preferences page.
 *
 * The same choice determines calendar-day metrics and absolute timestamps.
 * Relative durations such as "3d" remain independent of the zone.
 */
import { useSyncExternalStore } from 'react';

const TZ_KEY = 'board_timezone';
/** The board's old timezone key, read once as a fallback so a saved choice
 *  survives the rename (#1450). */
const LEGACY_TZ_KEY = 'lessly_timezone';
const listeners = new Set<() => void>();

/** Carry a saved timezone over from `lessly_timezone` once: read the old key,
 *  write the new one, remove the old one. Nothing is written when the new key
 *  already holds a value. */
function migrateTimezone(): void {
  try {
    if (localStorage.getItem(TZ_KEY) !== null) return;
    const legacy = localStorage.getItem(LEGACY_TZ_KEY);
    if (legacy === null) return;
    localStorage.setItem(TZ_KEY, legacy);
    localStorage.removeItem(LEGACY_TZ_KEY);
  } catch {
    // ignore — a device without storage just stays on system time
  }
}

export function getTimezone(): string {
  try {
    migrateTimezone();
    return localStorage.getItem(TZ_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setTimezone(tz: string): void {
  try {
    if (tz) localStorage.setItem(TZ_KEY, tz);
    else localStorage.removeItem(TZ_KEY);
  } catch {
    // ignore — a device without storage just stays on system time
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The chosen display timezone ('' = the browser's system zone), reactive. */
export function usePreferredTimezone(): string {
  return useSyncExternalStore(subscribe, getTimezone, () => '');
}

/** '' → undefined, so Intl falls back to the system zone. */
function zone(tz: string): string | undefined {
  return tz || undefined;
}

/** An absolute date in the chosen zone — "12 Nov 2025". */
export function formatDate(iso: string, tz: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: zone(tz),
  });
}

/** An absolute date + time in the chosen zone — "12 Nov 2025, 14:30". */
export function formatDateTime(iso: string, tz: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: zone(tz),
  });
}

/** The browser's own IANA zone (for the "System" label). */
export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A curated set of common zones for the dropdown — enough to be useful without a
 *  400-entry IANA wall. The browser's own zone is always included (added in the
 *  view), and "System" (empty value) leads. */
export const COMMON_TIMEZONES: string[] = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Moscow',
  'Europe/Istanbul',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'America/Sao_Paulo',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
];

/** Resolve the existing device preference before requesting calendar-day metrics. */
export function resolvedTimezone(preference = getTimezone()): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: preference || systemTimezone() }).resolvedOptions().timeZone;
  } catch {
    return systemTimezone();
  }
}

export function useResolvedTimezone(): string {
  return resolvedTimezone(usePreferredTimezone());
}

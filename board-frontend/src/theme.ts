/**
 * The theme and the accent, kept per browser (#449, #1450).
 *
 * The board owns this store since #1450. The public kit ships only the tokens, which follow
 * `<html data-theme data-accent>`. So this file writes those two attributes and keeps the
 * choice in `board_theme` and `board_accent`.
 *
 * Same convention as before: an OS that expresses no preference reads as dark, so the
 * board's dark-first default survives a device with nothing configured.
 */
import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type Accent = 'nebula' | 'phoenix' | 'ocean' | 'emerald';

export const THEME_KEY = 'board_theme';
export const ACCENT_KEY = 'board_accent';

const THEMES: readonly string[] = ['system', 'light', 'dark'];
export const ACCENTS: readonly Accent[] = ['nebula', 'phoenix', 'ocean', 'emerald'];
const LIGHT_QUERY = '(prefers-color-scheme: light)';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A browser without storage keeps the choice for this page only.
  }
}

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage, with a browser without storage read as empty. */
const safeStorage: ThemeStorage = { getItem: read, setItem: write };

function validTheme(value: string | null): ThemeChoice {
  return THEMES.includes(value as string) ? (value as ThemeChoice) : 'system';
}

/** The kit's old theme key, read once as a fallback so a viewer keeps their
 *  saved choice across the rename. */
export const LEGACY_THEME_KEY = 'lepsto_theme';


/** The stored theme, board's key first. Nothing stored reads as `system`. */
export function readStoredTheme(storage: ThemeStorage): ThemeChoice {
  return validTheme(storage.getItem(THEME_KEY) ?? storage.getItem(LEGACY_THEME_KEY));
}

/**
 * Seed the board's key once, carrying a saved choice across from `lepsto_theme`.
 * Dark-first (#322): nothing stored anywhere lands on `dark`, not the OS.
 */
export function seedStoredTheme(storage: ThemeStorage): ThemeChoice {
  const current = storage.getItem(THEME_KEY);
  if (current !== null) return validTheme(current);
  const carried = storage.getItem(LEGACY_THEME_KEY);
  const seeded = carried ?? 'dark';
  try {
    storage.setItem(THEME_KEY, seeded);
  } catch {
    // storage unavailable — the board is dark by default regardless
  }
  return validTheme(seeded);
}

/** Subscribes to OS appearance changes; returns the unsubscribe. */
export function subscribeToSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(LIGHT_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** The OS appearance right now. No preference, or no matchMedia, reads as dark. */
export function readSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
}

export function readTheme(): ThemeChoice {
  return readStoredTheme(safeStorage);
}

export function readAccent(): Accent {
  const stored = read(ACCENT_KEY);
  return ACCENTS.find((a) => a === stored) ?? 'nebula';
}

export function resolveTheme(theme: ThemeChoice): 'light' | 'dark' {
  return theme === 'system' ? readSystemTheme() : theme;
}

/** Paints the stored choice on `<html>`. Nebula is the kit's default, so it sets no attribute. */
export function applyTheme(): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(readTheme());
  const accent = readAccent();
  if (accent === 'nebula') delete root.dataset.accent;
  else root.dataset.accent = accent;
}

/**
 * Runs once on boot, before the first render.
 *
 * A first visit gets an explicit `dark`, because the board is dark-first (#322, #449). The
 * seed stays: macOS and Windows always report light or dark, so letting System decide would
 * hand a light-mode laptop a light board. A viewer opts into System on Preferences.
 *
 * `seedStoredTheme` carries a saved choice from `lepsto_theme` before it seeds. The old key
 * stays, so a rollback still finds it.
 */
export function startTheme(): void {
  seedStoredTheme(safeStorage);
  applyTheme();
  subscribeToSystemTheme(() => {
    if (readTheme() === 'system') applyTheme();
  });
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY || e.key === ACCENT_KEY) {
      applyTheme();
      notify();
    }
  });
}

/**
 * Cross-fades the colours for one switch. The kit has motion tokens but no theme
 * transition, so `app.css` gives `.theme-fade` a colour transition on `--dur-med`,
 * and only without reduced motion. The class goes once the fade ends, so no other
 * colour change on the page animates.
 */
let fadeTimer: ReturnType<typeof setTimeout> | undefined;
function fade(): void {
  const root = document.documentElement;
  root.classList.add('theme-fade');
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => root.classList.remove('theme-fade'), 300);
}

export function setTheme(theme: ThemeChoice): void {
  write(THEME_KEY, theme);
  fade();
  applyTheme();
  notify();
}

export function setAccent(accent: Accent): void {
  write(ACCENT_KEY, accent);
  fade();
  applyTheme();
  notify();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const off = subscribeToSystemTheme(onChange);
  return () => {
    listeners.delete(onChange);
    off();
  };
}

/** The stored theme and what it shows now. Both stay live through an OS flip. */
export function useTheme(): { theme: ThemeChoice; resolvedTheme: 'light' | 'dark' } {
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'dark' as ThemeChoice);
  const resolvedTheme = useSyncExternalStore(subscribe, () => resolveTheme(readTheme()), () => 'dark' as const);
  return { theme, resolvedTheme };
}

export function useAccent(): Accent {
  return useSyncExternalStore(subscribe, readAccent, () => 'nebula' as Accent);
}

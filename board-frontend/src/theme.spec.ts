/**
 * The System theme's two moving parts (#449): reading the OS appearance, and
 * subscribing so an OS flip re-renders anything that names the resolved theme.
 * Then the board's own store (#1450): the key carry, the dark seed and the accent.
 * The test env is `node`, so window, matchMedia, storage and `<html>` are stubbed per case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSystemTheme, readStoredTheme, seedStoredTheme, setAccent, startTheme, subscribeToSystemTheme, THEME_KEY, LEGACY_THEME_KEY } from './theme';
import { themeSwitchLabel } from './ThemeSwitch';

type Listener = () => void;

function stubMatchMedia(lightMatches: boolean) {
  const listeners: Listener[] = [];
  const mql = {
    matches: lightMatches,
    addEventListener: (_: string, cb: Listener) => { listeners.push(cb); },
    removeEventListener: (_: string, cb: Listener) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  (globalThis as { window?: unknown }).window = { matchMedia: () => mql };
  return listeners;
}

afterEach(() => {
  const g = globalThis as { window?: unknown; localStorage?: unknown; document?: unknown };
  delete g.window;
  delete g.localStorage;
  delete g.document;
});

/** A browser with the given keys stored and the OS in dark. */
function stubBrowser(stored: Record<string, string>) {
  const store = new Map(Object.entries(stored));
  const dataset: Record<string, string> = {};
  const g = globalThis as { window?: unknown; localStorage?: unknown; document?: unknown };
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  const classes = new Set<string>();
  g.document = { documentElement: { dataset, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } } };
  const osListeners = stubMatchMedia(false);
  (g.window as { addEventListener?: unknown }).addEventListener = () => {};
  return { store, dataset, classes, osListeners };
}

describe('readSystemTheme (#449)', () => {
  it('reads light when the OS asks for light', () => {
    stubMatchMedia(true);
    expect(readSystemTheme()).toBe('light');
  });

  it('reads dark when the OS does not ask for light', () => {
    stubMatchMedia(false);
    expect(readSystemTheme()).toBe('dark');
  });

  it('falls back to dark with no matchMedia — the board stays dark-first', () => {
    expect(readSystemTheme()).toBe('dark');
  });
});

describe('subscribeToSystemTheme (#449)', () => {
  it('notifies on an OS change and detaches on unsubscribe', () => {
    const listeners = stubMatchMedia(false);
    const onChange = vi.fn();
    const off = subscribeToSystemTheme(onChange);
    expect(listeners).toHaveLength(1);

    listeners[0]();
    expect(onChange).toHaveBeenCalledTimes(1);

    off();
    expect(listeners).toHaveLength(0);
  });

  it('is a no-op without matchMedia rather than throwing', () => {
    expect(() => subscribeToSystemTheme(() => {})()).not.toThrow();
  });
});

describe('themeSwitchLabel (#449)', () => {
  it('names the theme a click moves to', () => {
    expect(themeSwitchLabel('dark', 'light')).toBe('Switch to light theme');
    expect(themeSwitchLabel('light', 'dark')).toBe('Switch to dark theme');
  });

  it('says the click stops following the system while the theme is system', () => {
    expect(themeSwitchLabel('system', 'light')).toBe(
      'Switch to light theme and stop following the system',
    );
  });
});

describe('startTheme (#1450)', () => {
  it('repaints an OS flip while the choice is System', () => {
    const { dataset, osListeners } = stubBrowser({ board_theme: 'system' });
    startTheme();
    expect(dataset.theme).toBe('dark');
    stubMatchMedia(true);
    osListeners.forEach((l) => l());
    expect(dataset.theme).toBe('light');
  });
});

describe('setAccent (#1450)', () => {
  it('sets data-accent, and Nebula removes it because it is the kit default', () => {
    const { store, dataset } = stubBrowser({ board_theme: 'dark' });
    setAccent('ocean');
    expect(store.get('board_accent')).toBe('ocean');
    expect(dataset.accent).toBe('ocean');
    setAccent('nebula');
    expect(dataset.accent).toBeUndefined();
  });

  it('cross-fades the switch, then drops the fade class', () => {
    vi.useFakeTimers();
    const { classes } = stubBrowser({ board_theme: 'dark' });
    setAccent('phoenix');
    expect(classes.has('theme-fade')).toBe(true);
    vi.runAllTimers();
    expect(classes.has('theme-fade')).toBe(false);
    vi.useRealTimers();
  });
});

describe('the stored theme key (#1450)', () => {
  function fakeStorage(entries: Record<string, string | null> = {}) {
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(entries)) {
      if (value !== null) map.set(key, value);
    }
    return {
      map,
      getItem(key: string): string | null {
        return map.has(key) ? map.get(key)! : null;
      },
      setItem(key: string, value: string): void {
        map.set(key, value);
      },
    };
  }

  it('seeds the board key to dark on a first visit', () => {
    const storage = fakeStorage();
    expect(seedStoredTheme(storage)).toBe('dark');
    expect(storage.map.get(THEME_KEY)).toBe('dark');
  });

  it('carries a saved choice from the old key forward once', () => {
    const storage = fakeStorage({ [LEGACY_THEME_KEY]: 'light' });
    expect(seedStoredTheme(storage)).toBe('light');
    expect(storage.map.get(THEME_KEY)).toBe('light');
  });

  it('reads no key other than the board key and the old key', () => {
    const storage = fakeStorage();
    const read: string[] = [];
    const getItem = storage.getItem;
    storage.getItem = (key) => (read.push(key), getItem(key));
    seedStoredTheme(storage);
    expect(read).toEqual([THEME_KEY, LEGACY_THEME_KEY]);
  });

  it('prefers the board key over the old key when both exist', () => {
    const storage = fakeStorage({ [THEME_KEY]: 'dark', [LEGACY_THEME_KEY]: 'light' });
    expect(seedStoredTheme(storage)).toBe('dark');
    expect(readStoredTheme(storage)).toBe('dark');
  });

  it('reads the old key once when the board key is unset', () => {
    const storage = fakeStorage({ [LEGACY_THEME_KEY]: 'light' });
    expect(readStoredTheme(storage)).toBe('light');
  });
});

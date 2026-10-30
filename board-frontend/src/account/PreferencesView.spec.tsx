import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeOptions } from './PreferencesView';

const pressed = (html: string) => [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>/g)]
  .map(([tag, on]) => [tag.match(/aria-label="([^"]+)"/)?.[1] ?? '', on]);

describe('Preferences theme block (#1450)', () => {
  it('shows Auto, Light and Dark, then one wordless preview per accent', () => {
    const html = renderToStaticMarkup(<ThemeOptions theme="system" accent="ocean" />);
    expect(html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean)).toEqual(['Auto', 'Light', 'Dark']);
    expect(pressed(html)).toEqual([
      ['', 'true'], ['', 'false'], ['', 'false'],
      ['Nebula', 'false'], ['Phoenix', 'false'], ['Ocean', 'true'], ['Emerald', 'false'],
    ]);
  });

  it('marks the stored mode, not the one it resolves to', () => {
    const html = renderToStaticMarkup(<ThemeOptions theme="light" accent="nebula" />);
    expect(pressed(html).map(([, on]) => on)).toEqual(['false', 'true', 'false', 'true', 'false', 'false', 'false']);
  });
});

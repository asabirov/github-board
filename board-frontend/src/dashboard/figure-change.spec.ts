import { describe, expect, it } from 'vitest';
import { changeAgainst, figureChange, TONE_CLASS, type Tone } from './figure-change';
import { LAG_AGAINST, lagDays } from './OrgLagTrend';
import { THROUGHPUT_AGAINST } from './Pulse';
import { contrast, rgb, themeTokens, THEMES } from '../../test/kit-contrast';

describe('an Overview figure’s change says better or worse, not up or down (#1029)', () => {
  it('reads a rise as better where more is better, and as worse where less is', () => {
    expect(figureChange(3, 'up')).toEqual({ text: '+3', tone: 'better' });
    expect(figureChange(-3, 'up')).toEqual({ text: '−3', tone: 'worse' });
    expect(figureChange(2, 'down')).toEqual({ text: '+2', tone: 'worse' });
    expect(figureChange(-2, 'down')).toEqual({ text: '−2', tone: 'better' });
  });

  it('signs a figure with no better direction and draws it quiet', () => {
    expect(figureChange(9, null)).toEqual({ text: '+9', tone: 'neutral' });
    expect(figureChange(-9, null)).toEqual({ text: '−9', tone: 'neutral' });
  });

  it('calls no change neutral, whichever way is better', () => {
    for (const better of ['up', 'down', null] as const) {
      expect(figureChange(0, better)).toEqual({ text: '±0', tone: 'neutral' });
    }
  });

  it('carries the direction in the sign, never in the colour alone', () => {
    expect(figureChange(-1, 'up').text.startsWith('−')).toBe(true);
    expect(figureChange(1, 'up').text.startsWith('+')).toBe(true);
  });

  it('draws the magnitude through the caller’s own rounding', () => {
    expect(figureChange(-2.84, 'down', lagDays)).toEqual({ text: '−2.8', tone: 'better' });
    expect(figureChange(0.5, 'down', lagDays)).toEqual({ text: '+0.5', tone: 'worse' });
  });

  it('says what the delta is measured against, in days (#1170 review)', () => {
    expect(changeAgainst('+6', THROUGHPUT_AGAINST)).toBe('+6 compared with the previous 7 days.');
    expect(changeAgainst('−2.8', LAG_AGAINST)).toBe('−2.8 compared with the previous 90 days.');
    // The sign survives the sentence: a reader who hears it is told the
    // direction as well as the period, which is the whole of what the retired
    // caption and the coloured delta said between them.
    expect(changeAgainst(figureChange(-5, 'up').text, THROUGHPUT_AGAINST)).toBe('−5 compared with the previous 7 days.');
  });
});

describe('the change inks read on the card (#1029)', () => {
  // 12px semibold is small text, so 4.5:1 and not the 3:1 a large figure gets.
  it.each(THEMES)('clears 4.5:1 against the card in %s', (theme) => {
    const tokens = themeTokens(theme);
    const card = rgb(tokens['--surface']);
    for (const tone of ['better', 'worse', 'neutral'] as Tone[]) {
      // The board preset in tailwind.config.ts names these two hues by role.
      const name = TONE_CLASS[tone].replace(/^text-/, '');
      const token = `--${({ success: 'chip-success-ink', danger: 'pink' } as Record<string, string>)[name] ?? name}`;
      expect(tokens[token], `${token} is not a kit token`).toBeDefined();
      expect(contrast(rgb(tokens[token]), card), `${tone} (${token}) in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

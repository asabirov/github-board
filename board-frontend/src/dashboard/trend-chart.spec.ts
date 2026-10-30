import { describe, expect, it } from 'vitest';
import { weekAgoLabel, weekTipText } from './trend-chart';

describe('trend chart hover text (#421)', () => {
  it('labels the trailing week "this week", earlier weeks "N weeks ago"', () => {
    expect(weekAgoLabel(0)).toBe('this week');
    expect(weekAgoLabel(1)).toBe('1 week ago');
    expect(weekAgoLabel(11)).toBe('11 weeks ago');
  });

  it('formats the hover chip text with both series', () => {
    expect(weekTipText(0, 5, 2)).toBe('this week, 5 closed and 2 opened');
    expect(weekTipText(3, 0, 0)).toBe('3 weeks ago, 0 closed and 0 opened');
  });
});

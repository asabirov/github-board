import { describe, expect, it } from 'vitest';
import { smoothPath } from './smooth-path';

describe('smoothPath', () => {
  it('is empty for no points', () => {
    expect(smoothPath([])).toBe('');
  });

  it('a single point is a move, with nothing to curve to', () => {
    expect(smoothPath([[3, 9]])).toBe('M3 9');
  });

  it('joins each pair with a cubic segment, so a series of n points draws n−1 curves', () => {
    const d = smoothPath([[0, 10], [10, 0], [20, 10]]);
    expect(d.startsWith('M0 10')).toBe(true);
    expect(d.match(/ C/g)).toHaveLength(2);
    expect(d.endsWith('20.0 10.0')).toBe(true);
  });
});

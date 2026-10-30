import { describe, expect, it } from 'vitest';
import { requestedTimeZone } from './issues-metrics.controller';

describe('requested calendar zone', () => {
  it('uses UTC for clients without a browser preference', () => {
    expect(requestedTimeZone()).toBe('UTC');
  });
  it('accepts IANA zones and rejects invalid input', () => {
    expect(requestedTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(() => requestedTimeZone('invalid/zone')).toThrow('Choose a valid time zone, such as Europe/Berlin.');
  });
});

import { describe, expect, it } from 'vitest';
import { isReturnTarget } from './return-to';

describe('isReturnTarget', () => {
  it('accepts same-app deep links', () => {
    expect(isReturnTarget('/roadmap/C3/goal/o31')).toBe(true);
    expect(isReturnTarget('/roadmap/C3/kr/C3-KR5?root=acme')).toBe(true);
    expect(isReturnTarget('/team?root=keitaro')).toBe(true);
  });

  it('rejects the bare landing path — nothing to restore', () => {
    expect(isReturnTarget('/')).toBe(false);
  });

  it('rejects anything that could leave the app (open-redirect guard)', () => {
    expect(isReturnTarget('//evil.example/phish')).toBe(false);
    expect(isReturnTarget('https://evil.example/')).toBe(false);
    expect(isReturnTarget('javascript:alert(1)')).toBe(false);
    expect(isReturnTarget('roadmap/C3')).toBe(false);
  });

  it('rejects non-strings from storage', () => {
    expect(isReturnTarget(null)).toBe(false);
    expect(isReturnTarget(undefined)).toBe(false);
    expect(isReturnTarget(42)).toBe(false);
  });
});

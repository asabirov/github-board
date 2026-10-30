import { describe, expect, it } from 'vitest';
import { EmptyDerivedLoginsSource } from './derived-logins.source';

describe('EmptyDerivedLoginsSource', () => {
  it('derives nothing, completely — a board with no Github token answers as it did before', async () => {
    // `complete: true` matters: a successful run that found nobody, not a failed
    // one. The service caches it and stops asking.
    expect(await new EmptyDerivedLoginsSource().derive()).toEqual({ map: new Map(), complete: true });
  });
});

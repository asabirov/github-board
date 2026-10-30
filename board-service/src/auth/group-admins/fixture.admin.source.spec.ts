import { describe, expect, it } from 'vitest';
import { FixtureAdminSource } from './fixture.admin.source';

describe('FixtureAdminSource (#143)', () => {
  it('lowercases, trims, and drops blanks from the BOARD_FIXTURE_ADMINS list', async () => {
    const src = new FixtureAdminSource([' Owner ', '', '  ', 'manager']);
    await expect(src.listAdminEmails()).resolves.toEqual(['owner', 'manager']);
  });

  it('an empty list yields no admins', async () => {
    await expect(new FixtureAdminSource(['']).listAdminEmails()).resolves.toEqual([]);
  });
});

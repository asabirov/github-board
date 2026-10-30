import { describe, it, expect } from 'vitest';
import {
  BOARD_READ, BOARD_ADMIN,
  PRESET_SCOPES, expandPreset, deriveLegacyPreset, deriveAgentFlag,
  grantableScopesFor, ungrantableScopes, capToGrantable, grantablePresets,
  type Preset,
} from './scopes';

describe('scope vocabulary (#56)', () => {
  it('agent preset expands to read', () => {
    expect(expandPreset('agent')).toEqual([BOARD_READ]);
  });
  it('full preset expands to read + admin', () => {
    expect(expandPreset('full')).toEqual([BOARD_READ, BOARD_ADMIN]);
  });
  it('PRESET_SCOPES matches expandPreset', () => {
    expect(PRESET_SCOPES.agent).toEqual(expandPreset('agent'));
    expect(PRESET_SCOPES.full).toEqual(expandPreset('full'));
  });
  it('deriveLegacyPreset maps admin-bearing sets to full, else agent', () => {
    expect(deriveLegacyPreset([BOARD_READ])).toBe('agent');
    expect(deriveLegacyPreset([BOARD_READ, BOARD_ADMIN])).toBe('full');
  });
  it('deriveAgentFlag is true for any non-admin scope-set', () => {
    expect(deriveAgentFlag([BOARD_READ])).toBe(true);
    expect(deriveAgentFlag([BOARD_READ, BOARD_ADMIN])).toBe(false);
    expect(deriveAgentFlag([])).toBe(true);
  });
});

describe('who may hold which scope (#545)', () => {
  it('an admin may grant read and admin; anybody else may grant read alone', () => {
    expect(grantableScopesFor(true)).toEqual([BOARD_READ, BOARD_ADMIN]);
    expect(grantableScopesFor(false)).toEqual([BOARD_READ]);
  });

  it('names the scopes an authority may not hold, in request order', () => {
    expect(ungrantableScopes([BOARD_READ, BOARD_ADMIN], false)).toEqual([BOARD_ADMIN]);
    expect(ungrantableScopes([BOARD_READ, BOARD_ADMIN], true)).toEqual([]);
    expect(ungrantableScopes([BOARD_READ], false)).toEqual([]);
    // An unknown scope is nobody's to grant, admin included.
    expect(ungrantableScopes(['board:invent'], true)).toEqual(['board:invent']);
    // TWO ungrantable scopes, deliberately in an order that is NOT sorted order:
    // with a single offender the "request order" half of this test asserts
    // nothing, and `mint` reports `ungrantable[0]` to the person by name.
    expect(ungrantableScopes(['board:zeta', BOARD_ADMIN], false)).toEqual([
      'board:zeta',
      BOARD_ADMIN,
    ]);
  });

  it('caps a request to what the authority may hold', () => {
    expect(capToGrantable([BOARD_READ, BOARD_ADMIN], false)).toEqual([BOARD_READ]);
    expect(capToGrantable([BOARD_READ, BOARD_ADMIN], true)).toEqual([BOARD_READ, BOARD_ADMIN]);
    expect(capToGrantable([BOARD_ADMIN], false)).toEqual([]);
  });

  it('de-duplicates rather than repeating a scope back', () => {
    expect(capToGrantable([BOARD_READ, BOARD_READ], false)).toEqual([BOARD_READ]);
    expect(ungrantableScopes([BOARD_ADMIN, BOARD_ADMIN], false)).toEqual([BOARD_ADMIN]);
  });

  it('a preset is choosable only when its whole expansion is grantable', () => {
    expect(grantablePresets(true)).toEqual(['agent', 'full']);
    expect(grantablePresets(false)).toEqual(['agent']);
  });

  it('offers least privilege first, which is the order the screen renders in', () => {
    // consent-html.ts makes the FIRST entry the primary button. If PRESET_SCOPES
    // is ever reordered, the emphasis on the consent screen moves with it — so
    // the order is asserted here rather than left to the object literal.
    expect(grantablePresets(true)[0]).toBe('agent');
  });

  // The rule is derived, not restated: every preset a caller may choose expands
  // to a subset of what they may hold, and every preset they may not choose does
  // not. This is what makes 'full' un-choosable by a non-admin a CONSEQUENCE of
  // PRESET_SCOPES.full containing BOARD_ADMIN, rather than a second hardcoding
  // that a later edit to PRESET_SCOPES would leave behind.
  //
  // Not in the test matrix, and honestly so: with exactly two presets a
  // hardcoded ['agent'] / ['agent','full'] passes this too. It has no failing
  // mutation TODAY. It exists to fail on the day a third preset is added, which
  // is the only day it could ever matter.
  it('choosable presets follow from the scope sets, for both authorities', () => {
    for (const isAdmin of [true, false]) {
      const allowed = new Set(grantableScopesFor(isAdmin));
      const choosable = new Set(grantablePresets(isAdmin));
      for (const preset of Object.keys(PRESET_SCOPES) as Preset[]) {
        const fits = expandPreset(preset).every((s) => allowed.has(s));
        expect(choosable.has(preset)).toBe(fits);
      }
    }
  });

  // The empty-grant guard, as an invariant on PRESET_SCOPES rather than a branch
  // nobody can reach. `decide` refuses an empty capped set (Task 3) — but that
  // line is unreachable while every preset leaves SOMETHING for a non-admin.
  // This is what fails the day it stops being unreachable: add an admin-only
  // preset to PRESET_SCOPES and this test goes red before the empty grant can
  // ever be minted.
  it('every preset still grants something to every authority (#545 empty-grant guard)', () => {
    for (const isAdmin of [true, false]) {
      for (const preset of Object.keys(PRESET_SCOPES) as Preset[]) {
        expect(capToGrantable(expandPreset(preset), isAdmin).length).toBeGreaterThan(0);
      }
    }
  });
});

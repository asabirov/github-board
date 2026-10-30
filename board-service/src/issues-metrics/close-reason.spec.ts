// The predicate #1014 turns on: which closes this board counts as delivered
// work. Its frontend twin (`board-frontend/src/close-reason.spec.ts`) pins the
// mirrored copy against this one by reading the source file as text, so the two
// specs answer different questions — this one is about the rule, that one is
// about the two implementations of it agreeing.
import { describe, expect, it } from 'vitest';
import { DELIVERED_CLOSE_QUALIFIER, closeReasonOf, deliveredCloseAt, isDeliveredClose, unknownCloseReason, type CloseReason } from './close-reason';

const AT = '2026-09-09T12:00:00.000Z';
const closed = (stateReason: CloseReason) => ({ closedAt: AT, stateReason });

describe('closeReasonOf', () => {
  it('narrows each of Github’s four reasons to itself', () => {
    // The GraphQL enum is COMPLETED | NOT_PLANNED | REOPENED | DUPLICATE, and
    // REST sends the same four lowercased. All four are recognised, so the
    // unrecognised branch below means "new to us" rather than "not bothered
    // with".
    for (const raw of ['completed', 'not_planned', 'duplicate', 'reopened']) {
      expect(closeReasonOf(raw)).toBe(raw);
    }
  });

  it('maps an absent reason to null rather than to completed', () => {
    expect(closeReasonOf(null)).toBeNull();
    expect(closeReasonOf(undefined)).toBeNull();
  });

  it('maps a reason this build does not recognise to null rather than folding it into delivery', () => {
    // The failure this prevents: a mapper written as `raw === 'not_planned' ? …
    // : 'completed'` silently counts every value Github adds next as shipped
    // work, with nothing anywhere saying a new value arrived.
    expect(closeReasonOf('resolved_by_ai')).toBeNull();
  });
});

describe('unknownCloseReason', () => {
  it('fires only for a value Github sent that this build does not know', () => {
    expect(unknownCloseReason('resolved_by_ai')).toBe(true);
  });

  it('does not fire for an absent reason, which is the ordinary state of a source that does not select it', () => {
    // Were this true for null, the log would fire on every row of every source
    // predating the field rather than on the one row worth looking at.
    expect(unknownCloseReason(null)).toBe(false);
    expect(unknownCloseReason(undefined)).toBe(false);
    expect(unknownCloseReason('')).toBe(false);
  });

  it('does not fire for any of the four recognised reasons', () => {
    for (const raw of ['completed', 'not_planned', 'duplicate', 'reopened']) {
      expect(unknownCloseReason(raw)).toBe(false);
    }
  });
});

describe('deliveredCloseAt', () => {
  it('counts a completed close, returning the row’s own instant untouched', () => {
    // Untouched matters: every call site swaps `i.closedAt` for this and keeps
    // its own arithmetic, so a re-derived instant here would be a second answer
    // to what time the close happened.
    expect(deliveredCloseAt(closed('completed'))).toBe(AT);
  });

  it('refuses a not-planned close — the abandonment this change exists to stop counting', () => {
    expect(deliveredCloseAt(closed('not_planned'))).toBeNull();
  });

  it('refuses a duplicate, whose work is already counted under its twin', () => {
    expect(deliveredCloseAt(closed('duplicate'))).toBeNull();
  });

  it('COUNTS a close whose reason we were never told', () => {
    // Deliberate, and the direction most likely to be "tidied" backwards by a
    // later refactor. Unknown means a source that did not select the field or a
    // value Github added after this shipped — not abandonment. Folding it into
    // not-planned would delete real delivered throughput from every historical
    // figure with nothing on screen saying so.
    expect(deliveredCloseAt(closed(null))).toBe(AT);
  });

  it('refuses an open row whatever its reason, so the reason is never consulted for one', () => {
    // `reopened` belongs to an open issue and reaches no counter: the closedAt
    // gate takes it first.
    expect(deliveredCloseAt({ closedAt: null, stateReason: 'reopened' })).toBeNull();
    expect(deliveredCloseAt({ closedAt: null, stateReason: 'completed' })).toBeNull();
  });
});

describe('isDeliveredClose', () => {
  it('agrees with deliveredCloseAt on every reason, so the two cannot drift', () => {
    const reasons: CloseReason[] = ['completed', 'not_planned', 'duplicate', 'reopened', null];
    for (const stateReason of reasons) {
      for (const closedAt of [AT, null]) {
        expect(isDeliveredClose({ closedAt, stateReason })).toBe(deliveredCloseAt({ closedAt, stateReason }) !== null);
      }
    }
  });
});

describe('DELIVERED_CLOSE_QUALIFIER', () => {
  it('spells the qualifier the way Github’s search does, with a hyphen', () => {
    // The API field is `state_reason`; the search qualifier is `reason:` with a
    // HYPHEN in the value. Written once here because a link built from the
    // underscored form returns everything and silently disagrees with the count
    // it sits behind.
    expect(DELIVERED_CLOSE_QUALIFIER).toBe('-reason:not-planned');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { SIGN_OUT_UNCONFIRMED, signOutNotice } from './sign-out-copy';
import { reassuringWordIn } from '../reassuring-words';

const SERVER_SENTENCE =
  'Signed out of this browser, but the revocation was not recorded — a copy of this cookie still works until it expires. Sign out again from another browser where you are still signed in, or ask an admin to revoke the session.';

const handlers = () => ({ leave: vi.fn(), retry: vi.fn(), dismiss: vi.fn() });

describe('what a sign-out puts on screen (#682)', () => {
  it('says nothing at all when the sign-out was clean', () => {
    expect(signOutNotice({ kind: 'clean' }, handlers())).toBeNull();
  });

  it('carries the server’s sentence verbatim when the revocation was refused', () => {
    const notice = signOutNotice({ kind: 'refused', message: SERVER_SENTENCE }, handlers());
    expect(notice?.message).toBe(SERVER_SENTENCE);
  });

  it('cannot be dismissed at all on a refused revocation — the button is the only way out', () => {
    // A reflexive Escape would finish the redirect and take the sentence with
    // it, and it is the one sentence a person has to carry to another browser or
    // to an admin. So there is nothing to dismiss it with: `onDismiss` is null,
    // and the component refuses Escape and the scrim on the strength of that.
    const h = handlers();
    const notice = signOutNotice({ kind: 'refused', message: SERVER_SENTENCE }, h);
    expect(notice?.onDismiss).toBeNull();
    notice?.onAction();
    expect(h.leave).toHaveBeenCalledTimes(1);
    expect(h.retry).not.toHaveBeenCalled();
  });

  it('never redirects when the sign-out was unconfirmed — that is what signs them back in', () => {
    // The request never reached the handler, so no cookie was cleared. '/' would
    // find it still good and re-mount the signed-in board with nothing said.
    const h = handlers();
    const notice = signOutNotice({ kind: 'unconfirmed' }, h);
    expect(notice?.message).toBe(SIGN_OUT_UNCONFIRMED);
    notice?.onAction();
    notice?.onDismiss?.();
    expect(h.leave).not.toHaveBeenCalled();
    expect(h.retry).toHaveBeenCalledTimes(1);
    expect(h.dismiss).toHaveBeenCalledTimes(1);
  });

  it('writes down neither server sentence — there are two, and a third is coming', () => {
    for (const words of [SIGN_OUT_UNCONFIRMED, signOutNotice({ kind: 'unconfirmed' }, handlers())!.action]) {
      expect(words).not.toContain('Signed out of this browser');
      expect(words).not.toContain('revocation');
    }
  });

  it('spends no reassuring word on the one sentence the board owns here', () => {
    expect(reassuringWordIn(SIGN_OUT_UNCONFIRMED)).toBeUndefined();
  });

  it('names the button in plain words, and never in a sentence', () => {
    for (const outcome of [
      { kind: 'refused' as const, message: SERVER_SENTENCE },
      { kind: 'unconfirmed' as const },
    ]) {
      const action = signOutNotice(outcome, handlers())!.action;
      expect(action.split(' ').length).toBeLessThanOrEqual(3);
      expect(action).not.toContain('.');
    }
  });
});

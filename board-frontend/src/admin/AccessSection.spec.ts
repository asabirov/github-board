import { describe, expect, it } from 'vitest';
import { ApiError, WithdrawnReadError } from '../api/core';
import { ACCESS_NOT_NOW_CODE } from '../projects/projects-last-good';
import { editFailure } from './AccessSection';

/**
 * The identity dialog's line under a failed Save (#1079), and whether Save
 * survives it. The dialog used to print the rejection whole: the seventeen
 * sentences the service writes for this form, and beside them api.ts's
 * `unauthenticated` and Nest's "Internal server error".
 */
describe('editFailure (#1079)', () => {
  it('says what did not happen when the session ended under the press', () => {
    const f = editFailure(new ApiError(401, 'unauthenticated'));
    expect(f.sentence).toBe('Your session ended, so these changes weren’t saved.');
    expect(f.retry).toBe(false);
  });

  it('never prints the route and status a failed save threw', () => {
    const f = editFailure(new ApiError(500, 'identity 500', undefined, undefined, 'Internal server error'));
    expect(f.sentence).toBe('Couldn’t save these changes. Try again.');
    expect(f.sentence).not.toContain('identity 500');
    expect(f.retry).toBe(true);
  });

  it('keeps the validation sentence, which is the only instruction its reader gets', () => {
    const said = '“not an address” is not an email address.';
    const f = editFailure(new ApiError(400, 'identity 400', undefined, undefined, said));
    expect(f.sentence).toBe(said);
    // The way out is editing the field the sentence is about, so Save stays.
    expect(f.retry).toBe(true);
  });

  it('keeps the refusal that stops the board being handed over, and its way out', () => {
    const said =
      'This would leave the board with no administrator who can sign in — an Admin role only counts while its ' +
      'address is on the team roster. Give the Admin role to somebody on the roster first, then take this one away.';
    const f = editFailure(new ApiError(409, 'identity 409', undefined, undefined, said));
    expect(f.sentence).toBe(said);
    // The instruction is "change the role first", and the role control is in
    // this dialog, so the press it asks for has to still be there.
    expect(f.retry).toBe(true);
  });

  it('says a fixture roster cannot be edited, and takes Save away', () => {
    const said = 'This board is reading a fixed roster, so it cannot be edited here.';
    const f = editFailure(new ApiError(503, 'identity 503', undefined, undefined, said));
    expect(f.sentence).toBe(said);
    expect(f.retry).toBe(false);
  });

  it('names what the write needed on the 403 the board can place', () => {
    // `AdminGuard` raises this only after the admin roster was read and this
    // caller was not in it — an unread roster is a 503 with a machine code, not
    // this — so it is a stated verdict on a stable fact, which an admin demoted
    // while this dialog stood open meets. Its own words stay on the console.
    const f = editFailure(new ApiError(403, 'forbidden', undefined, undefined, 'admin access required'));
    expect(f.sentence).toBe(
      'These changes weren’t saved. Saving a person needs admin access, and this request was refused it. ' +
      'Ask an admin to make the change, or to give you the role.',
    );
    expect(f.sentence).not.toContain('admin access required');
    expect(f.retry).toBe(false);
  });

  it('keeps Save armed on the 403 that is a Directory hiccup as often as a verdict', () => {
    // `TeamAccessGuard` runs on this route too, BEFORE `AdminGuard`, because it
    // is a global APP_GUARD. It fails closed without caching on any Directory
    // error, so an admin editing a person during a blip meets it — and the first
    // cut told them they lacked admin access and killed Save (#1102 review, B2).
    for (const said of [
      'Access restricted to the Acme team (team@example.com)',
      'No email on token; cannot verify team membership',
      undefined,
    ]) {
      const f = editFailure(new ApiError(403, 'forbidden', undefined, undefined, said));
      expect(f.retry).toBe(true);
      expect(f.sentence).not.toContain('admin access');
      expect(f.sentence).toContain('so try again');
    }
  });

  it('never offers a press it has just taken away', () => {
    // The 503 the fixture roster answers carries a sentence; the 503 an ingress
    // answers during a rollout carries nothing the board can read, and used to
    // fall onto the armed default under a line ending "Try again." (S1, B3).
    const f = editFailure(new ApiError(503, 'identity 503'));
    expect(f.retry).toBe(false);
    expect(f.sentence).not.toContain('Try again.');
  });

  it('prints the admins-unread 503 the service writes with a machine code', () => {
    // `AdminGuard`'s other refusal (#811): the board has never read its admin
    // roster, so it cannot judge anybody. 503, not 403, and the sentence is the
    // service's own. A producer the first cut's header did not list (S2).
    //
    // The code is passed here now, and it is what carries the sentence through:
    // this test used to say "with a machine code" in its name and send none,
    // and passed only because every 503 body was repeated unread.
    const said =
      'This board cannot read who its admins are, so nobody resolves as an admin — including you. ' +
      'Its identity store is unreachable; the service log says why. Admin surfaces come back on the ' +
      'first roster read that succeeds.';
    const f = editFailure(new ApiError(503, 'identity 503', undefined, undefined, said, 'admins_unread'));
    expect(f.sentence).toBe(said);
    expect(f.retry).toBe(false);
  });

  it('keeps Save armed on a 503 the auth layer codes “not now”', () => {
    // The global chain answers 503 on this route as well as 403, and four of
    // those are transient by construction: a session store that could not be
    // read, a refresh lease held on another instance, a discovery past its own
    // window. All four carry ACCESS_NOT_NOW_CODE. The first two rounds sent
    // every 503 to `standing`, so Save died under the service's own
    // "retry or reconnect" (#1102 review, the 503 round).
    const f = editFailure(new ApiError(
      503, 'identity 503', undefined, undefined, 'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.', ACCESS_NOT_NOW_CODE,
    ));
    expect(f.retry).toBe(true);
    expect(f.sentence).toBe(
      'These changes weren’t saved. The board couldn’t confirm your access just then, ' +
      'which clears on its own, so try again in a moment.',
    );
    // The service's words are for the log. "retry or reconnect" beside a Save
    // that is still there is not wrong, but "reconnect" is not this dialog's
    // offer and nothing here can act on it.
    expect(f.sentence).not.toContain('reconnect');
  });

  it('does not repeat a 503 sentence it cannot place, beside a Save it has taken away', () => {
    // `github-user.service.ts:245`, uncoded, and its own words ask for exactly
    // the press this arm removes.
    const f = editFailure(new ApiError(503, 'identity 503', undefined, undefined, 'Your GitHub connection changed while this was running. Try again.'));
    expect(f.retry).toBe(false);
    expect(f.sentence).not.toContain('retry');
    expect(f.sentence).toBe(
      'These changes weren’t saved, and pressing Save again won’t change that. Reload the page.',
    );
  });

  it('does not claim the changes were lost when the board cannot say', () => {
    const f = editFailure(new WithdrawnReadError('Your GitHub access changed; reload this view.'));
    expect(f.sentence).toContain('can’t say whether these changes were saved');
    expect(f.retry).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { ApiError, WithdrawnReadError } from '../api/core';
import type { AccountTokens } from '../api/account';
import { reasonOf } from '../auth/session-copy';
import { ACCESS_NOT_NOW_CODE } from '../projects/projects-last-good';
import { mintFailure, tokensPaneArm } from './AccountView';

/**
 * The mint sheet's line under a failed Create token (#1079), and whether the
 * button beneath it survives. The sheet used to print the rejection whole, so a
 * store that threw put Nest's "Internal server error" under the form and an
 * expired session put api.ts's own `unauthenticated` there.
 *
 * The suite has no DOM, so nothing here presses anything: `retry` is the sheet's
 * verdict on the button as a value, which is what a spec can hold.
 */
describe('mintFailure (#1079)', () => {
  it('says what did not happen when the session ended under the press', () => {
    const f = mintFailure(new ApiError(401, 'unauthenticated'));
    expect(f.sentence).toBe('Your session ended, so the token wasn’t created.');
    expect(f.sentence).not.toContain('unauthenticated');
    expect(f.retry).toBe(false);
  });

  it('never prints the route and status a failed mint threw', () => {
    const f = mintFailure(new ApiError(500, 'tokens 500', undefined, undefined, 'Internal server error'));
    expect(f.sentence).toBe('Couldn’t create the token. Try again.');
    expect(f.sentence).not.toContain('500');
    expect(f.sentence).not.toContain('Internal server error');
    // The control that caused it is on the screen, so the offer is a second
    // press and not the reload `loadFailureText` has to ask a reader for.
    expect(f.retry).toBe(true);
  });

  it('keeps each of the five sentences the service wrote for this form', () => {
    // `personal-token.service.ts` names this file and this line as where they
    // are printed, and the caps in them live there. All five arrive as a 400.
    for (const said of [
      'A token needs a name.',
      'A token name is at most 60 characters.',
      'Pick at least one scope.',
      'Your account cannot grant board:admin, so this token cannot carry it.',
      'An expiry is 1 to 365 days. Leave it out for a token that does not expire.',
    ]) {
      const f = mintFailure(new ApiError(400, 'tokens 400', undefined, undefined, said));
      expect(f.sentence).toBe(said);
      expect(f.retry).toBe(true);
    }
  });

  it('keeps Create token armed under the only 403 this route can answer', () => {
    // `TeamAccessGuard` is a global APP_GUARD and answers every request on this
    // route, and it fails closed on a Directory error that the next press would
    // clear. The first cut said no 403 was reachable here at all, and printed
    // "Trying again won’t change that" over a dead button on the one that is
    // (#1102 review, B1). It is the transient case that decides this arm.
    for (const said of [
      'Access restricted to the Acme team (team@example.com)',
      'No email on token; cannot verify team membership',
      undefined,
    ]) {
      const f = mintFailure(new ApiError(403, 'forbidden', undefined, undefined, said));
      expect(f.retry).toBe(true);
      expect(f.sentence).toContain('The token wasn’t created.');
      expect(f.sentence).toContain('so try again');
      expect(f.sentence).not.toContain('won’t change that');
      // The refusal's own words stay on the console, not under the form.
      if (said) expect(f.sentence).not.toContain(said);
    }
  });

  it('never offers a press it has just taken away', () => {
    // A 404 or a 503 whose body the board could not read is a standing condition
    // with no sentence attached, and the first cut left it on the armed default
    // (#1102 review, S1). Whatever the sheet says under it, it must not be
    // "Try again" over a withdrawn button (B3, the same fault on the other row).
    for (const status of [404, 503]) {
      const f = mintFailure(new ApiError(status, `tokens ${status}`));
      expect(f.retry).toBe(false);
      expect(f.sentence).not.toContain('Try again.');
    }
  });

  it('keeps Create token armed on a 503 the auth layer codes “not now”', () => {
    // `GithubPrincipalGuard` and `JwtAuthGuard` are global APP_GUARDs, so their
    // 503s reach this sheet too. All four carry ACCESS_NOT_NOW_CODE, none is
    // about this person's access, and every one clears without them doing
    // anything — the first two rounds withdrew the button under the service's
    // own instruction to retry (#1102 review, the 503 round).
    for (const said of ['The board cannot confirm your sign-in right now. Try again in a moment.', 'Checking your GitHub access took too long. Try again.']) {
      const f = mintFailure(new ApiError(503, 'tokens 503', undefined, undefined, said, ACCESS_NOT_NOW_CODE));
      expect(f.retry, said).toBe(true);
      expect(f.sentence, said).toBe(
        'The token wasn’t created. The board couldn’t confirm your access just then, ' +
        'which clears on its own, so try again in a moment.',
      );
      expect(f.sentence, said).not.toContain(said);
    }
  });

  it('does not repeat a 503 sentence it cannot place, beside a button it has taken away', () => {
    // The uncoded half. `github-user.service.ts:245` says "retry" and this arm
    // has just removed the press, so the sheet says its own thing instead.
    const f = mintFailure(new ApiError(503, 'tokens 503', undefined, undefined, 'Your GitHub connection changed while this was running. Try again.'));
    expect(f.retry).toBe(false);
    expect(f.sentence).not.toContain('retry');
    expect(f.sentence).toBe(
      'The token wasn’t created, and pressing Create token again won’t change that. Reload the page.',
    );
  });

  it('does not claim the token was not created when the board cannot say', () => {
    // A withdrawal sits on a request that may have landed. Telling somebody to
    // press again here is how a second token gets minted by accident.
    const f = mintFailure(new WithdrawnReadError('Your GitHub access changed; reload this view.'));
    expect(f.sentence).toContain('can’t say whether the token was created');
    expect(f.retry).toBe(false);
  });
});

/**
 * Which arm the Access & agents body draws, as a function of what the page
 * holds (#1082).
 *
 * The page's `err` is set from a `.catch` inside an effect, and this suite has
 * no DOM and fires no effects, so nothing here can drive the component into its
 * failed-read arm. The choice is a function instead, and the function is what
 * is driven. What that does NOT prove is that the page draws the arm this
 * picks; the browser shots delivered on #1082 and #1083 are that half.
 */

const tokens = (over: Partial<AccountTokens> = {}): AccountTokens => ({
  enabled: true,
  grantableScopes: ['board:read'],
  tokens: [],
  ...over,
});

describe('tokensPaneArm (#1082)', () => {
  it('is the failed-read arm for an error carrying no message', () => {
    // The defect. `err` is `string | null` and the JSX asked `err && !data`, so
    // an empty message was filed under "no error" and the page fell through to
    // the first-load arm — `Loading…`, forever, over a list that was never
    // going to arrive. A read that failed with nothing to say is a read that
    // failed.
    expect(tokensPaneArm({ data: null, error: '' })).toBe('failed');
  });

  it('is the failed-read arm for a rejection that carried nothing at all', () => {
    // The other half of #1082, and the one that never reached this state to
    // begin with: the page read `e.message` off whatever it caught, and a
    // promise rejecting with `undefined` made that throw INSIDE the handler —
    // so `err` stayed null and the page said `Loading…` for the rest of the
    // session. `reasonOf` is what the page stores now, driven here rather than
    // assumed.
    for (const thrown of [undefined, null, new Error(), {}]) {
      expect(() => reasonOf(thrown)).not.toThrow();
      expect(tokensPaneArm({ data: null, error: reasonOf(thrown) })).toBe('failed');
    }
  });

  it('is the failed-read arm for the strings api.ts actually throws', () => {
    for (const error of ['tokens 503', 'unauthenticated', 'forbidden']) {
      expect(tokensPaneArm({ data: null, error })).toBe('failed');
    }
  });

  it('is the first-load arm only when nothing has failed and nothing has landed', () => {
    expect(tokensPaneArm({ data: null, error: null })).toBe('loading');
  });

  it('is the no-database arm when the server answered that it has none', () => {
    expect(tokensPaneArm({ data: tokens({ enabled: false }), error: null })).toBe('unavailable');
  });

  it('draws the list when the list is there', () => {
    expect(tokensPaneArm({ data: tokens(), error: null })).toBeNull();
  });

  it('keeps the list on screen when a reload fails, whatever the reload said', () => {
    // Rows survive a failed reload, the same rule ConnectedClients keeps. The
    // empty message must not change that either: it is still a reload that
    // failed over a list the page already has.
    for (const error of ['tokens 503', '', reasonOf(undefined)]) {
      expect(tokensPaneArm({ data: tokens(), error })).toBeNull();
    }
  });
});

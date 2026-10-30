/**
 * What a sign-out says, and what its one button does (#682).
 *
 * Pure, so the words and the wiring are both testable in a suite with no DOM.
 * The board owns exactly one sentence here — the other comes off the wire and is
 * never edited, summarised or matched on.
 */
import type { LogoutOutcome } from '../api/core';

/**
 * The one case no server described, because no server answered. Says what is
 * unknown rather than what failed: the cookie may be alive, and pressing on to
 * '/' would sign them back in on it.
 */
export const SIGN_OUT_UNCONFIRMED =
  'The sign-out did not reach the board. You may still be signed in, so try again.';

/** Where the button goes, named for the destination: '/' renders the sign-in
 *  screen for a signed-out person. Never "Continue" or "OK" — nothing about
 *  pressing it resolves what the sentence above is reporting. */
const GO_TO_SIGN_IN = 'Go to sign-in';
const TRY_AGAIN = 'Try again';

export interface SignOutNoticeState {
  /** The sentence, whoever wrote it. */
  readonly message: string;
  /** The button's words. */
  readonly action: string;
  readonly onAction: () => void;
  /** Escape, the scrim, the kit's close. Null means there is no dismissing it:
   *  the button is the only way out. */
  readonly onDismiss: (() => void) | null;
}

/**
 * The notice for an outcome, or null when there is nothing to say.
 *
 * `refused` cannot be dismissed at all: a reflexive Escape would finish the
 * redirect and take with it the one sentence the person has to carry to another
 * browser or to an admin. `unconfirmed` closes on any of them and redirects on
 * none — there the person is probably still signed in, and leaving is what would
 * hide that.
 */
export function signOutNotice(
  outcome: LogoutOutcome,
  handlers: { leave: () => void; retry: () => void; dismiss: () => void },
): SignOutNoticeState | null {
  if (outcome.kind === 'clean') return null;
  if (outcome.kind === 'refused') {
    return {
      message: outcome.message,
      action: GO_TO_SIGN_IN,
      onAction: handlers.leave,
      onDismiss: null,
    };
  }
  return {
    message: SIGN_OUT_UNCONFIRMED,
    action: TRY_AGAIN,
    onAction: handlers.retry,
    onDismiss: handlers.dismiss,
  };
}

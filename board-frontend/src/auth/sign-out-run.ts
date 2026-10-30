import type { LogoutOutcome } from '../api/core';
import { signOutNotice, type SignOutNoticeState } from './sign-out-copy';

/**
 * The sign-out sequence, one at a time (#682).
 *
 * Three controls reach it — the fallback button, the menu item, and the notice's
 * own Try again — and without the gate the last answer to arrive wins: a clean
 * second attempt settling behind a refused first calls `show(null)` and
 * `leave()`, unmounting the one notice that may not be dismissed and navigating
 * away from a sentence nobody has read yet.
 *
 * It lives here rather than in `SideAccount` because the board's suite has no
 * DOM: as a component callback none of this can be tested at all.
 */
export function createSignOut(deps: {
  logout: () => Promise<LogoutOutcome>;
  show: (notice: SignOutNoticeState | null) => void;
  leave: () => void;
}): () => Promise<void> {
  let inFlight = false;
  const run = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    let notice: SignOutNoticeState | null;
    try {
      notice = signOutNotice(await deps.logout(), {
        leave: deps.leave,
        retry: () => { void run(); },
        dismiss: () => deps.show(null),
      });
    } finally {
      // Down before anything is drawn: `logout()` cannot reject, and a press
      // after this attempt has to be able to start the next one.
      inFlight = false;
    }
    deps.show(notice);
    if (notice === null) deps.leave();
  };
  return run;
}

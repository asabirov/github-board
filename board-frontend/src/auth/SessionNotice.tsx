import { Button } from '../ui/kit';
import { SESSION_ENDED_NOTE, SESSION_ENDED_TITLE } from './session-copy';
import type { SessionView } from './session-state';

/**
 * What a person sees the moment their session dies (#512).
 *
 * A bar above the page, not a gate in front of it: the page stays exactly as it
 * was, so a half-written feedback message, an open edit panel and the filters
 * in the queue all survive. It sits at the top of the content column, sticky
 * with the top bar, so it lands in the same eyeline as the page title and stays
 * there while they scroll — the page below answers nothing until they sign in.
 *
 * The way back is a button they press. The board never sends anyone to Google
 * by itself: when the 401 is not the kind sign-in can fix (a revoked session, a
 * group membership removed) an automatic redirect just bounces them in a loop.
 */

const MARK =
  'flex size-5 flex-none items-center justify-center rounded-full text-[13px] font-bold text-danger';
// px-6 matches the top bar it sits on, so the two share one left edge.
const ROW = 'flex items-center gap-3.5 px-6 py-3.5 max-[560px]:flex-wrap';

export function SessionNotice({ session, onSignIn }: { session: SessionView; onSignIn: () => void }) {
  if (session.kind !== 'expired') return null;
  return (
    <div className="session-bar" role="alert">
      <div className={ROW}>
        <span
          className={MARK}
          style={{ background: 'color-mix(in srgb, var(--pink) 18%, transparent)' }}
          aria-hidden="true"
        >!</span>
        <p className="flex-1 text-[13px] text-dim">
          <span className="font-semibold text-fg">{SESSION_ENDED_TITLE}</span> {SESSION_ENDED_NOTE}
        </p>
        <Button type="button" size="sm" onClick={onSignIn}>Sign in</Button>
      </div>
    </div>
  );
}

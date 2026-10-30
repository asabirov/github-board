import type { ReactNode } from 'react';
import { AUTH_FILLED_BUTTON, AUTH_BUTTON_SHADOW, OnboardingScreenShell } from '../ui/kit';
import { beginLogin } from './oauth';

/** The pre-auth states: everything that is NOT an authenticated, loaded app.
 *  These used to be the old private kit's `SignInScreenState`, mapped 1:1; the kit
 *  dropped that component (see the note on the component below), so the union
 *  is board's own now and nothing off-repo constrains it.
 *
 *  `loading` was a fourth, and #1229 removed it rather than leaving it as a
 *  dead limb — the same treatment #892 gave `remembered` (its review, F13).
 *  Each of the three below is an ANSWER: the board asked who this is and was
 *  told nobody, or not you, or that the question could not be put. `loading`
 *  was the question still in the air, and drawing a full screen for it replaced
 *  a board that was about to be usable with a spinner that had no nav, no page
 *  name and nothing to press. The shell is drawn during the probe now
 *  (`ui/ProbeShell.tsx`), so nothing renders this view — and with the kind gone
 *  from the union, `App`'s gate cannot widen back over it without failing to
 *  typecheck. */
export type AuthView =
  | { kind: 'login' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

// board-specific copy, hoisted out of the JSX (kept scannable).
const LOGIN_TITLE = 'Everything the team runs on';
// The sign-in lock note — the ONE canonical mono treatment of the account kind
// (kept off a dangling middot so it wraps cleanly on the narrow card).
const RESTRICTION = <>Sign in with <code>GitHub</code></>;
// Forbidden callout — plain wording (the lock note below carries the chip), so
// the account kind isn't chipped twice on one screen.
const FORBIDDEN =
  "This board only admits the GitHub accounts and organisations its operator allowed. Your GitHub account isn’t in that list.";
// A signed-out user can't act on a raw status code; show a human error and let
// the Retry button carry the recovery (the real detail is in the server logs).
const ERROR_MSG = 'The board couldn’t verify your session. Try again in a moment.';

/** The headline per state. `login` is board's own line; the other two are the
 *  words `SignInScreen` defaulted to, kept so the screen reads as it did. */
const HEADING: Record<AuthView['kind'], string> = {
  login: LOGIN_TITLE,
  forbidden: 'Access restricted',
  error: 'Couldn’t load',
};

const CALLOUT =
  'mb-[22px] flex gap-[10px] rounded-[10px] border px-[13px] py-[12px] text-left text-[13px] ' +
  'leading-[1.5] text-dim';

const WORDMARK = 'text-[24px] font-bold leading-none tracking-[-0.02em] text-fg';

/** GitHub's own mark, drawn rather than fetched: an `<img>` from a CDN on the
 *  sign-in screen is a third-party request before anyone has signed in. */
function GithubGlyph() {
  return (
    <span className="inline-flex size-[26px] flex-none items-center justify-center rounded-md bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.05)_inset]">
      <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true">
        <path fill="#24292f" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    </span>
  );
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none text-muted">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-px flex-none text-warn">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function ErrorIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-px flex-none text-danger">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 4v6h-6" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

/** The lock note under the press. Its `<code>` chip is styled inline rather than
 *  in `app.css`: it is the only mono chip on a screen that draws no app chrome,
 *  and a rule there would have to name a selector this file owns. */
function LockNote({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto mt-[20px] flex flex-wrap items-center justify-center gap-[7px] text-[12px] leading-[1.4] text-dim [&_code]:rounded-[5px] [&_code]:bg-surface-3 [&_code]:px-[6px] [&_code]:py-[2px] [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:text-dim">
      <LockIcon />
      {children}
    </div>
  );
}

/**
 * Full-screen pre-auth gate. Renders no app chrome or nav.
 *
 * It was the old private kit's `<SignInScreen>` from #195 until #711 took board across
 * seven kit majors. `SignInScreen` was dropped in 0.20.0 — the kit's changelog
 * says "it had no consumers, so this is not a breaking change in practice", and
 * board was the consumer it did not know it had. It is the ONE symbol of the 56
 * board imports that stopped resolving anywhere in 0.16 → 7.1.6.
 *
 * The WINDOW it draws, the glow ground and the centred card, is
 * `OnboardingScreenShell` in `ui/kit`. #1450 copied that shell into board from
 * the old kit's 5.0.0. It reads the same `--auth-glow-*` and `--auth-card-*`
 * variables that `SignInScreen` used. This file owns the states, the copy in
 * each and the GitHub press.
 *
 * The card is the shell's `md`, 440px, where `SignInScreen`'s was 360px. That is
 * the one visible difference, and it is deliberate: narrowing it back means
 * changing the shell's `CARD_WIDTH`, for 80px.
 *
 * `themeToggle={null}` because board's theme switch lives beside the wordmark in
 * the rail (#322). A second one here would put the same control in one place
 * before sign-in and another after it.
 */
export function AuthScreen({ view }: { view: AuthView }) {
  return (
    <OnboardingScreenShell
      logo={<span className={WORDMARK}>board.</span>}
      themeToggle={null}
      title={HEADING[view.kind]}
    >
      <div className="text-center">
        {view.kind === 'login' && (
          <button type="button" onClick={beginLogin} className={AUTH_FILLED_BUTTON}
            style={{ boxShadow: AUTH_BUTTON_SHADOW }}>
            <GithubGlyph />
            <span>Continue with GitHub</span>
          </button>
        )}

        {view.kind === 'forbidden' && (
          <div role="status" className={`${CALLOUT} border-warn bg-warn-fill`}>
            <WarningIcon />
            <span>{FORBIDDEN}</span>
          </div>
        )}

        {view.kind === 'error' && (
          <>
            <div role="alert" className={`${CALLOUT} border-danger bg-danger-fill`}>
              <ErrorIcon />
              <span>{ERROR_MSG}</span>
            </div>
            <button type="button" onClick={() => window.location.reload()} className={AUTH_FILLED_BUTTON}
              style={{ boxShadow: AUTH_BUTTON_SHADOW }}>
              <RetryIcon />
              <span>Try again</span>
            </button>
          </>
        )}

        {(view.kind === 'login' || view.kind === 'forbidden') && <LockNote>{RESTRICTION}</LockNote>}
      </div>
    </OnboardingScreenShell>
  );
}

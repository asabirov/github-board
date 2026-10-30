import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthScreen, type AuthView } from './AuthScreen';

// `beginLogin` reaches window.location; this file asserts markup, never a press.
vi.mock('./oauth', () => ({ beginLogin: () => {} }));

const html = (view: AuthView) => renderToStaticMarkup(<AuthScreen view={view} />);

/**
 * #711 replaced the old private kit's `<SignInScreen>` — the one symbol of the 56 board
 * imports the kit dropped — with the kit's `OnboardingScreenShell` plus board's
 * own four states. Nothing tested this screen before, which is why the swap was
 * checked in a browser too, on #711. What a `node` render CAN
 * settle is which state draws what, and that is this file's whole subject: the
 * suite has no DOM, so no press here is a press (`docs/traps.md`).
 */
describe('AuthScreen', () => {
  it('draws the GitHub press, the headline and the lock note when signed out', () => {
    const s = html({ kind: 'login' });
    expect(s).toContain('Continue with GitHub');
    expect(s).toContain('Everything the team runs on<');
    expect(s).toContain('Sign in with');
    // The card, from the kit's own auth surface rather than a copy of it.
    expect(s).toContain('var(--auth-card-border)');
    expect(s).toContain('var(--auth-glow-a)');
  });

  it('offers no way in while forbidden, and says why', () => {
    const s = html({ kind: 'forbidden' });
    expect(s).not.toContain('Continue with GitHub');
    expect(s).toContain('only admits the GitHub accounts');
    expect(s).toContain('role="status"');
    // The sign-in kind is still said: it is what the reader is being measured
    // against, and the callout above names the rule without the chip.
    expect(s).toContain('Sign in with');
  });

  it('gives an error a retry and an alert role, and no GitHub press', () => {
    const s = html({ kind: 'error', message: 'ignored — the screen writes its own' });
    expect(s).toContain('role="alert"');
    expect(s).toContain('Try again');
    expect(s).not.toContain('Continue with GitHub');
    // The raw message is deliberately NOT rendered: a signed-out reader cannot
    // act on a status code, and the human sentence carries the recovery.
    expect(s).not.toContain('ignored — the screen writes its own');
  });

  /**
   * The state this screen used to have and does not (#1229 step 1).
   *
   * `loading` drew a spinner on the glow ground with no card — and, because
   * `App` returned this screen for it, no nav, no page name and nothing to
   * press either, for one round trip on every route. The shell is drawn during
   * the probe now (`ui/ProbeShell.tsx`), and the kind is gone from `AuthView`
   * rather than left unrendered, so a gate widened back over it fails to
   * typecheck instead of quietly restoring the spinner. `@ts-expect-error` is
   * the assertion: delete the kind's removal and this line stops erroring and
   * fails the suite.
   */
  it('has no loading state left to draw', () => {
    // @ts-expect-error `loading` is not an AuthView any more (#1229).
    const view: AuthView = { kind: 'loading' };
    expect(view).toBeTruthy();
    const source = AuthScreen.toString();
    expect(source).not.toContain('Loading…');
  });

  it('mounts no theme toggle — board’s switch lives in the rail (#322)', () => {
    // The old kit's shell defaulted `themeToggle` to its own `ThemeToggle`. The
    // board shell defaults it to `null`. This keeps a theme control off the
    // screen if a default comes back.
    const s = html({ kind: 'login' });
    expect(s.toLowerCase()).not.toContain('aria-label="switch to');
  });
});

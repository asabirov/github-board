import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionNotice } from './SessionNotice';
import type { SessionView } from './session-state';

// The board's test env is `node` (no DOM), so — the repo's established pattern —
// render to a static HTML string and assert against the markup.

const ME = { email: 'ivan.roslov@example.com', isAdmin: false };
const html = (session: SessionView) =>
  renderToStaticMarkup(<SessionNotice session={session} onSignIn={() => {}} />);

describe('SessionNotice (#512)', () => {
  it('says nothing while the session is live', () => {
    expect(html({ kind: 'ready', me: ME })).toBe('');
  });

  it('says nothing at the gates it does not own', () => {
    // A signed-out first load, a non-group account and a probe failure each
    // already have a full-screen answer — this bar must not double up on them.
    expect(html({ kind: 'loading' })).toBe('');
    expect(html({ kind: 'login' })).toBe('');
    expect(html({ kind: 'forbidden' })).toBe('');
    expect(html({ kind: 'error', message: 'me 502' })).toBe('');
  });

  it('tells the person their session ended, and that the page is no longer live', () => {
    const out = html({ kind: 'expired', me: ME });
    expect(out).toContain('Your session ended');
    expect(out).toContain('Nothing on this page is live until you sign in again');
  });

  it('offers a sign-in they press — never an automatic bounce to Google', () => {
    const out = html({ kind: 'expired', me: ME });
    expect(out).toContain('Sign in');
    expect(out).toContain('<button');
  });

  it('is announced, so it is not merely visible', () => {
    expect(html({ kind: 'expired', me: ME })).toContain('role="alert"');
  });

  it('never shows the raw sentinel the API throws', () => {
    expect(html({ kind: 'expired', me: ME })).not.toContain('unauthenticated');
  });
});

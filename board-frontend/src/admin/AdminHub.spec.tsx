import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminsUnreadNotice } from './AdminHub';

// Node test env, no DOM: render to a static string, the shape
// AuditSection.spec.tsx uses.

/**
 * The hub's own sentence for a board that cannot resolve its admins (#811).
 *
 * `/api/auth/me` answers `isAdmin: false` to everybody on a `db` board whose
 * Postgres was unreachable before it booted — the roster has never been read, so
 * nobody resolves as admin and the break-glass deliberately stays disarmed
 * (#588). The hub read that `false` as "you are not an admin" and drew a
 * permission message over an outage, which is how the Audit pane — the one place
 * the lost-record count lives (#781) — became unreachable in exactly the state
 * it was built for.
 *
 * Nothing here grants access. Every section behind the hub still refuses.
 */
describe('AdminHub when the board cannot read its admin roster (#811)', () => {
  const html = renderToStaticMarkup(<AdminsUnreadNotice />);

  it('names the board, not the reader', () => {
    expect(html).toContain('cannot read who its admins are');
    expect(html).not.toContain('for admins only');
    expect(html).not.toContain('Ask an admin');
  });

  it('says the refusal covers everybody, so an admin does not read it as their own account', () => {
    expect(html).toContain('including you');
  });

  it('points at where the cause is written down', () => {
    // The message the store failed with never rides an HTTP body — Prisma names
    // the host, the port and the user (#781) — so the sentence has to send its
    // reader somewhere the cause actually is.
    expect(html).toContain('service log');
  });

  it('is announced rather than drawn silently', () => {
    expect(html).toContain('role="status"');
  });
});

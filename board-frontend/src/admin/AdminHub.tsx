import { useIdentity } from '../auth/identity-context';
import type { AdminSection } from '../area-panel/panel';
import { AccessSection } from './AccessSection';
import { AuditSection } from './AuditSection';
import { PageHeading, PAGE_RAIL, PAGE_READING } from '../ui/PageHeading';
import { ADMIN_SECTIONS } from './sections';

/**
 * The admin hub (#183). Its section nav (Access #11, Audit #212) is the area
 * panel's left rail (#712) — the panel owns it — so this renders only the
 * active section, no in-content rail. Admin-gated all the same: the menu row
 * that opens it is admin-only, and the section APIs 403 independently, so this
 * line is the third layer rather than the first.
 */

// The shared app rail (#450) — the hub used to centre its own 900px column, so its
// H1 sat left of every other page's. The section content keeps a narrower measure
// inside the rail; the identity band starts where the rail starts.
const SHELL = `${PAGE_RAIL} pb-[90px] pt-[26px] max-[900px]:pt-4`;
const COLUMN = PAGE_READING;
const CARD = 'overflow-hidden rounded-[16px] bg-surface';

export function AdminHub({ section }: { section: AdminSection }) {
  const standing = useIdentity();

  if (standing === null)
    return (
      <div className={SHELL}>
        <div className={COLUMN}>
          <div className={`${CARD} px-[26px] py-[22px]`}><div className="rok-empty">Loading…</div></div>
        </div>
      </div>
    );

  // "You are not an admin" is a claim about the reader, and a board that has
  // never read its admin roster is in no position to make it (#811) — so it is
  // said only when the board actually judged them. The other branch renders the
  // sections, whose own 503 sentence names the outage; this line is what stops
  // the hub swallowing them first.
  if (!standing.isAdmin && !standing.adminsUnread)
    return (
      <div className={SHELL}>
        <div className={COLUMN}>
          <div className={`${CARD} px-[26px] py-[22px]`}>
            <p className="text-muted">This page is for admins only. Ask an admin if you need access.</p>
          </div>
        </div>
      </div>
    );

  // The section's name is this page's big H1 (#391); the panel's rail says
  // "Admin Hub" above it, so the name is said once.
  const heading = ADMIN_SECTIONS.find((s) => s.id === section)?.label ?? 'Admin hub';

  return (
    <div className={SHELL}>
      <div className={COLUMN}>
        <PageHeading className="mb-6">{heading}</PageHeading>
        {standing.adminsUnread && <AdminsUnreadNotice />}
        <div className={CARD}>
          {section === 'access' && <AccessSection />}
          {section === 'audit' && <AuditSection />}
        </div>
      </div>
    </div>
  );
}

/**
 * The board cannot resolve its admins, said once at the top of the hub (#811).
 *
 * Not a permission message. Every section below still refuses — a `db` board
 * whose Postgres was down before it booted has no roster to judge anybody
 * against, and the BOARD_ADMIN_EMAILS break-glass deliberately stays disarmed on
 * an unread roster (#588). What the reader gets instead of "you are not an
 * admin" is the reason nothing here will answer, which is the difference between
 * looking for the right problem and looking for their own account.
 *
 * Exported so `AdminHub.spec.tsx` can render it without a server.
 */
export function AdminsUnreadNotice() {
  return (
    <div className="mb-6 flex items-start gap-2.5 rounded-[10px] bg-warn-fill p-3" role="status">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-px flex-none text-warn"
        aria-hidden="true"
      >
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      <p className="text-[12.5px] leading-[1.5] text-fg">
        <span className="font-medium">This board cannot read who its admins are.</span>{' '}
        Its identity store has not answered since the board started, so nobody resolves as an admin —
        including you, whether or not you are one. Nothing below will load until a roster read succeeds;
        the service log says what the store returned.
      </p>
    </div>
  );
}

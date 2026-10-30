/**
 * The assignee avatar(s) for an issue row/card — the ONE shared treatment so every
 * issue-list surface (Oldest open, the IssuesViewer's list + board) renders
 * identical avatars (#315/#318, unified across the viewer in #394). This retired
 * the viewer's parallel `WhoAvatars`, whose only real difference was an alternate
 * empty state — folded in here as the optional `placeholder`. Reuses the shared
 * `Avatar` (photo when a login resolves, initials otherwise) and the `.q-who` /
 * `.q-who-empty` size hooks in app.css (20px, ringed to the card surface,
 * overlapped).
 */

import { Avatar } from './avatar';
import { Tip } from './Tip';
import { usePeople, resolvePerson } from '../people-ctx';
import { memberColors } from '../member-color';

/** `placeholder` (default on) fills an empty slot with the dashed circle so a Who
 *  column stays aligned; pass `false` for inline use (e.g. beside a timestamp),
 *  where an unassigned issue should render nothing rather than a gap. */
export function AssigneeCluster({ logins, placeholder = true }: { logins: string[]; placeholder?: boolean }) {
  const people = usePeople();
  const colorOf = memberColors(people);
  if (logins.length === 0) {
    // NAMED, not hidden (#752). It was `aria-hidden`, with the word "Unassigned"
    // living only in the hover tip — so an assigned row announced a person and an
    // unassigned one announced nothing, on surfaces where taking an unowned
    // issue is the whole point.
    //
    // `role="img"` + `aria-label` and NOT visible text: the word must not become
    // a fourth thing to read on a row. Every one of the five surfaces gains the
    // announcement and none of them gains a glyph, so this extends the shared
    // treatment rather than narrowing it.
    return placeholder ? (
      <Tip label="Unassigned"><span className="q-who-empty" role="img" aria-label="Unassigned" /></Tip>
    ) : null;
  }
  return (
    <div className="q-who">
      {logins.map((login) => {
        const name = resolvePerson(people, login, null)?.displayName ?? login;
        // The separator ring the cluster already draws now carries the person's
        // colour (#477) instead of the surface, so a row says whose it is before
        // the photo is legible. Someone off the roster keeps a neutral ring.
        return (
          <Avatar
            key={login}
            name={name}
            login={login}
            px={40}
            style={{ borderColor: colorOf(login) }}
          />
        );
      })}
    </div>
  );
}

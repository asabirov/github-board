/**
 * A line, beside numbers that cover part of their scope, saying which Github org
 * is missing from them (#650).
 *
 * It goes with the numbers rather than at the top of the page: a global banner
 * would have to be read and then carried down to whichever block it applied to,
 * and the reader is looking at a count, not at the page.
 *
 * Quiet, and no amber. I read `Pulse.tsx`'s `QUIET_NOTE` before writing this,
 * and it is the same kind of sentence — the board reporting what it does not
 * hold. `app.css` pins amber as a warning, spent a few pixels away on a Feedback
 * report left waiting past a day; an org the reader cannot restore from this
 * page is not a second thing demanding the same colour. (It named the Bugs and
 * Unassigned tile counts until #752 took that band off Overview.)
 *
 * The pure half takes `orgs` as a prop so a spec can render it. The wrapper
 * below reads them off the session hook, which is the only reader of /me this
 * surface needs.
 */
import { orgScopeCopy } from './auth/org-scope-copy';
import type { OrgReadState } from './api/types';
import { useMe } from './use-me';

/** No box and no border: this sits with a block, not beside one. It carries no
 *  margin of its own — each call site owns the gap to the numbers it follows. */
const NOTICE_CLS = 'text-[12.5px] leading-[1.5] text-muted';
/** Github's own words, on their own line under the sentence that needs them. */
const REASON_CLS = 'block text-[12px] text-muted';

/**
 * Draws nothing unless an org is explicitly `unreadable`. An empty `orgs` — an
 * old board-service, or a session that has not landed — is the board making no
 * claim, so the page is left exactly as it is. Nothing here ever draws a word
 * about the orgs that WERE read; there is no reassuring state to render.
 */
export function OrgScopeNotice({ orgs, className = '' }: {
  orgs: readonly OrgReadState[];
  className?: string;
}) {
  const copy = orgScopeCopy(orgs);
  if (copy === null) return null;
  return (
    <section className={`${NOTICE_CLS} ${className}`}>
      {copy.notice}
      {copy.reason !== null && <span className={REASON_CLS}>{copy.reason}</span>}
    </section>
  );
}

/** The same notice, reading this session's orgs. No fetch of its own — `useMe`
 *  is the hook that already carries the /me response. */
export function SessionOrgScopeNotice({ className }: { className?: string }) {
  const { me } = useMe();
  return <OrgScopeNotice orgs={me?.orgs ?? []} className={className} />;
}

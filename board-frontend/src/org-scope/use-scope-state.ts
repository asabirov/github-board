/**
 * The two facts a narrowed page needs about its scope (#714), composed in one
 * place so no surface composes them twice.
 *
 * `org` is what the address narrowed to, or null for the union. `notice` is the
 * ONE thing to say about that org — null the rest of the time, which is every
 * union page and every org the board read without incident.
 *
 * `failed` is what a narrowed read on this page came back with, or null when
 * nothing failed. The page has to hand it over because the frontend cannot ask
 * in advance: `/api/auth/me` carries `orgs`, but it answers `[]` on a fixture
 * board and `[]` is a board making NO CLAIM (see `MeResponse.orgs`), never a
 * board saying the org is fine. So an org the deployment does not serve is
 * learned from the refusal and from nothing else.
 *
 * `served` is the other half of that answer: a narrowed read on this page came
 * back with DATA. It is what the device remembers (#714), and it is the only
 * thing that gets remembered — one visit to a stale `/roadmap` bookmark used to
 * write `roadmap` into localStorage, and that device's `/` then opened a board
 * saying "This board does not cover roadmap" on every tab, for good. Writing it
 * here rather than in each page keeps one rule in one place; `App` handles the
 * other direction, forgetting when the address is back on the union.
 *
 * A refusal this page SAW beats the session's report, and only one of the two is
 * ever drawn: a 404 says the board does not serve the org at all, which is a
 * different place to send the reader than "could not read it", and a page that
 * said both would be arguing with itself.
 */
import { useEffect } from 'react';
import { useMe } from '../use-me';
import { writeOrgPref } from './org-pref';
import { useOrgScope } from './OrgScopeProvider';
import { refusedScopeCopy, unreadableScopeCopy, type ScopeNotice, type ScopeRefusal } from './scope-copy';

export interface ScopeState {
  org: string | null;
  notice: ScopeNotice | null;
}

export function useScopeState(failed: ScopeRefusal | null = null, served = false): ScopeState {
  const { org } = useOrgScope();
  const { me } = useMe();
  // `me?.orgs ?? []` and not a list this file makes up: an empty list is the
  // fixture board's real answer and it must stay one, so nothing here draws a
  // word about an org the session said nothing about.
  const notice = refusedScopeCopy(org, failed) ?? unreadableScopeCopy(org, me?.orgs ?? []);
  const remember = org !== null && served && notice === null;
  useEffect(() => {
    if (remember && org !== null) writeOrgPref(org);
  }, [org, remember]);
  return { org, notice };
}

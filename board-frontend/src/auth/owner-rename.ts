import { useEffect, useState } from 'react';
import { fetchOwnerRename } from '../api/me';
import type { MeResponse } from '../api/types';

/**
 * Telling a RENAMED organisation from one a person has genuinely lost (#1167).
 *
 * The organisation was renamed from `globex` to `acme` on 2026-09-16.
 * Every bookmark, document link and pasted address under the old name still
 * opens this board, and what the board said to the people holding them was
 * "Github hasn't given this account access. Check the app installation and your
 * own access on Github." Nobody's access had been touched. Their own account
 * listing named three owners at that moment, `acme` among them.
 *
 * The board cannot work the difference out on its own, and the service side
 * says why it cannot: an organisation lookup on a former login answers exactly
 * what it answers for a login nobody ever registered. So this asks
 * board-service, which asks Github about repositories this person already
 * reaches, and only ever answers a name it could prove. See
 * `board-service/src/auth/owner-rename.ts` for what the proof is and what it
 * refuses to conclude.
 *
 * The refusal itself is unchanged for every case but the proven one. That is
 * acceptance criterion 2, and it is also the honest reading: `null` here means
 * the board has no second thing to say.
 */

/**
 * The owner in the address that the board is about to refuse, or `null`.
 *
 * The same question `App` asks to decide whether to draw `GithubAccessState` at
 * all, minus the two arms that name no owner — an unconnected session and a
 * person who reaches nothing. Neither of those is about an organisation, so
 * neither has a rename to ask about.
 *
 * Case-folded, because Github folds a login and `/Acme` is the same
 * organisation as `/acme`. The board's own owner test folds too, so a
 * narrower one here would ask about an owner the page is not refusing.
 */
export function unreachedOwner(
  github: MeResponse['github'] | undefined,
  routeOrg: string | null,
): string | null {
  if (!github || !github.configured || !github.connected || !routeOrg) return null;
  if (github.owners.some((o) => o.login.toLowerCase() === routeOrg.toLowerCase())) return null;
  return routeOrg;
}

/**
 * Where that owner went, once the answer arrives.
 *
 * `null` while the ask is in flight, so the screen a person meets first is the
 * refusal they met before this existed and never a blank waiting state. The
 * rename sentence replaces it when there is one to show. That order is
 * deliberate: the refusal is the truthful reading of what the board knows at
 * mount, and a spinner in its place would withhold a correct answer to avoid
 * showing it twice.
 *
 * A rejected ask is swallowed for the same reason `fetchOwnerRename` answers
 * `null` for one. There is no state on this screen for "the board could not
 * find out", because the screen is already showing what it knows.
 */
export function useOwnerRename(owner: string | null): string | null {
  const [renamedTo, setRenamedTo] = useState<string | null>(null);
  useEffect(() => {
    setRenamedTo(null);
    if (owner === null) return;
    let alive = true;
    void fetchOwnerRename(owner).then(
      (answer) => { if (alive) setRenamedTo(answer); },
      () => {},
    );
    return () => { alive = false; };
  }, [owner]);
  return renamedTo;
}

import type { GithubRepository } from './github-principal';

/**
 * Where an organisation went, when somebody opens a board path under a name the
 * board does not serve (#1167).
 *
 * The board used to answer one sentence for every such path: "Github hasn't
 * given this account access." That was true for a revoked grant and false for
 * the case that produced this issue. The organisation was renamed, every
 * bookmark under the old name kept resolving to this board, and the board told
 * the people holding them they had lost an access nobody had taken away. Their
 * own account listing named the new owner among the owners they already held.
 *
 * WHAT GITHUB WILL AND WILL NOT TELL US, measured against the live API on
 * 2026-09-17 from a host with no credential of its own:
 *
 *   GET /orgs/acme                  404 Not Found
 *   GET /orgs/zzq-never-existed-org-…     404 Not Found
 *
 * An organisation lookup by a former login is byte for byte the answer for a
 * login nobody ever registered, so nothing built on it could honestly say
 * "renamed" — it would be this issue's own defect pointing the other way. The
 * asymmetry that makes an answer possible is that a REPOSITORY path survives a
 * rename, and the same run shows it on a public pair, `zeit`, renamed to
 * `vercel`:
 *
 *   GET /repos/zeit/next.js   301 → /repositories/70107786 → full_name vercel/next.js
 *
 * And the trap the maintainer named, live on that same pair: an organisation
 * login is FREE the moment a rename completes, and `zeit` has been taken. `GET
 * /orgs/zeit` answers 200 for account id 60456076, created 2020-01-30, while
 * the repositories that left it belong to id 14985020. A board that read the
 * old login as an organisation would be reading a stranger's.
 *
 * So the question this module asks is never "what is at that login". It is
 * "does a repository I ALREADY REACH also answer at that login", and the answer
 * is only believed when the repository that comes back is the same repository —
 * compared by Github's numeric id, which a rename does not change and a
 * same-named repository in a stranger's organisation cannot forge.
 *
 * TWO REPOSITORIES HAVE TO AGREE. One is not enough, because one repository
 * moving from `old/name` to `new/name` is equally the signature of a single
 * repository TRANSFER between two unrelated organisations, and a transfer is
 * not a rename: saying "old is now new" about it would send somebody to an
 * organisation that is not theirs. Two independent repositories making the same
 * move is not something a transfer explains.
 *
 * The oldest repositories are asked first, by ascending id. A repository
 * created after the rename never lived at the old address and can only ever
 * answer "no"; id order is the closest thing to creation order that a principal
 * carries, so it spends the probe budget on the repositories that can actually
 * answer.
 *
 * WHAT THIS CANNOT SEE: A REPOSITORY RENAMED AFTER THE ORGANISATION WAS.
 *
 * The ask below is `old-owner/CURRENT-name`, because the current name is the
 * only name a principal carries. Github keys a repository redirect on the
 * literal historical `owner/name`, so a repository that has been renamed since
 * the organisation was has no record at the address this asks about — that
 * address was never real. Measured on the public pair on 2026-09-17:
 *
 *   GET /repos/vercel/vercel   200, id 67753070      (current owner, current name)
 *   GET /repos/zeit/now        301 → /repositories/67753070  (old owner, old name)
 *   GET /repos/vercel/now      301 → /repositories/67753070  (new owner, old name)
 *   GET /repos/zeit/vercel     404                   (old owner, CURRENT name)
 *
 * `zeit/now` resolving although `zeit` now belongs to a different account is
 * what rules out the other reading: the lookup is on the historical string and
 * not on whoever holds the login today, so the 404 on `zeit/vercel` is the
 * missing record and nothing else.
 *
 * THIS REPOSITORY IS ONE OF THEM. It went `old-owner/repo` →
 * `new-owner/repo` when the organisation was renamed, and then
 * `new-owner/old-repo` → `new-owner/new-repo` when the repository was. This
 * module will ask `GET /repos/old-owner/new-repo` and be told 404, however
 * true the rename is.
 *
 * It fails in the safe direction — a repository renamed this way can cost a
 * rename the board would have proved and can never invent one — and the rule is
 * deliberately NOT relaxed to compensate: two witnesses is what the transfer
 * argument above requires, and trading it for a wider reach would be trading
 * away the thing that stops somebody being sent into a stranger's organisation.
 * What it costs is margin. The probe set is the five OLDEST repositories, which
 * is exactly where a long-lived repository like this one sits, so each such
 * rename takes the set from five usable witnesses towards the two that are
 * needed. A rebranding that renames several repositories at once — #1176 is
 * that shape — can take it below two, and then a real rename reads as the
 * ordinary refusal. Anyone testing this against the live organisation and
 * finding no rename sentence should count the untouched repositories before
 * concluding the mechanism is broken.
 */

/** One repository this person reaches, reduced to what the question needs. */
export interface KnownRepo {
  id: number;
  owner: string;
  name: string;
}

/** What Github answers for one `owner/name` ask, after any redirect it served. */
export interface AskedRepo {
  id: number;
  owner: string;
}

/** The one thing this module does over the network, injected so the decision
 *  above can be tested without one. `null` is every failure and every refusal:
 *  a 404, a 403, a dropped socket. None of them is evidence of a rename, so
 *  none of them needs telling apart here. */
export type AskRepo = (owner: string, name: string) => Promise<AskedRepo | null>;

/** How many repositories are asked about. Five round trips on a refusal screen
 *  nobody is reading a number off, against a person who typically reaches
 *  seventy. */
export const RENAME_PROBES = 5;

/** How many of them have to agree before the board will say "renamed" — see the
 *  transfer argument above. */
export const RENAME_AGREEMENT = 2;

/** A Github owner login: alphanumeric and hyphen, no leading hyphen, 39 at
 *  most. The same shape `config/github-orgs.ts` accepts, and the reason it is
 *  checked here is that this login arrives off an address bar. */
export const OWNER_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** The repositories a principal carries, in the shape the question wants. */
export function knownRepos(repositories: readonly GithubRepository[]): KnownRepo[] {
  return repositories.map((r) => ({ id: r.id, owner: r.owner.login, name: r.name }));
}

/** Which repositories get asked about, oldest first. The tie-break on full name
 *  is not expected to fire — Github ids are unique — and is here so the set is
 *  the same set on every run, which is what makes the answer reproducible. */
export function probeSet(repos: readonly KnownRepo[], limit = RENAME_PROBES): KnownRepo[] {
  return [...repos]
    .sort((a, b) => a.id - b.id || `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`))
    .slice(0, limit);
}

/**
 * The owner this login's work is under now, or `null` for every case the board
 * cannot prove.
 *
 * `null` covers a login that never existed, a login whose organisation is alive
 * and simply does not admit this person, and a login the board has no
 * repository old enough to ask about. The caller shows its ordinary refusal for
 * all three, which is what it showed before this existed.
 */
export async function whereOwnerWent(
  login: string,
  repos: readonly KnownRepo[],
  ask: AskRepo,
): Promise<string | null> {
  if (!OWNER_LOGIN.test(login)) return null;
  const folded = login.toLowerCase();
  // A login this person already reaches is not a former name of anything. The
  // refusal screen never asks about one, and answering it would turn "you were
  // refused this organisation" into "this organisation is now itself".
  if (repos.some((r) => r.owner.toLowerCase() === folded)) return null;
  const probes = probeSet(repos);
  const moved = await Promise.all(
    probes.map(async (repo) => {
      // `repo.name` is the name this repository has TODAY, and a repository
      // renamed since the organisation was has no record at that address. See
      // the docblock: it costs a witness, never invents one.
      const found = await ask(login, repo.name);
      // The id is the whole of the proof. Without it, a stranger's organisation
      // holding a repository of the same name answers 200 and reads as a rename.
      return found && found.id === repo.id ? repo.owner : null;
    }),
  );
  const counts = new Map<string, { owner: string; count: number }>();
  for (const owner of moved) {
    if (owner === null) continue;
    const key = owner.toLowerCase();
    const seen = counts.get(key) ?? { owner, count: 0 };
    seen.count += 1;
    counts.set(key, seen);
  }
  const agreed = [...counts.values()].filter((o) => o.count >= RENAME_AGREEMENT);
  // Exactly one. Two owners each carrying two repositories out of one login is
  // not a rename either way round, and the board has nothing to say about it.
  return agreed.length === 1 ? agreed[0].owner : null;
}

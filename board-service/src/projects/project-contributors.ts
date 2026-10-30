/**
 * Whose work a board's completed issues were (#454) — the tally behind the
 * segmented completion ring.
 *
 * The ring's arc is the board's closed share, cut into one run per person. That
 * only holds if the runs sum to `closed`: a segment list that quietly drops the
 * issues automation closed, or the tail of a crowded board, would paint a ring
 * that disagrees with the percentage in its own middle. So nothing is dropped —
 * everything lands in exactly one bucket, and the two aggregate buckets carry
 * the leftovers openly.
 *
 * Both attributions are tallied by the same function; the sources feed it one
 * login per closed issue, and which login that is (the closer or the assignee)
 * is the caller's choice. See `ProjectSummary.contributors` for why both ship.
 */
import { isBotActor } from './bot-actors';
import type { ProjectContributor } from './project.types';

/**
 * How many people get their own colour before the tail is folded together.
 *
 * Five, for two reasons that meet at about the same number. The palette holds
 * eight stable hues, but a colour-vision pass over them shows that past ~5
 * simultaneous hues the segments stop separating for a deuteranope — orange,
 * yellow and red converge on one olive. And the small ring is 34px across, so
 * a sixth run on a busy board is a few pixels of arc that no one can aim a
 * cursor at. Past five, the rest becomes one `others` run, named in the legend
 * with its own count, so the reader can always see that a tail exists.
 */
export const CONTRIBUTOR_CAP = 5;

/**
 * One login per closed issue → the ring's segment list, biggest share first.
 *
 * A missing login (nobody assigned, a deleted account, no close event on
 * record) and a bot login both land in `unattributed` rather than being
 * dropped or given a person's colour: a close nobody's hand is on is a real
 * part of the board's progress, it just isn't anyone's contribution. Ties in
 * the ranking break on login so the order — and therefore nothing about the
 * render — depends on Map insertion order.
 */
export function tallyContributors(logins: (string | null | undefined)[]): ProjectContributor[] {
  const counts = new Map<string, number>();
  let unattributed = 0;
  for (const raw of logins) {
    const login = (raw ?? '').trim();
    if (!login || isBotActor(login)) {
      unattributed++;
      continue;
    }
    counts.set(login, (counts.get(login) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const named = ranked.slice(0, CONTRIBUTOR_CAP);
  const tail = ranked.slice(CONTRIBUTOR_CAP);

  const out: ProjectContributor[] = named.map(([login, closed]) => ({ login, closed, kind: 'person' as const }));
  if (tail.length) {
    out.push({
      login: '',
      closed: tail.reduce((sum, [, n]) => sum + n, 0),
      kind: 'others',
      people: tail.length,
    });
  }
  if (unattributed) out.push({ login: '', closed: unattributed, kind: 'unattributed' });
  return out;
}

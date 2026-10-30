/**
 * Whose work a board's progress was (#454) — the model behind the segmented
 * completion ring and the hover that names its runs.
 *
 * The server sends one run per person plus, when needed, an `others` run and an
 * `unattributed` run (see `ProjectContributor` in api.ts). This module turns
 * those into painted segments: it picks which of the two attributions to read,
 * reads each person's colour from the one place that decides it
 * (`src/member-color.ts`, #477), and writes the label the hover shows.
 */
import type { Person } from '../api/people';
import type { ProjectContributor } from '../api/projects';
import { resolvePerson } from '../people-ctx';
import { memberColors } from '../member-color';
import type { RingSegment } from '../ui/ring';
import { firstName } from './pulse';

// ─── Attribution ─────────────────────────────────────────────────────────────
/**
 * Whose name goes on a closed issue: the person who CLOSED it, or the person it
 * was ASSIGNED to. The two disagree often — a repo where one person merges
 * everything credits that person under `closer`, and a board where half the work
 * was never assigned reads half `unattributed` under `assignee`. Neither is
 * wrong; they answer different questions ("who moved it" vs "whose was it").
 *
 * The API carries both, so this is the only line that has to change to switch
 * the whole product over. `closer` is the standing default because it matches
 * what the surface already says elsewhere — the rollup's last-closed line reads
 * "closed by whom" from the same event.
 */
export type Attribution = 'closer' | 'assignee';
export const RING_ATTRIBUTION: Attribution = 'closer';

/** The runs the ring should paint for a board, per `RING_ATTRIBUTION`. Empty
 *  when the board has nothing closed, or when board-api predates the field —
 *  either way the ring falls back to its single brand arc. */
export function contributorsOf(p: {
  contributors?: ProjectContributor[];
  contributorsByAssignee?: ProjectContributor[];
}): ProjectContributor[] {
  const runs = RING_ATTRIBUTION === 'assignee' ? p.contributorsByAssignee : p.contributors;
  return runs ?? [];
}

// ─── Segments ────────────────────────────────────────────────────────────────
/** A painted run plus everything the hover needs to name it. */
export interface ContributionSegment {
  key: string;
  label: string;
  closed: number;
  color: string;
  kind: ProjectContributor['kind'];
}

/** How the folded tail names itself. The count matters — "3 others" tells you a
 *  tail exists and how deep it is; a bare "Others" would hide that. Singular
 *  when the cap folded exactly one person, which happens at cap + 1. */
const othersLabel = (n: number) => (n === 1 ? '1 other' : `${n} others`);

/**
 * Server runs → painted segments, in the order the server ranked them (biggest
 * share first, the two aggregate runs last). Share order, not colour order: the
 * ring is a share chart, so the eye should meet the largest contribution first,
 * and the aggregates read as one quiet region where the named work ends.
 */
export function contributionSegments(
  contributors: ProjectContributor[],
  people: Person[],
): ContributionSegment[] {
  const colorOf = memberColors(people);
  return contributors.map((c, i) => {
    if (c.kind === 'person') {
      const person = resolvePerson(people, c.login);
      return {
        key: `p:${c.login}`,
        label: firstName(person?.displayName ?? c.login),
        closed: c.closed,
        color: colorOf(c.login),
        kind: c.kind,
      };
    }
    const others = c.kind === 'others';
    return {
      key: `${c.kind}:${i}`,
      label: others ? othersLabel(c.people ?? 0) : 'Unattributed',
      closed: c.closed,
      color: others ? 'var(--seg-others)' : 'var(--seg-unattributed)',
      kind: c.kind,
    };
  });
}

/** Segments → the shape `Ring` paints. */
export function ringSegments(segments: ContributionSegment[]): RingSegment[] {
  return segments.map((s) => ({ key: s.key, value: s.closed, color: s.color }));
}

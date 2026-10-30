import { describe, expect, it } from 'vitest';
import type { Person } from '../api/people';
import type { ProjectContributor } from '../api/projects';
import {
  contributionSegments,
  contributorsOf,
  RING_ATTRIBUTION,
  ringSegments,
} from './contributors';
import { memberColors } from '../member-color';

function person(login: string, displayName: string): Person {
  return {
    id: `${login}@acme.dev`,
    displayName,
    emails: [`${login}@acme.dev`],
    clickupNames: [],
    githubLogin: login,
  };
}

const PEOPLE = [person('octocat', 'Octocat'), person('ivanroslov', 'Ivan Roslov'), person('antonk', 'Anton K')];

const p = (login: string, closed: number): ProjectContributor => ({ login, closed, kind: 'person' });

describe('contributorsOf (#454)', () => {
  const board = {
    contributors: [p('octocat', 5)],
    contributorsByAssignee: [p('antonk', 5)],
  };

  it('reads the array the single attribution constant selects', () => {
    const expected = RING_ATTRIBUTION === 'assignee' ? board.contributorsByAssignee : board.contributors;
    expect(contributorsOf(board)).toEqual(expected);
  });

  it('degrades to no segments when board-api predates the field', () => {
    expect(contributorsOf({})).toEqual([]);
  });
});

describe('segment colour (#454/#477)', () => {
  it("reads a run's colour from the member scheme, not from its rank on the board", () => {
    const colorOf = memberColors(PEOPLE);
    // Same three people, opposite standings — nobody repaints.
    const busy = contributionSegments([p('octocat', 14), p('ivanroslov', 6)], PEOPLE);
    const quiet = contributionSegments([p('ivanroslov', 20), p('octocat', 1)], PEOPLE);
    const colorIn = (segs: typeof busy, login: string) => segs.find((s) => s.key === `p:${login}`)?.color;
    expect(colorIn(busy, 'octocat')).toBe(colorOf('octocat'));
    expect(colorIn(quiet, 'octocat')).toBe(colorOf('octocat'));
    expect(colorIn(busy, 'ivanroslov')).toBe(colorOf('ivanroslov'));
    expect(colorIn(quiet, 'ivanroslov')).toBe(colorOf('ivanroslov'));
  });

  it('gives a run for someone off the roster the neutral rather than a hue', () => {
    const segs = contributionSegments([p('drive-by', 2)], PEOPLE);
    expect(segs[0].color).toBe('var(--seg-none)');
  });
});

describe('contributionSegments (#454)', () => {
  it('names a person by their first name, falling back to the login when unresolved', () => {
    const segs = contributionSegments([p('octocat', 3), p('ghost', 1)], PEOPLE);
    expect(segs.map((s) => s.label)).toEqual(['Octocat', 'ghost']);
  });

  it('names the two aggregate runs and gives them non-person tones', () => {
    const segs = contributionSegments(
      [p('octocat', 3), { login: '', closed: 4, kind: 'others', people: 3 }, { login: '', closed: 2, kind: 'unattributed' }],
      PEOPLE,
    );
    expect(segs.map((s) => s.label)).toEqual(['Octocat', '3 others', 'Unattributed']);
    expect(segs[1].color).toBe('var(--seg-others)');
    expect(segs[2].color).toBe('var(--seg-unattributed)');
  });

  it('says "1 other" when the cap folded exactly one person', () => {
    const segs = contributionSegments([{ login: '', closed: 2, kind: 'others', people: 1 }], PEOPLE);
    expect(segs[0].label).toBe('1 other');
  });

  it('keeps the server ranking, so the biggest share is met first', () => {
    const segs = contributionSegments([p('ivanroslov', 9), p('octocat', 2)], PEOPLE);
    expect(segs.map((s) => s.closed)).toEqual([9, 2]);
  });
});

describe('ringSegments (#454)', () => {
  it('hands the ring one run per segment, valued by closed count', () => {
    const segs = contributionSegments([p('octocat', 3), p('antonk', 1)], PEOPLE);
    expect(ringSegments(segs)).toEqual([
      { key: 'p:octocat', value: 3, color: segs[0].color },
      { key: 'p:antonk', value: 1, color: segs[1].color },
    ]);
  });
});

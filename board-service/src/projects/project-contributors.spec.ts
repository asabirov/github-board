import { describe, expect, it } from 'vitest';
import { CONTRIBUTOR_CAP, tallyContributors } from './project-contributors';

/** The property the segmented ring rests on: every closed issue lands in
 *  exactly one run, so the runs sum to the closed count the percentage is
 *  computed from. */
const total = (runs: { closed: number }[]) => runs.reduce((s, r) => s + r.closed, 0);

describe('tallyContributors (#454)', () => {
  it('counts one run per person, biggest share first', () => {
    const runs = tallyContributors(['ivanroslov', 'octocat', 'octocat', 'antonk', 'octocat', 'ivanroslov']);
    expect(runs).toEqual([
      { login: 'octocat', closed: 3, kind: 'person' },
      { login: 'ivanroslov', closed: 2, kind: 'person' },
      { login: 'antonk', closed: 1, kind: 'person' },
    ]);
    expect(total(runs)).toBe(6);
  });

  it('breaks an equal-share tie on login, so the order never depends on input order', () => {
    const a = tallyContributors(['zoe', 'adam']);
    const b = tallyContributors(['adam', 'zoe']);
    expect(a.map((r) => r.login)).toEqual(['adam', 'zoe']);
    expect(a).toEqual(b);
  });

  it('a board with nothing closed has no runs at all', () => {
    expect(tallyContributors([])).toEqual([]);
  });

  // ── Attribution: the same function serves both, the caller picks the login ──
  it('attributes by closer when fed close-event actors', () => {
    // Ivan closed everything; Octocat was assigned everything.
    const closers = ['ivanroslov', 'ivanroslov', 'ivanroslov'];
    expect(tallyContributors(closers)).toEqual([{ login: 'ivanroslov', closed: 3, kind: 'person' }]);
  });

  it('attributes by assignee when fed assignee logins — a different answer on the same issues', () => {
    const assignees = ['octocat', 'octocat', 'antonk'];
    expect(tallyContributors(assignees)).toEqual([
      { login: 'octocat', closed: 2, kind: 'person' },
      { login: 'antonk', closed: 1, kind: 'person' },
    ]);
  });

  // ── Bot and null actors ────────────────────────────────────────────────────
  it('groups bot and missing actors into one unattributed run rather than dropping them', () => {
    const runs = tallyContributors([
      'octocat',
      null,
      undefined,
      '',
      '   ',
      'github-actions',
      'dependabot[bot]',
      'Renovate',
    ]);
    expect(runs).toEqual([
      { login: 'octocat', closed: 1, kind: 'person' },
      { login: '', closed: 7, kind: 'unattributed' },
    ]);
    expect(total(runs)).toBe(8);
  });

  it('puts the unattributed run last, after every person', () => {
    const runs = tallyContributors([null, null, null, 'octocat']);
    expect(runs.map((r) => r.kind)).toEqual(['person', 'unattributed']);
  });

  // ── Truncation cap ─────────────────────────────────────────────────────────
  it('names up to the cap and folds the tail into one others run, counting the people it stands for', () => {
    // 7 people, descending closes: 7,6,5,4,3,2,1 = 28 issues.
    const logins: string[] = [];
    const people = ['p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1'];
    people.forEach((login, i) => {
      for (let n = 0; n < people.length - i; n++) logins.push(login);
    });

    const runs = tallyContributors(logins);
    expect(runs.filter((r) => r.kind === 'person')).toHaveLength(CONTRIBUTOR_CAP);
    expect(runs.map((r) => r.login).slice(0, CONTRIBUTOR_CAP)).toEqual(['p7', 'p6', 'p5', 'p4', 'p3']);
    expect(runs[CONTRIBUTOR_CAP]).toEqual({ login: '', closed: 3, kind: 'others', people: 2 });
    expect(total(runs)).toBe(28);
  });

  it('does not add an others run when the contributors fit under the cap', () => {
    const runs = tallyContributors(['a', 'b', 'c']);
    expect(runs.some((r) => r.kind === 'others')).toBe(false);
  });

  it('keeps others before unattributed, so the two quiet runs sit together at the end', () => {
    const logins = ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', null, null];
    const runs = tallyContributors(logins);
    expect(runs.map((r) => r.kind)).toEqual([
      'person',
      'person',
      'person',
      'person',
      'person',
      'others',
      'unattributed',
    ]);
    expect(total(runs)).toBe(logins.length);
  });
});

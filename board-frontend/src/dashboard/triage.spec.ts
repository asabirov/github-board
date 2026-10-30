import { describe, expect, it } from 'vitest';
import type { PersonalIssue } from '../api/issues';
import type { PersonalIssueType } from '../api/types';
import { triageCounts } from './triage';

/** Minimal PersonalIssue for count tests — only `type` is load-bearing here. */
function issue(type: PersonalIssueType, over: Partial<PersonalIssue> = {}): PersonalIssue {
  return {
    repo: 'board',
    owner: 'acme',
    number: 1,
    title: 't',
    htmlUrl: 'https://github.com/acme/board/issues/1',
    createdAt: '2026-08-01T00:00:00.000Z',
    ageDays: 3,
    labels: [type],
    type,
    blocked: false,
    assignedToMe: true,
    assignees: ['octocat'],
    author: 'octocat',
    projects: [],
    state: 'open',
    closedAt: null,
    ...over,
  };
}

describe('triageCounts (#412)', () => {
  it('tallies bugs and feedback by type, ignoring feature/chore', () => {
    const issues = [
      issue('bug'),
      issue('bug'),
      issue('feedback'),
      issue('feature'),
      issue('chore'),
    ];
    expect(triageCounts(issues)).toEqual({ bugs: 2, feedback: 1 });
  });

  it('returns zeros for an empty queue (nothing assigned to me)', () => {
    expect(triageCounts([])).toEqual({ bugs: 0, feedback: 0 });
  });

  it('returns zeros when I have only feature/chore work', () => {
    expect(triageCounts([issue('feature'), issue('chore')])).toEqual({ bugs: 0, feedback: 0 });
  });
});

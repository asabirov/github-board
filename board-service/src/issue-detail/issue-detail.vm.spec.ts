import { describe, expect, it } from 'vitest';
import { GqlIssue, shapeIssue } from './issue-detail.vm';

function gql(p: Partial<GqlIssue> = {}): GqlIssue {
  return {
    number: 218,
    title: "Board deploy didn't fire on merge",
    state: 'OPEN',
    url: 'https://github.com/acme/acme/issues/218',
    body: 'body **md**',
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-25T00:00:00Z',
    author: { login: 'IvanRoslov', name: 'Ivan Roslov' },
    labels: { nodes: [{ name: 'bug', color: 'd73a4a' }, { name: 'deploy', color: '0e8a16' }] },
    assignees: { nodes: [{ login: 'octocat', name: 'Octocat Octocat' }] },
    milestone: { title: 'C4' },
    closedByPullRequestsReferences: {
      nodes: [{ number: 240, url: 'https://x/240', title: 'avatars', state: 'MERGED' }],
    },
    comments: { totalCount: 2, nodes: [
      { url: 'https://github.com/acme/acme/issues/218#issuecomment-1', author: { login: 'octocat', name: 'Octocat' }, body: 'c1', createdAt: '2026-07-22T00:00:00Z' },
      { url: 'https://github.com/acme/acme/issues/218#issuecomment-2', author: null, body: 'c2', createdAt: '2026-07-23T00:00:00Z' },
    ] },
    ...p,
  };
}

describe('shapeIssue', () => {
  it('maps the full issue, lowercasing state and PR state', () => {
    const d = shapeIssue('acme', 'acme', gql(), 100);
    expect(d).toMatchObject({
      owner: 'acme', repo: 'acme', number: 218, state: 'open',
      htmlUrl: 'https://github.com/acme/acme/issues/218',
      author: { login: 'IvanRoslov', name: 'Ivan Roslov' },
      labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'deploy', color: '0e8a16' }],
      assignees: [{ login: 'octocat', name: 'Octocat Octocat' }],
      milestone: 'C4',
      bodyMarkdown: 'body **md**',
    });
    expect(d.linkedPrs).toEqual([{ number: 240, url: 'https://x/240', title: 'avatars', state: 'merged' }]);
    expect(d.comments).toHaveLength(2);
    expect(d.comments[0].htmlUrl).toBe('https://github.com/acme/acme/issues/218#issuecomment-1');
    expect(d.comments[1].author).toBeNull(); // ghost author survives
    expect(d.commentsTruncated).toBe(false);
  });

  it('caps comments and flags truncation from totalCount', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      url: `https://x/#issuecomment-${i}`, author: { login: `u${i}` }, body: `c${i}`, createdAt: '2026-07-22T00:00:00Z',
    }));
    const d = shapeIssue('o', 'r', gql({ comments: { totalCount: 40, nodes } }), 3);
    expect(d.comments).toHaveLength(3);
    expect(d.totalComments).toBe(40);
    expect(d.commentsTruncated).toBe(true);
  });

  it('falls back to a neutral grey when a label has no color (#289)', () => {
    const d = shapeIssue('o', 'r', gql({ labels: { nodes: [{ name: 'wip' }] } }), 100);
    expect(d.labels).toEqual([{ name: 'wip', color: '6a737d' }]);
  });

  it('never throws on a half-null payload (deleted author, no milestone/labels)', () => {
    const d = shapeIssue('o', 'r', gql({
      author: null, milestone: null, labels: null, assignees: null,
      closedByPullRequestsReferences: null, comments: null, body: null,
      projectItems: null,
    }), 100);
    expect(d.author).toBeNull();
    expect(d.milestone).toBeNull();
    expect(d.labels).toEqual([]);
    expect(d.assignees).toEqual([]);
    expect(d.linkedPrs).toEqual([]);
    expect(d.comments).toEqual([]);
    expect(d.totalComments).toBe(0);
    expect(d.bodyMarkdown).toBe('');
    expect(d.projects).toEqual([]);
  });

  it('maps projectItems into IssueProjectMembership (fields + values) (#384)', () => {
    const d = shapeIssue('acme', 'acme', gql({
      projectItems: {
        nodes: [
          {
            id: 'ITEM1',
            project: {
              id: 'PROJ1',
              number: 7,
              title: 'Board hardening',
              fields: {
                nodes: [
                  {
                    __typename: 'ProjectV2SingleSelectField',
                    id: 'F1',
                    name: 'Status',
                    options: [
                      { id: 'o1', name: 'Todo', color: 'GRAY' },
                      { id: 'o2', name: 'Doing', color: 'BLUE' },
                    ],
                  },
                ],
              },
            },
            fieldValues: {
              nodes: [
                { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { id: 'F1' }, optionId: 'o2' },
              ],
            },
          },
        ],
      },
    }), 100);

    expect(d.projects).toHaveLength(1);
    expect(d.projects[0]).toEqual({
      projectId: 'PROJ1',
      itemId: 'ITEM1',
      number: 7,
      title: 'Board hardening',
      fields: [
        {
          fieldId: 'F1',
          name: 'Status',
          dataType: 'single_select',
          options: [
            { id: 'o1', name: 'Todo', color: 'GRAY' },
            { id: 'o2', name: 'Doing', color: 'BLUE' },
          ],
        },
      ],
      values: { F1: { kind: 'single_select', optionId: 'o2' } },
    });
  });

  // #1199 — the page tells the board's workflow states from an ordinary
  // single-select field by a marker, and the marker is made here: the project's
  // own `createdAt` has to reach every field of that project, or the rule has
  // nothing to compare against.
  it('marks the Status GitHub seeded the project with, and nothing added later', () => {
    const seeded = '2026-03-04T10:15:22Z';
    const d = shapeIssue('acme', 'acme', gql({
      projectItems: {
        nodes: [
          {
            id: 'ITEM1',
            project: {
              id: 'PROJ1',
              number: 7,
              title: 'Board hardening',
              createdAt: seeded,
              fields: {
                nodes: [
                  // Renamed since, and still the field GitHub seeded.
                  { __typename: 'ProjectV2SingleSelectField', id: 'F1', name: 'State', createdAt: seeded, options: [] },
                  // Added by the team, and called "status" by a team that did
                  // not know the first one was taken.
                  { __typename: 'ProjectV2SingleSelectField', id: 'F2', name: 'status', createdAt: '2026-06-01T09:00:00Z', options: [] },
                ],
              },
            },
          },
        ],
      },
    }), 100);

    expect(d.projects[0].fields.map((f) => [f.fieldId, f.builtInStatus])).toEqual([['F1', true], ['F2', undefined]]);
  });

  // The collision the rule refuses to resolve (#1212): GitHub stamps
  // `createdAt` to the second, so a single-select created in the same second as
  // its project — or a whole schema copied into a new one — shares that instant
  // without being the seeded Status. Neither is marked, and both keep the
  // search field the page draws by default.
  it('marks neither single-select where two carry the project\u2019s instant', () => {
    const seeded = '2026-03-04T10:15:22Z';
    const d = shapeIssue('acme', 'acme', gql({
      projectItems: {
        nodes: [
          {
            id: 'ITEM1',
            project: {
              id: 'PROJ1',
              number: 7,
              title: 'Copied board',
              createdAt: seeded,
              fields: {
                nodes: [
                  { __typename: 'ProjectV2SingleSelectField', id: 'F1', name: 'Status', createdAt: seeded, options: [] },
                  { __typename: 'ProjectV2SingleSelectField', id: 'F2', name: 'Team', createdAt: seeded, options: [] },
                  { __typename: 'ProjectV2Field', id: 'F3', name: 'Title', dataType: 'TEXT', createdAt: seeded },
                ],
              },
            },
          },
        ],
      },
    }), 100);

    expect(d.projects[0].fields.map((f) => [f.fieldId, f.builtInStatus]))
      .toEqual([['F1', undefined], ['F2', undefined], ['F3', undefined]]);
  });

  it('defaults projects to [] when projectItems is absent', () => {
    const d = shapeIssue('o', 'r', gql(), 100);
    expect(d.projects).toEqual([]);
  });

  // #467: Github's ORG-LEVEL issue type (Task/Bug/Feature) — the real
  // `issueType` field, not the label heuristic `deriveIssueType` reads.
  it('maps Github issueType to its name (#467)', () => {
    const d = shapeIssue('o', 'r', gql({ issueType: { name: 'Feature' } }), 100);
    expect(d.issueType).toBe('Feature');
  });

  it('leaves issueType null when the issue is untyped (#467)', () => {
    expect(shapeIssue('o', 'r', gql({ issueType: null }), 100).issueType).toBeNull();
    expect(shapeIssue('o', 'r', gql(), 100).issueType).toBeNull();
  });

  // #469: how this issue sits among others — parent, sub-issues (with Github's
  // own completion summary), and the two dependency directions.
  describe('relations (#469)', () => {
    // Every reference carries a label connection, because since #497 that is
    // what the words gate places a NEIGHBOUR by — a relation shaped without one
    // would prove the mapping over data the live query no longer sends.
    const ref = (
      number: number,
      state: 'OPEN' | 'CLOSED',
      nameWithOwner = 'acme/acme',
      labels: string[] = [],
    ) => ({
      number, title: `#${number}`, url: `https://github.com/${nameWithOwner}/issues/${number}`,
      state, repository: { nameWithOwner },
      labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) },
    });

    it('maps the parent, splitting its repo into owner + repo', () => {
      const d = shapeIssue('acme', 'acme', gql({
        parent: ref(130, 'OPEN', 'acme/compliance.example.com'),
      }), 100);
      expect(d.relations.parent).toEqual({
        owner: 'acme',
        repo: 'compliance.example.com',
        number: 130,
        title: '#130',
        state: 'open',
        url: 'https://github.com/acme/compliance.example.com/issues/130',
        labels: [],
      });
    });

    it("takes Github's sub-issue summary over the fetched page", () => {
      // The page is capped, the summary is not — "8 of 19 done" must stay true
      // past the page, so the counts come from `subIssuesSummary`.
      const d = shapeIssue('acme', 'acme', gql({
        subIssues: { nodes: [ref(131, 'CLOSED'), ref(132, 'OPEN')] },
        subIssuesSummary: { total: 19, completed: 8 },
      }), 100);
      expect(d.relations.subIssues.map((s) => s.number)).toEqual([131, 132]);
      expect(d.relations.subIssuesTotal).toBe(19);
      expect(d.relations.subIssuesClosed).toBe(8);
    });

    it('falls back to counting the fetched sub-issues when no summary comes back', () => {
      const d = shapeIssue('acme', 'acme', gql({
        subIssues: { nodes: [ref(131, 'CLOSED'), ref(132, 'OPEN'), ref(133, 'CLOSED')] },
        subIssuesSummary: null,
      }), 100);
      expect(d.relations.subIssuesTotal).toBe(3);
      expect(d.relations.subIssuesClosed).toBe(2);
    });

    it('keeps blocked-by and blocking apart', () => {
      const d = shapeIssue('acme', 'acme', gql({
        blockedBy: { nodes: [ref(300, 'OPEN')] },
        blocking: { nodes: [ref(400, 'CLOSED', 'other-org/thing')] },
      }), 100);
      expect(d.relations.blockedBy.map((r) => r.number)).toEqual([300]);
      expect(d.relations.blocking).toEqual([{
        owner: 'other-org', repo: 'thing', number: 400, title: '#400', state: 'closed',
        url: 'https://github.com/other-org/thing/issues/400', labels: [],
      }]);
    });

    it('an issue with no relations carries empty ones, never null', () => {
      const d = shapeIssue('o', 'r', gql(), 100);
      expect(d.relations).toEqual({
        parent: null, subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0,
        blockedBy: [], blocking: [],
      });
    });

    it('never throws on a half-null relations payload', () => {
      const d = shapeIssue('o', 'r', gql({
        parent: null, subIssues: null, subIssuesSummary: null, blockedBy: null, blocking: null,
      }), 100);
      expect(d.relations.parent).toBeNull();
      expect(d.relations.subIssues).toEqual([]);
    });

    it('falls back to the host repo when a reference carries no repository', () => {
      const d = shapeIssue('acme', 'acme', gql({
        parent: { number: 9, title: 'p', url: 'https://x/9', state: 'OPEN' },
      }), 100);
      expect(d.relations.parent).toMatchObject({ owner: 'acme', repo: 'acme' });
    });

    // #497: the words gate places a neighbour by its labels, so the shaping has
    // to carry them — and has to say when it could not establish them, rather
    // than reporting an empty set the gate would read as "no `feedback` here".
    describe('labels ride along for the words gate (#497)', () => {
      it('a complete page becomes the relation’s label set', () => {
        const d = shapeIssue('acme', 'acme', gql({
          subIssues: { nodes: [ref(901, 'OPEN', 'acme/board', ['feedback', 'bug'])] },
        }), 100);
        expect(d.relations.subIssues[0].labels).toEqual(['feedback', 'bug']);
      });

      it('a page Github had more labels than becomes null, not a short set', () => {
        const d = shapeIssue('acme', 'acme', gql({
          subIssues: { nodes: [{
            number: 901, title: 't', url: 'https://x/901', state: 'OPEN',
            repository: { nameWithOwner: 'acme/board' },
            labels: { totalCount: 40, nodes: [{ name: 'bug' }] },
          }] },
        }), 100);
        expect(d.relations.subIssues[0].labels).toBeNull();
      });

      it('a reference the query selected no labels on is null, not empty', () => {
        const d = shapeIssue('acme', 'acme', gql({
          parent: { number: 9, title: 'p', url: 'https://x/9', state: 'OPEN' },
        }), 100);
        expect(d.relations.parent?.labels).toBeNull();
      });
    });
  });

  // #497: the host issue's own label page. Same rule as a relation's — the gate
  // must be able to tell "no feedback label" from "we never saw the whole set".
  describe('labelsComplete (#497)', () => {
    it('is true when the page holds every label Github has', () => {
      const d = shapeIssue('o', 'r', gql({
        labels: { totalCount: 2, nodes: [{ name: 'bug', color: 'd73a4a' }, { name: 'deploy', color: '0e8a16' }] },
      }), 100);
      expect(d.labelsComplete).toBe(true);
      expect(d.labels.map((l) => l.name)).toEqual(['bug', 'deploy']);
    });

    it('is false when Github held more than the page, and the page still renders', () => {
      const d = shapeIssue('o', 'r', gql({
        labels: { totalCount: 40, nodes: [{ name: 'bug', color: 'd73a4a' }] },
      }), 100);
      expect(d.labelsComplete).toBe(false);
      expect(d.labels).toEqual([{ name: 'bug', color: 'd73a4a' }]);
    });

    it('is false when the query selected no labels at all', () => {
      const d = shapeIssue('o', 'r', gql({ labels: null }), 100);
      expect(d.labelsComplete).toBe(false);
      expect(d.labels).toEqual([]);
    });
  });

  it('does not fall back to a label-derived type (#467)', () => {
    // Labels say "bug"; Github's own issue type is unset. The panel must read
    // untyped, not "bug" — the two taxonomies are different fields.
    const d = shapeIssue('o', 'r', gql({ labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] } }), 100);
    expect(d.issueType).toBeNull();
  });
});

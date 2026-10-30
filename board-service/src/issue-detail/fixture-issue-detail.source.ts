import type { Capability } from '../capability/capability';
import { setTaskChecked } from './body-tasks';
import {
  ClosedIssue,
  ChosenCloseReason,
  CreatedProject,
  FieldValue,
  IIssueDetailSource,
  IssueDetail,
  IssueEditOptions,
  IssueLabel,
  IssueNotFoundError,
  IssueProjectMembership,
  IssueState,
  Person,
  PostedComment,
  ProjectTitleTakenError,
} from './issue-detail.types';

/**
 * Deterministic in-memory issue detail for local dev + tests (no GitHub creds).
 * Keyed by `owner/repo#number`; unknown keys return null so the 404 path is
 * exercisable offline. Times are relative to `now` so ages stay realistic.
 */
const now = Date.now();
const ago = (days: number) => new Date(now - days * 86400_000).toISOString();

/** The one seeded Projects v2 board, owned by the org the board mirrors — the
 *  fixture stand-in for a real `projectOwnerLogin` lookup (Task 7, B1). */
const SEEDED_PROJECT_ID = 'PVT_kwDOAboardhardening';
const SEEDED_PROJECT_OWNER = 'acme';
/** A sentinel project owned OUTSIDE the mirrored org — exercises the B1
 *  add-to-project 404 offline (no real cross-org project to test against). */
const EVIL_PROJECT_ID = 'PVT_evil';
const EVIL_PROJECT_OWNER = 'evilcorp';

/** The projects-catalog boards the add picker offers (#404), keyed by the same
 *  `PVT_fixture_<n>` id the fixture Projects source synthesises. `addToProject`
 *  returns the picked board with this title + a Status field (empty value) — the
 *  fixture stand-in for GitHub returning a newly-added board's real schema, so a
 *  local add reconciles to a complete board group, not a bare title. */
const CATALOG_BOARDS: Record<string, { number: number; title: string }> = {
  PVT_fixture_7: { number: 7, title: 'Acme Go-To-Market' },
};
const ADDED_BOARD_FIELDS: IssueProjectMembership['fields'] = [
  {
    fieldId: 'PVTSSF_status',
    name: 'Status',
    dataType: 'single_select',
    // The board GitHub just created carries the Status GitHub seeded it with,
    // so the fixture says so too (#1199) — the marker the live source derives
    // from the timestamps, for the one single-select that carries the
    // project's own (`mapFieldDefs`).
    builtInStatus: true,
    options: [
      { id: 'opt_todo', name: 'Todo', color: 'GRAY' },
      { id: 'opt_doing', name: 'In progress', color: 'YELLOW' },
      { id: 'opt_done', name: 'Done', color: 'GREEN' },
    ],
  },
];

const BODY = [
  'When PR #240 merged to `main`, the release workflow tagged the image but the',
  'deploy job never ran — so board kept serving the previous revision.',
  '',
  '```',
  'gh run list --workflow=release.yml --limit 1',
  "gh run view <id> --json jobs -q '.jobs[].name'",
  '```',
  '',
  '- Merge any PR labeled `deploy` to `main`',
  '- Watch the release run finish green',
  '- `commitSha` on the live service still points at the prior revision',
  '',
  '### Revisions',
  '',
  '| Stage | Expected | Actual |',
  '| --- | --- | --- |',
  '| Tag image | `sha-a1b2c3d` | `sha-a1b2c3d` |',
  '| Deploy job | ran | ~~ran~~ skipped |',
  '| Live commitSha | `a1b2c3d` | `9f8e7d6` (stale) |',
  '',
  '### Checklist',
  '',
  '- [x] Reproduce on a labeled PR',
  '- [ ] Make the skipped apply step fail loud',
].join('\n');

/** The end user's own words, as the old feedback form filed them: the first line of
 *  their message becomes the issue TITLE, and their address rides in the
 *  attribution the body OPENS with (#749 moved it there; the body below is kept
 *  hand-written and in the legacy trailing shape, because everything already on
 *  Github is that shape and this is the fixture the gates are driven against).
 *  Both are what a static agent token may not read (#497). */
const SUBMISSION_TITLE = '[Bug] my weekly report never arrives and the button just spins';
const SUBMISSION_BODY = [
  'my weekly report never arrives and the button just spins',
  '',
  'I click Send report and the spinner runs forever. Nothing lands in my inbox,',
  'not even in spam. This has happened every Monday for three weeks.',
  '',
  '---',
  'Submitted by octocat@example.org via the board feedback form.',
].join('\n');

/** The same submission after ordinary triage swapped `feedback` for `bug` (#516).
 *  Its labels no longer say what it is; the footer in its body still does — and
 *  the body is the same one, because a triager relabels an issue rather than
 *  rewriting somebody's message. This twin exists so every door can be driven
 *  against a submission the LABEL rule alone would hand over. */
const RELABELLED_TITLE = '[Bug] the digest email arrives empty every second week';

/** That submission as a RELATION of the umbrella above — the shape the #497
 *  relations gate places. Shared between `subIssues` and `blockedBy` so both
 *  doors lead to the same issue. */
const SUBMISSION_RELATION = {
  owner: 'acme',
  repo: 'board',
  number: 901,
  title: SUBMISSION_TITLE,
  state: 'open' as const,
  url: 'https://github.com/acme/board/issues/901',
  labels: ['feedback', 'bug'],
};

/** The relabelled twin as a relation (#516). Carries `bug`, so the label rule
 *  alone reads it as an ordinary team issue — which is the whole point. */
const RELABELLED_RELATION = {
  owner: 'acme',
  repo: 'board',
  number: 902,
  title: RELABELLED_TITLE,
  state: 'open' as const,
  url: 'https://github.com/acme/board/issues/902',
  labels: ['bug', 'in progress'],
};

/** The seed template. Each source instance clones this (so mutating tests don't
 *  bleed into one another) — the fixture SIMULATES GitHub writes in memory. */
const SEED: Record<string, IssueDetail> = {
  'acme/acme#218': {
    owner: 'acme',
    repo: 'acme',
    number: 218,
    title: "Board deploy didn't fire on merge",
    state: 'open',
    htmlUrl: 'https://github.com/acme/acme/issues/218',
    author: { login: 'hubot', name: 'Hubot' },
    createdAt: ago(6),
    updatedAt: ago(2),
    bodyMarkdown: BODY,
    labels: [
      { name: 'bug', color: 'd73a4a' },
      { name: 'deploy', color: '0e8a16' },
    ],
    labelsComplete: true,
    assignees: [{ login: 'octocat', name: 'Octocat' }],
    milestone: 'C4',
    issueType: 'Bug',
    // A full relations shape (#469): an umbrella parent in a SIBLING repo of the
    // same org (in-board, written `owner/repo#NN`), sub-issues in this repo
    // (`#NN`), a same-org blocker, and one blocking issue in ANOTHER org — the
    // only one of the four the page has to send to Github rather than the board.
    relations: {
      parent: {
        owner: 'acme', repo: 'roadmap', number: 42,
        title: 'Board reads like a board, not a mirror',
        state: 'open', url: 'https://github.com/acme/roadmap/issues/42', labels: [],
      },
      subIssues: [
        { owner: 'acme', repo: 'acme', number: 241, title: 'Fail the apply step loudly when the quota rejects it', state: 'closed', url: 'https://github.com/acme/acme/issues/241', labels: ['deploy'] },
        { owner: 'acme', repo: 'acme', number: 242, title: 'Report the live commitSha on the health endpoint', state: 'closed', url: 'https://github.com/acme/acme/issues/242', labels: ['deploy'] },
        { owner: 'acme', repo: 'acme', number: 243, title: 'Re-run the deploy job from the release run', state: 'open', url: 'https://github.com/acme/acme/issues/243', labels: ['deploy'] },
        { owner: 'acme', repo: 'acme', number: 244, title: 'Alert when a tagged image never deploys', state: 'open', url: 'https://github.com/acme/acme/issues/244', labels: ['deploy'] },
        { owner: 'acme', repo: 'acme', number: 245, title: 'Document the quota ceiling in the runbook', state: 'open', url: 'https://github.com/acme/acme/issues/245', labels: ['docs'] },
        // The whole of #497 in one row: an end user's submission filed under this
        // ordinary team umbrella, which is how we triage them. Its TITLE is the
        // first line of their message (`submission-footer.ts`), and reading it costs a
        // caller nothing but a GET on the parent — the parent passes the body
        // gate, because the parent is ours.
        SUBMISSION_RELATION,
        // …and the same submission after triage relabelled it (#516). The label
        // rule alone would read this row as an ordinary `bug` and hand over the
        // end user's first line.
        RELABELLED_RELATION,
      ],
      subIssuesTotal: 7,
      subIssuesClosed: 2,
      blockedBy: [
        { owner: 'acme', repo: 'acme-ui', number: 356, title: 'Ship the EmptyState primitive', state: 'open', url: 'https://github.com/acme/acme-ui/issues/356', labels: ['ui'] },
        // The same submission, reached by the other door.
        SUBMISSION_RELATION,
      ],
      blocking: [
        { owner: 'selgeo', repo: 'selgeo-app', number: 88, title: 'Adopt the shared deploy workflow', state: 'open', url: 'https://github.com/selgeo/selgeo-app/issues/88', labels: [] },
      ],
    },
    linkedPrs: [
      { number: 240, url: 'https://github.com/acme/acme/pull/240', title: 'assignee avatars on cards', state: 'merged' },
    ],
    activity: {state: 'read', events: [
      {id:'fixture-label',kind:'labeled',actor:{login:'hubot',name:'Hubot'},createdAt:ago(5.8),label:'bug'},
      {id:'fixture-assign',kind:'assigned',actor:{login:'hubot',name:'Hubot'},createdAt:ago(4.8),assignee:'octocat'},
      {id:'fixture-milestone',kind:'milestoned',actor:{login:'octocat',name:'Octocat'},createdAt:ago(4.5),milestone:'C4'},
      {id:'fixture-reference',kind:'cross-referenced',actor:{login:'hubot',name:'Hubot'},createdAt:ago(3.8),reference:{url:'https://github.com/acme/acme/issues/241',label:'#241'}},
      {id:'fixture-unassign',kind:'unassigned',actor:{login:'octocat',name:'Octocat'},createdAt:ago(3.5),assignee:'octocat'},
      {id:'fixture-close',kind:'closed',actor:{login:'octocat',name:'Octocat'},createdAt:ago(3)},
      {id:'fixture-reopen',kind:'reopened',actor:null,createdAt:ago(2.5)},
    ]},
    comments: [
      { author: { login: 'octocat', name: 'Octocat' }, bodyMarkdown: 'Confirmed — the apply step hit the k8s Service quota (10/10) and got skipped without failing the run. Not a code bug, an infra limit.', createdAt: ago(5), htmlUrl: 'https://github.com/acme/acme/issues/218#issuecomment-1001' },
      { author: { login: 'monalisa', name: 'Monalisa' }, bodyMarkdown: 'Raised the `acme-default-quota` cap to 16. Re-running the failed job should push the pending revision now.', createdAt: ago(4), htmlUrl: 'https://github.com/acme/acme/issues/218#issuecomment-1002' },
      { author: { login: 'hubot', name: 'Hubot' }, bodyMarkdown: 'Verified — live service is on the latest `commitSha`. Leaving open until the fail-loud fix lands.', createdAt: ago(2), htmlUrl: 'https://github.com/acme/acme/issues/218#issuecomment-1003' },
    ],
    totalComments: 3,
    commentsTruncated: false,
    projects: [
      {
        projectId: SEEDED_PROJECT_ID,
        itemId: 'PVTI_kwDOAitem218',
        number: 3,
        title: 'Board hardening',
        fields: [
          {
            fieldId: 'PVTSSF_status',
            name: 'Status',
            dataType: 'single_select',
            builtInStatus: true,
            options: [
              { id: 'opt_todo', name: 'Todo', color: 'GRAY' },
              { id: 'opt_doing', name: 'In progress', color: 'YELLOW' },
              { id: 'opt_done', name: 'Done', color: 'GREEN' },
            ],
          },
          {
            fieldId: 'PVTSSF_priority',
            name: 'Priority',
            dataType: 'single_select',
            options: [
              { id: 'opt_low', name: 'Low', color: 'GRAY' },
              { id: 'opt_medium', name: 'Medium', color: 'YELLOW' },
              { id: 'opt_high', name: 'High', color: 'RED' },
            ],
          },
          {
            fieldId: 'PVTF_effort',
            name: 'Effort',
            dataType: 'number',
          },
        ],
        values: {
          PVTSSF_status: { kind: 'single_select', optionId: 'opt_doing' },
          PVTSSF_priority: { kind: 'single_select', optionId: 'opt_high' },
          PVTF_effort: { kind: 'number', number: 5 },
        },
      },
    ],
  },
  // A typed issue carrying nothing else — the plain "type shows, no board, no
  // milestone" shape (#467).
  'acme/acme#219': {
    owner: 'acme',
    repo: 'acme',
    number: 219,
    title: 'Name the deploy step that skipped',
    state: 'open',
    htmlUrl: 'https://github.com/acme/acme/issues/219',
    author: { login: 'octocat', name: 'Octocat' },
    createdAt: ago(3),
    updatedAt: ago(1),
    bodyMarkdown: 'The apply step logs nothing when the quota check rejects it, so a green run and a skipped deploy look the same.',
    labels: [{ name: 'deploy', color: '0e8a16' }],
    labelsComplete: true,
    assignees: [],
    milestone: null,
    issueType: 'Task',
    // No relations at all (#469) — the page must render nothing for them here,
    // not an empty panel.
    relations: { parent: null, subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0, blockedBy: [], blocking: [] },
    linkedPrs: [],
    comments: [],
    totalComments: 0,
    commentsTruncated: false,
    projects: [],
  },
  // The submission the umbrella above hangs onto, as its OWN issue (#497). The
  // body route refuses this one to a static agent token — words and address are
  // the whole payload, and there is no redacted version worth serving.
  'acme/board#901': {
    owner: 'acme',
    repo: 'board',
    number: 901,
    title: SUBMISSION_TITLE,
    state: 'open',
    htmlUrl: 'https://github.com/acme/board/issues/901',
    author: { login: 'acme-feedback-bot', name: null },
    createdAt: ago(6),
    updatedAt: ago(2),
    bodyMarkdown: SUBMISSION_BODY,
    labels: [
      { name: 'feedback', color: 'd4c5f9' },
      { name: 'bug', color: 'd73a4a' },
    ],
    labelsComplete: true,
    assignees: [],
    milestone: null,
    issueType: 'Bug',
    relations: {
      parent: {
        owner: 'acme', repo: 'acme', number: 218,
        title: "Board deploy didn't fire on merge",
        state: 'open', url: 'https://github.com/acme/acme/issues/218', labels: ['bug', 'deploy'],
      },
      subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0, blockedBy: [], blocking: [],
    },
    linkedPrs: [],
    comments: [],
    totalComments: 0,
    commentsTruncated: false,
    projects: [],
  },
  // The relabelled twin as its OWN issue (#516). Same footer, `feedback` swapped
  // for `bug` — so the body route must still refuse it to a static agent token,
  // off the footer rather than off the labels.
  'acme/board#902': {
    owner: 'acme',
    repo: 'board',
    number: 902,
    title: RELABELLED_TITLE,
    state: 'open',
    htmlUrl: 'https://github.com/acme/board/issues/902',
    author: { login: 'acme-feedback-bot', name: null },
    createdAt: ago(9),
    updatedAt: ago(1),
    bodyMarkdown: SUBMISSION_BODY,
    labels: [
      { name: 'bug', color: 'd73a4a' },
      { name: 'in progress', color: '0e8a16' },
    ],
    labelsComplete: true,
    assignees: [],
    milestone: null,
    issueType: 'Bug',
    relations: {
      parent: {
        owner: 'acme', repo: 'acme', number: 218,
        title: "Board deploy didn't fire on merge",
        state: 'open', url: 'https://github.com/acme/acme/issues/218', labels: ['bug', 'deploy'],
      },
      subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0, blockedBy: [], blocking: [],
    },
    linkedPrs: [],
    comments: [],
    totalComments: 0,
    commentsTruncated: false,
    projects: [],
  },
  // An UNTYPED issue — the org has issue types, this one carries none, so the
  // panel has to say so honestly rather than invent one from labels (#467).
  'acme/acme#220': {
    owner: 'acme',
    repo: 'acme',
    number: 220,
    title: 'Sync now reads the repo list twice',
    state: 'open',
    htmlUrl: 'https://github.com/acme/acme/issues/220',
    author: { login: 'monalisa', name: 'Monalisa' },
    createdAt: ago(2),
    updatedAt: ago(1),
    bodyMarkdown: 'A manual sync fetches the org repo list once per cache, and there are two caches.',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    labelsComplete: true,
    assignees: [],
    milestone: null,
    issueType: null,
    // No relations at all (#469) — the page must render nothing for them here,
    // not an empty panel.
    relations: { parent: null, subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0, blockedBy: [], blocking: [] },
    linkedPrs: [],
    comments: [],
    totalComments: 0,
    commentsTruncated: false,
    projects: [],
  },
};

export class FixtureIssueDetailSource implements IIssueDetailSource {
  /** A per-instance clone of SEED so a mutating test never leaks state into the
   *  next — each source is its own little GitHub. */
  private readonly seed: Record<string, IssueDetail> = structuredClone(SEED);

  /** The fixture's stand-in for repo-assignable users: a login outside this set
   *  is silently dropped by `setAssignees`, exactly as `issues.update` drops a
   *  non-collaborator — so specs exercise GitHub's coercion (B2) offline. */
  private static readonly ASSIGNABLE = new Set(['octocat', 'hubot', 'monalisa']);

  async fetch(owner: string, repo: string, number: number): Promise<IssueDetail | null> {
    return this.seed[`${owner}/${repo}#${number}`] ?? null;
  }

  /** Read a seed entry or throw the 404 error — the shared lookup for every
   *  fixture mutation, so unknown keys hit the controller's 404 path offline. */
  private entry(owner: string, repo: string, number: number): IssueDetail {
    const e = this.seed[`${owner}/${repo}#${number}`];
    if (!e) throw new IssueNotFoundError(owner, repo, number);
    return e;
  }

  async setState(owner: string, repo: string, number: number, state: IssueState): Promise<IssueState> {
    this.entry(owner, repo, number).state = state;
    return state;
  }

  /** The reason each issue this fixture closed carries, as Github keeps one (#1006). */
  private readonly reasons = new Map<string, string>();

  /** Simulate a close (#287/#291). Unknown keys throw `IssueNotFoundError` (the
   *  404 path). Like Github, the reason only moves when the state does: closing
   *  an issue that is already closed answers with the reason it had, which is
   *  the stale card's case offline. A seed issue closed before any of this
   *  answers `completed`, Github's own default. */
  async close(
    owner: string,
    repo: string,
    number: number,
    _capability?: Capability,
    reason?: ChosenCloseReason,
  ): Promise<ClosedIssue> {
    const e = this.entry(owner, repo, number);
    const key = `${owner}/${repo}#${number}`;
    const alreadyClosed = e.state === 'closed';
    if (!alreadyClosed) this.reasons.set(key, reason ?? 'completed');
    e.state = 'closed';
    return { state: 'closed', stateReason: this.reasons.get(key) ?? 'completed', alreadyClosed };
  }

  async setAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]> {
    // Drop non-assignable logins (B2 coercion): the returned set is what GitHub
    // would accept, NOT the request.
    const accepted: Person[] = logins
      .filter((l) => FixtureIssueDetailSource.ASSIGNABLE.has(l))
      .map((login) => ({ login, name: null }));
    this.entry(owner, repo, number).assignees = accepted;
    return accepted;
  }

  /** Github's add endpoint offline (#1009): the named people join whoever holds
   *  the issue already, and a login the repo will not assign is dropped. */
  async addAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]> {
    const e = this.entry(owner, repo, number);
    const joining = logins.filter(
      (l) => FixtureIssueDetailSource.ASSIGNABLE.has(l) && !e.assignees.some((a) => a.login === l),
    );
    e.assignees = [...e.assignees, ...joining.map((login) => ({ login, name: null }))];
    return [...e.assignees];
  }

  /** Github's remove endpoint offline (#1009): only the named people go. */
  async removeAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]> {
    const e = this.entry(owner, repo, number);
    e.assignees = e.assignees.filter((a) => !logins.includes(a.login));
    return [...e.assignees];
  }

  async currentAssignees(owner: string, repo: string, number: number): Promise<Person[] | null> {
    const e = this.seed[`${owner}/${repo}#${number}`];
    return e ? [...e.assignees] : null;
  }

  async setLabels(owner: string, repo: string, number: number, names: string[]): Promise<IssueLabel[]> {
    const e = this.entry(owner, repo, number);
    // Preserve a known label's colour; fall back to GitHub's default grey for a
    // name we've not seen before.
    e.labels = names.map((name) => ({ name, color: e.labels.find((l) => l.name === name)?.color ?? '8b949e' }));
    return e.labels;
  }

  async setMilestone(owner: string, repo: string, number: number, milestoneNumber: number | null): Promise<string | null> {
    const e = this.entry(owner, repo, number);
    e.milestone = milestoneNumber == null ? null : `M${milestoneNumber}`;
    return e.milestone;
  }

  /** Flip the body task-list checkbox on 1-based `line` in-memory (#426) and echo
   *  the resulting body — the fixture stand-in for GitHub rewriting + returning the
   *  issue body. `setTaskChecked` throws `TaskToggleError` for a non-task line (→ 400). */
  async toggleTask(owner: string, repo: string, number: number, line: number, checked: boolean): Promise<string> {
    const e = this.entry(owner, repo, number);
    e.bodyMarkdown = setTaskChecked(e.bodyMarkdown, line, checked);
    return e.bodyMarkdown;
  }

  /** Append a comment to the seeded thread (#693) and return the STORED entry,
   *  the fixture stand-in for Github recording one. The permalink is minted from
   *  the growing thread length so it carries the `#issuecomment-` shape the page
   *  deep-links with, and `totalComments` moves with the thread — otherwise the
   *  page would read the new comment as one Github had truncated away. */
  async editText(): Promise<{ bodyMarkdown: string }> {
    throw new Error('Fixture text cannot be edited.');
  }

  async addComment(owner: string, repo: string, number: number, bodyMarkdown: string): Promise<PostedComment> {
    const e = this.entry(owner, repo, number);
    const comment = {
      author: { login: 'board', name: 'Board' },
      bodyMarkdown,
      createdAt: new Date().toISOString(),
      htmlUrl: `https://github.com/${owner}/${repo}/issues/${number}#issuecomment-${9000 + e.comments.length}`,
    };
    e.comments = [...e.comments, comment];
    e.totalComments = e.comments.length;
    return comment;
  }

  /** The repo's autocomplete catalog (#384) — labels with colour, open
   *  milestones, repo-assignable logins. Static offline so the panel's editors
   *  populate without GitHub creds. */
  async editOptions(_owner: string, _repo: string): Promise<IssueEditOptions> {
    return {
      labels: [
        { name: 'bug', color: 'd73a4a' },
        { name: 'deploy', color: '0e8a16' },
        { name: 'ui', color: '1f6feb' },
      ],
      milestones: [
        { number: 4, title: 'C4' },
        { number: 5, title: 'C5' },
      ],
      assignableLogins: ['octocat', 'hubot', 'monalisa'],
    };
  }

  // --- Projects v2 membership + custom fields (#384 Task 7) -----------------

  /** Resolve a project node id's owning org/user login — the fixture stand-in
   *  for the real GraphQL lookup. Resolves to this org for the seeded project and
   *  for the projects-catalog boards (`PVT_fixture_*`, #404 — so a candidate the
   *  add picker offers actually passes the write's owner-pin locally, the way a
   *  real board in the owner scope does in prod); one sentinel `PVT_evil` (an
   *  outside org) resolves for the B1 negative test; anything else is unknown →
   *  `null` → the caller's 404. */
  async projectOwnerLogin(projectId: string): Promise<string | null> {
    if (projectId === SEEDED_PROJECT_ID || projectId.startsWith('PVT_fixture_')) return SEEDED_PROJECT_OWNER;
    if (projectId === EVIL_PROJECT_ID) return EVIL_PROJECT_OWNER;
    return this.made.get(projectId)?.owner ?? null;
  }

  /** The projects `createProject` has made on this fixture (#982), by id. */
  private readonly made = new Map<string, { number: number; title: string; owner: string }>();

  /** The fixture's `createProjectV2`: refuses a name an existing board of that
   *  owner already carries, as the live source does, then records the project
   *  so the add that follows finds it. */
  async createProject(owner: string, repo: string, number: number, title: string): Promise<CreatedProject> {
    // The issue first, as the live read asks for it: IssueNotFoundError, and nothing made.
    this.entry(owner, repo, number);
    const known = [
      ...Object.entries(CATALOG_BOARDS).map(([id, b]) => ({ id, ...b, owner: SEEDED_PROJECT_OWNER })),
      ...[...this.made].map(([id, b]) => ({ id, ...b })),
    ];
    const wanted = title.trim().toLowerCase();
    const taken = known.find(
      (p) => p.owner.toLowerCase() === owner.toLowerCase() && p.title.trim().toLowerCase() === wanted,
    );
    if (taken) throw new ProjectTitleTakenError({ id: taken.id, number: taken.number, title: taken.title });
    const seq = 100 + this.made.size;
    const id = `PVT_made_${seq}`;
    this.made.set(id, { number: seq, title, owner });
    return { id, number: seq, title, url: `https://github.com/orgs/${owner}/projects/${seq}`, owner };
  }

  /** Find a membership by its (projectId, itemId) pair across every seeded
   *  issue — `setFieldValue`/`removeFromProject` are keyed by item, not by
   *  owner/repo/number, mirroring the real GraphQL mutations' shape. */
  private findMembership(projectId: string, itemId: string): IssueProjectMembership | undefined {
    for (const issue of Object.values(this.seed)) {
      const membership = issue.projects.find((p) => p.projectId === projectId && p.itemId === itemId);
      if (membership) return membership;
    }
    return undefined;
  }

  async addToProject(owner: string, repo: string, number: number, projectId: string): Promise<{ itemId: string }> {
    const e = this.entry(owner, repo, number);
    const itemId = `PVTI_${owner}_${repo}_${number}_${e.projects.length}`;
    const board = CATALOG_BOARDS[projectId] ?? this.made.get(projectId);
    e.projects.push({
      projectId,
      itemId,
      number: board?.number ?? 0,
      title: board?.title ?? (projectId === SEEDED_PROJECT_ID ? 'Board hardening' : projectId),
      // A catalog board reconciles to its real (empty-valued) field schema, the
      // way GitHub returns a newly added board's fields (#404).
      fields: board ? ADDED_BOARD_FIELDS : [],
      values: {},
    });
    return { itemId };
  }

  // `owner`/`repo` ride the widened interface (#584) so the live source can key
  // what Github refused on `owner/repo`. A fixture addresses its seed by node
  // id and needs neither, but the three signatures read alike.
  async removeFromProject(itemId: string, projectId: string, _owner?: string, _repo?: string): Promise<void> {
    for (const issue of Object.values(this.seed)) {
      const idx = issue.projects.findIndex((p) => p.projectId === projectId && p.itemId === itemId);
      if (idx !== -1) {
        issue.projects.splice(idx, 1);
        return;
      }
    }
  }

  async setFieldValue(
    projectId: string,
    itemId: string,
    fieldId: string,
    value: FieldValue,
    _owner?: string,
    _repo?: string,
  ): Promise<FieldValue> {
    const membership = this.findMembership(projectId, itemId);
    if (membership) membership.values[fieldId] = value;
    return value;
  }
}

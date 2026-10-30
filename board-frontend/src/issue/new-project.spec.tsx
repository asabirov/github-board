/** Pure creation decisions and rendered form states; browser coverage was taken on #1094. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api/core';
import { ProjectCreateError, createProjectForIssue, type MadeProject } from '../api/issues';
import type { ProjectCatalogEntry } from '../api/projects';
import { resetSessionExpiry } from '../auth/session-expiry';
import { meFixture } from '../me-fixture';
import type { Me } from '../use-me';
import { ISSUE_CAP, issuePageVerdict, newProjectOffered } from './facet-editors';
import {
  AT_REST,
  NewProjectFields,
  appMayWriteProjects,
  createBlocked,
  createFailure,
  projectTitleTaken,
  type CreateFailure,
} from './new-project';

const OWNER = 'acme';
const noop = () => {};

const board = (over: Partial<ProjectCatalogEntry> = {}): ProjectCatalogEntry => ({
  id: 'PVT_7',
  number: 7,
  title: 'Acme Go-To-Market',
  org: OWNER,
  ...over,
});

const made: MadeProject = { id: 'PVT_9', number: 9, title: 'Launch week', url: null, owner: OWNER };

/** A session whose Github App installations are these, every issue write available. */
function session(
  installations: { login: string; type?: 'Organization' | 'User'; projects?: string; suspended?: boolean }[] | undefined,
  writesEnabled = true,
): Me {
  const capabilities = Object.fromEntries(Object.values(ISSUE_CAP).map((c) => [c, 'available']));
  return meFixture({
    writesEnabled,
    capabilities,
    github: {
      installations: installations?.map((i, n) => ({
        id: n + 1,
        account: { login: i.login, type: i.type ?? 'Organization' },
        repositorySelection: 'all',
        repositoryCount: 1,
        permissions: i.projects ? { issues: 'write', organization_projects: i.projects } : { issues: 'write' },
        suspended: i.suspended ?? false,
        manageUrl: '',
      })),
    } as Me['github'],
  });
}

describe('whether the board’s Github App may make a project under the issue’s owner', () => {
  it('yes where the installation on that org grants Projects write or admin', () => {
    expect(appMayWriteProjects(session([{ login: OWNER, projects: 'write' }]), OWNER)).toBe(true);
    expect(appMayWriteProjects(session([{ login: 'Acme', projects: 'admin' }]), OWNER)).toBe(true);
  });

  it('no where it grants only read, nothing, or is suspended', () => {
    expect(appMayWriteProjects(session([{ login: OWNER, projects: 'read' }]), OWNER)).toBe(false);
    expect(appMayWriteProjects(session([{ login: OWNER }]), OWNER)).toBe(false);
    expect(appMayWriteProjects(session([{ login: OWNER, projects: 'write', suspended: true }]), OWNER)).toBe(false);
  });

  it('says no only on evidence, so where nothing is known it leaves the decision to Github', () => {
    expect(appMayWriteProjects(null, OWNER)).toBe(true);
    expect(appMayWriteProjects(session(undefined), OWNER)).toBe(true);
    expect(appMayWriteProjects(session([{ login: 'globex', projects: 'read' }]), OWNER)).toBe(true);
    expect(appMayWriteProjects(session([{ login: 'octocat', type: 'User' }]), 'octocat')).toBe(true);
  });

  it('withholds only the new-project entry, and says read-only where the session writes nothing', () => {
    const readOnlyApp = session([{ login: OWNER, projects: 'read' }]);
    expect(issuePageVerdict(readOnlyApp, OWNER, ISSUE_CAP.projectCreate)).toBe('refused');
    expect(issuePageVerdict(readOnlyApp, OWNER, ISSUE_CAP.projectAdd)).toBe('armed');
    expect(issuePageVerdict(session([{ login: OWNER, projects: 'write' }]), OWNER, ISSUE_CAP.projectCreate)).toBe('armed');
    expect(issuePageVerdict(session([{ login: OWNER, projects: 'read' }], false), OWNER, ISSUE_CAP.projectCreate)).toBe(
      'read-only',
    );
  });

  it('offers the entry off the create verdict, which the issue page makes owner-aware', () => {
    const verdictFor = (me: Me) => (cap: string) => issuePageVerdict(me, OWNER, cap);
    expect(newProjectOffered(verdictFor(session([{ login: OWNER, projects: 'write' }])))).toBe(true);
    expect(newProjectOffered(verdictFor(session([{ login: OWNER, projects: 'read' }])))).toBe(false);
    // The key it asks about, and no other.
    expect(newProjectOffered((cap) => (cap === ISSUE_CAP.projectCreate ? 'armed' : 'refused'))).toBe(true);
    expect(newProjectOffered((cap) => (cap === ISSUE_CAP.projectCreate ? 'refused' : 'armed'))).toBe(false);
  });
});

describe('a name the owner already has a board by', () => {
  const catalog = [board(), board({ id: 'PVT_8', title: 'Roadmap', org: 'globex' })];

  it('is found whatever its case and the spaces round it', () => {
    expect(projectTitleTaken('  acme go-to-market ', catalog, OWNER)?.id).toBe('PVT_7');
  });

  it('is not found under another owner, and a blank name matches nothing', () => {
    expect(projectTitleTaken('Roadmap', catalog, OWNER)).toBeNull();
    expect(projectTitleTaken('   ', catalog, OWNER)).toBeNull();
  });

  it('counts a board with no owner recorded, as a single-org service sends it', () => {
    expect(projectTitleTaken('Roadmap', [board({ title: 'Roadmap', org: undefined })], OWNER)).not.toBeNull();
  });
});

describe('what a failed new project says', () => {
  /** What the page says when the project exists and the issue is not on it. */
  const MADE_NOT_ADDED = 'The project was made, but this issue wasn’t added to it.';
  /** The service's own sentence for that, as `madeButNotAdded` builds it: its
   *  own words, then the inner failure's message appended whole. */
  const MADE_TAIL =
    'The project “Launch week” was made in acme, but this issue could not be added to it. GitHub refused this write on acme/acme: the board is not permitted to do it.';
  const err = (status: number, reason?: ApiError['reason'], serverMessage?: string) =>
    new ApiError(status, `project-create ${status}`, reason, undefined, serverMessage);

  // The one failure whose sentence the page no longer prints leaves it on the
  // console instead, so every case below is run with that console held.
  let said: ReturnType<typeof vi.fn<(line: string) => void>>;
  beforeEach(() => {
    said = vi.fn<(line: string) => void>();
    vi.spyOn(console, 'warn').mockImplementation(said);
  });
  afterEach(() => vi.restoreAllMocks());

  /**
   * Both refusals that name a project are the page's own sentence, because the
   * service's own runs long in two different ways and the page has everything
   * either one says (#1072). For a taken name the service's ends "Choose
   * another name, or add this issue to that project" over the board's own "Add
   * this issue to it" button, which is the same offer twice. For a project made
   * whose add then failed it names the project and the owner and appends the
   * inner failure's message, which has no length at all: the service's own spec
   * pins 175 characters for an 11-character title, and the tail grows with
   * whatever Github said. Neither reaches a screen now.
   */
  it('says both refusals that name a project in its own words', () => {
    const existing: MadeProject = { id: 'PVT_7', number: 7, title: 'Roadmap', url: null, owner: OWNER };
    const taken = new ProjectCreateError(
      409,
      'x',
      undefined,
      undefined,
      'acme already has a project called “Roadmap”. Choose another name, or add this issue to that project.',
      existing,
    );
    expect(createFailure(taken, OWNER)).toEqual({
      sentence: 'acme already has a project called “Roadmap”.',
      project: existing,
      retryAdd: true,
      retry: false,
    });
    // The half the button already says is gone from the prose.
    expect(createFailure(taken, OWNER).sentence).not.toContain('add this issue to that project');
    // The project it names is the one the service named, and it names it with
    // no server sentence to read the name out of.
    const bare = new ProjectCreateError(409, 'x', undefined, undefined, undefined, existing);
    expect(createFailure(bare, OWNER).sentence).toBe('acme already has a project called “Roadmap”.');
    // The add after the create was refused: the same add is refused again, so
    // what is offered is Github's page for the project, not a second add.
    const refused = new ProjectCreateError(403, 'x', 'not-permitted', undefined, MADE_TAIL, made);
    expect(createFailure(refused, OWNER)).toEqual({
      sentence: MADE_NOT_ADDED,
      project: made,
      retryAdd: false,
      retry: false,
    });
    // The add after it never got an answer: trying it again is the right move.
    const dropped = new ProjectCreateError(502, 'x', undefined, undefined, MADE_TAIL, made);
    expect(createFailure(dropped, OWNER).retryAdd).toBe(true);
    // The sentence says nothing that grows: no title, no owner, no tail. The
    // name is in the field above it and the owner is in the form's title.
    const long = new ProjectCreateError(502, 'x', undefined, undefined, MADE_TAIL, { ...made, title: 'x'.repeat(256) });
    expect(createFailure(long, OWNER).sentence).toBe(MADE_NOT_ADDED);
  });

  /**
   * The service's sentence is the only place on this side the reason the add
   * failed is written down, so taking it off the screen must not delete it.
   */
  it('leaves the service’s own sentence in the console', () => {
    createFailure(new ProjectCreateError(502, 'x', undefined, undefined, MADE_TAIL, made), OWNER);
    expect(said).toHaveBeenCalledWith(`new project: ${MADE_TAIL}`);
  });

  it('a taken name the issue is already on is not something to add it to', () => {
    const taken = new ProjectCreateError(409, 'x', undefined, undefined, 'acme already has a project called “Launch week”.', made);
    expect(createFailure(taken, OWNER, [made.id])).toEqual({
      sentence: 'acme already has a project called “Launch week”, and this issue is on it. Choose another name.',
      project: made,
      retryAdd: false,
      retry: false,
    });
  });

  /**
   * The third column is `retry` — whether pressing Create again, with this same
   * name, could work. It is the button's own state (`blocked` in
   * `NewProjectFields`), so a `true` beside a sentence that says the board was
   * refused would be the page inviting a press it has just said cannot happen.
   * Only the three that never reached a verdict carry it: Github unreachable,
   * its quota cooling down, and an answer this module has no sentence for.
   */
  it('reads the reason before the status, and never calls a refusal something to retry', () => {
    const cases: [unknown, string, boolean][] = [
      [err(403, 'not-permitted'), 'The board isn’t allowed to do this in acme.', false],
      [err(403, 'not-permitted-yet'), 'This needs GitHub authorization before the board can make a project here.', false],
      [err(502, 'try-again'), 'Couldn’t reach GitHub. Try again in a moment.', true],
      // Two answers are 503, and only the envelope's says writes are off.
      [err(503, undefined, 'Issue writes are disabled (GITHUB_WRITE_ENABLED).'), 'Issue writes are turned off right now.', false],
      [
        err(503, undefined, 'GitHub GraphQL quota is cooling down; retry after 2026-09-11T14:00:00.000Z'),
        'GitHub isn’t answering the board right now. Try again in a few minutes.',
        true,
      ],
      [
        err(409, undefined, 'A project called “Launch week” is being made in acme right now.'),
        'A project called “Launch week” is being made in acme right now.',
        false,
      ],
      [err(400, undefined, 'A new project needs a name.'), 'A new project needs a name.', false],
      [err(404), 'GitHub couldn’t find this issue or its owner.', false],
      [err(500), 'Couldn’t make the project. Try again.', true],
      [new TypeError('Failed to fetch'), 'Couldn’t make the project. Try again.', true],
    ];
    for (const [thrown, sentence, retry] of cases) {
      expect(createFailure(thrown, OWNER)).toEqual({ sentence, project: null, retryAdd: false, retry });
    }
  });

  /**
   * The refusal this fix is for (#1057). The read that opens the create asks for
   * the owner's projects, which wants a Projects READ permission the add beside
   * it does not, so it can be refused on its own. It used to reach the page as
   * an unclassified 500 — "Couldn’t make the project. Try again." over an armed
   * button, neither of which was true. Classified, it is a 403 that says the
   * board is not allowed, and it does not ask for a second press.
   */
  it('a forbidden read of the owner’s projects says the board isn’t allowed, and asks for no second press', () => {
    const forbidden = err(403, 'not-permitted', 'GitHub refused this write on acme/board: the board is not permitted to do it.');
    expect(createFailure(forbidden, OWNER)).toEqual({
      sentence: 'The board isn’t allowed to do this in acme.',
      project: null,
      retryAdd: false,
      retry: false,
    });
    // The same read failing transiently is the opposite answer on both counts.
    expect(createFailure(err(502, 'try-again'), OWNER).retry).toBe(true);
  });
});

describe('the new-project form, state by state', () => {
  const fields = (over: {
    title?: string;
    taken?: ProjectCatalogEntry | null;
    failure?: CreateFailure | null;
    saving?: boolean;
    onIssue?: string[];
  }) =>
    renderToStaticMarkup(
      <NewProjectFields
        owner={OWNER}
        title={over.title ?? ''}
        taken={over.taken ?? null}
        failure={over.failure ?? null}
        saving={over.saving ?? false}
        onIssue={over.onIssue ?? []}
        inputId="np"
        noteId="np-note"
        formId="np-form"
        onTitle={noop}
        onSubmit={noop}
        onCancel={noop}
        onAdd={noop}
      />,
    );
  // The ATTRIBUTE, never the word: every button here carries `disabled:` classes.
  const create = (html: string) => html.match(/<button[^>]*type="submit"[^>]*>[^<]*<\/button>/)?.[0] ?? '';
  const cancel = (html: string) => html.match(/<button[^>]*type="button"[^>]*>Cancel<\/button>/)?.[0] ?? '';
  // React's server renderer writes an input's `value` after its other
  // attributes, so the tag is read attribute by attribute rather than in order.
  const input = (html: string) => html.match(/<input[^>]*>/)?.[0] ?? '';
  // The line under the field, which is also the form's description.
  const note = (html: string) => html.match(/<p id="np-note"[^>]*>.*?<\/p>/)?.[0] ?? '';

  it('asks for a name, suggests none, and ties the footer’s Create to the form', () => {
    const html = fields({});
    expect(html).toContain('<label for="np"');
    expect(html).toContain('Project name');
    expect(input(html)).toContain('id="np"');
    expect(input(html)).toContain('placeholder="Project name"');
    expect(input(html)).toContain('value=""');
    // Enter in the field and the footer press are one submit.
    expect(html).toContain('<form id="np-form"');
    expect(create(html)).toContain('form="np-form"');
    expect(create(html)).toContain('Create project');
  });

  it('always draws the line under the field, and says something in it at rest', () => {
    expect(note(fields({}))).toContain(AT_REST);
    expect(note(fields({}))).toContain('min-h-[2lh]');
    expect(note(fields({}))).toContain('max-sm:min-h-[3lh]');
    expect(note(fields({ title: 'Launch week' }))).toContain(AT_REST);
    for (const state of [
      { title: 'acme go-to-market', taken: board() },
      { title: 'x', failure: { sentence: 'Issue writes are turned off right now.', project: null, retryAdd: false, retry: false } },
      { title: 'Launch week', saving: true },
    ]) {
      expect(note(fields(state))).not.toBe('');
    }
  });

  it('is described by that line, and announces it politely rather than as an alert', () => {
    // `NewProjectForm` points the form's `aria-describedby` at this id, so
    // the sentence the reader sees is the one a screen reader is given (#1043).
    expect(note(fields({}))).toContain('aria-live="polite"');
    expect(fields({ title: 'x', failure: { sentence: 'Nope.', project: null, retryAdd: false, retry: false } })).not.toContain(
      'role="alert"',
    );
  });

  it('will not create with no name, and will once one is typed', () => {
    expect(create(fields({}))).toContain('disabled=""');
    expect(create(fields({ title: '   ' }))).toContain('disabled=""');
    expect(create(fields({ title: 'Launch week' }))).not.toContain('disabled=""');
  });

  it('names the board that has the name already, offers it, and will not make a second', () => {
    const html = fields({ title: 'acme go-to-market', taken: board() });
    expect(html).toContain('acme already has a project called “Acme Go-To-Market”.');
    expect(html).toContain('Add this issue to it');
    expect(create(html)).toContain('disabled=""');
  });

  it('says a failure in that line, offering the add only where the failure says it could work', () => {
    const retry = fields({ title: 'Launch week', failure: { sentence: 'Made, not added.', project: made, retryAdd: true, retry: false } });
    expect(note(retry)).toContain('Made, not added.');
    expect(note(retry)).toContain('text-danger');
    expect(retry).toContain('Add this issue to it');
    const without = fields({
      title: 'Launch week',
      failure: { sentence: 'Issue writes are turned off right now.', project: null, retryAdd: false, retry: false },
    });
    expect(without).toContain('Issue writes are turned off right now.');
    expect(without).not.toContain('Add this issue to it');
  });

  it('after a refusal, links to the project that was made rather than offering the add again', () => {
    const html = fields({
      title: 'Launch week',
      failure: {
        sentence: 'Made, not added.',
        project: { ...made, url: 'https://github.com/orgs/acme/projects/9' },
        retryAdd: false,
        retry: false,
      },
    });
    expect(html).toContain('href="https://github.com/orgs/acme/projects/9"');
    expect(html).toContain('Open it on GitHub');
    expect(html).not.toContain('Add this issue to it');
  });

  it('a board the issue is already on is named as such and offered for nothing', () => {
    const html = fields({ title: 'acme go-to-market', taken: board(), onIssue: ['PVT_7'] });
    expect(html).toContain('This issue is already on “Acme Go-To-Market”.');
    expect(html).not.toContain('Add this issue to it');
    expect(create(html)).toContain('disabled=""');
    const failed = fields({ title: 'x', failure: { sentence: 'Taken.', project: made, retryAdd: true, retry: false }, onIssue: [made.id] });
    expect(failed).not.toContain('Add this issue to it');
  });

  it('holds Create shut after a failure a second identical press would meet again (#1057)', () => {
    const refused: CreateFailure = {
      sentence: 'The board isn’t allowed to do this in acme.',
      project: null,
      retryAdd: false,
      retry: false,
    };
    const html = fields({ title: 'Launch week', failure: refused });
    expect(html).toContain('The board isn’t allowed to do this in acme.');
    expect(create(html)).toContain('disabled=""');
    // Unreachable is the other answer: the sentence asks for another press and
    // the button allows one.
    const transient: CreateFailure = { ...refused, sentence: 'Couldn’t reach GitHub. Try again in a moment.', retry: true };
    expect(create(fields({ title: 'Launch week', failure: transient }))).not.toContain('disabled=""');
  });

  it('reads Create’s state off one predicate, whichever side of the form draws the button', () => {
    const at = (over: Partial<Parameters<typeof createBlocked>[0]>) =>
      createBlocked({ title: 'Launch week', taken: null, saving: false, failure: null, ...over });
    expect(at({})).toBe(false);
    expect(at({ title: '  ' })).toBe(true);
    expect(at({ taken: board() })).toBe(true);
    expect(at({ saving: true })).toBe(true);
    expect(at({ failure: { sentence: 'x', project: null, retryAdd: false, retry: false } })).toBe(true);
    expect(at({ failure: { sentence: 'x', project: null, retryAdd: false, retry: true } })).toBe(false);
  });

  it('while it sends, says so and holds the field and both buttons', () => {
    const html = fields({ title: 'Launch week', saving: true });
    expect(create(html)).toContain('Creating…');
    expect(create(html)).toContain('disabled=""');
    expect(input(html)).toContain('disabled=""');
    expect(cancel(html)).toContain('disabled=""');
  });
});

describe('createProjectForIssue reads what the service answers (#982)', () => {
  beforeEach(() => resetSessionExpiry());
  afterEach(() => vi.unstubAllGlobals());

  function answer(status: number, body: unknown) {
    const fn = vi.fn(
      async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('posts the name to the issue’s new-project route and resolves the project and item', async () => {
    const fn = answer(201, { project: made, itemId: 'PVTI_1' });
    await expect(createProjectForIssue(OWNER, 'acme', 218, 'Launch week')).resolves.toEqual({ project: made, itemId: 'PVTI_1' });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/issues\/acme\/acme\/218\/project\/new$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ title: 'Launch week' });
  });

  it('a taken name rejects with the project that has it and the service’s sentence', async () => {
    answer(409, { message: 'acme already has a project called “Roadmap”.', project: { id: 'P', number: 3, title: 'Roadmap', owner: OWNER } });
    const thrown = await createProjectForIssue(OWNER, 'acme', 218, 'roadmap').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ProjectCreateError);
    expect(thrown).toMatchObject({
      status: 409,
      serverMessage: 'acme already has a project called “Roadmap”.',
      project: { id: 'P', number: 3, title: 'Roadmap', owner: OWNER, url: null },
    });
  });

  it('a project made and not added rejects with the add’s reason and the project that exists', async () => {
    answer(403, { message: 'The project “Launch week” was made in acme, but…', reason: 'not-permitted', project: made });
    await expect(createProjectForIssue(OWNER, 'acme', 218, 'Launch week')).rejects.toMatchObject({
      status: 403,
      reason: 'not-permitted',
      project: made,
    });
  });

  it('a body that is not JSON leaves the status alone to answer', async () => {
    answer(502, '<html>bad gateway</html>');
    await expect(createProjectForIssue(OWNER, 'acme', 218, 'Launch week')).rejects.toMatchObject({
      status: 502,
      project: null,
      serverMessage: undefined,
    });
  });
});

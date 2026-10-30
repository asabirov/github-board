import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PropertiesPanel } from './PropertiesPanel';
import { RelationsPanel } from './RelationsPanel';
import {
  addIssueToProjectArgs,
  addProjectToIssue,
  fieldValuesEqual,
  patchIssueField,
  removeIssueFromProjectArgs,
  removeProjectFromIssue,
  ISSUE_CAP,
  issueControlVerdict,
  setIssueFieldArgs,
  StatePill,
} from './facet-editors';
import { fieldEditPress } from './facet-editors';
import { LabelChip, Person } from './atoms';
import facetSource from './facet-editors.tsx?raw';
import { REFUSED_REASON } from '../refusal';
import type { Actor, IssueDetail } from '../api/issues';
import type { Me } from '../use-me';
import { meFixture } from '../me-fixture';

// The board's test env is `node` (no DOM), so — rather than pull in jsdom + RTL —
// we render the panel to a static HTML string with react-dom/server (already a
// dep) and assert against the markup. Enough to lock the read-only contract:
// every facet + custom-field value renders, and the editable marker is present
// only when the caller can write (the Task-10 edit affordances hang off it).

const name = (a: Actor | null): string => a?.name ?? a?.login ?? 'unknown';

// #635: the panel no longer takes one boolean — every control asks about its own
// write. These two stand in for the sessions the pre-#635 cases meant by
// `verdict={ARMED}` / `verdict={READ_ONLY}`: one where every capability is armed,
// one that does not write at all. The per-capability cases live at the bottom of
// this file. No default on `verdict` — a defaulted one would let a caller keep
// drawing all eight controls off a single answer and still pass here.
const ARMED = () => 'armed' as const;
const READ_ONLY = () => 'read-only' as const;
const verdictProp = (canWrite: boolean) => (canWrite ? ARMED : READ_ONLY);

/**
 * One property row, split into the grid CELLS the browser will lay out — the
 * label, the value, and (on a refused row) the reason. There is no DOM here, so
 * the split is done by walking `div` depth from the row's opening tag: every
 * depth-1 child is one grid cell, whatever it contains.
 *
 * Cells rather than a class string, because #424's real subject is which cells
 * share a grid ROW: a note that lands inside the value cell grows that cell and
 * drags a centred label off the avatar it names, and no assertion about
 * `items-center` can see that happen.
 */
function rowCells(
  html: string,
  label: string,
): { row: string; label: string; value: string; note: string } | null {
  const re = new RegExp(
    `<div class="([^"]*grid[^"]*)"([^>]*)><div class="[^"]*text-muted[^"]*">${label}</div>`,
  );
  const m = html.match(re);
  if (!m || m.index === undefined) return null;
  const cells: string[] = [];
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = html.indexOf('>', m.index) + 1;
  let depth = 0;
  let cellStart = -1;
  let t: RegExpExecArray | null;
  while ((t = tag.exec(html))) {
    if (t[0].startsWith('</')) {
      depth--;
      if (depth === 0) cells.push(html.slice(cellStart, tag.lastIndex));
      if (depth < 0) break; // the row's own closing tag
    } else {
      if (depth === 0) cellStart = t.index;
      depth++;
    }
  }
  return { row: `${m[1]} ${m[2]}`, label: cells[0] ?? '', value: cells[1] ?? '', note: cells[2] ?? '' };
}

/** The same issue, sitting on TWO boards — the shape that turns one refused
 *  capability into a stack of identical sentences (#635 design review 4). */
function twoBoards(): IssueDetail {
  const one = fixture();
  const second = { ...one.projects[0], projectId: 'PVT_2', itemId: 'IT_2', number: 9, title: 'Platform' };
  return { ...one, projects: [one.projects[0], second] };
}

/** A fixture issue on one project with a single-select + a number custom field. */
function fixture(): IssueDetail {
  return {
    owner: 'acme',
    repo: 'acme',
    number: 218,
    title: "Board deploy didn't fire on merge",
    state: 'open',
    htmlUrl: 'https://github.com/acme/acme/issues/218',
    author: { login: 'IvanRoslov', name: 'Ivan Roslov' },
    createdAt: '',
    updatedAt: '',
    bodyMarkdown: '',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: [{ login: 'octocat', name: 'Octocat' }],
    milestone: 'C4',
    issueType: 'Bug',
    relations: { parent: null, subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0, blockedBy: [], blocking: [] },
    linkedPrs: [],
    comments: [],
    totalComments: 0,
    commentsTruncated: false,
    projects: [
      {
        projectId: 'PVT_1',
        itemId: 'IT_1',
        number: 7,
        title: 'Board hardening',
        fields: [
          {
            fieldId: 'F1',
            name: 'Status',
            dataType: 'single_select',
            options: [
              { id: 'o1', name: 'Todo', color: 'GRAY' },
              { id: 'o2', name: 'In progress', color: 'BLUE' },
            ],
          },
          { fieldId: 'F2', name: 'Effort', dataType: 'number' },
        ],
        values: {
          F1: { kind: 'single_select', optionId: 'o2' },
          F2: { kind: 'number', number: 5 },
        },
      },
    ],
  };
}

describe('PropertiesPanel (#384)', () => {
  it('read-only: renders every facet + custom-field value, no editable marker', () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={READ_ONLY} onPatch={() => {}} name={name} />,
    );
    // #404: boards are grouped as grey blocks headed by the board NAME, not a
    // repeated "Project" label — so the native facet labels + field names show,
    // and the board name heads its block (asserted separately below).
    for (const label of ['Assignees', 'Labels', 'Milestone', 'Issue properties', 'Status', 'Effort']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('bug'); // label chip
    expect(html).toContain('C4'); // milestone
    expect(html).toContain('Board hardening'); // board name heads its block
    expect(html).toContain('In progress'); // single-select option name
    expect(html).toContain('>5<'); // number field value
    // Read-only rows carry no edit affordance the Task-10 editors could hang off.
    expect(html).not.toContain('data-editable');
  });

  // #404: each board is its own grey block, headed once by the board name (no
  // repeated "Project" label, no oversized gap). Lock both: exactly one
  // occurrence of the title, and the canonical block surface present.
  it('B1: the board title heads its block once, on the canonical block surface', () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={READ_ONLY} onPatch={() => {}} name={name} />,
    );
    const occurrences = html.split('Board hardening').length - 1;
    expect(occurrences).toBe(1);
    expect(html).toContain('rounded-xl bg-surface');
  });

  it('writer: rows carry the data-editable marker', () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={ARMED} onPatch={() => {}} name={name} />,
    );
    expect(html).toContain('data-editable="true"');
  });

  // Design-review B2 fix: the remove control's aria-label used to be the
  // generic "Remove from project" — not enough context with multiple projects
  // on an issue. It now names the specific project.
  it('B2: the remove-from-project control names the project in its aria-label', () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={ARMED} onPatch={() => {}} name={name} />,
    );
    expect(html).toContain('aria-label="Remove from Board hardening"');
  });

  // Design-review B2 follow-up: massimo flagged the × as the only *persistently
  // visible* control glyph on the panel — every other row reads as plain data
  // until you hover it. The × is now hidden at rest and revealed on Project-row
  // hover (`group`/`group-hover:opacity-100`) or on its own keyboard focus
  // (`focus-visible:opacity-100`) — present in the DOM the whole time (so it
  // stays reachable by Tab), never `hidden`/`display:none`.
  it('B2 follow-up: the remove control is hidden at rest, present for hover/focus reveal', () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={ARMED} onPatch={() => {}} name={name} />,
    );
    // The Project row is the group-hover context the button reveals against.
    expect(html).toContain('group');
    // The button itself: opacity-0 at rest, still in the DOM (reachable by Tab).
    expect(html).toContain('opacity-0');
    expect(html).toContain('group-hover:opacity-100');
    expect(html).toContain('focus-visible:opacity-100');
    expect(html).toContain('aria-label="Remove from Board hardening"');
  });
});

// #742: the editable rows opened on a click and on nothing else — a plain <div>
// with an onClick, no role, no place in the tab order and no key handler, so a
// reader on a keyboard could not change an assignee, a label, a milestone or a
// board field on this page at all. The panel is the entry point for the half of
// that a rendered page can settle: which rows a Tab reaches, and what a screen
// reader is told about them. (What the KEYS then do needs the handler itself —
// `PropertyRow.spec.tsx`, since this env has no DOM to dispatch one in.)
describe('PropertiesPanel (#742) — the rows answer the keyboard', () => {
  /** The row's whole opening tag, found by the label in its first child div. */
  const rowTag = (html: string, label: string): string => {
    const re = new RegExp(`<div class="([^"]*grid[^"]*)"([^>]*)><div class="[^"]*text-muted[^"]*">${label}</div>`);
    const m = html.match(re);
    expect(m, `no ${label} row in the panel`).toBeTruthy();
    return `${m![1]} ${m![2]}`;
  };
  const armed = () =>
    renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={ARMED} onPatch={() => {}} name={name} />,
    );

  // Effort is the fixture's NUMBER field, and it is in this list on purpose: its
  // popover is a lone <input>, so it is the row where an `aria-haspopup="menu"`
  // was furthest from true.
  for (const label of ['Assignees', 'Labels', 'Milestone', 'Status', 'Effort']) {
    it(`a writer's ${label} row is a control Tab reaches and a reader is told about`, () => {
      const tag = rowTag(armed(), label);
      expect(tag, 'not in the tab order').toContain('tabindex="0"');
      expect(tag, 'announced as nothing in particular').toContain('role="button"');
      expect(tag, 'never says whether its editor is open').toContain('aria-expanded="false"');
      // No `aria-haspopup`: the popover carries no `role="menu"`, and on this
      // very row it is a single text input.
      expect(tag, 'claims a menu it does not open').not.toContain('aria-haspopup');
      // Escape has something to put the reader back on only if the mark is on
      // the element focus can actually reach — the row itself (#739).
      expect(tag, 'the menu hook cannot find its trigger').toContain('data-menu-trigger');
    });
  }

  it('a read-only panel puts nothing new in the tab order and says nothing new', () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={READ_ONLY} onPatch={() => {}} name={name} />,
    );
    for (const label of ['Assignees', 'Labels', 'Milestone', 'Status', 'Effort', 'Type']) {
      const tag = rowTag(html, label);
      expect(tag, `the read-only ${label} row joined the tab order`).not.toContain('tabindex');
      expect(tag, `the read-only ${label} row now claims to be a control`).not.toContain('role=');
      expect(tag, `the read-only ${label} row now claims a menu`).not.toContain('aria-haspopup');
      expect(tag, `the read-only ${label} row now claims a menu`).not.toContain('aria-expanded');
      expect(tag).not.toContain('data-menu-trigger');
    }
    expect(html, 'a read-only panel gained a tab stop').not.toContain('tabindex="0"');
  });

  // The Type row is read-only for everyone (Github sets the type on Github), so
  // it must not join the tab order just because the viewer can write.
  it("a writer's Type row stays out of the tab order", () => {
    const tag = rowTag(armed(), 'Type');
    expect(tag).not.toContain('tabindex');
    expect(tag).not.toContain('role=');
  });

  // Every row this panel renders comes out CLOSED, so no render here can tell
  // `expanded={open}` from `expanded={false}` — a reviewer mutated exactly that
  // and the whole suite stayed green. Binding it is a fact about the source, so
  // the source is what this reads. The rig under ~/.claude/jobs is what watches
  // the attribute actually flip on a real Enter press.
  it('EditableRow hands the row its OWN open state, not a constant', () => {
    const body = facetSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // To the next top-level function, the way `command-menu.callers.spec.tsx`
    // slices a file into components — `\n}` alone stops at the destructured
    // parameter list, three lines in.
    const from = body.indexOf('function EditableRow');
    const next = body.slice(from + 1).search(/^(?:export )?function /m);
    const editableRow = body.slice(from, next < 0 ? undefined : from + 1 + next);
    expect(editableRow, 'EditableRow moved or was renamed').toContain('useDismiss(');
    expect(editableRow, 'the row is told a constant, so aria-expanded can never be true')
      .toMatch(/expanded=\{open\}/);
  });

  // #1199 — the board's workflow states open on their rows instead of on a
  // search field, and WHICH field that is cannot be rendered here: the menu is
  // drawn by a closed row's `menu` callback. What can be read is the question
  // `FieldEditor` asks, and the whole finding against the first attempt was
  // that it asked the wrong one — `field.name.toLowerCase() !== 'status'`
  // takes the search away from any field a project happens to call "status",
  // however many options it has, and hands it back the moment somebody renames
  // the real one. The identity comes from the service (`project-fields.ts`,
  // `seededWithProject`), and this holds the page to reading it.
  it('the single-select editor opts out of search by the marker, never by the name', () => {
    const body = facetSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const from = body.indexOf('export function FieldEditor');
    const next = body.slice(from + 1).search(/^(?:export )?function /m);
    const editor = body.slice(from, next < 0 ? undefined : from + 1 + next);
    expect(editor, 'FieldEditor moved or was renamed').toContain('<PickList');
    expect(editor).toContain('searchable={!field.builtInStatus}');
    expect(editor, 'a field name is not an identity: a project renames Status and adds its own')
      .not.toMatch(/field\.name[^\n]*(===|!==|toLowerCase|startsWith|includes)/);
    expect(editor, 'nor is a case-folded one').not.toContain('toLowerCase');
  });

  // Enter on an <a href> is not a keydown activation: the browser synthesises a
  // bubbling CLICK, which reaches the row's onClick — and onClick has no target
  // guard, because a click that started on the row is how the mouse opens it.
  // So the assignee's profile link would open the editor as well as GitHub.
  // `admin/AccessSection.tsx` writes the same fix for the same reason.
  it('the profile link inside a row does not also open that row', () => {
    const a = Person({ login: 'octocat', name: 'Octocat', avatar: null }) as unknown as {
      props: { href?: string; onClick?: (e: { stopPropagation: () => void }) => void };
    };
    expect(a.props.href, 'this Person should be a link').toContain('octocat');
    expect(typeof a.props.onClick, 'the link lets its press reach the row').toBe('function');
    let stopped = false;
    a.props.onClick!({ stopPropagation: () => { stopped = true; } });
    expect(stopped).toBe(true);
  });
});

// Escape out of a field editor used to SAVE, because nothing in the editor said
// otherwise: `useDismiss` focuses the trigger BEFORE it closes (#739, and that
// order is load-bearing for the FilterBar), the input blurs, and `onBlur`
// commits. It was only ever a cancel by accident — before #742 marked the row,
// no trigger existed inside these popovers, so nothing took focus and React
// fires no blur on unmount. Measured in Chrome: Effort read 5, the reader typed
// 599, pressed Escape to back out, and a PATCH …/field went out.
describe('the field editor (#742 follow-up) — Escape cancels', () => {
  const press = (key: string) => {
    const seen: string[] = [];
    fieldEditPress(key, { commit: () => seen.push('commit'), cancel: () => seen.push('cancel') });
    return seen;
  };

  it('Enter commits the draft', () => expect(press('Enter')).toEqual(['commit']));
  it('Escape cancels it, and commits nothing', () => expect(press('Escape')).toEqual(['cancel']));
  it('leaves every other key to the input', () => {
    for (const k of ['a', '9', 'Tab', 'ArrowDown', ' ']) expect(press(k)).toEqual([]);
  });
});

// #423: the panel used to open with a "State" row sitting directly above each
// board block's "Status" field, which read as one field written twice. State now
// lives on the properties column's leading pill, so nothing named for state is
// left inside the panel to collide with a board's Status.
describe('PropertiesPanel (#423) — no State row', () => {
  for (const canWrite of [false, true]) {
    it(`${canWrite ? 'writer' : 'read-only'}: renders no State row, keeps the board's Status`, () => {
      const html = renderToStaticMarkup(
        <PropertiesPanel issue={fixture()} verdict={verdictProp(canWrite)} onPatch={() => {}} name={name} />,
      );
      expect(html).not.toContain('State');
      expect(html).toContain('Status');
    });
  }
});

// #467: Github's org-level issue type (Task/Bug/Feature) leads the properties
// block. It is the real `issueType` field off the issue, never the label-derived
// coarse type the queue groups by — an issue labelled `bug` with no Github type
// must read untyped here.
describe('PropertiesPanel (#467) — issue type', () => {
  for (const canWrite of [false, true]) {
    it(`${canWrite ? 'writer' : 'read-only'}: shows the Github issue type`, () => {
      const html = renderToStaticMarkup(
        <PropertiesPanel issue={fixture()} verdict={verdictProp(canWrite)} onPatch={() => {}} name={name} />,
      );
      expect(html).toContain('Type');
      expect(html).toContain('Bug');
    });

    it(`${canWrite ? 'writer' : 'read-only'}: an untyped issue reads None, not its labels`, () => {
      const untyped = { ...fixture(), issueType: null, labels: [{ name: 'bug', color: 'd73a4a' }] };
      const html = renderToStaticMarkup(
        <PropertiesPanel issue={untyped} verdict={verdictProp(canWrite)} onPatch={() => {}} name={name} />,
      );
      const typeRow = /Type<\/div><div[^>]*>(.*?)<\/div>/.exec(html)?.[1] ?? '';
      expect(typeRow).toContain('None');
      expect(typeRow).not.toContain('bug');
    });
  }

  // The type is read-only on the board: Github's type is set on Github, and the
  // row must not pretend otherwise by wearing the editable affordance.
  it('the Type row carries no edit affordance, even for a writer', () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={ARMED} onPatch={() => {}} name={name} />,
    );
    expect(/<div class="[^"]*"><div class="[^"]*text-muted[^"]*">Type<\/div>/.test(html)).toBe(true);
  });
});

// #469: an issue's relations — parent, sub-issues with their completion
// summary, and both dependency directions. The board is owner-pinned to the org
// it mirrors, so a reference under the SAME owner as the host issue is one the
// board can open and anything else goes to Github.
describe('RelationsPanel (#469)', () => {
  const rel = (owner: string, repo: string, number: number, state: 'open' | 'closed' = 'open') => ({
    owner, repo, number, title: `title ${number}`, state,
    url: `https://github.com/${owner}/${repo}/issues/${number}`,
  });

  const related = (): IssueDetail => ({
    ...fixture(),
    relations: {
      parent: rel('acme', 'roadmap', 42),
      subIssues: [rel('acme', 'acme', 241, 'closed'), rel('acme', 'acme', 243)],
      subIssuesTotal: 5,
      subIssuesClosed: 2,
      blockedBy: [rel('acme', 'acme-ui', 356)],
      blocking: [rel('selgeo', 'selgeo-app', 88)],
    },
  });

  // Variant B: the block moved out of the properties panel into the reading
  // column, so it is rendered directly here — same component, same data, the
  // `wide` row grammar it gets at that measure.
  const render = (issue: IssueDetail) =>
    renderToStaticMarkup(<RelationsPanel issue={issue} layout="wide" />);

  it('an issue with no relations renders nothing — not an empty panel', () => {
    expect(render(fixture())).toBe('');
    // And the properties panel it used to live in says nothing about relations.
    const panel = renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={READ_ONLY} onPatch={() => {}} name={name} />,
    );
    for (const word of ['Relations', 'Parent', 'Sub-issues', 'Blocked by', 'Blocking']) {
      expect(panel).not.toContain(word);
    }
  });

  it('names each relation kind it has', () => {
    const html = render(related());
    for (const word of ['Relations', 'Parent', 'Sub-issues', 'Blocked by', 'Blocking']) {
      expect(html).toContain(word);
    }
  });

  it('omits a kind the issue has none of', () => {
    const issue = related();
    issue.relations = { ...issue.relations, blocking: [], blockedBy: [] };
    const html = render(issue);
    expect(html).toContain('Parent');
    expect(html).not.toContain('Blocked by');
    expect(html).not.toContain('Blocking');
  });

  it('writes a same-repo reference #NN and a cross-repo one owner/repo#NN', () => {
    const html = render(related());
    expect(html).toContain('#241'); // same repo as the host issue
    expect(html).toContain('acme/roadmap#42'); // sibling repo
    expect(html).toContain('selgeo/selgeo-app#88'); // another org
  });

  it('links a board repo into the board and anything else to Github', () => {
    const html = render(related());
    // Same owner as the host issue → the board can open it.
    expect(html).toContain('href="/issue/acme/roadmap/42"');
    expect(html).toContain('href="/issue/acme/acme-ui/356"');
    // Another org → the board has no page for it, so Github.
    expect(html).toContain('href="https://github.com/selgeo/selgeo-app/issues/88"');
    expect(html).not.toContain('href="/issue/selgeo/selgeo-app/88"');
  });

  it('says how many sub-issues are closed, from the summary not the fetched page', () => {
    const html = render(related());
    // Two nodes fetched, five sub-issues in total: the count is Github's.
    expect(html).toContain('2 of 5 done');
  });

  it('offers the rest on Github when the sub-issue list is a partial page', () => {
    const html = render(related());
    expect(html).toContain('3 more on GitHub');
  });

  it('does not offer "more on GitHub" when the whole list is shown', () => {
    const issue = related();
    issue.relations = { ...issue.relations, subIssuesTotal: 2, subIssuesClosed: 1 };
    const html = render(issue);
    expect(html).toContain('1 of 2 done');
    expect(html).not.toContain('more on GitHub');
  });
});

describe('issue badges without decorative discs (#910)', () => {
  it('keeps the label text and tint without a hidden disc', () => {
    const html = renderToStaticMarkup(<LabelChip label={{ name: 'blocked', color: 'd73a4a' }} />);
    expect(html).toContain('blocked');
    expect(html).toContain('text-fg');
    expect(html).not.toContain('aria-hidden');
  });

  it.each([false, true])('keeps state readable with armed=%s without a hidden disc', (armed) => {
    const html = renderToStaticMarkup(<StatePill issue={fixture()} armed={armed} onPatch={() => {}} />);
    expect(html).toContain('Open');
    expect(html).not.toContain('aria-hidden');
  });
});

describe('StatePill (#423)', () => {
  it('read-only: a plain pill, no button and no menu affordance', () => {
    const html = renderToStaticMarkup(<StatePill issue={fixture()} armed={false} onPatch={() => {}} />);
    expect(html).toContain('iss-state');
    expect(html).toContain('Open');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-haspopup');
  });

  it('writer: the pill is the state editor — a menu button carrying the current state', () => {
    const html = renderToStaticMarkup(<StatePill issue={fixture()} armed={true} onPatch={() => {}} />);
    expect(html).toContain('<button');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('Open');
  });

  it('a closed issue reads Closed and carries the settled hue', () => {
    const closed = { ...fixture(), state: 'closed' as const };
    const html = renderToStaticMarkup(<StatePill issue={closed} armed={true} onPatch={() => {}} />);
    expect(html).toContain('Closed');
    expect(html).toContain('--iss-tone:var(--accent)');
  });
});

// Task 11: custom-field + project-membership editing. The board's test env is
// `node` (no DOM, no @testing-library), so — same rationale as
// use-facet-edit.spec.ts — rather than simulate a click we exercise the exact
// pure patch functions FieldEditor/ProjectEditor's `apply` calls on a successful
// commit (B2: reconciled to the server-returned value, immutable), then
// re-render the panel with the patched issue and assert the rendered value
// actually moved. This locks the same "apply patches issue.projects
// immutably, PropertiesPanel is a pure function of it" contract the click
// would otherwise exercise.
// #424: a row whose value carries an avatar (Assignees) must align its label to
// the value's vertical CENTRE, not the shared text baseline every other row uses
// — else the muted label sits below the avatar's centre and reads misaligned,
// most visibly on hover. Lock the wiring: the Assignees row grid is `items-center`
// while the text-only rows stay `items-baseline`. (DOM-less markup assertion —
// see the top-of-file note. A row's class sits on the grid div immediately before
// its tertiary-coloured label div.)
describe('PropertiesPanel (#424) — avatar-row alignment', () => {
  const rowClassFor = (html: string, label: string): string | null => {
    // `[^>]*` after the class tolerates the writer row's data-editable attribute.
    const re = new RegExp(`<div class="([^"]*grid[^"]*)"[^>]*><div class="[^"]*text-muted[^"]*">${label}</div>`);
    return html.match(re)?.[1] ?? null;
  };
  for (const canWrite of [false, true]) {
    it(`${canWrite ? 'writer' : 'read-only'}: Assignees aligns to centre, text rows to baseline`, () => {
      const html = renderToStaticMarkup(
        <PropertiesPanel issue={fixture()} verdict={verdictProp(canWrite)} onPatch={() => {}} name={name} />,
      );
      const assignees = rowClassFor(html, 'Assignees');
      // Milestone stands in for the text-only rows here; the State row it used to
      // be checked against left the panel in #423.
      const milestone = rowClassFor(html, 'Milestone');
      expect(assignees).toContain('items-center');
      expect(assignees).not.toContain('items-baseline');
      expect(milestone).toContain('items-baseline');
      expect(milestone).not.toContain('items-center');
    });
  }

  // What `items-center` is FOR, asserted instead of asserted-about.
  //
  // The class alone passed over a row that centred the label against the wrong
  // box: a refused Assignees row put its reason inside the value cell, the cell
  // grew a second line, and `items-center` obediently re-centred "Assignees"
  // between the avatars and the sentence — labelling neither, 12.5px below the
  // avatar it exists to line up with. The class was right and the outcome was
  // wrong, so the outcome is what this asserts.
  //
  // DOM-less, so the outcome is stated structurally: the label and the avatar
  // must share ONE grid row, which they do exactly when the value cell holds the
  // avatar and nothing else, and any note is a separately-placed cell below it
  // (`col-start-2`). That is a property of the markup, and it is false in every
  // arrangement that produced the 12.5px drop.
  it('a refused Assignees row still centres its label on the avatar, not on the note', () => {
    const me = meFixture({
      writesEnabled: true,
      capabilities: { ...Object.fromEntries(Object.values(ISSUE_CAP).map((c) => [c, 'available'])), [ISSUE_CAP.assignees]: 'refused' },
    });
    const html = renderToStaticMarkup(
      <PropertiesPanel
        issue={fixture()}
        verdict={(cap) => issueControlVerdict(me, cap)}
        onPatch={() => {}}
        name={name}
      />,
    );
    const cells = rowCells(html, 'Assignees');
    expect(cells).not.toBeNull();
    expect(cells!.row).toContain('items-center');
    // The value cell is the avatar's, and the label is centred against it …
    expect(cells!.value).toContain('octocat');
    expect(cells!.value).not.toContain(REFUSED_REASON);
    // … while the reason is its own cell on the row below, in column 2.
    expect(cells!.note).toContain(REFUSED_REASON);
    expect(cells!.note).toContain('col-start-2');
  });
});

describe('PropertiesPanel (#384) — Task 11 field + project editing', () => {
  // NB: this is the POST-reconciliation state (what `apply` writes once the
  // server has responded), not a simulated in-flight optimistic render — the
  // generic optimistic-then-reconcile mechanic is already covered, DOM-free,
  // in use-facet-edit.spec.ts. This test's job is narrower: prove the panel
  // actually re-renders the new value once `apply` has patched `issue.projects`.
  it('apply reconciles the server-returned single-select value into the rendered row', () => {
    const before = fixture();
    const beforeHtml = renderToStaticMarkup(
      <PropertiesPanel issue={before} verdict={ARMED} onPatch={() => {}} name={name} />,
    );
    expect(beforeHtml).toContain('In progress');

    const after = patchIssueField(before, 'PVT_1', 'F1', { kind: 'single_select', optionId: 'o1' });
    const afterHtml = renderToStaticMarkup(
      <PropertiesPanel issue={after} verdict={ARMED} onPatch={() => {}} name={name} />,
    );
    expect(afterHtml).toContain('Todo');
    expect(afterHtml).not.toContain('In progress');
  });

  it('a number field accepts a numeric edit', () => {
    const before = fixture();
    const after = patchIssueField(before, 'PVT_1', 'F2', { kind: 'number', number: 8 });
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={after} verdict={ARMED} onPatch={() => {}} name={name} />,
    );
    expect(html).toContain('>8<');
    expect(html).not.toContain('>5<');
  });

  it('removing the issue from a project drops its whole field group', () => {
    const before = fixture();
    const after = removeProjectFromIssue(before, 'PVT_1');
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={after} verdict={ARMED} onPatch={() => {}} name={name} />,
    );
    expect(html).not.toContain('Board hardening');
    expect(html).not.toContain('Status');
    expect(html).not.toContain('Effort');
  });
});

// The wiring gap the patch-function tests above don't reach: the positional
// arg order FieldEditor/ProjectEditor hand to setIssueField/
// removeIssueFromProject. Both components call these exact helpers (not a
// re-derivation), so a fieldId/itemId swap — or any other arg-order slip —
// fails here instead of only being catchable by eyeballing the diff.
describe('Task 11 — api arg-order glue', () => {
  it('setIssueFieldArgs orders args positionally: owner, repo, number, projectId, itemId, fieldId, value', () => {
    const issue = fixture();
    const value = { kind: 'single_select', optionId: 'o1' } as const;
    const args = setIssueFieldArgs(issue, issue.projects[0], 'F1', value);
    expect(args).toEqual(['acme', 'acme', 218, 'PVT_1', 'IT_1', 'F1', value]);
  });

  it('removeIssueFromProjectArgs orders args positionally: owner, repo, number, projectId, itemId', () => {
    const issue = fixture();
    const args = removeIssueFromProjectArgs(issue, issue.projects[0]);
    expect(args).toEqual(['acme', 'acme', 218, 'PVT_1', 'IT_1']);
  });

  it('addProjectToIssue appends a freshly-added membership immutably', () => {
    const before = fixture();
    const originalLength = before.projects.length;
    const entry = { id: 'PVT_2', number: 8, title: 'Another board' };
    const itemId = 'IT_2';
    const after = addProjectToIssue(before, entry, itemId);

    // Original unchanged
    expect(before.projects.length).toBe(originalLength);
    expect(before.projects[0].projectId).toBe('PVT_1');

    // New array length +1
    expect(after.projects.length).toBe(originalLength + 1);

    // Existing memberships preserved
    expect(after.projects[0]).toBe(before.projects[0]);

    // New membership appended with fields/values empty
    expect(after.projects[1]).toEqual({
      projectId: 'PVT_2',
      itemId: 'IT_2',
      number: 8,
      title: 'Another board',
      fields: [],
      values: {},
    });
  });

  it('addIssueToProjectArgs orders args positionally: owner, repo, number, projectId', () => {
    const issue = fixture();
    const entry = { id: 'PVT_2', number: 8, title: 'Another board' };
    const args = addIssueToProjectArgs(issue, entry);
    expect(args).toEqual(['acme', 'acme', 218, 'PVT_2']);
  });
});

// The add-to-project affordance (#404, Variant C): a render-only lock since the
// board's test env has no DOM to simulate a click through (see the top-of-file
// note) — the pick/commit logic itself is exercised above (the
// addProjectToIssue/addIssueToProjectArgs helper tests) and in
// use-facet-edit.spec.ts's generic optimistic-then-reconcile coverage. This
// just proves the row is wired into the panel, and only for a writer.
//
// It is read off `data-add-project`, not off the words (#1021). The trigger is
// a kit `Button` beside a `PickDialog` since #1067 — the kit's `AddPicker` is
// gone from this tree — and it is drawn once the catalog read lands, which no
// read does in a suite with no DOM; the box that will hold it is there from the
// first render, and only where the add is armed.
describe('PropertiesPanel (#404) — add-to-project affordance', () => {
  it('armed: renders the "Add to project…" affordance', () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={ARMED} onPatch={() => {}} name={name} />,
    );
    expect(html).toContain('data-add-project');
  });

  it('read-only: does not render the affordance', () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel issue={fixture()} verdict={READ_ONLY} onPatch={() => {}} name={name} />,
    );
    expect(html).not.toContain('data-add-project');
  });
});

// Final-review fix wave: tabbing out of a text/number/date field editor
// without changing anything used to still commit — a redundant GitHub write
// (latency + audit noise). FieldEditor's text/number/date commit paths now
// guard with `fieldValuesEqual(next, value)` before calling `edit(...)`; since
// the board's test env has no DOM (see the top-of-file note), we can't
// simulate an actual blur event, so — same rationale as the arg-order tests
// above — we unit-test the extracted pure predicate the guard is built on.
// A wrong predicate (e.g. one that let a same-kind, same-primitive pair
// through) would fail here instead of only being catchable by clicking
// through the popover by hand.
describe('Task 11 fix-wave — fieldValuesEqual (no-op field-edit guard)', () => {
  it('text: identical strings are equal, including the already-empty case', () => {
    expect(fieldValuesEqual({ kind: 'text', text: 'x' }, { kind: 'text', text: 'x' })).toBe(true);
    expect(fieldValuesEqual({ kind: 'text', text: '' }, { kind: 'text', text: '' })).toBe(true);
    expect(fieldValuesEqual({ kind: 'text', text: 'x' }, { kind: 'text', text: 'y' })).toBe(false);
  });

  it('number: null equals null (unset stays unset), distinguishes distinct numbers', () => {
    expect(fieldValuesEqual({ kind: 'number', number: null }, { kind: 'number', number: null })).toBe(true);
    expect(fieldValuesEqual({ kind: 'number', number: 5 }, { kind: 'number', number: 5 })).toBe(true);
    expect(fieldValuesEqual({ kind: 'number', number: 5 }, { kind: 'number', number: 6 })).toBe(false);
  });

  it('date: identical dates are equal, including the already-unset case', () => {
    expect(fieldValuesEqual({ kind: 'date', date: '2026-01-01' }, { kind: 'date', date: '2026-01-01' })).toBe(true);
    expect(fieldValuesEqual({ kind: 'date', date: null }, { kind: 'date', date: null })).toBe(true);
    expect(fieldValuesEqual({ kind: 'date', date: '2026-01-01' }, { kind: 'date', date: '2026-01-02' })).toBe(false);
  });

  it('never equal across kinds, even with matching primitives', () => {
    const text = { kind: 'text', text: '' } as const;
    const number = { kind: 'number', number: null } as const;
    expect(fieldValuesEqual(text, number)).toBe(false);
  });
});

// #635: the panel asks about each control's OWN write, not about one boolean.
// `issueControlVerdict` is the whole decision: `armed` when the session may use
// the control, `refused` when the board's credential has already been told no
// for THAT capability, `read-only` when this session is not a writer at all.
// Only `refused` earns the reason — a reader is not owed an explanation for a
// permission the board still has.
describe('#635 — one verdict per control', () => {
  // `meFixture` derives `canWrite` from `writesEnabled` and the `issue.*`
  // refusals rather than taking it (#626) — see `me-fixture.ts` for why a
  // hand-built pair is the bug this suite is here to catch.
  const session = (capabilities: Record<string, string>, writesEnabled = true): Me =>
    meFixture({
      email: 'octocat@example.com',
      isAdmin: true,
      name: 'Octocat',
      githubLogin: 'octocat',
      writesEnabled,
      capabilities,
    });
  const CAPS = Object.values(ISSUE_CAP);
  const all = (verdict: string) => Object.fromEntries(CAPS.map((c) => [c, verdict]));
  const panel = (me: Me | null, issue = fixture()) =>
    renderToStaticMarkup(
      <PropertiesPanel
        issue={issue}
        verdict={(cap) => issueControlVerdict(me, cap)}
        onPatch={() => {}}
        name={name}
      />,
    );
  /** The row's whole opening tag — its classes AND any data-editable — found by
   *  its label, which sits in the row's first child div. */
  const rowTag = (html: string, label: string): string | null => {
    const re = new RegExp(`<div class="([^"]*grid[^"]*)"([^>]*)><div class="[^"]*text-muted[^"]*">${label}</div>`);
    const m = html.match(re);
    return m ? `${m[1]} ${m[2]}` : null;
  };
  /** Whether a row wears the edit affordance. A row that stopped MATCHING is a
   *  broken helper, not an unarmed row: `?? ''` read the two as the same thing,
   *  and every `toBe(false)` below would have passed over a regex that had gone
   *  stale. */
  const armedRow = (html: string, label: string) => {
    const tag = rowTag(html, label);
    expect(tag, `no ${label} row in this panel — the helper stopped matching`).not.toBeNull();
    return tag!.includes('data-editable="true"');
  };

  it('a refusal withdraws its own control and leaves the other seven armed', () => {
    for (const refused of CAPS) {
      const me = session({ ...all('available'), [refused]: 'refused' });
      for (const cap of CAPS) {
        expect(issueControlVerdict(me, cap)).toBe(cap === refused ? 'refused' : 'armed');
      }
    }
  });

  // The defect #635 exists to remove, stated in the terms that finally express
  // it. Before #626 split the flag, `canWrite` was the only session bit there
  // was, so this session could not be built: one refused issue capability and
  // `canWrite` were the same fact. They disagree now, and the disagreement is
  // the whole bug — a control gated on `canWrite` reads a credential-wide
  // `issue.labels` refusal as "this person does not write" and darkens the
  // other seven writes, every one of which would have gone through.
  it('a session whose canWrite is false still arms every control that is fine (#626)', () => {
    const me = session({ ...all('available'), [ISSUE_CAP.labels]: 'refused' });
    // What the server actually ships for this session, asserted beside the
    // verdicts because it is exactly what the wrong bit would have read.
    expect(me.writesEnabled).toBe(true);
    expect(me.canWrite).toBe(false);
    for (const cap of CAPS) {
      expect(issueControlVerdict(me, cap)).toBe(cap === ISSUE_CAP.labels ? 'refused' : 'armed');
    }
    // And on the page: the refused row says why rather than going quiet, which
    // is the half a `canWrite` tiebreak loses — it would call this refusal
    // `read-only` and draw the row plain, with nothing saying the board had
    // been told no.
    const html = panel(me);
    expect(html).toContain(REFUSED_REASON);
    expect(armedRow(html, 'Assignees')).toBe(true);
    expect(armedRow(html, 'Milestone')).toBe(true);
  });

  it('one refused facet leaves the panel rows around it editable', () => {
    const html = panel(session({ ...all('available'), [ISSUE_CAP.labels]: 'refused' }));
    expect(armedRow(html, 'Labels')).toBe(false);
    expect(armedRow(html, 'Assignees')).toBe(true);
    expect(armedRow(html, 'Milestone')).toBe(true);
    expect(armedRow(html, 'Status')).toBe(true); // the board's custom field
    expect(html).toContain('data-add-project'); // issue.project.add untouched
    expect(html).toContain('aria-label="Remove from Board hardening"'); // issue.project.remove
  });

  it('a refused facet says why, in the row, without hover', () => {
    const html = panel(session({ ...all('available'), [ISSUE_CAP.labels]: 'refused' }));
    expect(html).toContain(REFUSED_REASON);
    // Once — the row that lost its control, not the panel and not its neighbours.
    expect(html.split(REFUSED_REASON).length - 1).toBe(1);
    // The withdrawal is on the VALUE, which is what lost its control. It cannot
    // be on the row: CSS opacity clamps every descendant and nothing inside can
    // climb back out, so a dimmed row takes the reason down with it — measured
    // at 2.34:1 on --surface, below the kit's own --disabled-ink (2.86:1).
    const cells = rowCells(html, 'Labels');
    expect(cells!.row).not.toContain('opacity-50');
    expect(cells!.value).toContain('opacity-50');
  });

  it('the reason is legible — it carries no dimming of its own or above it', () => {
    const html = panel(session({ ...all('available'), [ISSUE_CAP.labels]: 'refused' }));
    const cells = rowCells(html, 'Labels');
    expect(cells!.note).toContain(REFUSED_REASON);
    expect(cells!.note).toContain('text-muted'); // 5.15:1 on --surface
    expect(cells!.note).not.toContain('opacity');
    // …and the label that names the row keeps its own strength too.
    expect(cells!.label).not.toContain('opacity');
  });

  // A screen reader on a withdrawn row otherwise reaches the value and nothing
  // that says why it cannot be changed.
  it('points the withheld row at its own reason', () => {
    const html = panel(session({ ...all('available'), [ISSUE_CAP.labels]: 'refused' }));
    const described = rowCells(html, 'Labels')!.row.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(described).toBeTruthy();
    expect(rowCells(html, 'Labels')!.note).toContain(`id="${described}"`);
  });

  it('a refused custom field withdraws that row and no native facet', () => {
    const html = panel(session({ ...all('available'), [ISSUE_CAP.field]: 'refused' }));
    expect(armedRow(html, 'Status')).toBe(false);
    expect(armedRow(html, 'Effort')).toBe(false);
    expect(armedRow(html, 'Labels')).toBe(true);
    expect(html).toContain(REFUSED_REASON);
    // Once for the block, not once per field. `issue.field` is ONE capability
    // covering every custom field on the board, so a sentence per row is the
    // same sentence copied down a 250px column — two here, six on an issue
    // sitting on two boards with three fields each.
    expect(html.split(REFUSED_REASON).length - 1).toBe(1);
  });

  it('says it once per board, however many fields the board carries', () => {
    const html = panel(session({ ...all('available'), [ISSUE_CAP.field]: 'refused' }), twoBoards());
    expect(html.split(REFUSED_REASON).length - 1).toBe(2); // 2 boards × 2 fields → 2
    // Every field row is still withdrawn and still dimmed — only the sentence
    // is said once. A row that goes quiet AND keeps its affordance would be the
    // worse bug this could have traded for.
    for (const field of ['Status', 'Effort']) {
      expect(armedRow(html, field)).toBe(false);
      expect(rowCells(html, field)!.value).toContain('opacity-50');
    }
    // And each silent row still points at the reason its block does carry.
    const note = rowCells(html, 'Status')!.row.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(note).toBeTruthy();
    expect(rowCells(html, 'Effort')!.row).toContain(`aria-describedby="${note}"`);
  });

  // The set is not the controller's: `issue-detail.controller.ts` declares every
  // one of these plus `issue.close`, which is deliberately absent here because
  // Close is not an editor control (it lives on `IssueActions`). So they are
  // pinned as literals rather than derived from `ISSUE_CAP`, which every other
  // case in this file does — a spec that reads the map it is checking cannot see
  // a typo, and `mayWrite` reads an unrecognised key as NOT refused, so one
  // misspelling arms that control permanently. That is the exact defect #635
  // exists to remove, coming back invisibly.
  //
  // `issue.comment` (#693) is the ninth and the only one that draws no panel row
  // — it is the composer at the foot of the thread. It belongs in `ISSUE_CAP`
  // anyway, because being in the map is what puts a control in the issue
  // editor's set, and a control asks `mayWrite(me, ISSUE_CAP.comment)` before it
  // offers itself. The panel still draws EIGHT rows, so no case above it moves.
  // `issue.project.create` (#982) is the tenth, and draws no row either: it is
  // one more entry in the add block's menu.
  it('asks about the ten capabilities the server declares, spelled out', () => {
    expect(Object.values(ISSUE_CAP)).toEqual([
      'issue.state',
      'issue.assignees',
      'issue.labels',
      'issue.milestone',
      'issue.body.task',
      'issue.project.add',
      'issue.project.create',
      'issue.project.remove',
      'issue.field',
      'issue.comment',
    ]);
  });

  it('a refused project.add drops only that block', () => {
    const html = panel(session({ ...all('available'), [ISSUE_CAP.projectAdd]: 'refused' }));
    expect(html).not.toContain('data-add-project');
    expect(armedRow(html, 'Labels')).toBe(true);
  });

  it('a refused project.remove drops only the remove affordance', () => {
    const html = panel(session({ ...all('available'), [ISSUE_CAP.projectRemove]: 'refused' }));
    expect(html).not.toContain('aria-label="Remove from Board hardening"');
    expect(html).toContain('data-add-project');
    expect(armedRow(html, 'Labels')).toBe(true);
  });

  // The failure this issue exists to remove, arriving through the other door: a
  // capability nobody has attempted yet, and a board-service too old to send the
  // map at all, must BOTH draw every control exactly as today.
  it('unknown arms the control — an unattempted capability is not a refusal', () => {
    const me = session(all('unknown'));
    for (const cap of CAPS) expect(issueControlVerdict(me, cap)).toBe('armed');
    const html = panel(me);
    expect(html).toContain('data-editable="true"');
    expect(html).not.toContain(REFUSED_REASON);
  });

  it('a key the map does not carry arms the control', () => {
    const me = session({});
    for (const cap of CAPS) expect(issueControlVerdict(me, cap)).toBe('armed');
    const html = panel(me);
    expect(armedRow(html, 'Labels')).toBe(true);
    expect(html).not.toContain(REFUSED_REASON);
  });

  // A non-writer is not a refusal. The board's credential is fine; this session
  // simply does not write, so the rows read exactly as they always have and the
  // reason — which says the BOARD isn't allowed — would be a lie.
  it('a reader gets plain rows and is told nothing about the board', () => {
    for (const me of [session(all('available'), false), null]) {
      for (const cap of CAPS) expect(issueControlVerdict(me, cap)).toBe('read-only');
      const html = panel(me);
      expect(html).not.toContain('data-editable');
      expect(html).not.toContain(REFUSED_REASON);
      expect(html).not.toContain('data-add-project');
    }
  });

  // The pill is not a row: no label column sits beside it to say WHAT the board
  // isn't allowed to do, so it withdraws to the reader's badge either way.
  it('the state pill is armed by issue.state alone', () => {
    const refused = session({ ...all('available'), [ISSUE_CAP.state]: 'refused' });
    expect(issueControlVerdict(refused, ISSUE_CAP.state)).toBe('refused');
    const off = renderToStaticMarkup(
      <StatePill issue={fixture()} armed={false} onPatch={() => {}} />,
    );
    expect(off).not.toContain('<button');
    // …and a refusal on a different capability leaves the pill armed.
    const on = renderToStaticMarkup(
      <StatePill
        issue={fixture()}
        armed={issueControlVerdict(session({ ...all('available'), [ISSUE_CAP.labels]: 'refused' }), ISSUE_CAP.state) === 'armed'}
        onPatch={() => {}}
      />,
    );
    expect(on).toContain('<button');
  });
});

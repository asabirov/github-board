import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, type GroupDim } from './filter-group';
import { DEFAULT_GROUP, DEFAULT_VIEWER, decodeViewer, encodeViewer, hasExplicitGroup, hasExplicitView, isGroupDim, type ViewerState } from './viewer-url';
import { parseRoute, routePath } from '../route';

describe('viewer URL codec (#376)', () => {
  it('round-trips a fully-populated viewer state', () => {
    const s: ViewerState = {
      q: 'auth', group: 'project', view: 'board',
      filters: { ...DEFAULT_FILTERS, q: 'auth', labels: ['bug'], assignees: ['al'], projects: ['P'], state: 'all' },
    };
    expect(decodeViewer(encodeViewer(s))).toEqual(s);
  });

  it('ignores unknown/stale params and returns {} when nothing is recognised', () => {
    expect(decodeViewer('?bogus=1')).toEqual({});
    expect(decodeViewer('')).toEqual({});
  });

  it('omits defaults so a pristine viewer serializes to an empty query', () => {
    expect(encodeViewer(DEFAULT_VIEWER)).toBe('');
  });

  it('round-trips multi-select values that contain commas (repeated params, #376)', () => {
    // Github label/project names can carry commas — a joined-then-split codec
    // would corrupt "needs review, later" into two wrong tokens.
    const s: ViewerState = {
      q: '', group: DEFAULT_VIEWER.group, view: 'list',
      filters: {
        ...DEFAULT_FILTERS,
        q: '',
        labels: ['needs review, later', 'p1'],
        assignees: [],
        projects: ['Q3, planning'],
        state: 'open',
      },
    };
    const encoded = encodeViewer(s);
    expect(decodeViewer(encoded).filters).toEqual(s.filters);
    // The comma lives inside a single value, not as a separator.
    expect(decodeViewer(encoded).filters?.labels).toEqual(['needs review, later', 'p1']);
  });

  it('drops empty multi-select tokens from a stale query (`?label=`)', () => {
    expect(decodeViewer('?label=').filters?.labels).toEqual([]);
  });

  it('round-trips the repo dimension as `?repo=` (#472)', () => {
    const s: ViewerState = {
      q: '', group: DEFAULT_VIEWER.group, view: 'list',
      filters: { ...DEFAULT_FILTERS, repos: ['board', 'acme-ui'] },
    };
    expect(encodeViewer(s)).toBe('?repo=board&repo=acme-ui');
    expect(decodeViewer(encodeViewer(s)).filters?.repos).toEqual(['board', 'acme-ui']);
    // `?repo=` alone is enough to recognise the query as viewer state, so a
    // Repos-map link hydrates the queue on a cold load.
    expect(decodeViewer('?repo=board').filters?.repos).toEqual(['board']);
  });

  it('round-trips `?group=repo` (#661)', () => {
    // `repo` is both a grouping and a filter, and they are separate params:
    // `?group=repo` stacks by repository, `?repo=board` narrows to one. A URL
    // can carry either alone, or both.
    const s: ViewerState = {
      q: '', group: 'repo', view: 'list',
      filters: { ...DEFAULT_FILTERS },
    };
    expect(encodeViewer(s)).toBe('?group=repo');
    expect(decodeViewer('?group=repo')).toEqual(s);
    expect(decodeViewer('?group=repo&repo=board').filters?.repos).toEqual(['board']);
    expect(decodeViewer('?group=repo&repo=board').group).toBe('repo');
  });

  it('defends against a partial query (missing pieces fall to defaults)', () => {
    const decoded = decodeViewer('?label=bug');
    expect(decoded).toEqual({
      q: '',
      group: DEFAULT_VIEWER.group,
      view: 'list',
      filters: { ...DEFAULT_FILTERS, q: '', labels: ['bug'], assignees: [], projects: [], state: 'open' },
    });
  });
});

describe('viewer URL codec: type / timeframe / custom fields (#401)', () => {
  it('round-trips type / timeframe / custom fields', () => {
    const s: ViewerState = {
      ...DEFAULT_VIEWER,
      filters: {
        ...DEFAULT_VIEWER.filters,
        types: ['bug'],
        timeframe: 'opened-week',
        customFields: { priority: ['High', 'Med'], sprint: ['S3'] },
      },
    };
    const round = decodeViewer(encodeViewer(s));
    expect(round.filters).toMatchObject({
      types: ['bug'],
      timeframe: 'opened-week',
      customFields: { priority: ['High', 'Med'], sprint: ['S3'] },
    });
  });

  it('a URL with only a cf_ param is recognised as viewer state', () => {
    expect(decodeViewer('?cf_priority=High').filters?.customFields).toEqual({ priority: ['High'] });
  });

  it('drops unknown/stale timeframe / type values', () => {
    // Covers both a nonsense value and any retired preset a stale deep-link
    // might carry (only 'opened-week' is a recognised non-default value now) —
    // either decodes gracefully to 'any' rather than erroring or leaking through.
    expect(decodeViewer('?tf=nonsense&type=zzz').filters).toMatchObject({ timeframe: 'any', types: [] });
  });

  it('round-trips tf=closed-week (#407)', () => {
    const s = { ...DEFAULT_VIEWER, filters: { ...DEFAULT_VIEWER.filters, timeframe: 'closed-week' as const } };
    const enc = encodeViewer(s);
    expect(enc).toContain('tf=closed-week');
    expect(decodeViewer(enc).filters?.timeframe).toBe('closed-week');
  });

  it('drops an unknown tf to any (#407)', () => {
    expect(decodeViewer('?tf=bogus').filters?.timeframe ?? 'any').toBe('any');
  });

  // The Oldest-open block hands the aging set to the queue by writing this param
  // (#478), so a shared URL has to carry the same narrowed queue back.
  it('round-trips tf=aging (#478)', () => {
    const s = { ...DEFAULT_VIEWER, filters: { ...DEFAULT_VIEWER.filters, timeframe: 'aging' as const } };
    const enc = encodeViewer(s);
    expect(enc).toContain('tf=aging');
    expect(decodeViewer(enc).filters?.timeframe).toBe('aging');
  });
});

describe('route.ts delegates to the codec (#376)', () => {
  it('parseRoute reads a viewer query; routePath serializes it back', () => {
    const s: ViewerState = {
      q: '', group: 'label', view: 'board',
      filters: { ...DEFAULT_FILTERS, q: '', labels: ['bug'], assignees: [], projects: [], state: 'open' },
    };
    const path = routePath({ tab: 'projects', project: 7, viewer: s });
    expect(path.startsWith('/projects/7?')).toBe(true);
    const r = parseRoute('/projects/7', path.slice(path.indexOf('?')));
    expect(r).toMatchObject({ tab: 'projects', project: 7 });
    expect(r.viewer).toEqual(s);
  });

  it('a viewer-less route keeps a clean path and no viewer key', () => {
    expect(routePath({ tab: 'projects', project: 7 })).toBe('/projects/7');
    expect(parseRoute('/projects/7').viewer).toBeUndefined();
  });
});

// #429: the Project page leads with board mode via `defaultView`, which needs an
// unambiguous "did the URL actually say `view`" signal — `decodeViewer` can't give
// one, since it fills `view` with its OWN 'list' default the moment any other
// known param is present.
describe('hasExplicitView (#429)', () => {
  it('is false with no query and with unrelated known params', () => {
    expect(hasExplicitView('')).toBe(false);
    expect(hasExplicitView('?label=bug')).toBe(false);
  });

  it('is true whenever `view` is named, regardless of its value', () => {
    expect(hasExplicitView('?view=board')).toBe(true);
    expect(hasExplicitView('?view=list')).toBe(true);
    expect(hasExplicitView('?label=bug&view=board')).toBe(true);
  });
});

// #727: the group's twin of the signal above, and needed for the same reason —
// `decodeViewer` resolves `group` to DEFAULT_GROUP the moment ANY known param is
// present, so `/?label=bug` arrives claiming `status` and a host default would
// have nothing to sit above.
describe('hasExplicitGroup (#727)', () => {
  it('is false with no query and with unrelated known params', () => {
    expect(hasExplicitGroup('')).toBe(false);
    expect(hasExplicitGroup('?label=bug')).toBe(false);
  });

  it('is true whenever `group` is named, regardless of its value', () => {
    expect(hasExplicitGroup('?group=label')).toBe(true);
    expect(hasExplicitGroup('?label=bug&group=project')).toBe(true);
  });

  it('reads a query the router hands over without its leading `?`', () => {
    expect(hasExplicitGroup('group=label')).toBe(true);
  });
});

describe('encodeViewer: per-page default threshold (#429)', () => {
  it('omits `view` when it matches the app-wide default (unchanged behaviour)', () => {
    expect(encodeViewer({ ...DEFAULT_VIEWER, view: 'list' })).not.toContain('view=');
  });

  it('a defaultView of "board" omits `view` when the state IS board', () => {
    const s: ViewerState = { ...DEFAULT_VIEWER, view: 'board' };
    expect(encodeViewer(s, 'board')).not.toContain('view=');
  });

  it('a defaultView of "board" still writes `view=list` for an explicit list choice '
    + '(so it survives reload instead of reverting to the page default)', () => {
    const s: ViewerState = { ...DEFAULT_VIEWER, view: 'list' };
    expect(encodeViewer(s, 'board')).toContain('view=list');
  });
});

describe('the unassigned dimension in the URL (#462)', () => {
  it('round-trips as `?unassigned=1`', () => {
    const s: ViewerState = {
      q: '', group: DEFAULT_VIEWER.group, view: 'list',
      filters: { ...DEFAULT_FILTERS, unassigned: true },
    };
    expect(encodeViewer(s)).toBe('?unassigned=1');
    expect(decodeViewer(encodeViewer(s)).filters?.unassigned).toBe(true);
  });

  it('is omitted when off, so a pristine viewer stays a clean URL', () => {
    expect(encodeViewer(DEFAULT_VIEWER)).not.toContain('unassigned');
  });

  it('is enough on its own to make a query read as viewer state (a cold deep link)', () => {
    expect(decodeViewer('?unassigned=1').filters?.unassigned).toBe(true);
  });

  it('reads any other value as off', () => {
    expect(decodeViewer('?unassigned=0&label=bug').filters?.unassigned).toBe(false);
  });
});

/**
 * #782 — `?project=` carries a board NAME, and a name is not a board. Two orgs
 * can each hold a board called "Roadmap", and every reader of this param treated
 * the pair as one.
 *
 * The address rides beside the name in its own `?board=` param, spelled
 * `<org>/<number>/<name>`, and it QUALIFIES the name rather than replacing it.
 * That is why the codec keeps both: `filters.projects` is what the queue matches
 * on and what the FilterBar draws as a chip, unchanged; `filters.boards` is what
 * says which of the boards wearing that name was meant.
 */
describe('a board address rides beside the name it qualifies (#782)', () => {
  const withBoards = (projects: string[], boards: string[]): ViewerState => ({
    ...DEFAULT_VIEWER,
    filters: { ...DEFAULT_FILTERS, projects, boards },
  });

  it('round-trips the address and the name it qualifies', () => {
    const s = withBoards(['Roadmap'], ['acme/3/Roadmap']);
    const qs = encodeViewer(s);
    expect(decodeViewer(qs).filters?.projects).toEqual(['Roadmap']);
    expect(decodeViewer(qs).filters?.boards).toEqual(['acme/3/Roadmap']);
  });

  it('leaves the name-only URL exactly as it was — the chip writes one param still', () => {
    expect(encodeViewer(withBoards(['Roadmap'], []))).toBe('?project=Roadmap');
    expect(decodeViewer('?project=Roadmap').filters?.boards).toEqual([]);
  });

  it('carries a board name holding a slash whole', () => {
    // The token is parsed from the LEFT — an org holds no `/` and a number is
    // digits — so everything after the second `/` is the name, verbatim. A
    // right-to-left split would cut "Q3/Q4 push" in half and match nothing.
    const qs = encodeViewer(withBoards(['Q3/Q4 push'], ['acme/3/Q3/Q4 push']));
    expect(decodeViewer(qs).filters?.boards).toEqual(['acme/3/Q3/Q4 push']);
  });

  it('drops a token that is not an address rather than filtering on it', () => {
    expect(decodeViewer('?project=Roadmap&board=Roadmap').filters?.boards).toEqual([]);
    expect(decodeViewer('?project=Roadmap&board=acme/x/Roadmap').filters?.boards).toEqual([]);
    expect(decodeViewer('?project=Roadmap&board=').filters?.boards).toEqual([]);
  });

  it('drops an address the name it qualified has left, rather than carrying it forward', () => {
    // The FilterBar's chip owns `projects` and knows no addresses, so removing
    // the chip leaves the token behind in the state it commits. Written back out
    // it would re-narrow the name on the reader's next pick from the menu.
    expect(encodeViewer(withBoards([], ['acme/3/Roadmap']))).toBe('');
    expect(encodeViewer(withBoards(['Onboarding'], ['acme/3/Roadmap']))).toBe('?project=Onboarding');
  });

  it('is recognised as viewer state, so a stale `board` cannot fabricate a viewer alone', () => {
    // It is written only beside a `project`, but it has to be KNOWN either way:
    // an unrecognised param would survive a round-trip through the codec as
    // rubbish nobody drops.
    expect(decodeViewer('?board=acme/3/Roadmap').filters?.projects).toEqual([]);
    expect(decodeViewer('?board=acme/3/Roadmap').filters?.boards).toEqual(['acme/3/Roadmap']);
  });
});

it('round-trips the exact yesterday UTC drilldown (#913)', () => {
  const state = { ...DEFAULT_VIEWER, filters: { ...DEFAULT_VIEWER.filters, timeframe: 'closed-yesterday' as const } };
  expect(decodeViewer(encodeViewer(state)).filters?.timeframe).toBe('closed-yesterday');
});


describe('a triage grouping in the URL (#1099)', () => {
  const grouped = (group: GroupDim) => ({ ...DEFAULT_VIEWER, group });

  it('round-trips, separator and all', () => {
    expect(decodeViewer(encodeViewer(grouped('triage:size'))).group).toBe('triage:size');
    expect(decodeViewer(encodeViewer(grouped('triage:priority'))).group).toBe('triage:priority');
  });

  it('percent-encodes the `:` rather than splitting on it', () => {
    // `URLSearchParams` encodes each value whole, which is the same property
    // `?board=` leans on for `<org>/<number>/<name>`.
    expect(encodeViewer(grouped('triage:size'))).toBe('?group=triage%3Asize');
  });

  it('accepts a property this page has never seen, so a link from another queue works', () => {
    // Shape, not existence: `availableGroupDims` never offers a property the
    // data lacks and `resolveGroupDim` falls off it, exactly as `?group=status`
    // does on a queue with no Status field.
    expect(decodeViewer('?group=triage:effort').group).toBe('triage:effort');
  });

  it('falls back for a shape that names no single property', () => {
    expect(decodeViewer('?group=triage:').group).toBe(DEFAULT_GROUP);
    expect(decodeViewer('?group=triage:size:L').group).toBe(DEFAULT_GROUP);
    expect(decodeViewer('?group=triage').group).toBe(DEFAULT_GROUP);
  });

  it('still refuses a fixed dimension nobody has, which is a typo not a label', () => {
    expect(decodeViewer('?group=milestone').group).toBe(DEFAULT_GROUP);
  });

  it('is what `isGroupDim` answers, one test for the URL and for storage both', () => {
    expect(isGroupDim('triage:size')).toBe(true);
    expect(isGroupDim('status')).toBe(true);
    expect(isGroupDim('triage:')).toBe(false);
    expect(isGroupDim('milestone')).toBe(false);
    expect(isGroupDim(undefined)).toBe(false);
  });
});

describe('a triage grouping typed by hand (#1108)', () => {
  it('resolves whatever case and separator it was written in', () => {
    // N1: `?group=triage:Deadline-Class` used to pass validation in its own
    // spelling and then fall off `resolveGroupDim`, which reads as the link
    // having been ignored.
    for (const typed of ['triage:Deadline-Class', 'triage:deadline_class', 'triage:DEADLINE CLASS']) {
      expect(decodeViewer(`?group=${typed}`).group).toBe('triage:deadline-class');
    }
  });

  it('re-encodes in the one spelling, so a shared link stops depending on how it was typed', () => {
    const decoded = decodeViewer('?group=triage:Deadline_Class');
    expect(encodeViewer({ ...DEFAULT_VIEWER, group: decoded.group! })).toBe('?group=triage%3Adeadline-class');
  });

  it('names no grouping longer than a `triage:` label could carry', () => {
    // S4's bound: 41 characters of property, which is what is left of Github's
    // 50-character label name after `triage:`, the separating `:` and one
    // character of value.
    expect(decodeViewer(`?group=triage:${'x'.repeat(41)}`).group).toBe(`triage:${'x'.repeat(41)}`);
    expect(decodeViewer(`?group=triage:${'x'.repeat(42)}`).group).toBe(DEFAULT_GROUP);
    expect(decodeViewer(`?group=triage:${'x'.repeat(50_000)}`).group).toBe(DEFAULT_GROUP);
  });
});

import { describe, expect, it } from 'vitest';
import { TRIAGE_FAMILIES } from './triage-families';
import {
  CATCH_ALL,
  foldTriage,
  isTriageLabel,
  MAX_TRIAGE_PROPERTY,
  parseTriageLabel,
  triageDim,
  triageProperties,
  triagePropertyLabel,
  triagePropertyOf,
  triageValueLabel,
  triageValueOrder,
  triageValues,
} from './triage-labels';
import { groupDimLabels } from './ViewerControls';
import type { GroupDim } from './filter-group';

/** The twelve labels `acme/board` actually carries, read off
 *  its label list on 2026-09-13. Every assertion about "today's labels" below
 *  runs against this list and not a convenient subset of it. */
const REAL = [
  'triage:XS', 'triage:S', 'triage:M', 'triage:L', 'triage:XL',
  'triage:P0', 'triage:P1', 'triage:P2', 'triage:P3',
  'triage:agent', 'triage:owner', 'triage:defer',
];

describe('parseTriageLabel — the two-segment labels the repo carries (#1099)', () => {
  it('reads all twelve into exactly three properties', () => {
    const byProperty = new Map<string, string[]>();
    for (const name of REAL) {
      const facet = parseTriageLabel(name)!;
      byProperty.set(facet.property, [...(byProperty.get(facet.property) ?? []), facet.spelling]);
    }
    expect([...byProperty.keys()].sort()).toEqual(['priority', 'route', 'size']);
    expect(byProperty.get('size')).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    expect(byProperty.get('priority')).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(byProperty.get('route')).toEqual(['agent', 'owner', 'defer']);
  });

  it('keeps the value spelt as the label spells it, beside the folded identity', () => {
    expect(parseTriageLabel('triage:XS')).toEqual({ property: 'size', value: 'xs', spelling: 'XS' });
  });

  it('leaves every label outside the prefix alone', () => {
    for (const name of ['bug', 'pr:blocked', 'triaged', 'needs-triage']) {
      expect(parseTriageLabel(name)).toBeNull();
    }
  });
});

describe('parseTriageLabel — the three-segment shape, which needs no table entry', () => {
  it('reads the property straight out of the name', () => {
    expect(parseTriageLabel('triage:effort:3')).toEqual({ property: 'effort', value: '3', spelling: '3' });
  });

  it('folds the property so one family cannot split over its spelling', () => {
    expect(parseTriageLabel('triage:Size:L')).toEqual({ property: 'size', value: 'l', spelling: 'L' });
  });

  it('lands a renamed label in the same property as the old one, under the same value', () => {
    // The whole reason the two shapes fold together: renaming `triage:L` to
    // `triage:size:L` on Github must not split the Size stack in two, and must
    // not break a `?group=triage:size` link somebody already shared.
    expect(parseTriageLabel('triage:size:L')).toEqual(parseTriageLabel('triage:L'));
  });

  it('keeps a value that holds its own separators whole', () => {
    expect(parseTriageLabel('triage:effort:2:3')).toEqual({ property: 'effort', value: '2:3', spelling: '2:3' });
  });

  it('reads nothing from a label with no value after the property', () => {
    expect(parseTriageLabel('triage:size:')).toBeNull();
    expect(parseTriageLabel('triage:')).toBeNull();
    expect(parseTriageLabel('triage::L')).toBeNull();
  });
});

describe('parseTriageLabel — a two-segment value no family claims', () => {
  // The gap this closes: before the catch-all, a `triage:XXL` added on Github
  // ahead of its table row matched no family and no three-segment rule, and
  // vanished from every triage grouping without a word.
  it('files it under the catch-all rather than dropping it', () => {
    expect(parseTriageLabel('triage:XXL')).toEqual({ property: CATCH_ALL, value: 'xxl', spelling: 'XXL' });
  });

  it('never guesses a family for it', () => {
    expect(parseTriageLabel('triage:XXL')!.property).not.toBe('size');
  });

  it('leaves the catch-all the moment the family names it', () => {
    // What a person has to do to add a value to an existing family, as a test:
    // one row in `triage-families.ts`. This asserts the wiring, by naming the
    // value the table already carries and the value it does not.
    expect(parseTriageLabel('triage:XL')!.property).toBe('size');
    expect(parseTriageLabel('triage:XXL')!.property).toBe(CATCH_ALL);
  });
});

describe('isTriageLabel — the one question the Label grouping asks (#1099)', () => {
  // The Label grouping hides a triage label and stacks everything else; the
  // parser decides which labels make a triage grouping. Those two MUST be one
  // question, because a label that one of them owns and the other does not is
  // a label that draws nowhere, or twice. So the predicate is defined as the
  // parser's answer, and this block holds it to that on every shape the parser
  // has an opinion about — the ones it takes and the ones it refuses.
  it('is exactly whether the parser reads a property off the label', () => {
    const shapes = [
      ...REAL, 'Triage:P0', 'triage:XXL', 'triage:effort:3', 'triage:tech_debt:x', 'triage:tech-debt:x',
      'triage:', 'triage:size:', 'triage::L', 'bug', 'triaged', 'needs-triage', 'pr:blocked', 'No label',
    ];
    for (const name of shapes) {
      expect(isTriageLabel(name), name).toBe(parseTriageLabel(name) !== null);
    }
  });

  it('takes both separators of one property, and the fold decides nothing here', () => {
    expect(isTriageLabel('triage:tech-debt:x')).toBe(true);
    expect(isTriageLabel('triage:tech_debt:x')).toBe(true);
  });

  it('leaves a prefix with nothing usable after it to the Label grouping', () => {
    // The parser reads no property off these, so no triage grouping shows them.
    // Hiding them from Label too would be the one place a label could vanish.
    expect(isTriageLabel('triage:')).toBe(false);
    expect(isTriageLabel('triage:size:')).toBe(false);
  });
});

describe('triageProperties — what the Group by menu is offered', () => {
  it('offers the three families alphabetically for the labels the repo carries', () => {
    expect(triageProperties(REAL)).toEqual(['priority', 'route', 'size']);
  });

  it('offers nothing for a set carrying no triage label', () => {
    expect(triageProperties(['bug', 'ui', 'pr:blocked'])).toEqual([]);
  });

  it('offers a family nobody wrote code for, off the three-segment shape alone', () => {
    expect(triageProperties(['triage:effort:3', 'triage:P0'])).toEqual(['effort', 'priority']);
  });

  it('puts the catch-all last, and only when something landed in it', () => {
    expect(triageProperties(['triage:XXL', 'triage:P0'])).toEqual(['priority', CATCH_ALL]);
  });

  it('counts one property once however many labels carry it', () => {
    expect(triageProperties(['triage:XS', 'triage:XS', 'triage:L'])).toEqual(['size']);
  });
});

describe('triageValues — which stacks an issue lands in', () => {
  it('reads the value of the property asked for and no other', () => {
    expect(triageValues(['triage:L', 'triage:P0', 'bug'], 'size')).toEqual(['l']);
  });

  it('returns both when an issue wears two values of one property', () => {
    // Not a state anybody intends, but the grouping shows it rather than
    // picking one — the same call `label` grouping makes.
    expect(triageValues(['triage:P0', 'triage:P2'], 'priority')).toEqual(['p0', 'p2']);
  });

  it('returns one stack for one value however many spellings of it an issue wears', () => {
    // S3, at the issue: two spellings of one priority must not draw the same row
    // twice in the same stack.
    expect(triageValues(['triage:P0', 'triage:p0'], 'priority')).toEqual(['p0']);
  });

  it('returns nothing for an issue carrying none of that property', () => {
    expect(triageValues(['bug', 'triage:P0'], 'size')).toEqual([]);
  });
});

describe('the dimension a property makes, and reading it back', () => {
  it('round-trips', () => {
    expect(triagePropertyOf(triageDim('size'))).toBe('size');
  });

  it('is not a dimension for any fixed grouping', () => {
    for (const dim of ['status', 'openclosed', 'type', 'assignee', 'label', 'project', 'repo']) {
      expect(triagePropertyOf(dim)).toBeNull();
    }
  });

  it('refuses a shape that names no single property', () => {
    expect(triagePropertyOf('triage:')).toBeNull();
    expect(triagePropertyOf('triage:size:L')).toBeNull();
  });
});

describe('triageValueOrder — the scales, so a Size stack reads as one', () => {
  it('gives each family the order its table row declares', () => {
    expect(triageValueOrder('size')).toEqual(['xs', 's', 'm', 'l', 'xl']);
    expect(triageValueOrder('priority')).toEqual(['p0', 'p1', 'p2', 'p3']);
  });

  it('gives no order for a property nobody declared one for', () => {
    expect(triageValueOrder('effort')).toBeNull();
    expect(triageValueOrder(CATCH_ALL)).toBeNull();
  });
});

describe('triagePropertyLabel — what a reader sees', () => {
  it('is the property word itself', () => {
    expect(triagePropertyLabel('size')).toBe('size');
  });

  it('puts a space where a label name had to use a separator', () => {
    expect(triagePropertyLabel('tech-debt')).toBe('tech debt');
    expect(triagePropertyLabel('tech_debt')).toBe('tech debt');
  });
});

describe('triage-families.ts — the table itself', () => {
  it('claims no value for two properties at once', () => {
    const seen = new Map<string, string>();
    for (const family of TRIAGE_FAMILIES) {
      for (const value of family.values) {
        const folded = value.toLowerCase();
        expect(seen.get(folded)).toBeUndefined();
        seen.set(folded, family.property);
      }
    }
  });

  it('names no property twice', () => {
    const properties = TRIAGE_FAMILIES.map((f) => f.property);
    expect(new Set(properties).size).toBe(properties.length);
  });

  it('does not claim the catch-all as a family', () => {
    expect(TRIAGE_FAMILIES.map((f) => f.property)).not.toContain(CATCH_ALL);
  });
});


// ── #1108: the invariant, once per finding ──────────────────────────────────
// Two labels that differ only in case or separator are the same thing and must
// share one stack. Two labels that are genuinely different must never render
// under the same heading.

describe('foldTriage — the one normalisation (#1108)', () => {
  it('folds case and every separator to one identity', () => {
    expect(new Set(['tech-debt', 'tech_debt', 'tech debt', 'Tech Debt', 'TECH__DEBT'].map(foldTriage)).size).toBe(1);
    expect(foldTriage('P0')).toBe(foldTriage('p0'));
  });

  it('leaves two genuinely different words different', () => {
    expect(foldTriage('techdebt')).not.toBe(foldTriage('tech-debt'));
    expect(foldTriage('p0')).not.toBe(foldTriage('p1'));
  });
});

describe('S3 — one stack for one value, whatever case it was labelled in', () => {
  it('gives `triage:p0` and `triage:P0` the same identity', () => {
    // Github enforces label case-uniqueness per REPOSITORY and this queue spans
    // repositories, so both really do arrive. Before this they were two
    // adjacent Priority stacks.
    expect(parseTriageLabel('triage:p0')!.value).toBe(parseTriageLabel('triage:P0')!.value);
    expect(parseTriageLabel('triage:p0')!.property).toBe(parseTriageLabel('triage:P0')!.property);
  });

  it('heads that stack with the spelling the families table declares', () => {
    expect(triageValueLabel('priority', 'p0', ['p0', 'P0'])).toBe('P0');
    expect(triageValueLabel('priority', 'p0', ['p0'])).toBe('P0');
    expect(triageValueLabel('size', 'xs', ['xs'])).toBe('XS');
  });

  it('heads a stack nobody declared by a stated rule and not by arrival order', () => {
    // First in code-point order, so the same queue reads the same way twice.
    expect(triageValueLabel('effort', 'low', ['low', 'Low'])).toBe('Low');
    expect(triageValueLabel('effort', 'low', ['Low', 'low'])).toBe('Low');
  });

  it('falls back to the value itself when a stack collected no spelling', () => {
    expect(triageValueLabel('effort', 'low', [])).toBe('low');
  });
});

describe('S2 — separators, on both halves of a label', () => {
  it('makes `tech-debt`, `tech_debt` and `tech debt` one property and not three', () => {
    const properties = ['triage:tech-debt:yes', 'triage:tech_debt:yes', 'triage:tech debt:yes'];
    expect(triageProperties(properties)).toEqual(['tech-debt']);
    // Which is what stops three groupings rendering under one heading.
    expect(new Set(properties.map((n) => triagePropertyLabel(parseTriageLabel(n)!.property))).size).toBe(1);
  });

  it('makes them one stack and not three under one heading', () => {
    for (const name of ['triage:tech-debt:in-progress', 'triage:tech_debt:in progress']) {
      expect(parseTriageLabel(name)!.value).toBe('in-progress');
    }
  });

  it('leaves a property that is genuinely a different word alone', () => {
    expect(triageProperties(['triage:tech-debt:yes', 'triage:techdebt:yes']).length).toBe(2);
  });
});

describe('N1 — a grouping typed by hand resolves however it was spelt', () => {
  it('folds the incoming property rather than only matching the folded one', () => {
    for (const typed of ['triage:Deadline-Class', 'triage:deadline_class', 'triage:DEADLINE CLASS']) {
      expect(triagePropertyOf(typed)).toBe('deadline-class');
    }
  });

  it('lands on the dimension `availableGroupDims` actually offers', () => {
    const offered = triageDim(parseTriageLabel('triage:Deadline-Class:soon')!.property);
    expect(triageDim(triagePropertyOf('triage:Deadline-Class')!)).toBe(offered);
  });

  it('still refuses a shape that names no single property', () => {
    expect(triagePropertyOf('triage:-')).toBeNull();
    expect(triagePropertyOf('triage:size:L')).toBeNull();
  });
});

describe('S4 — the ceiling on what a grouping may be', () => {
  // A dimension longer than any `triage:` label could name is a grouping this
  // page can never resolve, so it is not one a URL may name and not one a stored
  // arrangement may hold.
  it('is the longest property a 50-character Github label can carry', () => {
    expect(MAX_TRIAGE_PROPERTY).toBe(41);
    expect(`triage:${'x'.repeat(MAX_TRIAGE_PROPERTY)}:v`.length).toBe(50);
  });

  it('reads a property right up to the ceiling', () => {
    expect(triagePropertyOf(`triage:${'x'.repeat(MAX_TRIAGE_PROPERTY)}`)).toBe('x'.repeat(MAX_TRIAGE_PROPERTY));
  });

  it('reads none past it, however long the string is', () => {
    expect(triagePropertyOf(`triage:${'x'.repeat(MAX_TRIAGE_PROPERTY + 1)}`)).toBeNull();
    expect(triagePropertyOf(`triage:${'x'.repeat(50_000)}`)).toBeNull();
  });

  it('still shows a label whose property is past it, under the catch-all', () => {
    // The ceiling bounds a DIMENSION. A label is never made to vanish by it.
    const long = `triage:${'x'.repeat(MAX_TRIAGE_PROPERTY + 1)}:v`;
    expect(parseTriageLabel(long)!.property).toBe(CATCH_ALL);
  });
});

describe('S1 — no two rows in the Group by menu carry the same label', () => {
  const rows = (dims: GroupDim[]) => [...groupDimLabels(dims).values()];

  it('disambiguates a derived property named like a fixed dimension', () => {
    // A `triage:type:*` family on Github used to draw two rows both reading
    // "type"; picking one of them was a guess.
    expect(rows(['type', 'label', 'triage:type'])).toEqual(['type', 'label', 'type (triage)']);
  });

  it('never drops the derived row, which is the failure #1099 was filed about', () => {
    expect(groupDimLabels(['type', 'triage:type']).has('triage:type')).toBe(true);
  });

  it('holds over every fixed dimension a family could be named after', () => {
    const fixed: GroupDim[] = ['status', 'openclosed', 'type', 'assignee', 'label', 'project', 'repo'];
    const derived = fixed.map((d) => triageDim(d === 'openclosed' ? 'open / closed' : d));
    const labels = rows([...fixed, ...derived]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('leaves a derived property nobody collides with exactly as it reads', () => {
    expect(rows(['label', 'triage:size', 'triage:tech-debt'])).toEqual(['label', 'size', 'tech debt']);
  });
});

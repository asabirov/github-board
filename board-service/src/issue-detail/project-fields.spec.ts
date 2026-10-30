import { describe, expect, it } from 'vitest';
import { isFieldClear, mapFieldDef, mapFieldDefs, mapFieldValue, toGqlFieldValue } from './project-fields';

describe('mapFieldDef', () => {
  it('maps a single-select field def with options', () => {
    const def = mapFieldDef({
      __typename: 'ProjectV2SingleSelectField',
      id: 'F1',
      name: 'Status',
      options: [
        { id: 'o1', name: 'Todo', color: 'GRAY' },
        { id: 'o2', name: 'Done', color: 'GREEN' },
      ],
    } as any);
    expect(def).toEqual({
      fieldId: 'F1',
      name: 'Status',
      dataType: 'single_select',
      options: [
        { id: 'o1', name: 'Todo', color: 'GRAY' },
        { id: 'o2', name: 'Done', color: 'GREEN' },
      ],
    });
  });

  it('maps an iteration field def with iterations', () => {
    const def = mapFieldDef({
      __typename: 'ProjectV2IterationField',
      id: 'F2',
      name: 'Sprint',
      configuration: {
        iterations: [
          { id: 'i1', title: 'Sprint 1' },
          { id: 'i2', title: 'Sprint 2' },
        ],
      },
    } as any);
    expect(def).toEqual({
      fieldId: 'F2',
      name: 'Sprint',
      dataType: 'iteration',
      iterations: [
        { id: 'i1', title: 'Sprint 1' },
        { id: 'i2', title: 'Sprint 2' },
      ],
    });
  });

  it('maps a text field def', () => {
    const def = mapFieldDef({
      __typename: 'ProjectV2Field',
      id: 'F3',
      name: 'Notes',
      dataType: 'TEXT',
    } as any);
    expect(def).toEqual({ fieldId: 'F3', name: 'Notes', dataType: 'text' });
  });

  it('maps a number field def', () => {
    const def = mapFieldDef({
      __typename: 'ProjectV2Field',
      id: 'F4',
      name: 'Estimate',
      dataType: 'NUMBER',
    } as any);
    expect(def).toEqual({ fieldId: 'F4', name: 'Estimate', dataType: 'number' });
  });

  it('maps a date field def', () => {
    const def = mapFieldDef({
      __typename: 'ProjectV2Field',
      id: 'F5',
      name: 'Due',
      dataType: 'DATE',
    } as any);
    expect(def).toEqual({ fieldId: 'F5', name: 'Due', dataType: 'date' });
  });

  it('drops an unsupported field type', () => {
    expect(mapFieldDef({ __typename: 'ProjectV2FieldOfSomeFutureKind' } as any)).toBeNull();
  });

  it('drops a ProjectV2Field with an unsupported dataType', () => {
    expect(
      mapFieldDef({
        __typename: 'ProjectV2Field',
        id: 'F6',
        name: 'Mystery',
        dataType: 'SOME_FUTURE_TYPE',
      } as any),
    ).toBeNull();
  });
});

describe('mapFieldDefs — which single-select is the seeded Status (#1199)', () => {
  // The page cannot be told by the field's NAME: a project renames Status, and
  // a project adds a field of its own called "status". `seededWithProject`
  // reads the one signal GitHub gives, the timestamp it stamped both with —
  // and the whole list decides, because that timestamp can be shared.
  const SEEDED = '2026-03-04T10:15:22Z';
  const singleSelect = (name: string, createdAt: string | null, id = 'F1') =>
    ({ __typename: 'ProjectV2SingleSelectField', id, name, createdAt, options: [] }) as any;
  const marked = (defs: { name: string; builtInStatus?: boolean }[]) =>
    defs.filter((d) => d.builtInStatus).map((d) => d.name);

  it('marks the field GitHub created WITH the project as the built-in Status', () => {
    expect(marked(mapFieldDefs([singleSelect('Status', SEEDED)], SEEDED))).toEqual(['Status']);
  });

  it('marks it however the project has since renamed it', () => {
    expect(marked(mapFieldDefs([singleSelect('Состояние', SEEDED)], SEEDED))).toEqual(['Состояние']);
  });

  it('leaves a field added later unmarked, whatever it is called', () => {
    const later = '2026-06-01T09:00:00Z';
    const defs = mapFieldDefs(
      [singleSelect('Status', SEEDED, 'F1'), singleSelect('status', later, 'F2'), singleSelect('Status', later, 'F3')],
      SEEDED,
    );
    expect(defs.filter((d) => d.builtInStatus).map((d) => d.fieldId)).toEqual(['F1']);
  });

  it('reads the two timestamps as instants, not as strings', () => {
    expect(marked(mapFieldDefs([singleSelect('Status', '2026-03-04T10:15:22+00:00')], SEEDED))).toEqual(['Status']);
  });

  // GitHub stamps `createdAt` to the second, so a single-select somebody
  // created in the same second as the project shares its instant without being
  // the seeded one. The rule cannot tell the two apart, so it marks neither and
  // BOTH keep their search field — the failure it is allowed to have, never the
  // one #1199 was filed about.
  it('marks neither where a second single-select shares the project\u2019s instant', () => {
    const defs = mapFieldDefs([singleSelect('Status', SEEDED, 'F1'), singleSelect('Team', SEEDED, 'F2')], SEEDED);
    expect(defs).toHaveLength(2);
    expect(marked(defs)).toEqual([]);
    expect(defs[0]).not.toHaveProperty('builtInStatus');
    expect(defs[1]).not.toHaveProperty('builtInStatus');
  });

  // The copied or templated project, where the copy stamps every field it
  // brought along with the new project's own instant. Not reproducible here
  // without creating a project in the owner's org, so it is pinned as a shape.
  it('marks none of them where a whole copied schema shares that instant', () => {
    const copied = ['Status', 'Phase', 'Scope', 'Team', 'Priority'].map((n, i) =>
      singleSelect(n, SEEDED, `F${i + 1}`),
    );
    expect(marked(mapFieldDefs(copied, SEEDED))).toEqual([]);
  });

  // Thirteen of the fourteen fields GitHub seeds a project with share the
  // project's instant; Status is the only single-select among them, and the
  // count is over single-selects alone, so they do not resolve it away.
  it('counts only single-selects, not the other fields GitHub seeds', () => {
    const defs = mapFieldDefs(
      [
        singleSelect('Status', SEEDED, 'F1'),
        { __typename: 'ProjectV2Field', id: 'F2', name: 'Title', dataType: 'TEXT', createdAt: SEEDED } as any,
        { __typename: 'ProjectV2IterationField', id: 'F3', name: 'Sprint', createdAt: SEEDED } as any,
      ],
      SEEDED,
    );
    expect(defs.filter((d) => d.builtInStatus).map((d) => d.fieldId)).toEqual(['F1']);
  });

  it('leaves the marker off where either timestamp is missing or unreadable', () => {
    expect(marked(mapFieldDefs([singleSelect('Status', SEEDED)]))).toEqual([]);
    expect(marked(mapFieldDefs([singleSelect('Status', null)], SEEDED))).toEqual([]);
    expect(marked(mapFieldDefs([singleSelect('Status', 'not a date')], SEEDED))).toEqual([]);
    // Both unreadable and identical as strings: `NaN === NaN` is false, so the
    // project side is guarded without a second check.
    expect(marked(mapFieldDefs([singleSelect('Status', 'not a date')], 'not a date'))).toEqual([]);
    expect(marked(mapFieldDefs([singleSelect('Status', SEEDED)], 'not a date'))).toEqual([]);
  });

  it('drops the nodes `mapFieldDef` drops and keeps mapping the rest', () => {
    const defs = mapFieldDefs(
      [null, undefined, { __typename: 'ProjectV2FieldOfSomeFutureKind' } as any, singleSelect('Status', SEEDED)],
      SEEDED,
    );
    expect(defs.map((d) => d.name)).toEqual(['Status']);
    expect(marked(defs)).toEqual(['Status']);
  });

  it('never marks a field `mapFieldDef` alone would leave unmarked', () => {
    // The per-field mapper carries no marker at all — the rule needs siblings.
    expect(mapFieldDef(singleSelect('Status', SEEDED))).not.toHaveProperty('builtInStatus');
  });
});

describe('mapFieldValue', () => {
  it('maps a single-select value', () => {
    expect(
      mapFieldValue({
        __typename: 'ProjectV2ItemFieldSingleSelectValue',
        field: { id: 'F1' },
        optionId: 'o1',
      } as any),
    ).toEqual({ fieldId: 'F1', value: { kind: 'single_select', optionId: 'o1' } });
  });

  it('maps a text value', () => {
    expect(
      mapFieldValue({
        __typename: 'ProjectV2ItemFieldTextValue',
        field: { id: 'F2' },
        text: 'hello',
      } as any),
    ).toEqual({ fieldId: 'F2', value: { kind: 'text', text: 'hello' } });
  });

  it('maps a number value', () => {
    expect(
      mapFieldValue({
        __typename: 'ProjectV2ItemFieldNumberValue',
        field: { id: 'F3' },
        number: 5,
      } as any),
    ).toEqual({ fieldId: 'F3', value: { kind: 'number', number: 5 } });
  });

  it('maps a date value', () => {
    expect(
      mapFieldValue({
        __typename: 'ProjectV2ItemFieldDateValue',
        field: { id: 'F4' },
        date: '2026-08-02',
      } as any),
    ).toEqual({ fieldId: 'F4', value: { kind: 'date', date: '2026-08-02' } });
  });

  it('maps an iteration value', () => {
    expect(
      mapFieldValue({
        __typename: 'ProjectV2ItemFieldIterationValue',
        field: { id: 'F5' },
        iterationId: 'i1',
      } as any),
    ).toEqual({ fieldId: 'F5', value: { kind: 'iteration', iterationId: 'i1' } });
  });

  it('drops an unsupported value type', () => {
    expect(
      mapFieldValue({ __typename: 'ProjectV2ItemFieldOfSomeFutureKind' } as any),
    ).toBeNull();
  });
});

describe('toGqlFieldValue', () => {
  it('maps every FieldValue kind to the GraphQL input key', () => {
    expect(toGqlFieldValue({ kind: 'single_select', optionId: 'o1' })).toEqual({
      singleSelectOptionId: 'o1',
    });
    expect(toGqlFieldValue({ kind: 'single_select', optionId: null })).toEqual({
      singleSelectOptionId: null,
    });
    expect(toGqlFieldValue({ kind: 'text', text: 'hi' })).toEqual({ text: 'hi' });
    expect(toGqlFieldValue({ kind: 'number', number: 5 })).toEqual({ number: 5 });
    expect(toGqlFieldValue({ kind: 'number', number: null })).toEqual({ number: null });
    expect(toGqlFieldValue({ kind: 'date', date: '2026-08-02' })).toEqual({
      date: '2026-08-02',
    });
    expect(toGqlFieldValue({ kind: 'date', date: null })).toEqual({ date: null });
    expect(toGqlFieldValue({ kind: 'iteration', iterationId: 'i1' })).toEqual({
      iterationId: 'i1',
    });
    expect(toGqlFieldValue({ kind: 'iteration', iterationId: null })).toEqual({
      iterationId: null,
    });
  });
});

describe('isFieldClear', () => {
  it('is true for a null single_select optionId', () => {
    expect(isFieldClear({ kind: 'single_select', optionId: null })).toBe(true);
  });
  it('is false for a real single_select optionId', () => {
    expect(isFieldClear({ kind: 'single_select', optionId: 'o1' })).toBe(false);
  });

  it('is true for a null iteration iterationId', () => {
    expect(isFieldClear({ kind: 'iteration', iterationId: null })).toBe(true);
  });
  it('is false for a real iteration iterationId', () => {
    expect(isFieldClear({ kind: 'iteration', iterationId: 'i1' })).toBe(false);
  });

  it('is true for a null date', () => {
    expect(isFieldClear({ kind: 'date', date: null })).toBe(true);
  });
  it('is false for a real date', () => {
    expect(isFieldClear({ kind: 'date', date: '2026-08-03' })).toBe(false);
  });

  it('is true for a null number', () => {
    expect(isFieldClear({ kind: 'number', number: null })).toBe(true);
  });
  it('is false for a zero number (0 is a real value, not a clear)', () => {
    expect(isFieldClear({ kind: 'number', number: 0 })).toBe(false);
  });

  it('is true for an empty-string text', () => {
    expect(isFieldClear({ kind: 'text', text: '' })).toBe(true);
  });
  it('is false for a non-empty text', () => {
    expect(isFieldClear({ kind: 'text', text: 'x' })).toBe(false);
  });
});

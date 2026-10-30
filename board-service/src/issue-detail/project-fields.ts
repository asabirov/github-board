/**
 * Projects v2 field-definition + value mappers (#384). Pure functions only —
 * no I/O. Translate between GitHub's GraphQL field/value union shapes and our
 * `ProjectFieldDef` / `FieldValue` types (`issue-detail.types.ts`). The GitHub
 * source (Task 6) calls `mapFieldDefs`/`mapFieldValue` when reading a project's
 * schema + an issue's values; the GitHub source (Task 8) calls
 * `toGqlFieldValue` when writing a value back.
 *
 * Unknown/future typenames map to `null` rather than throwing — GitHub can
 * add new Projects v2 field kinds at any time, and an unsupported kind should
 * be silently ignored, not crash the read.
 */
import type { FieldDataType, FieldValue, ProjectFieldDef } from './issue-detail.types';

/** GitHub's raw dataType enum for the plain `ProjectV2Field` (text/number/date). */
type GqlPlainDataType = 'TEXT' | 'NUMBER' | 'DATE' | string;

/** The `ProjectV2FieldConfiguration` union, discriminated by `__typename`.
 *  Fields are optional so a half-null payload never throws. */
export type GqlFieldNode =
  | {
      __typename: 'ProjectV2SingleSelectField';
      id?: string;
      name?: string;
      /** When the project got this field — the whole of `seededWithProject`. */
      createdAt?: string | null;
      options?: { id: string; name: string; color: string | null }[];
    }
  | {
      __typename: 'ProjectV2IterationField';
      id?: string;
      name?: string;
      /** Every field kind carries it — the query asks `ProjectV2FieldCommon`
       *  for it — and GitHub stamps most of a project's seeded fields with the
       *  project's own. Only a single-select's is read (`mapFieldDefs`). */
      createdAt?: string | null;
      configuration?: { iterations?: { id: string; title: string }[] };
    }
  | {
      __typename: 'ProjectV2Field';
      id?: string;
      name?: string;
      createdAt?: string | null;
      dataType?: GqlPlainDataType;
    };

/** The `ProjectV2ItemFieldValue` union, discriminated by `__typename`. */
export type GqlFieldValueNode =
  | { __typename: 'ProjectV2ItemFieldSingleSelectValue'; field?: { id?: string }; optionId?: string | null }
  | { __typename: 'ProjectV2ItemFieldTextValue'; field?: { id?: string }; text?: string | null }
  | { __typename: 'ProjectV2ItemFieldNumberValue'; field?: { id?: string }; number?: number | null }
  | { __typename: 'ProjectV2ItemFieldDateValue'; field?: { id?: string }; date?: string | null }
  | { __typename: 'ProjectV2ItemFieldIterationValue'; field?: { id?: string }; iterationId?: string | null };

const PLAIN_DATA_TYPES: Record<string, FieldDataType> = {
  TEXT: 'text',
  NUMBER: 'number',
  DATE: 'date',
};

/**
 * Whether this field carries the project's own creation instant (#1199).
 *
 * This is half of the question. It asks "was this field stamped with the
 * project", and a single-select that answers yes is the built-in Status only
 * if it is the ONLY single-select that answers yes — which is a property of
 * the whole field list, not of one field, so `mapFieldDefs` asks that half.
 *
 * There is no marker to read. `ProjectV2SingleSelectField` publishes
 * `createdAt`, `dataType`, `databaseId`, `id`, `isIssueField`, `issueField`,
 * `name`, `options`, `project` and `updatedAt` — no `isDefault`, no
 * `isBuiltIn`. Introspected, and the two that look like they might answer do
 * not: `isIssueField` is false on the built-in Status of all three live
 * projects, and `databaseId` differs from one project to the next. The
 * timestamp is the one signal that held on all three — GitHub creates Status
 * as it creates the project, so the field's `createdAt` IS the project's, and
 * a field somebody added afterwards is later.
 *
 * This is a heuristic about how GitHub seeds a project, not a contract GitHub
 * publishes. It can stop being true — a change in the seeding, a project
 * created some way that stamps the two differently — and then it matches
 * nothing. That is the direction it is allowed to fail in: no match means no
 * marker, and the page draws the search field it draws by default.
 *
 * Compared as instants rather than as strings, so two spellings of one moment
 * ('…Z' and '…+00:00') are still that moment.
 */
function seededWithProject(fieldCreatedAt: string | null | undefined, projectCreatedAt: string | null | undefined): boolean {
  if (!fieldCreatedAt || !projectCreatedAt) return false;
  const field = Date.parse(fieldCreatedAt);
  const project = Date.parse(projectCreatedAt);
  return Number.isFinite(field) && field === project;
}

/** Map a project's field schema node to our `ProjectFieldDef`, or `null` for
 *  an unsupported field kind (forward-compatible: never throws).
 *
 *  Carries no `builtInStatus`: which single-select is the seeded Status cannot
 *  be read off one field, so only `mapFieldDefs`, which sees the project's
 *  whole list, writes that marker. */
export function mapFieldDef(node: GqlFieldNode): ProjectFieldDef | null {
  switch (node.__typename) {
    case 'ProjectV2SingleSelectField':
      return {
        fieldId: node.id ?? '',
        name: node.name ?? '',
        dataType: 'single_select',
        options: node.options ?? [],
      };
    case 'ProjectV2IterationField':
      return {
        fieldId: node.id ?? '',
        name: node.name ?? '',
        dataType: 'iteration',
        iterations: node.configuration?.iterations ?? [],
      };
    case 'ProjectV2Field': {
      const dataType = node.dataType ? PLAIN_DATA_TYPES[node.dataType] : undefined;
      if (!dataType) return null;
      return { fieldId: node.id ?? '', name: node.name ?? '', dataType };
    }
    default:
      return null;
  }
}

/**
 * Mark the sole single-select in the supplied schema whose valid creation
 * instant equals the project's, as a heuristic for seeded Status (#1199).
 * Names play no part: renaming a field cannot change the result, and a field
 * with a later instant cannot match. Missing or invalid project timestamps,
 * no matches, or multiple matches leave every marker off and preserve search.
 *
 * Uniqueness is only over the supplied nodes (the source currently requests
 * the first 30 fields). A lone custom single-select carrying the project's
 * instant still matches if seeded Status is absent, outside that window, or
 * carries a different instant. The available data cannot distinguish that
 * case from seeded Status, so that custom field can still lose its search.
 */
export function mapFieldDefs(
  nodes: readonly (GqlFieldNode | null | undefined)[],
  projectCreatedAt?: string | null,
): ProjectFieldDef[] {
  const defs: ProjectFieldDef[] = [];
  // One pass, which this walk already is: remember where the candidates
  // landed, and mark only if the walk ends with exactly one of them.
  const seeded: number[] = [];
  for (const node of nodes) {
    if (!node) continue;
    const def = mapFieldDef(node);
    if (!def) continue;
    if (node.__typename === 'ProjectV2SingleSelectField' && seededWithProject(node.createdAt, projectCreatedAt)) {
      seeded.push(defs.length);
    }
    defs.push(def);
  }
  // Written only where it holds: an absent marker is "not established", and
  // every reader of it treats that as the ordinary field.
  if (seeded.length === 1) defs[seeded[0]] = { ...defs[seeded[0]], builtInStatus: true };
  return defs;
}

/** Map an issue's field-value node to its fieldId + our `FieldValue`, or
 *  `null` for an unsupported value kind (forward-compatible: never throws). */
export function mapFieldValue(node: GqlFieldValueNode): { fieldId: string; value: FieldValue } | null {
  switch (node.__typename) {
    case 'ProjectV2ItemFieldSingleSelectValue':
      return {
        fieldId: node.field?.id ?? '',
        value: { kind: 'single_select', optionId: node.optionId ?? null },
      };
    case 'ProjectV2ItemFieldTextValue':
      return {
        fieldId: node.field?.id ?? '',
        value: { kind: 'text', text: node.text ?? '' },
      };
    case 'ProjectV2ItemFieldNumberValue':
      return {
        fieldId: node.field?.id ?? '',
        value: { kind: 'number', number: node.number ?? null },
      };
    case 'ProjectV2ItemFieldDateValue':
      return {
        fieldId: node.field?.id ?? '',
        value: { kind: 'date', date: node.date ?? null },
      };
    case 'ProjectV2ItemFieldIterationValue':
      return {
        fieldId: node.field?.id ?? '',
        value: { kind: 'iteration', iterationId: node.iterationId ?? null },
      };
    default:
      return null;
  }
}

/** Map our discriminated `FieldValue` to the GraphQL `ProjectV2FieldValue`
 *  input shape for `updateProjectV2ItemFieldValue`. A `switch` with no
 *  `default` so TypeScript enforces exhaustiveness over the `FieldValue`
 *  union — adding a new `kind` without updating this function is a compile
 *  error, not a silent no-op on the live API. */
export function toGqlFieldValue(v: FieldValue): Record<string, unknown> {
  switch (v.kind) {
    case 'single_select':
      return { singleSelectOptionId: v.optionId };
    case 'text':
      return { text: v.text };
    case 'number':
      return { number: v.number };
    case 'date':
      return { date: v.date };
    case 'iteration':
      return { iterationId: v.iterationId };
  }
}

/** True when this FieldValue means "clear the field" — GitHub can't clear via
 *  updateProjectV2ItemFieldValue(null); the source routes these to
 *  clearProjectV2ItemFieldValue instead. */
export function isFieldClear(v: FieldValue): boolean {
  switch (v.kind) {
    case 'single_select':
      return v.optionId === null;
    case 'iteration':
      return v.iterationId === null;
    case 'date':
      return v.date === null;
    case 'number':
      return v.number === null;
    case 'text':
      return v.text === '';
  }
}

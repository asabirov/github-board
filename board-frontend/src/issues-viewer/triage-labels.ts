/**
 * The `triage:` labels, read as properties the queue can group by (#1099).
 *
 * An issue's triage decisions are written as labels: how big it is, how urgent,
 * who takes it. The board could group by `label`, which draws one stack per
 * label name — `triage:XS` beside `triage:P0` beside `bug` — and never by Size
 * or Priority, which is what a person triaging actually asks for.
 *
 * ## The invariant every function here holds to
 *
 * **Two labels that differ only in case or separator are the same thing and must
 * share one stack. Two labels that are genuinely different must never render
 * under the same heading.**
 *
 * `foldTriage` is the one normalisation that makes the first half true, and it
 * is applied to BOTH halves of a label — the property and the value — and to a
 * `?group=` on its way in. The second half is why a stack still shows a spelling
 * a label actually used (`triageValueLabel`) rather than the folded key, and why
 * `groupDimLabels` in `ViewerControls.tsx` refuses to draw two menu rows under
 * one name.
 *
 * Both halves are reachable in production, not theoretical: Github enforces label
 * case-uniqueness per REPOSITORY, and this queue spans repositories, so
 * `triage:p0` in one repo and `triage:P0` in another arrive together.
 *
 * ## The two label shapes
 *
 * Two shapes reach this parse, and only one of them says what property it
 * encodes:
 *
 * - `triage:<property>:<value>` — `triage:size:L`, `triage:effort:3`. The
 *   property is written down, so a family nobody here has heard of becomes a
 *   grouping with no code change. This is the shape to name new families in.
 * - `triage:<value>` — `triage:XS`, `triage:P0`, `triage:agent`, the twelve
 *   labels the repo carries today. Nothing in `triage:XS` says "size", so the
 *   property comes from `triage-families.ts`, which is the team convention
 *   written down and the one place a label can need a change.
 *
 * A two-segment value no family claims is NOT dropped. It groups under
 * `CATCH_ALL` — one stack, named, in a grouping called Triage that appears only
 * when such a label exists. A `triage:XXL` added before its table row is
 * somewhere a reader can see rather than missing from the board, which is the
 * whole reason the catch-all is here.
 *
 * Triage-specific on purpose. The repo also carries a `pr:` family and the
 * reporter asked for triage alone, so the prefix is a constant here rather than
 * a parameter; `TRIAGE_PREFIX` and the families table are the only two things a
 * second prefix would need.
 */
import { TRIAGE_FAMILIES } from './triage-families';

/** What every label in a triage family starts with. */
export const TRIAGE_PREFIX = 'triage:';

/**
 * The one fold: lower case, and every run of `-`, `_` or whitespace as a single
 * `-`, with any at the ends dropped.
 *
 * This is the invariant above, as a function. `triage:P0` and `triage:p0` fold
 * to one stack; `triage:tech-debt:x`, `triage:tech_debt:y` and
 * `triage:tech debt:z` name one property and not three groupings that would all
 * have drawn the heading "tech debt".
 *
 * `-` is the canonical separator rather than a space because the folded property
 * is also a grouping dimension and therefore a `?group=` value, and
 * `triage:tech-debt` is a link a person can read. `triagePropertyLabel` is what
 * puts the space back for a reader.
 */
export function foldTriage(text: string): string {
  return text.toLowerCase().replace(/[-_\s]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The longest property a `triage:` label can name.
 *
 * Github caps a label name at 50 characters, and the shortest label that names a
 * property spends `triage:` (7) plus a separating `:` plus at least one
 * character of value on everything else — so 41 is the longest property any real
 * label can carry. A longer one is not a grouping this page could ever resolve,
 * whatever a hand-written `?group=` says, so it is not a dimension and is not
 * something a stored arrangement may hold.
 */
export const MAX_TRIAGE_PROPERTY = 50 - TRIAGE_PREFIX.length - 2;

/**
 * The property a two-segment value nobody claims is filed under.
 *
 * Its own name, so the menu reads Triage and the stack over the unclaimed
 * labels is the prefix they share. The dimension it makes is `triage:triage`,
 * which is only ever a React key and a `?group=` value. A real label spelled
 * `triage:triage:x` would land here too, which is a collision nobody will ever
 * type and the alternative was a made-up word a label could collide with just
 * as well.
 */
export const CATCH_ALL = 'triage';

/** A grouping dimension naming one triage property, e.g. `triage:size`. Kept
 *  distinct from the value it holds: the dimension is `triage:size` whichever
 *  shape the labels are written in. */
export type TriageDim = `triage:${string}`;

/** One property read off one label. `property` and `value` are folded, so they
 *  are identities — what decides which grouping and which stack. `spelling` is
 *  the value exactly as this label writes it, and is a CANDIDATE heading: which
 *  of the spellings a stack collected actually gets drawn is
 *  `triageValueLabel`'s answer, never whichever label arrived first. */
export interface TriageFacet {
  property: string;
  value: string;
  spelling: string;
}

/** value (folded) -> property, for the two-segment shape. */
const PROPERTY_OF_VALUE = new Map(
  TRIAGE_FAMILIES.flatMap((f) => f.values.map((v) => [foldTriage(v), foldTriage(f.property)] as const)),
);

/** property -> its declared value order (folded), for display ranking. */
const ORDER_OF_PROPERTY = new Map(
  TRIAGE_FAMILIES.map((f) => [foldTriage(f.property), f.values.map(foldTriage)] as const),
);

/** property -> folded value -> the spelling the family declares for it. The
 *  table is where the team wrote down how it spells its own values, so it wins
 *  over anything a repository happened to type. */
const SPELLING_OF_VALUE = new Map(
  TRIAGE_FAMILIES.map(
    (f) => [foldTriage(f.property), new Map(f.values.map((v) => [foldTriage(v), v] as const))] as const,
  ),
);

/**
 * The property and value one label encodes, or `null` for a label that is not a
 * triage label at all.
 *
 * Only two things read `null`: a name outside the prefix, and a `triage:` with
 * nothing usable after it (`triage:`, `triage:size:`). Everything else gets a
 * property, the unclaimed values included — see `CATCH_ALL`. What this must
 * never do is be WRONG: filing `triage:XXL` under Size because it starts with
 * an X would be the parse guessing, and a guess is worse here than a stack
 * called Triage.
 */
export function parseTriageLabel(name: string): TriageFacet | null {
  if (!name.toLowerCase().startsWith(TRIAGE_PREFIX)) return null;
  const rest = name.slice(TRIAGE_PREFIX.length);
  const cut = rest.indexOf(':');
  if (cut === 0) return null;
  if (cut > 0) {
    const property = foldTriage(rest.slice(0, cut));
    const spelling = rest.slice(cut + 1);
    if (!spelling) return null;
    // A property no real label could carry is not read as one — but the label
    // still lands under the catch-all below rather than disappearing, which is
    // the rule this whole file is built around.
    if (property && property.length <= MAX_TRIAGE_PROPERTY) {
      return { property, value: foldTriage(spelling), spelling };
    }
  }
  if (!rest) return null;
  return { property: PROPERTY_OF_VALUE.get(foldTriage(rest)) ?? CATCH_ALL, value: foldTriage(rest), spelling: rest };
}

/**
 * Whether a label is a triage label: the thing the Label grouping skips, now
 * that Size, Priority and Route have groupings of their own (#1099).
 *
 * Defined as the parser's answer and nothing looser, on purpose. Two predicates
 * for "is this a triage label" would be two places to disagree, and a label one
 * of them owns and the other does not is a label drawn nowhere, or twice. So a
 * label goes to a triage grouping if and only if it leaves the Label grouping:
 * `triage:tech_debt:x` and `triage:tech-debt:x` are both triage labels because
 * `foldTriage` makes them one property, and a bare `triage:` is not one because
 * the parser reads no property off it, which keeps it in the one grouping that
 * can still show it.
 */
export const isTriageLabel = (name: string): boolean => parseTriageLabel(name) !== null;

/** The grouping dimension for a property. The property is folded first, so
 *  `triageDim` of anything is a dimension `triagePropertyOf` reads back whole. */
export const triageDim = (property: string): TriageDim => `${TRIAGE_PREFIX}${foldTriage(property)}`;

/**
 * The property a grouping dimension names, or `null` for every other dimension.
 *
 * The incoming property is FOLDED, not merely matched: a hand-written
 * `?group=triage:Deadline-Class` and a stored `triage:deadline_class` name the
 * one grouping `availableGroupDims` offers, rather than silently falling off
 * onto the host's lead because only the folded spelling resolved.
 *
 * Beyond the fold the shape test stays loose — non-empty, no further `:`, and
 * within `MAX_TRIAGE_PROPERTY` — because this is also what validates a `?group=`
 * somebody hand-edited. A property this data does not carry needs no rejection
 * here: `availableGroupDims` never offers it and `resolveGroupDim` falls back
 * off it, which is the same path a stale `?group=status` already takes on a
 * queue with no Status field.
 */
export function triagePropertyOf(dim: string): string | null {
  if (!dim.toLowerCase().startsWith(TRIAGE_PREFIX)) return null;
  const property = foldTriage(dim.slice(TRIAGE_PREFIX.length));
  return property && !property.includes(':') && property.length <= MAX_TRIAGE_PROPERTY ? property : null;
}

/** Every facet of one property these labels carry, spellings included. Usually
 *  one; an issue wearing two sizes lands in both stacks rather than having one
 *  of them picked for it. */
export function triageFacets(labelNames: readonly string[], property: string): TriageFacet[] {
  return labelNames.flatMap((name) => {
    const facet = parseTriageLabel(name);
    return facet && facet.property === property ? [facet] : [];
  });
}

/** The stacks of one property an issue belongs in: folded values, deduplicated,
 *  so an issue carrying `triage:P0` and `triage:p0` is carrying one priority and
 *  is drawn in that stack once. */
export function triageValues(labelNames: readonly string[], property: string): string[] {
  return [...new Set(triageFacets(labelNames, property).map((f) => f.value))];
}

/**
 * The one spelling a stack is headed with.
 *
 * The family's own spelling when the table declares this value — so `triage:p0`
 * and `triage:P0` share a stack headed `P0`, the way the team writes it. For
 * everything else, the first of the spellings collected in code-point order.
 * That is a RULE and not an arrival: a heading picked by whichever repository
 * answered first would change between two reads of the same queue.
 */
export function triageValueLabel(property: string, value: string, spellings: readonly string[]): string {
  const declared = SPELLING_OF_VALUE.get(property)?.get(value);
  if (declared !== undefined) return declared;
  return [...spellings].sort()[0] ?? value;
}

/**
 * Every triage property these labels carry, in menu order: the families, then
 * the catch-all last if anything landed in it.
 *
 * Alphabetical among the families rather than count-ranked, because a menu whose
 * entries reorder as issues get labelled is a menu you have to re-read every
 * visit. Triage sits last because it is the leftovers, and on today's twelve
 * labels it is not there at all.
 */
export function triageProperties(labelNames: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of labelNames) {
    const facet = parseTriageLabel(name);
    if (facet) found.add(facet.property);
  }
  const named = [...found].filter((p) => p !== CATCH_ALL).sort((a, b) => a.localeCompare(b));
  return found.has(CATCH_ALL) ? [...named, CATCH_ALL] : named;
}

/** The declared value order for a property, or `null` for one nobody declared.
 *  Folded, because that is what a stack's key is. */
export function triageValueOrder(property: string): readonly string[] | null {
  return ORDER_OF_PROPERTY.get(property) ?? null;
}

/** A property as a person reads it: the label's own word, with the separator a
 *  folded property uses in place of a space put back. `tech-debt` -> `tech
 *  debt`, which the menu draws capitalised and a group heading draws inside
 *  "No …". */
export function triagePropertyLabel(property: string): string {
  return property.replace(/[-_]+/g, ' ');
}

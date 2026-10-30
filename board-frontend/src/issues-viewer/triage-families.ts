/**
 * The `triage:` label families whose names do not say which property they
 * encode (#1099). This file is the team convention, written down.
 *
 * ## If you are here to add a label
 *
 * You need a row here ONLY for a label of the shape `triage:<value>` —
 * `triage:XS`, `triage:P0`. Nothing in `triage:XS` says "size", so a parser
 * cannot know, and a value missing from this table groups under Triage rather
 * than under Size.
 *
 * - **A new value in a family below** (say `triage:XXL`): add it to that
 *   family's `values`, in the position it belongs in on the scale. That
 *   position is the order its stack is drawn in.
 * - **A whole new family**: name its labels `triage:<property>:<value>` —
 *   `triage:effort:3` — and add NOTHING here. The board reads the property out
 *   of the name, so Effort appears in Group by on the next read, with no code
 *   change and no deploy. That is the shape to prefer for anything new.
 *
 * Both shapes fold to the same property, so `triage:XS` and `triage:size:XS`
 * land in one Size stack under one value. That is what lets these twelve labels
 * be renamed to the three-segment shape later without splitting a stack or
 * breaking a `?group=triage:size` link somebody has already shared.
 *
 * ## What is deliberately NOT read
 *
 * Every one of these labels carries a Github description — `triage:L` is "About
 * a week", `triage:P3` is "Nice to have" — and the property is obvious in them
 * to a reader and not to a parser. A rule that works on today's twelve
 * descriptions is a trap for the thirteenth, so the descriptions are not read
 * and are not plumbed through to the browser.
 */

/** One family: the property its labels encode, and the order its values read in.
 *  The order is why this table earns its place twice over — Size is a scale, and
 *  ranking its stacks by how full they are puts XL between S and M. */
export interface TriageFamily {
  property: string;
  values: readonly string[];
}

/** Read against `acme/board`'s label list on 2026-09-13: these
 *  twelve are every `triage:` label the repo carries, and all twelve are in the
 *  two-segment shape. */
export const TRIAGE_FAMILIES: readonly TriageFamily[] = [
  { property: 'size', values: ['XS', 'S', 'M', 'L', 'XL'] },
  { property: 'priority', values: ['P0', 'P1', 'P2', 'P3'] },
  { property: 'route', values: ['agent', 'owner', 'defer'] },
];

/**
 * Small shared issue-page atoms (#384). Lifted out of IssuePage so the reading
 * column (opening post, comment nodes) and the new PropertiesPanel render the
 * same person link and label chip without either importing the other (which
 * would be circular). Pure presentation — no data fetching.
 */
import type { ReactNode } from 'react';
import type { IssueLabel } from '../api/types';

/** A person's Github profile, or null when the account is a ghost (deleted). */
export const profileUrl = (login: string | null | undefined) =>
  login ? `https://github.com/${login}` : null;

/** Avatar + name, linked to the person's Github profile when we have a login (#293).
 *  Falls back to a plain span for ghost accounts so it never renders a dead link. */
export function Person({ login, name, avatar }: { login: string | null; name: string; avatar: ReactNode }) {
  const href = profileUrl(login);
  const inner = (
    <>
      {avatar}
      {name}
    </>
  );
  if (!href) return <span className="flex items-center gap-1.5">{inner}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      // A press here goes to Github and nowhere else (#742). This link sits
      // inside an editable PropertyRow, a `role="button"` whose own onClick
      // opens the facet editor — and Enter on an `<a href>` is not a keydown
      // activation the row's key guard can see, it is a synthesised CLICK that
      // bubbles. `admin/AccessSection.tsx` stops the same press for the same
      // reason. On the two IssuePage authors there is no clickable container,
      // so this changes nothing for them.
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-1.5 hover:text-fg text-link"
    >
      {inner}
    </a>
  );
}

/** Primary text stays readable even for pale labels; the fill carries the hue. */
const CHIP_CLS = 'inline-flex items-center rounded-md px-2 py-0.5 text-[12px] font-medium text-fg';

export function LabelChip({ label }: { label: IssueLabel }) {
  const hex = `#${label.color}`;
  return (
    <span className={CHIP_CLS} style={{ background: `color-mix(in srgb, ${hex} 16%, transparent)` }}>
      {label.name}
    </span>
  );
}

/**
 * The strip at the top of a comment card: who wrote it, and a slot on the right
 * (#693 design review 3).
 *
 * Two callers draw it — the thread's comment card in `IssuePage.tsx` and the
 * composer's preview in `CommentComposer.tsx` — and the preview's whole job is
 * to be the posted comment before it posts. Written twice they agreed on the day
 * they were written; here they cannot disagree at all. The right-hand slot is
 * what differs: a posted comment says when, a preview says it has not.
 *
 * A caller drawing a `Person` here passes `avatar={null}` on purpose: the card
 * hangs on the thread's rail by an avatar outside it, so a second one inside the
 * header would be the same face twice.
 */
export const COMMENT_HEADER =
  'flex items-center gap-2.5 border-b border-line px-[18px] py-[11px] ' +
  'text-[14px] font-semibold text-fg';

/**
 * The weight of a slot holding a FACT about the card rather than a name: the
 * timestamp on a posted comment, and both slots of the preview's header.
 *
 * The preview uses a statement rather than an author name, so it carries less
 * weight than the author line. Posts under your own credential have no signature;
 * only shared-account posts keep attribution in the body.
 */
const HEADER_NOTE = 'text-[13px] font-normal text-muted';

/** The right-hand slot — a fact about the card, pushed to the far edge. */
export const COMMENT_HEADER_ASIDE = `ml-auto ${HEADER_NOTE}`;

/** The left slot when it holds a statement rather than a person. */
export const COMMENT_HEADER_NOTE = HEADER_NOTE;

/**
 * A comment's prose, from the card's edge.
 *
 * `px-5` and NOT the header's `px-[18px]`, which is the 2px the card was
 * misaligned with itself by (#693 design review). The preview follows the PROSE
 * rather than the header, because what it is previewing is a paragraph, and the
 * two have to start on the same pixel or the preview moves when it posts. A
 * posted card adds its own `pb-5`; the composer's preview has the footer row
 * under it instead.
 */
export const COMMENT_PROSE = 'pj-md px-5 pt-[18px]';

export function CommentHeader({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  return (
    <div className={COMMENT_HEADER}>
      {children}
      {aside}
    </div>
  );
}

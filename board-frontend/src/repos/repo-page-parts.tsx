/**
 * The pieces the repo page's four tabs share (#828).
 *
 * `RepoPage.tsx` draws the header band, the tab row and Overview;
 * `RepoSections.tsx` draws the other three tabs. Both need the same card, the
 * same absent-state block and the same list row, and both need the one rule
 * about which click belongs to this board. They live here rather than in one of
 * the two files so neither has to import the other, and so a second copy of a
 * row's five class strings cannot drift from the first.
 *
 * Nothing here is in `src/ui/`: these are this page's parts, not the board's,
 * and two callers inside one directory is not a shared component.
 */
import type { ReactNode } from 'react';
import { BlockHeader } from '../ui/BlockHeader';
import { BLOCK } from '../ui/block';
import { gotoPath } from '../route';
import { tileOpens, type ClickLike } from './tile-nav';

export const CARD = `${BLOCK} px-[18px] pb-[17px] pt-4`;
/** The absence line that replaces a block's whole body, and every quiet
 *  sentence a block says about itself. */
export const NOTHING = 'm-0 text-[12.5px] leading-[1.55] text-muted';

/** One row of a list of things: a number, a title that truncates, and an age
 *  held against the right edge. The open issues and the open pull requests are
 *  the same row with different nouns. */
export const ROW = 'flex items-baseline gap-[10px] py-[7px] min-w-0';
export const ROW_NUM = 'w-[42px] flex-none text-[12px] tabular-nums text-muted';
export const ROW_TITLE = 'min-w-0 flex-1 truncate text-[13px] leading-[1.4] text-link';
export const ROW_AGE = 'w-[132px] flex-none text-right text-[11.5px] tabular-nums text-muted';
/** The way to the rest of the queue, on the row after the last item, so it reads
 *  as the list's own last line rather than as a control parked in the header.
 *  `w-fit` keeps the target on the words: as a flex item it stretched to the
 *  block's full width, 948px of anchor around 150px of text at 1280, so a stray
 *  click in the empty space under the last row left the page. */
export const ROW_ALL = 'block w-fit py-[7px] text-[12.5px] leading-[1.4] text-accent text-link';

/**
 * An anchor's two props for a destination ON this board: a real href, and the
 * click that takes it in place.
 *
 * `tileOpens` is the rule for which press is ours, and it is here rather than in
 * each anchor for the reason #575 wrote down: written inline, that guard read ⌘
 * and ctrl only and swallowed shift-click and alt-click, so a reader asking for
 * a new window got their current page replaced. Four anchors on this page now
 * ask the same question, and this is the one place it is answered.
 *
 * `go` overrides what a press that IS ours does, and one anchor needs it (#823):
 * the missing-repo state's way out goes BACK where the reader walked in, which
 * is the map as they left it rather than the map at its resting order. The href
 * stays the canonical path either way, so ⌘-click, middle-click and Copy link
 * address a page rather than a history position, and the rule for which press is
 * ours is still answered once.
 */
export function boardLinkProps(path: string, go?: () => void): {
  href: string;
  onClick: (e: ClickLike & { preventDefault: () => void }) => void;
} {
  return {
    href: path,
    onClick: (e) => {
      if (!tileOpens(e)) return;
      e.preventDefault();
      if (go) go();
      else gotoPath(path);
    },
  };
}

/** A block whose whole body is one sentence about what is not there. Same
 *  treatment for every kind of absence — the difference is in the words, which
 *  is where it belongs; dressing a failed read differently would make it louder
 *  than the repo it is about. */
export function Absent({ label, line, labelId }: { label: string; line: string; labelId?: string }) {
  return (
    <section className={CARD} aria-labelledby={labelId}>
      <BlockHeader label={label} labelId={labelId} />
      <p className={NOTHING}>{line}</p>
    </section>
  );
}

/** A tab's own block: the header, an optional quiet line under it about the
 *  list's own length, and then the list. */
export function SectionCard({ label, meta, note, children }: {
  label: string;
  meta?: ReactNode;
  note?: string | null;
  children: ReactNode;
}) {
  return (
    <section className={CARD}>
      <BlockHeader label={label} meta={meta} />
      {note && <p className={`${NOTHING} mb-2`}>{note}</p>}
      {children}
    </section>
  );
}

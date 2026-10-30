/**
 * Soft tinted status chip — a tone dot + label pill. Shared by the Projects
 * rollup/header (board health) and the IssuesViewer's group headers (#376), so
 * the two can't drift. Same convention as the old RoadmapRows STATUS_CLASS.
 *
 * Given a `link`, the pill IS the anchor rather than a span wrapped in one
 * (#1191). Two reasons, and both are the same reason: a chip is `inline-flex`,
 * so it is an atomic inline box — an underline on a wrapper never
 * reaches the text inside it, and the board's elision measures the box's first
 * element as the element that PAINTS the label. One element stays one element.
 */
import { LinkIcon } from '../icons';
import { FOCUS_RING_INSIDE } from '../repos/controls';
import type { ClickLike } from '../repos/tile-nav';

export type Tone = 'success' | 'warning' | 'brand' | 'danger' | 'neutral';

/** Fill and ink follow the same tone for linked and plain chips. */
const CHIP_FILL: Record<Tone, string> = {
  success: 'bg-success-fill',
  warning: 'bg-warn-fill',
  brand: 'bg-accent-fill',
  danger: 'bg-danger-fill',
  neutral: 'bg-elevated',
};

const CHIP_INK: Record<Tone, string> = {
  success: 'text-success',
  warning: 'text-warn',
  brand: 'text-accent',
  danger: 'text-danger',
  neutral: 'text-dim',
};

const CHIP_SHAPE =
  'inline-flex items-center gap-[7px] whitespace-nowrap rounded-full px-[9px] py-[4px] text-[12.5px] font-medium leading-[1.3]';

/** Linked chips use an icon at rest and underline on hover/focus; all labels keep their tone ink.
 *  The inside focus ring stays visible when the header clips the chip. */
const CHIP_LINK = `text-link ${FOCUS_RING_INSIDE}`;

/** Where a chip's name goes. `onClick` is the caller's — `boardLinkProps` on
 *  this board, so a modifier press stays the browser's and a plain one is
 *  routed in place. `ariaLabel` names the link when the visible label was
 *  shortened to fit, so what a screen reader announces is the whole name. */
interface ChipLink {
  href: string;
  onClick: (e: ClickLike & { preventDefault: () => void }) => void;
  ariaLabel?: string;
}

export function StatusChip({ tone, label, dot = true, link }: {
  tone: Tone;
  label: string;
  dot?: boolean;
  link?: ChipLink;
}) {
  const className = `${CHIP_SHAPE} ${CHIP_FILL[tone]} ${CHIP_INK[tone]}${link ? ` ${CHIP_LINK}` : ''}`;
  const body = (
    <>
      {/* The dot carries the tone (its color). For a tone-less grouping (Open/Closed,
          #376) the dot would be a decorative hollow ring, so callers drop it. */}
      {dot && (
        <span
          className={`h-[7px] w-[7px] flex-none rounded-full ${
            tone === 'neutral' ? 'shadow-[inset_0_0_0_1.5px_var(--muted)]' : 'bg-current'
          }`}
          aria-hidden="true"
        />
      )}
      {label}
      {link && <LinkIcon size={12} className="shrink-0" data-link-cue="" />}
    </>
  );
  if (!link) return <span className={className}>{body}</span>;
  return (
    <a href={link.href} onClick={link.onClick} aria-label={link.ariaLabel} className={className}>
      {body}
    </a>
  );
}

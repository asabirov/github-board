/**
 * The seven lucide glyphs the kit wrappers draw (#1450). The paths and attributes are lucide's, so
 * each glyph keeps its old drawing without lucide-react as a dependency.
 */
import { forwardRef, type SVGProps } from 'react';

type GlyphProps = SVGProps<SVGSVGElement>;

function glyph(name: string, children: React.ReactNode) {
  const Glyph = forwardRef<SVGSVGElement, GlyphProps>(({ className, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={['lucide', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </svg>
  ));
  Glyph.displayName = name;
  return Glyph;
}

export const XGlyph = glyph('XGlyph', <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
export const CheckGlyph = glyph('CheckGlyph', <path d="M20 6 9 17l-5-5" />);
export const CircleGlyph = glyph('CircleGlyph', <circle cx="12" cy="12" r="10" />);
export const ChevronDownGlyph = glyph('ChevronDownGlyph', <path d="m6 9 6 6 6-6" />);
export const ChevronRightGlyph = glyph('ChevronRightGlyph', <path d="m9 18 6-6-6-6" />);
export const SearchGlyph = glyph('SearchGlyph', <><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></>);
export const CopyGlyph = glyph('CopyGlyph', <>
  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
</>);

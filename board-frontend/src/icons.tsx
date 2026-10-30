/**
 * Small inline SVG icon set (lucide paths), matching the app's existing
 * inline-<svg> convention (TopBar, Pulse, …) rather than pulling lucide-react
 * in as a direct dep. 24-unit viewBox, `currentColor` stroke so an icon
 * inherits its container's text colour. Used by the account menu (#183) and
 * the admin hub. Keep the set minimal — add an icon only when a surface needs it.
 */
import type { SVGProps } from 'react';

function Svg({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function KeyRoundIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** The `···` of a row or card's action handle (#314), drawn on the pixel grid
 *  (#948), one unit to a pixel. The icon it replaced scaled a 24-unit drawing
 *  down, which put 1.25px dots at 3.125, 7.5 and 11.875 in a 15px box: no dot
 *  could cover whole pixels, so at 1x every one of them was a grey smear across
 *  two or three. Here each dot starts on a whole pixel and is a whole number of
 *  pixels wide, and the box is an even 16 so it centres on a whole pixel in any
 *  even chip. A 3px dot leaves the row half a pixel left of centre, which is
 *  the price of keeping its edges whole.
 *
 *  Three circles written out rather than mapped: `chart-pointer.callers.spec.tsx`
 *  reads a `.map(` of svg primitives as a chart's series, and three dots are not
 *  a series. */
export function DotsGlyph({ dot, pitch, box = 16 }: { dot: number; pitch: number; box?: number }) {
  const left = Math.floor((box - (dot + 2 * pitch)) / 2);
  const top = Math.floor((box - dot) / 2);
  const r = dot / 2;
  return (
    <Svg size={box} viewBox={`0 0 ${box} ${box}`} fill="currentColor" stroke="none">
      <circle cx={left + r} cy={top + r} r={r} />
      <circle cx={left + pitch + r} cy={top + r} r={r} />
      <circle cx={left + 2 * pitch + r} cy={top + r} r={r} />
    </Svg>
  );
}

export function SlidersIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M20 7h-9" />
      <path d="M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </Svg>
  );
}

export function LogOutIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </Svg>
  );
}

export function ChevronUpIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="m18 15-6-6-6 6" />
    </Svg>
  );
}

export function ShieldIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </Svg>
  );
}

export function BotIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </Svg>
  );
}

export function CopyIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Svg>
  );
}

export function CheckIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function MessageIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Svg>
  );
}

export function SunIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </Svg>
  );
}

export function MoonIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Svg>
  );
}

export function HomeIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </Svg>
  );
}

export function UsersIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  );
}

export function BoardIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </Svg>
  );
}

/** Repos (#472) — the git branch glyph. It has to be legible at the nav's 17px
 *  AND unmistakable next to BoardIcon: a shelf-of-bars shape read as a second
 *  Projects icon, since that one is already vertical columns. */
export function ReposIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Svg>
  );
}

/** External-link affordance — the real icon, replacing the decorative "↗" glyph. */
export function ExternalLinkIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Svg>
  );
}

export function LinkIcon(p: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <Svg {...p}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Svg>
  );
}

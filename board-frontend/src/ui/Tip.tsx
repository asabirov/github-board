/**
 * Board's one styled tooltip (#334). Replaces the browser-native `title` tooltip
 * on visible controls with the kit's Tooltip — dark-styled and consistent, so a
 * hover hint reads in the board's own skin instead of the OS grey box. Delay and
 * animation come from the single <TooltipProvider> at the app root (App.tsx).
 *
 * Usage: wrap the trigger element, pass the hint as `label`.
 *   <Tip label="Copy for an agent"><button …/></Tip>
 * The child must forward a ref and spread props (a DOM element or a kit control
 * does); `asChild` keeps the child as the real element, adding no wrapper.
 *
 * Keep a plain `title`/`aria-label` — NOT this — where the hint is purely for
 * accessibility or reveals truncated text, never shown as a visible tooltip.
 */
import { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from './kit';

export function Tip({
  label,
  side = 'top',
  children,
}: {
  label: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

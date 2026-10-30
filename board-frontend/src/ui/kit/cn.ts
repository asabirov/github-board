/**
 * The class joiner every kit wrapper uses (#1450). It is the board's copy of the old kit's `cn`.
 * Tailwind-merge learns the board's token names for font weight, max width, border width,
 * duration and easing, so a caller's class still overrides the wrapper's own. The font-size
 * group conflicts with nothing, so a `text-*` colour never removes a `text-*` size.
 */
import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const TOKEN_FONT_WEIGHTS = ['normal', 'regular', 'medium', 'semibold', 'bold', 'extrabold'];
const TOKEN_BORDER_WIDTHS = ['none', 'thin', 'medium', 'thick', 'heavy'];
const TOKEN_MAX_WIDTHS = ['layout-40', 'layout-48', 'layout-56', 'layout-64', 'layout-80', 'layout-96', 'container'];
const TOKEN_DURATIONS = ['instant', 'fast', 'normal', 'slow', 'slower', 'slowest', 'ui', 'collapse', 'slide', 'overlay', 'toast'];
const TOKEN_EASINGS = ['default', 'in', 'out', 'in-out', 'spring', 'linear', 'standard', 'enter', 'exit', 'emphasized'];

type Groups = Record<string, unknown[]>;

const twMerge = extendTailwindMerge((config) => {
  const theme = config.theme as Groups;
  const groups = config.classGroups as Groups;
  theme['font-weight'] = [...(theme['font-weight'] ?? []), ...TOKEN_FONT_WEIGHTS];
  groups['max-w'] = [...(groups['max-w'] ?? []), { 'max-w': TOKEN_MAX_WIDTHS }];
  for (const group of Object.keys(groups)) {
    if (group !== 'border-w' && !group.startsWith('border-w-')) continue;
    groups[group] = [...(groups[group] ?? []), { [group.replace('border-w', 'border')]: TOKEN_BORDER_WIDTHS }];
  }
  groups['duration'] = [...(groups['duration'] ?? []), { duration: TOKEN_DURATIONS }];
  groups['ease'] = [...(groups['ease'] ?? []), { ease: TOKEN_EASINGS }];
  for (const entry of groups['outline-w'] ?? []) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const named = entry as Record<string, unknown>;
    for (const [name, members] of Object.entries(named)) {
      if (Array.isArray(members)) named[name] = members.filter((m) => m !== '');
    }
  }
  (config.conflictingClassGroups as Record<string, string[]>)['font-size'] = [];
  return config;
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Below `sm`, a small control gets a 44px hit area without a bigger drawing. */
export const TOUCH_HIT_LAYER =
  'relative max-sm:after:absolute max-sm:after:left-1/2 max-sm:after:top-1/2 max-sm:after:size-11 max-sm:after:-translate-x-1/2 max-sm:after:-translate-y-1/2';

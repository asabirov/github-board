import type { Config } from 'tailwindcss';

/**
 * The board's own Tailwind scale (#1450).
 *
 * The layout values are literals, so a page keeps its measures without a token sheet behind them.
 * The colours are the public kit's tokens from `@apliteni/apliteni-ui/tokens`, which main.tsx
 * imports, so the theme and the accent change every surface from `<html data-theme data-accent>`.
 *
 * `lineHeight` and `letterSpacing` are literals too. Tailwind's defaults read `--leading-*` and
 * `--tracking-*`, and the kit sheet declares those names with other values.
 */
const tone = (name: string) => `var(--${name})`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    screens: { sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' },
    spacing: {
      0: '0px', px: '1px', 0.5: '2px', 1: '4px', 1.5: '6px', 2: '8px', 2.5: '10px', 3: '12px', 3.5: '14px',
      4: '16px', 5: '20px', 6: '24px', 7: '28px', 8: '32px', 9: '36px', 10: '40px', 11: '44px', 12: '48px',
      14: '56px', 16: '64px', 18: '72px', 20: '80px', 22: '88px', 24: '96px', 28: '112px', 32: '128px',
      40: '160px', 48: '192px', 56: '224px', 64: '256px', 72: '288px', 80: '320px', 96: '384px',
    },
    borderRadius: { none: '0', xs: '2px', sm: '4px', md: '6px', lg: '8px', xl: '12px', '2xl': '16px', full: '9999px' },
    borderWidth: { 0: '0', 2: '2px', none: '0', thin: '1px', DEFAULT: '1px', medium: '1.5px', thick: '2px', heavy: '3px' },
    fontFamily: { sans: tone('font-sans'), display: tone('font-display'), mono: tone('font-mono') },
    fontSize: {
      xs: ['0.6875rem', { lineHeight: '1.5', letterSpacing: '0.02em' }],
      sm: ['0.8125rem', { lineHeight: '1.5', letterSpacing: '0.01em' }],
      base: ['1rem', { lineHeight: '1.5', letterSpacing: '0' }],
      lg: ['1.1875rem', { lineHeight: '1.4', letterSpacing: '-0.005em' }],
      xl: ['1.4375rem', { lineHeight: '1.35', letterSpacing: '-0.01em' }],
      '2xl': ['1.75rem', { lineHeight: '1.3', letterSpacing: '-0.015em' }],
      '3xl': ['2.0625rem', { lineHeight: '1.25', letterSpacing: '-0.02em' }],
      '4xl': ['2.5rem', { lineHeight: '1.2', letterSpacing: '-0.025em' }],
      '5xl': ['3rem', { lineHeight: '1.15', letterSpacing: '-0.03em' }],
      display: ['3.5625rem', { lineHeight: '1.1', letterSpacing: '-0.035em' }],
    },
    fontWeight: { regular: '400', normal: '400', medium: '500', semibold: '600', bold: '700', extrabold: '800' },
    zIndex: {
      10: '10', 20: '20', 50: '50', base: '0', raised: '10', dropdown: '100', sticky: '200',
      overlay: '300', modal: '400', toast: '500', tooltip: '600', max: '9999',
    },
    opacity: {
      0: '0', 5: '0.05', 10: '0.1', 20: '0.2', 40: '0.4', 50: '0.5', 60: '0.6', 70: '0.7',
      75: '0.75', 80: '0.8', 90: '0.9', 100: '1',
    },
    boxShadow: { sm: tone('shadow-sm'), md: tone('shadow-md'), lg: tone('shadow-lg'), none: 'none' },
    // Each duration reads a board variable, so app.css can zero them all for a reader who asked
    // for reduced motion.
    transitionDuration: Object.fromEntries(
      Object.entries({
        150: 150, 200: 200, 300: 300, 500: 500, instant: 0, fast: 100, normal: 200, slow: 300, slower: 500,
        slowest: 800, ui: 100, collapse: 100, slide: 200, overlay: 300, toast: 300,
      }).map(([name, ms]) => [name, `var(--board-motion, ${ms}ms)`]),
    ),
    transitionTimingFunction: {
      default: 'cubic-bezier(0.25, 0.1, 0.25, 1)', standard: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
      in: 'cubic-bezier(0.42, 0, 1, 1)', exit: 'cubic-bezier(0.42, 0, 1, 1)',
      out: 'cubic-bezier(0, 0, 0.58, 1)', enter: 'cubic-bezier(0, 0, 0.58, 1)',
      'in-out': 'cubic-bezier(0.42, 0, 0.58, 1)',
      spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)', emphasized: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      linear: 'cubic-bezier(0, 0, 1, 1)',
    },
    extend: {
      lineHeight: { none: '1', tight: '1.25', snug: '1.375', normal: '1.5', relaxed: '1.625' },
      letterSpacing: { tight: '-0.025em', normal: '0em', wide: '0.025em', widest: '0.1em' },
      colors: {
        fg: tone('text'),
        strong: tone('strong'),
        dim: tone('dim'),
        muted: tone('muted'),
        accent: tone('accent'),
        'accent-strong': tone('accent-strong'),
        'accent-contrast': tone('accent-contrast'),
        'accent-fill': tone('glow-purple'),
        danger: tone('pink'),
        'danger-fill': tone('chip-danger-fill'),
        'danger-solid': tone('signal-solid-danger'),
        // The kit's light --amber is 3.87:1 on white. Its warn ink is the same amber in dark
        // and #825900 in light, so warn text and the goal line pass in both.
        warn: tone('chip-warn-ink'),
        'warn-fill': tone('chip-warn-fill'),
        'warn-solid': tone('signal-solid-warn'),
        // The kit's light --green is 4.45:1 on white. Its success ink is the same green in dark
        // and #145a26 in light, so success text passes 4.5:1 in both.
        success: tone('chip-success-ink'),
        'success-fill': tone('chip-success-fill'),
        bg: tone('bg'),
        surface: tone('surface'),
        'surface-2': tone('surface-2'),
        'surface-3': tone('surface-3'),
        elevated: tone('bg-elevated'),
        overlay: tone('board-overlay'),
        scrim: tone('scrim'),
        line: tone('border'),
        'line-strong': tone('border-strong'),
        field: tone('field-bg'),
      },
      size: {
        4: '16px', 5: '20px', 6: '24px', 8: '32px', 9: '36px', 10: '40px', 11: '44px', 12: '48px',
        14: '56px', 16: '64px', 20: '80px', 60: '240px', 72: '288px',
      },
      maxWidth: {
        'layout-40': '160px', 'layout-48': '192px', 'layout-56': '224px', 'layout-64': '256px',
        'layout-80': '320px', 'layout-96': '384px', container: '1440px',
      },
      gap: { gutter: '16px' },
      padding: { 'grid-sm': '16px', 'grid-md': '24px', 'grid-xl': '40px' },
    },
  },
} satisfies Config;

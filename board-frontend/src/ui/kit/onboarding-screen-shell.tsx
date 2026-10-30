import * as React from 'react';
import { cn } from './cn';

export const AUTH_GLOW_BG =
  'radial-gradient(560px 320px at 28% 16%, var(--auth-glow-a), transparent 68%),radial-gradient(520px 340px at 78% 90%, var(--auth-glow-b), transparent 66%),var(--surface-2)';
export const AUTH_FILLED_BUTTON =
  'auth-filled-button flex h-[46px] w-full items-center justify-center gap-[11px] rounded-[10px] border border-transparent bg-fg px-[14px] text-[14.5px] font-semibold tracking-[-0.005em] text-surface-2 transition-opacity duration-fast cursor-pointer hover:opacity-[0.92] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] active:translate-y-px disabled:pointer-events-none disabled:opacity-[0.55]';
export const AUTH_BUTTON_SHADOW = 'var(--auth-focus-shadow, var(--auth-btn-shadow))';

const CARD_WIDTH = { md: 'max-w-[440px]', lg: 'max-w-[560px]' };

export interface OnboardingScreenShellProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  logo?: React.ReactNode;
  /** Drawn in the top-right corner. The board keeps its theme switch elsewhere, so there is no default. */
  themeToggle?: React.ReactNode;
  /** `null` renders no `h1`. */
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'md' | 'lg';
  children: React.ReactNode;
}

/** A full-viewport glow ground with one centered card. */
export const OnboardingScreenShell = React.forwardRef<HTMLDivElement, OnboardingScreenShellProps>(
  ({ logo, themeToggle = null, title, description, footer, width = 'md', children, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden px-6 py-12 text-fg',
        className,
      )}
      style={{ background: AUTH_GLOW_BG }}
      {...props}
    >
      {themeToggle && <div className="absolute right-6 top-6">{themeToggle}</div>}
      <div
        className={cn('relative w-full rounded-2xl bg-surface px-[34px] pb-[30px] pt-[38px] text-center', CARD_WIDTH[width])}
        style={{ border: '1px solid var(--auth-card-border)', boxShadow: 'var(--auth-card-shadow)' }}
      >
        {logo && (
          <div className="mb-[22px] flex items-center justify-center text-xl font-bold leading-none tracking-[-0.02em] text-fg">
            {logo}
          </div>
        )}
        {title != null && (
          <h1
            className={cn(
              'text-lg font-semibold leading-[1.25] tracking-[-0.015em] text-fg',
              // Without a description the headline itself carries the gap to the form.
              description ? 'mb-[8px]' : 'mb-[24px]',
            )}
          >
            {title}
          </h1>
        )}
        {description && <p className="mx-auto mb-[24px] max-w-[320px] text-sm text-dim">{description}</p>}
        <div className="text-left">{children}</div>
        {footer != null && <div className="mt-[24px] text-xs tracking-[0.005em] text-muted">{footer}</div>}
      </div>
    </div>
  ),
);
OnboardingScreenShell.displayName = 'OnboardingScreenShell';

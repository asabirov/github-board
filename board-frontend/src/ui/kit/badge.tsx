import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors duration-fast focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)]',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent-strong text-accent-contrast',
        secondary: 'border-transparent bg-surface-3 text-fg',
        outline: 'border-line-strong text-fg',
        status: 'border-line bg-elevated text-fg',
        destructive: 'border-transparent bg-danger-solid text-[var(--signal-solid-ink)]',
        'danger-subtle': 'border-transparent bg-danger-fill text-danger',
        'warning-subtle': 'border-transparent bg-warn-fill text-warn',
        'neutral-subtle': 'border-line bg-elevated text-muted',
        success: 'border-transparent bg-[var(--signal-solid-success)] text-[var(--signal-solid-ink)]',
        warning: 'border-transparent bg-warn-solid text-[var(--signal-solid-ink)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
));
Badge.displayName = 'Badge';

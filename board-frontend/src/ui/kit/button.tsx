import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

/** Each variant names its own focus edge and glow, and the base names none. A raw
 *  `buttonVariants()` joins rather than merges, so a base colour would sit beside the variant's. */
export const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-accent-strong text-accent-contrast focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg hover:bg-[color-mix(in_srgb,var(--accent-strong)_90%,var(--text))]',
        destructive: 'border border-line-strong bg-danger-fill text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-danger focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--pink)_20%,transparent)] hover:border-danger hover:text-danger',
        'destructive-ghost': 'text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-danger focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--pink)_20%,transparent)] hover:bg-danger-fill hover:text-danger',
        'destructive-solid': 'bg-danger-solid text-[var(--signal-solid-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg hover:bg-[color-mix(in_srgb,var(--signal-solid-danger)_90%,transparent)]',
        outline: 'border border-line-strong bg-transparent text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] hover:bg-surface-3',
        secondary: 'border border-line-strong bg-surface-3 text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_8%,var(--surface-3))]',
        ghost: 'text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] hover:bg-surface-3',
        link: 'text-[var(--accent)] underline-offset-4 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] hover:underline hover:text-accent-strong',
      },
      // Below `sm` every size floors at 44px on both axes, so a finger can reach it.
      size: {
        default: 'h-10 max-sm:min-h-11 max-sm:min-w-11 px-4 py-2',
        sm: 'h-9 max-sm:min-h-11 max-sm:min-w-11 rounded-md px-3',
        xs: 'h-7 max-sm:min-h-11 max-sm:min-w-11 gap-1.5 rounded-md px-2',
        lg: 'h-11 max-sm:min-h-11 max-sm:min-w-11 rounded-md px-8',
        icon: 'h-10 w-10 max-sm:min-h-11 max-sm:min-w-11',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type Size = NonNullable<VariantProps<typeof buttonVariants>['size']>;

const ICON_ONLY_BOX: Record<Size, string> = {
  xs: 'size-7 p-0', sm: 'size-9 p-0', default: 'size-10 p-0', lg: 'size-11 p-0', icon: 'size-10 p-0',
};
const ICON_GLYPH: Record<Size, string> = {
  xs: '[&>svg]:size-3.5', sm: '[&>svg]:size-4', default: '[&>svg]:size-4', lg: '[&>svg]:size-4', icon: '[&>svg]:size-4',
};

type ButtonBase = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & VariantProps<typeof buttonVariants>;
type ButtonLabelledProps = ButtonBase & {
  children: React.ReactNode;
  icon?: React.ReactNode;
  iconPosition?: 'leading' | 'trailing';
  asChild?: boolean;
};
type ButtonIconOnlyProps = ButtonBase & {
  children?: never;
  icon: React.ReactNode;
  iconPosition?: never;
  asChild?: never;
} & ({ 'aria-label': string } | { 'aria-labelledby': string });
type ButtonEmptyProps = ButtonBase & {
  children?: never;
  icon?: never;
  iconPosition?: never;
  asChild?: boolean;
};
export type ButtonProps = ButtonLabelledProps | ButtonIconOnlyProps | ButtonEmptyProps;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => {
  const { className, variant, size, asChild = false, icon, iconPosition = 'leading', children, type, ...rest } = props;
  const resolvedSize = size ?? 'default';
  const iconOnly = icon != null && children == null;
  if (import.meta.env.DEV) {
    const label = (rest as { 'aria-label'?: string })['aria-label'];
    const labelledBy = (rest as { 'aria-labelledby'?: string })['aria-labelledby'];
    if (iconOnly && !label?.trim() && !labelledBy?.trim()) {
      console.warn('[Button] an icon-only button needs an accessible name: pass `aria-label`.');
    }
    if (asChild && icon != null) console.warn('[Button] `icon` is ignored with `asChild`: the consumer owns the element.');
  }
  const Comp = asChild ? Slot : 'button';
  const glyph = icon == null ? null : (
    <span className={cn('inline-flex shrink-0 items-center justify-center', ICON_GLYPH[resolvedSize])} aria-hidden>
      {icon}
    </span>
  );
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), iconOnly && ICON_ONLY_BOX[resolvedSize], className)}
      ref={ref}
      type={asChild ? type : (type ?? 'button')}
      {...rest}
    >
      {asChild ? children : iconPosition === 'trailing' ? <>{children}{glyph}</> : <>{glyph}{children}</>}
    </Comp>
  );
});
Button.displayName = 'Button';

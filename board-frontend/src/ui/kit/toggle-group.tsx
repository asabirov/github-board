import * as React from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export const toggleVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium data-[state=on]:font-semibold text-dim transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      /** `ToggleGroup` sets this from its `type`. */
      treatment: {
        frame: 'focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:outline-offset-2 ring-1 ring-inset ring-line hover:bg-surface-3 hover:text-fg data-[state=on]:text-fg data-[state=on]:ring-line-strong',
        track: 'focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] focus-visible:outline-offset-2 data-[state=off]:hover:text-fg data-[state=on]:bg-surface-2 data-[state=on]:text-fg',
      },
      variant: {
        default: 'bg-transparent',
        /** @deprecated Renders exactly as `default`. */
        outline: 'bg-transparent',
      },
      size: {
        default: 'h-10 max-sm:min-h-11 max-sm:min-w-11 min-w-10 px-3',
        sm: 'h-9 max-sm:min-h-11 max-sm:min-w-11 min-w-9 px-2.5',
        lg: 'h-12 max-sm:min-h-11 max-sm:min-w-11 min-w-12 px-5',
      },
    },
    defaultVariants: { treatment: 'frame', variant: 'default', size: 'default' },
  },
);

const ICON_ONLY_BOX = 'has-[>svg:only-child]:px-0';
const isIconOnly = (children: React.ReactNode) => {
  const only = React.Children.toArray(children);
  return only.length === 1 && React.isValidElement(only[0]);
};

type ToggleContext = VariantProps<typeof toggleVariants> & { sliding?: boolean; wordless?: boolean };
const ToggleGroupContext = React.createContext<ToggleContext>({ size: 'default', variant: 'default', treatment: 'frame' });

const SlidingThumb = ({ index, count, ring }: { index: number; count: number; ring: boolean }) => (
  <span
    aria-hidden="true"
    className={cn('motion-segment-thumb pointer-events-none absolute inset-y-0 left-0 rounded-md bg-surface-2', ring && 'ring-1 ring-inset ring-accent')}
    style={{ width: `calc(100% / ${count})`, transform: `translateX(${index * 100}%)` }}
  />
);

type ToggleGroupProps = (
  | React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
) & VariantProps<typeof toggleVariants> & {
  /** One selection fill slides between the slots. The slots take equal widths. */
  sliding?: boolean;
};

export const ToggleGroup = React.forwardRef<React.ElementRef<typeof ToggleGroupPrimitive.Root>, ToggleGroupProps>(
  ({ className, variant, size, treatment, sliding, children, ...props }, ref) => {
    const slots = React.Children.toArray(children).filter(React.isValidElement<{ children?: React.ReactNode; value?: string }>);
    const wordless = slots.length > 0 && slots.every((slot) => isIconOnly(slot.props.children));
    const resolved = treatment ?? (props.type === 'single' ? 'track' : 'frame');
    const [mirror, setMirror] = React.useState(() => (typeof props.defaultValue === 'string' ? props.defaultValue : undefined));
    const selected = typeof props.value === 'string' ? props.value : mirror;
    const index = slots.findIndex((slot) => slot.props.value === selected);
    const rootProps = (sliding && typeof props.value !== 'string'
      ? {
          ...props,
          onValueChange: (next: string & string[]) => {
            setMirror(next);
            (props.onValueChange as ((value: typeof next) => void) | undefined)?.(next);
          },
        }
      : props) as React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>;
    return (
      <ToggleGroupPrimitive.Root
        ref={ref}
        className={cn(
          resolved === 'track' ? cn('inline-flex w-fit items-center gap-0.5', !sliding && 'max-sm:flex-wrap') : 'flex items-center justify-center gap-1',
          sliding && 'relative flex w-fit gap-0',
          className,
        )}
        {...rootProps}
      >
        <ToggleGroupContext.Provider value={{ variant, size, treatment: resolved, sliding, wordless }}>
          {sliding && index >= 0 && <SlidingThumb index={index} count={slots.length} ring={resolved === 'track' && wordless} />}
          {children}
        </ToggleGroupContext.Provider>
      </ToggleGroupPrimitive.Root>
    );
  },
);
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName;

export const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants> & {
    /** Draws an invisible slot that holds the width and takes no part in the group. */
    inert?: boolean;
  }
>(({ className, children, variant, size, inert, ...props }, ref) => {
  const context = React.useContext(ToggleGroupContext);
  const box = cn(
    toggleVariants({ variant: context.variant || variant, size: context.size || size, treatment: context.treatment }),
    isIconOnly(children) && ICON_ONLY_BOX,
    context.treatment === 'track' && 'data-[state=on]:font-semibold',
    context.treatment === 'track' && context.wordless && !context.sliding && 'data-[state=on]:ring-1 data-[state=on]:ring-inset data-[state=on]:ring-accent',
    context.sliding && 'relative z-10 flex-1 data-[state=on]:bg-transparent',
  );
  if (inert) {
    return <span ref={ref} aria-hidden="true" className={cn(box, 'invisible', className)}>{children}</span>;
  }
  return <ToggleGroupPrimitive.Item ref={ref} className={cn(box, className)} {...props}>{children}</ToggleGroupPrimitive.Item>;
});
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;

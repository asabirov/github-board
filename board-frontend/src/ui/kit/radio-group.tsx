import * as React from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { cn, TOUCH_HIT_LAYER } from './cn';
import { CircleGlyph } from './icons';

export const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>, React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  // Below `sm` the rows open to a 44px pitch, so that two hit layers do not overlap.
  <RadioGroupPrimitive.Root ref={ref} className={cn('grid gap-2 max-sm:gap-7', className)} {...props} />
));
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

export const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>, React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      TOUCH_HIT_LAYER,
      'aspect-square size-4 cursor-pointer rounded-full border border-[var(--field-edge)] text-blue-400 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-blue-400',
      className,
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
      <CircleGlyph className="h-2.5 w-2.5 fill-blue-400 text-blue-400" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

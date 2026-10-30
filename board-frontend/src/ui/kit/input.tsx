import * as React from 'react';
import { cn } from './cn';

const FIELD_BOX =
  'flex h-10 max-sm:min-h-11 w-full rounded-md border border-[var(--field-edge)] hover:border-[var(--field-edge-hover)] bg-[var(--field-bg)] text-fg px-3 py-2 text-sm';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** The unit of the value. It sits inside the field's border, on the side where the number ends.
   *  It is text and not a control. */
  suffix?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, suffix, style, ...props }, ref) => {
  if (suffix != null) {
    return (
      <span
        className={cn(
          FIELD_BOX,
          'max-sm:min-h-12 max-sm:py-0',
          'items-center gap-1.5 focus-within:outline focus-within:outline-1 focus-within:outline-accent focus-within:ring-[3px] focus-within:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-50',
          className,
        )}
      >
        <input
          type={type}
          style={{ textAlign: 'inherit', ...style }}
          className="w-full min-w-0 max-sm:min-h-11 bg-transparent p-0 placeholder:text-muted focus-visible:outline-none disabled:cursor-not-allowed"
          ref={ref}
          {...props}
        />
        <span className="shrink-0 select-none text-muted">{suffix}</span>
      </span>
    );
  }
  return (
    <input
      type={type}
      style={style}
      className={cn(
        FIELD_BOX,
        'file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = 'Input';

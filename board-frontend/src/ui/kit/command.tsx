import * as React from 'react';
import { Command as CommandPrimitive, useCommandState } from 'cmdk';
import { cn } from './cn';
import { SearchGlyph } from './icons';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

export const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>, React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn('flex h-full w-full flex-col overflow-hidden rounded-md bg-overlay text-fg', className)}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

export const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => {
  const wrapper = React.useRef<HTMLDivElement>(null);
  const value = useCommandState((state) => state.value);
  const selectedItemId = useCommandState((state) => (state as { selectedItemId?: string }).selectedItemId);
  const count = useCommandState((state) => state.filtered.count);
  // The input names the selected row, so a screen reader follows the arrow keys.
  useIsomorphicLayoutEffect(() => {
    const input = wrapper.current?.querySelector('[cmdk-input]');
    if (!input) return;
    const listId = input.getAttribute('aria-controls');
    const row = (listId ? document.getElementById(listId) : null)?.querySelector('[cmdk-item][data-selected="true"]');
    if (row?.id) input.setAttribute('aria-activedescendant', row.id);
    else input.removeAttribute('aria-activedescendant');
  }, [value, selectedItemId, count]);
  return (
    <div ref={wrapper} className="flex items-center border-b border-line px-3" cmdk-input-wrapper="">
      <SearchGlyph className="mr-2 h-4 w-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          'flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  );
});
CommandInput.displayName = CommandPrimitive.Input.displayName;

export const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List ref={ref} className={cn('max-h-[300px] overflow-y-auto overflow-x-hidden pb-2', className)} {...props} />
));
CommandList.displayName = CommandPrimitive.List.displayName;

export const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => <CommandPrimitive.Empty ref={ref} className="py-6 text-center text-sm text-muted" {...props} />);
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

export const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1 text-fg [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted',
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

export type CommandItemProps = React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item> & {
  /** A glyph before the label. */
  mark?: React.ReactNode;
  /** A second line under the label. */
  sub?: React.ReactNode;
};

export const CommandItem = React.forwardRef<React.ElementRef<typeof CommandPrimitive.Item>, CommandItemProps>(
  ({ className, mark, sub, children, ...props }, ref) => (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none gap-2 rounded-sm px-2 py-1.5 max-sm:min-h-11 text-sm outline-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] data-[selected=true]:text-fg',
        mark ? 'items-start' : 'items-center',
        className,
      )}
      {...props}
    >
      {mark ? <span className="shrink-0">{mark}</span> : null}
      {sub ? (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{children}</span>
          <span className="truncate text-xs text-dim">{sub}</span>
        </span>
      ) : (
        children
      )}
    </CommandPrimitive.Item>
  ),
);
CommandItem.displayName = CommandPrimitive.Item.displayName;

export const CommandShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('ml-auto text-xs tracking-widest text-muted', className)} {...props} />
);
CommandShortcut.displayName = 'CommandShortcut';

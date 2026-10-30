import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from './cn';

export const tooltipSurface =
  'max-w-layout-80 overflow-hidden break-words rounded-md border border-line bg-overlay px-3 py-1.5 text-xs text-fg shadow-lg';
const tooltipCollisionPadding = 8;

const ProviderMounted = React.createContext(false);

export const TooltipProvider = (props: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) => (
  <ProviderMounted.Provider value>
    <TooltipPrimitive.Provider {...props} />
  </ProviderMounted.Provider>
);
TooltipProvider.displayName = 'TooltipProvider';

/** A tooltip outside any provider brings its own, so it still opens. */
const TooltipGroup = ({ children }: { children: React.ReactNode }) =>
  React.useContext(ProviderMounted) ? <>{children}</> : <TooltipProvider>{children}</TooltipProvider>;

interface TriggerState {
  trigger: HTMLElement | null;
  setTrigger: (node: HTMLElement | null) => void;
  repeatsTheName: boolean;
  setRepeatsTheName: (repeats: boolean) => void;
}

const TriggerContext = React.createContext<TriggerState>({
  trigger: null,
  setTrigger: () => {},
  repeatsTheName: false,
  setRepeatsTheName: () => {},
});

function textOf(children: React.ReactNode) {
  return typeof children === 'string' || typeof children === 'number' ? String(children).trim() : null;
}

function directionOf(trigger: HTMLElement | null): 'ltr' | 'rtl' {
  if (!trigger) return 'ltr';
  const declared = trigger.closest('[dir="rtl"], [dir="ltr"]')?.getAttribute('dir');
  if (declared) return declared.toLowerCase() === 'rtl' ? 'rtl' : 'ltr';
  const computed = trigger.ownerDocument.defaultView?.getComputedStyle(trigger).direction;
  return computed === 'rtl' ? 'rtl' : 'ltr';
}

export const Tooltip = ({ children, ...props }: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>) => {
  const [trigger, setTrigger] = React.useState<HTMLElement | null>(null);
  const [repeatsTheName, setRepeatsTheName] = React.useState(false);
  const value = React.useMemo(() => ({ trigger, setTrigger, repeatsTheName, setRepeatsTheName }), [trigger, repeatsTheName]);
  return (
    <TooltipGroup>
      <TriggerContext.Provider value={value}>
        <TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>
      </TriggerContext.Provider>
    </TooltipGroup>
  );
};
Tooltip.displayName = 'Tooltip';

export const TooltipTrigger = React.forwardRef<
  HTMLButtonElement, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>((props, ref) => {
  const { setTrigger, repeatsTheName } = React.useContext(TriggerContext);
  const composedRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      setTrigger(node);
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref, setTrigger],
  );
  // When the tip only repeats the trigger's name, a reader would hear the name twice.
  return <TooltipPrimitive.Trigger ref={composedRef} {...(repeatsTheName ? { 'aria-describedby': undefined } : null)} {...props} />;
});
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

export const TooltipContent = React.forwardRef<
  HTMLDivElement, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, dir, ...props }, ref) => {
  const { trigger, repeatsTheName, setRepeatsTheName } = React.useContext(TriggerContext);
  const text = textOf(props.children);
  React.useEffect(() => {
    const name = trigger?.getAttribute('aria-label')?.trim();
    setRepeatsTheName(text !== null && text === name);
    return () => setRepeatsTheName(false);
  }, [trigger, text, setRepeatsTheName]);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        dir={dir ?? directionOf(trigger)}
        sideOffset={sideOffset}
        collisionPadding={tooltipCollisionPadding}
        aria-hidden={repeatsTheName || undefined}
        className={cn(
          tooltipSurface,
          'z-50 max-w-[min(320px,var(--radix-popper-available-width))] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

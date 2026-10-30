import type * as React from 'react';
import { Toaster as SonnerToaster, toast } from 'sonner';
import { cn } from './cn';

/** The board passes `theme`, so the wrapper reads no theme of its own. */
export const Toaster = ({ className, richColors = false, ...props }: React.ComponentProps<typeof SonnerToaster>) => (
  <SonnerToaster
    className={cn('toaster group', className)}
    toastOptions={{
      classNames: {
        // Sonner's unlayered, more specific vendor CSS requires important surface utilities.
        toast: 'group toast data-[rich-colors=false]:!bg-overlay !border data-[rich-colors=false]:!border-line data-[rich-colors=false]:!text-fg !shadow-lg',
        description: 'group-data-[rich-colors=false]:!text-dim',
        actionButton: '!bg-accent-strong !text-accent-contrast',
      },
    }}
    {...props}
    richColors={richColors}
  />
);

export { toast };

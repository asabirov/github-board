import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn, TOUCH_HIT_LAYER } from './cn';
import { XGlyph } from './icons';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // The scrim's duration is the panel's, so the two arrive as one.
      'fixed inset-0 z-50 bg-black/50 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/** Centred from `sm` up. Below `sm` the dialog is a sheet on the bottom edge. */
export const dialogSurface =
  'fixed inset-x-4 top-[50%] z-50 mx-auto flex max-h-[85dvh] w-auto max-w-lg flex-col overflow-hidden [&>[data-dialog-pinned]]:shrink-0 translate-y-[-50%] gap-4 rounded-lg border border-line bg-overlay p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:max-w-none max-sm:translate-y-0 max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=closed]:slide-out-to-bottom max-sm:data-[state=open]:slide-in-from-bottom';

/** Wraps each child that is not pinned in a scroll box, so a tall body scrolls and the header,
 *  the footer and the close button stay in view. */
export function withDialogScrollRoom(children: React.ReactNode, pinned: readonly unknown[]): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (child == null || typeof child === 'boolean') return child;
    if (React.isValidElement<{ children?: React.ReactNode; 'data-dialog-pinned'?: unknown }>(child)) {
      if (child.type === React.Fragment) return withDialogScrollRoom(child.props.children, pinned);
      if (child.props['data-dialog-pinned'] !== undefined || pinned.some((type) => type === child.type)) return child;
    }
    return <div className="-m-1 min-h-0 overflow-y-auto p-1 [&>*]:overflow-visible">{child}</div>;
  });
}

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { showClose?: boolean }
>(({ className, children, showClose = true, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content ref={ref} className={cn(dialogSurface, className)} {...props}>
      {withDialogScrollRoom(children, [DialogHeader, DialogFooter, DialogTitle, DialogDescription])}
      {showClose && (
        <DialogPrimitive.Close
          data-dialog-pinned=""
          className={cn(
            TOUCH_HIT_LAYER,
            'absolute right-4 top-4 cursor-pointer rounded-sm text-muted opacity-70 transition-opacity duration-fast hover:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] disabled:pointer-events-none',
          )}
        >
          <XGlyph className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div data-dialog-pinned="" className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div data-dialog-pinned="" className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
);
DialogFooter.displayName = 'DialogFooter';

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold text-fg', className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-dim', className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

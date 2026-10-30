import { useRef } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '../ui/kit';
import type { SignOutNoticeState } from './sign-out-copy';

/**
 * What a person sees when a sign-out did not do what it says (#682).
 *
 * A kit dialog, not a panel of our own: it portals out of the sidebar's stacking
 * context — where a `fixed inset-0` renders under the session bar and dies with
 * the mobile sheet — and brings the focus trap with it.
 *
 * Which kit dialog is the difference between the outcomes. A refused revocation
 * gets AlertDialog — no close X, an ignored scrim, and Escape refused on top,
 * because a reflex would finish the redirect and take away the one sentence the
 * person has to carry elsewhere. Anything dismissible gets Dialog, where the X,
 * the scrim and Escape all close.
 *
 * The sentence is the dialog's title: announced with it, read first, and always
 * somebody else's words — the server's, or `sign-out-copy`'s where no server
 * answered. `sign-out-copy` decides both the words and the way out.
 */

/** The kit's title treatment is sized for a few words; these are sentences. */
const TITLE = 'text-base font-medium leading-relaxed text-fg';

export function SignOutNotice({ notice }: { notice: SignOutNoticeState | null }) {
  const control = useRef<HTMLButtonElement>(null);
  if (notice === null) return null;
  const button = (
    <Button ref={control} type="button" variant="outline" size="sm" onClick={notice.onAction}>
      {notice.action}
    </Button>
  );
  // Bound out, or TypeScript loses the narrowing inside the callback below.
  const dismiss = notice.onDismiss;
  // `aria-describedby={undefined}`: the message IS the title, so there is no
  // description element for the kit to point at.
  if (dismiss === null) {
    return (
      <AlertDialog open>
        <AlertDialogContent
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => e.preventDefault()}
          // AlertDialog focuses its Cancel and nothing else; there is no Cancel
          // here, so without this the focus never enters the trap.
          onOpenAutoFocus={(e) => { e.preventDefault(); control.current?.focus(); }}
        >
          <AlertDialogTitle className={TITLE}>{notice.message}</AlertDialogTitle>
          <DialogFooter>{button}</DialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss(); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle className={TITLE}>{notice.message}</DialogTitle>
        <DialogFooter>{button}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

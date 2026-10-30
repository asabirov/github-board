/**
 * Confirm-and-close dialog (#287/#291). Closing an issue on Github is board's one
 * edit-existing-state write and is reversible only on Github, so a stray click
 * shouldn't do it — every close goes through this confirm. Controlled externally
 * (no trigger) so it composes with both the queue card's context menu and the
 * issue page's header actions. Reports the outcome via `flash`, calls
 * `onClosed` so the caller can reflect the new state, and bumps the refresh
 * nonce so the REST of the board re-reads (#692) — see `runClose`.
 *
 * It asks why as well (#1006): Github records a reason with every close, and
 * `completed` is one of three. `completed` is chosen when the dialog opens,
 * because it is what Github records when nobody says, and the button names the
 * choice, so a press never closes as something the reader did not read.
 */
import { useId, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  RadioGroup,
  RadioGroupItem,
} from './kit';
import { ApiError } from '../api/core';
import { closeIssue } from '../api/issues';
import { CLOSE_CHOICES, DEFAULT_CLOSE_CHOICE, reasonWords, type ChosenCloseReason } from '../close-reason';
import { useRefreshBump } from '../sync/sync-status';
import { flash } from './flash';

export interface CloseTarget {
  owner: string;
  repo: string;
  number: number;
  title: string;
}

/** #584 — the reason first, the status second. This was matching on the message
 *  strings `closeIssue` used to throw, then on the status those throws started
 *  carrying; the status is where three different refusals become one number.
 *  Two of the sentences below hang off a 403, so a status-only read cannot tell
 *  "the board may not" from "the board may, once somebody authorizes it" — and
 *  the second is the one a person can do something about. `reason` is absent
 *  from an older deploy and from any failure that did not come through the
 *  service's classifier, and the status answers for those; the `not-found`
 *  branch is the one that was dead until the status arrived.
 *
 *  The 403 names nobody: `assignReason` in `AssignIssueDialog.tsx` carries the
 *  enumeration, and this arm is the same arm on the same routes under a
 *  different verb (#1103 review, B1). In short: since #892 the write goes out
 *  under the READER's token, so the board's own credential is the one thing
 *  this refusal is not about, and nothing on the wire tells the reader's
 *  refusal from an ingress's.
 *
 *  The dialog renders no link. `authorizeUrl` reaches the surfaces that draw a
 *  short note beside a control; here there is room to say it in words.
 *  Exported for the spec: this mapping is the whole of what a person reads. */
export function reason(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Couldn’t close the issue. Try again on GitHub.';
  if (err.reason === 'not-permitted-yet') return 'This needs GitHub authorization before it can close.';
  if (err.reason === 'try-again') return 'Couldn’t reach GitHub. Try again in a moment.';
  if (err.status === 503) return 'Issue writes are turned off right now.';
  if (err.status === 403) return 'This issue wasn’t closed. Trying again won’t change that.';
  if (err.status === 404) return 'That issue no longer exists on GitHub.';
  if (err.status === 400) return 'The board refused that close reason. Reload the page and try again.';
  return 'Couldn’t close the issue. Try again on GitHub.';
}

/** What the confirmed close does, injected so each half is assertable — the
 *  same shape `repo-actions.ts` gives a row's menu, and for the same reason:
 *  the suite has no DOM, so the click that reaches `runClose` cannot be driven
 *  and its body has to be reachable on its own. */
export interface CloseEffects {
  /** Perform the write — `closeIssue` — and answer with the reason Github KEPT,
   *  or null where the service did not say (a deploy from before #1006). */
  close: (target: CloseTarget, reason: ChosenCloseReason) => Promise<string | null>;
  /** Say how it went — `flash`. */
  say: (message: string, tone?: 'default' | 'danger') => void;
  /** Ask every OTHER mounted view to re-read — `useRefreshBump()` (#384). The
   *  closed issue is gone from the counts, the stacks and the lists the moment
   *  the write lands, and each of those holds its own pre-close payload; the
   *  seven facet editors have bumped since #384 and the close never did. */
  bump: () => void;
  /** Tell the caller the issue is closed, so its row can dim where it is. */
  closed: () => void;
  /** Dismiss the dialog. */
  dismiss: () => void;
}

/** The confirm button's whole body. Nothing happens on a refusal but the
 *  sentence: the dialog stays up, the row stays open, and the caller is not
 *  told anything that isn't true.
 *
 *  Github ignores the reason unless the state changes (#1006), so a reason back
 *  that differs from the one sent means the issue was closed before this press:
 *  the card was stale. It is closed either way, so the row dims and the dialog
 *  shuts, and the sentence says which reason Github holds and where to change it. */
export async function runClose(target: CloseTarget, chosen: ChosenCloseReason, fx: CloseEffects): Promise<void> {
  const ref = `${target.repo}#${target.number}`;
  try {
    const kept = await fx.close(target, chosen);
    if (kept && kept !== chosen) {
      fx.say(`${ref} was already closed on GitHub, as ${reasonWords(kept)}. Change the reason there.`, 'danger');
    } else {
      fx.say(kept ? `Closed ${ref} as ${reasonWords(kept)}` : `Closed ${ref}`);
    }
    fx.bump();
    fx.closed();
    fx.dismiss();
  } catch (err) {
    fx.say(reason(err), 'danger');
  }
}

const CHOICE = 'flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-elevated';

/** The three reasons as one radio group. Exported so the spec can render it:
 *  the dialog around it draws into a portal, which static markup never reaches.
 *  A reason's note is drawn under it only while it is the choice (#1048), so
 *  the reader who picks Duplicate reads what the board leaves undone and nobody
 *  else has to. */
export function CloseReasonChoices({
  value,
  onChange,
  disabled = false,
}: {
  value: ChosenCloseReason;
  onChange: (reason: ChosenCloseReason) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <RadioGroup
      value={value}
      onValueChange={(v: string) => {
        const picked = CLOSE_CHOICES.find((c) => c.reason === v);
        if (picked) onChange(picked.reason);
      }}
      disabled={disabled}
      aria-label="Close as"
      className="gap-1"
    >
      {CLOSE_CHOICES.map((c) => (
        <label key={c.reason} htmlFor={`${id}-${c.reason}`} className={CHOICE}>
          <RadioGroupItem id={`${id}-${c.reason}`} value={c.reason} className="mt-[2px]" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] font-medium text-fg">{c.label}</span>
            {/* Drawn for whoever chose this reason, and reserved for everyone
                else (#1054). `invisible` is `visibility: hidden`, so the note
                keeps the room it will need — choosing Duplicate used to grow
                the alert and move all three radios up 10.4px — while leaving
                the accessibility tree, where it joins the radio's name only
                once it is the choice. Reserving with the real string rather
                than a fixed height means a note that wraps reserves two lines
                without anyone remembering to say so. */}
            {c.note && (
              <span className={`text-[12.5px] text-dim${c.reason === value ? '' : ' invisible'}`}>
                {c.note}
              </span>
            )}
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}

export function CloseIssueAlert({
  target,
  open,
  onOpenChange,
  onClosed,
}: {
  target: CloseTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
}) {
  const bump = useRefreshBump();
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<ChosenCloseReason>(DEFAULT_CLOSE_CHOICE);
  // Every opening starts from Github's default, never from the last issue's
  // answer. Reset during render as `open` turns true, so the opening's first
  // frame already draws it; an effect would paint the old choice first.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setChoice(DEFAULT_CLOSE_CHOICE);
  }

  async function confirm() {
    if (!target) return;
    setBusy(true);
    try {
      await runClose(target, choice, {
        close: (t, r) => closeIssue(t.owner, t.repo, t.number, r).then((res) => res.stateReason),
        say: flash,
        bump,
        closed: onClosed,
        dismiss: () => onOpenChange(false),
      });
    } finally {
      setBusy(false);
    }
  }

  const label = CLOSE_CHOICES.find((c) => c.reason === choice)?.label.toLowerCase() ?? reasonWords(choice);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close this issue on GitHub?</AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? `${target.repo}#${target.number} — “${target.title}” will be closed on GitHub. You can reopen it there.`
              : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <CloseReasonChoices value={choice} onChange={setChoice} disabled={busy} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault(); // stay open until the async close settles
              void confirm();
            }}
            disabled={busy}
          >
            {busy ? 'Closing…' : `Close as ${label}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

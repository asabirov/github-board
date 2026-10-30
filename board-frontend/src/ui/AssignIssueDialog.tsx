import { useResponseState } from '../auth/use-response-state';
import { useRenewalSignal, useAccessEpoch } from '../sync/sync-status';
/**
 * "Hand it to somebody" (#751) — the picker behind the action menu's
 * `Assign to…`, and the write behind `Assign to me` as well.
 *
 * It is `CloseIssueAlert`'s twin by design: controlled from outside with no
 * trigger of its own, so it composes with both menu paths; the confirmed action's
 * whole body is a pure `runAssign` with its effects injected, because the suite
 * has no DOM and the press cannot be driven; and it reports
 * through `flash`, bumps the refresh nonce so the REST of the board re-reads
 * (#384), and tells its caller what landed.
 *
 * A `Dialog` rather than an `AlertDialog`: an assignment is reversible on Github
 * in one click, so Escape and the scrim may dismiss it. `SignOutNotice` draws the
 * same line between the two.
 *
 * Since #1067 it takes that dialog from `PickDialog`, the shell the other
 * fourteen data pickers moved into when the human asked for modals. It was the
 * one they were shaped against, so nothing a reader reads here changed: it gains
 * the shared box, the shared width, the line under the title that holds its own
 * room, and a list that holds the height its set asks for.
 *
 * The one thing this write does that no other issue write does is disagree with
 * its own request. `PATCH …/assignees` replaces the set and Github DROPS a login
 * the repo will not assign, answering 200 with the set it kept — so the accepted
 * set is the truth and the login this dialog sent never is. `runAssign` reads the
 * answer and says what actually happened.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button, DialogFooter } from './kit';
import { ApiError } from '../api/core';
import { changeIssueAssignees, fetchEditOptions, fetchIssueAssignees, setIssueAssignees } from '../api/issues';
import { resolvePerson, usePeople } from '../people-ctx';
import { useRefreshBump } from '../sync/sync-status';
import { Avatar } from './avatar';
import type { CloseTarget } from './CloseIssueAlert';
import { flash } from './flash';
import { PickDialog, PickList } from './pick-list';

/**
 * The issue coordinates an assign needs: owner, repo, number, title — the four
 * `closeTargetOf` already resolves off a row's html URL. It is that type under
 * the name this file uses rather than a second declaration to keep in step; the
 * two writes address the same issue the same way, and only the verb differs.
 */
export type AssignTarget = CloseTarget;

/** #584, the assign wording of `CloseIssueAlert`'s `reason`. Same table, because
 *  the statuses mean the same things on every issue write; different sentences,
 *  because three of them name the act. Folding the two into one helper that takes
 *  the verb is the obvious next move and it edits `CloseIssueAlert` — worth doing
 *  when a third write joins them, not for a pair.
 *
 *  THE 403 NAMES NOBODY, and that is the whole of what this board can prove
 *  (#1103 review, B1). It said "You do not have permission to assign this
 *  issue.", which is a verdict on the reader; #979 replaced that with the
 *  board's own credential, which since #892 is not the credential the write
 *  went out under. `tokenFor` (`sources/github-client.ts`) hands every
 *  browser-initiated write the ACTING PERSON's token, `githubPrincipalGuard`
 *  makes the deployment fallback unreachable from a browser, and
 *  `auth/github-user.spec.ts` measures it on the wire. So the board's
 *  credential is the one thing a refused assign is NOT about.
 *
 *  What it could be about, none of which the wire tells apart: GitHub refusing
 *  that person write access to that repo, an App installation that does not
 *  cover it, an org wanting SSO authorization, `GithubPrincipalGuard` answering
 *  403 for a token that expired between two 20-second `me` polls,
 *  `TeamAccessGuard`, and an ingress. The arm is reached with `reason` absent
 *  or `'not-permitted'` and the reasoned one is per-principal too
 *  (`capability.registry.ts`), so a reason does not narrow it either.
 *
 *  So the sentence says what did not happen and stops. It is the shape
 *  `auth/write-failure.ts` (#1079) gives its `refused` kind, so the two
 *  write refusals on this board do not contradict each other on one screen.
 *  "Trying again won't change that" is true of every branch above: the same
 *  press against the same session is answered the same way. */
export function assignReason(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Couldn’t assign the issue. Try again on GitHub.';
  if (err.reason === 'not-permitted-yet') return 'This needs GitHub authorization before it can be assigned.';
  if (err.reason === 'try-again') return 'Couldn’t reach GitHub. Try again in a moment.';
  if (err.status === 503) return 'Issue writes are turned off right now.';
  if (err.status === 403) return 'This issue wasn’t assigned. Trying again won’t change that.';
  if (err.status === 404) return 'That issue no longer exists on GitHub.';
  return 'Couldn’t assign the issue. Try again on GitHub.';
}

/** What an assignment does, injected so each half is assertable — the shape
 *  `CloseEffects` gives the close, and for the same reason. */
export interface AssignEffects {
  /** Perform the write and answer with the set Github ACCEPTED — `setIssueAssignees`. */
  assign: (target: AssignTarget, logins: string[]) => Promise<string[]>;
  /** Add and remove the named people, touching nobody else, and answer with the
   *  whole set Github holds afterwards — `changeIssueAssignees` (#1009). */
  change: (target: AssignTarget, change: AssigneeChange) => Promise<string[]>;
  /** Say how it went — `flash`. */
  say: (message: string, tone?: 'default' | 'danger') => void;
  /** Ask every OTHER mounted view to re-read — `useRefreshBump()` (#384). */
  bump: () => void;
  /** Hand the caller the set the issue now holds, so its row can reflect it. */
  assigned: (logins: string[]) => void;
  /** Dismiss the picker. */
  dismiss: () => void;
}

/** "alice", "alice and bob", "alice, bob and carol" — a list of people read out
 *  as a sentence rather than as a bare array. */
function andList(logins: string[]): string {
  const last = logins[logins.length - 1];
  return logins.length === 1 ? last : `${logins.slice(0, -1).join(', ')} and ${last}`;
}

/** The same, as the state an issue is in. */
function nameList(logins: string[]): string {
  return logins.length === 0 ? 'unassigned' : `assigned to ${andList(logins)}`;
}

/**
 * The same person, whatever the casing (#752).
 *
 * The two strings come from different systems: what a menu SENDS is
 * `me.githubLogin`, the handle somebody typed into the roster
 * (`identity/github-login.resolver.ts`), and what Github ANSWERS with is its own
 * canonical spelling. Compared exactly, a mis-cased roster row made a write that
 * had succeeded report itself as a refusal: the row redrew correctly and the
 * reader got a red flash saying Github had turned it down. `identity/team-roster.ts`
 * canonicalises spelling for exactly this reason.
 */
function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * One assign in flight per issue (#752).
 *
 * `Assign to me` had no busy guard while the picker had its own, so pressing the
 * item and then picking somebody in `Assign to…` put two PATCHes on the wire and
 * `onAssigned` landed in ARRIVAL order rather than request order — the row
 * settling on whichever answer was slower. A plain object rather than a hook, so
 * the menu item and the picker can hold the SAME one; two hooks would be two
 * flags, which is the bug written twice.
 */
export interface AssignGate {
  /** Claim the wire. `false` means somebody already has it — do nothing. */
  begin(): boolean;
  /** Give it back. Must run on the failure path too, or one refusal shuts the
   *  control for the life of the row. */
  end(): void;
}

export function assignGate(): AssignGate {
  let busy = false;
  return {
    begin: () => (busy ? false : ((busy = true), true)),
    end: () => { busy = false; },
  };
}

/**
 * Only the newest read may answer (#752).
 *
 * Open the picker, Escape, open it again: two reads of the repo's assignable
 * set are in flight, and nothing said the first one is stale. Request #1
 * rejecting after #2 resolved set a failure flag that was never cleared, leaving
 * a permanent red banner over a perfectly usable list.
 *
 * This is a SEQUENCE and not the `useRef` once-guard that deadlocks under
 * StrictMode: every run of the effect takes a new ticket, so
 * StrictMode's second run is the newest and its answer lands. Nothing here is
 * about unmount — a `setState` after unmount is a no-op in React 18 — it is
 * about which of two live answers is the truth.
 */
export interface LatestOnly {
  /** Begin a read; the returned predicate answers "is this still the newest?" */
  start(): () => boolean;
}

export function latestOnly(): LatestOnly {
  let issued = 0;
  return {
    start() {
      const mine = ++issued;
      return () => mine === issued;
    },
  };
}

/**
 * Hand the issue to `login`. Both menu items end here — taking it yourself is the
 * same write with your own handle.
 *
 * The payload is the full desired set (`[login]`), because the route replaces
 * rather than adds and this menu has no view of the current assignees to add to.
 * So an assignment from here is a hand-over: the issue ends up held by the one
 * person chosen. `AssigneeEditor` in the issue panel is where a multi-select
 * belongs, and it has the current set to build one from.
 *
 * Github's answer is reconciled to whatever it says — including the empty set a
 * dropped login leaves behind, which is a state change and gets the same refresh
 * as a success. Only the sentence differs, and on a drop the picker stays up so
 * the reader can choose somebody the repo will take.
 */
export async function runAssign(
  target: AssignTarget,
  login: string,
  fx: AssignEffects,
  /**
   * Who holds the issue at the moment of the press, so the sentence afterwards
   * can name whoever this took it from (#752).
   *
   * The picker warns before the fact — its description says the pick replaces
   * anyone assigned now — and `Assign to me` has no dialog to warn in, so the
   * flash is the only place a silent hand-over can be named. That is what makes
   * it reversible by somebody who did not mean to do it.
   *
   * Defaulted to nobody: `ActionableIssue` carries no assignees, so a surface
   * that does not know says nothing rather than guessing, and gets the sentence
   * this write has always printed.
   */
  heldBy: readonly string[] = [],
): Promise<void> {
  const ref = `${target.repo}#${target.number}`;
  try {
    const accepted = await fx.assign(target, [login]);
    fx.bump();
    fx.assigned(accepted);
    if (!accepted.some((a) => sameLogin(a, login))) {
      fx.say(`GitHub didn’t accept ${login}. ${ref} is now ${nameList(accepted)}.`, 'danger');
      return;
    }
    // Taking a report you already hold is not a hand-over from yourself.
    const displaced = heldBy.filter((held) => !sameLogin(held, login));
    fx.say(
      displaced.length
        ? `Assigned ${ref} to ${login} — taken from ${andList(displaced)}`
        : `Assigned ${ref} to ${login}`,
    );
    fx.dismiss();
  } catch (err) {
    fx.say(assignReason(err), 'danger');
  }
}

/** Github's cap on one issue: "Both issues and pull requests support up to 10
 *  assignees" (docs.github.com, "Assigning issues and pull requests to other
 *  GitHub users", read 2026-09-11). */
export const MAX_ASSIGNEES = 10;

/** Tick or untick one person. A tick past the cap changes nothing, and the
 *  picker says why under the list rather than sending a set Github would refuse. */
export function toggleAssignee(chosen: readonly string[], login: string): string[] {
  if (chosen.some((c) => sameLogin(c, login))) return chosen.filter((c) => !sameLogin(c, login));
  return chosen.length >= MAX_ASSIGNEES ? [...chosen] : [...chosen, login];
}

/** The picker's rows: everyone the repo will assign, then anyone holding the
 *  issue whom that list does not name (somebody who has since lost access). They
 *  are drawn ticked, and a save that leaves them ticked never names them, so they
 *  stay unless the reader unticks them. */
export function pickerRows(assignable: readonly string[], holders: readonly string[]): string[] {
  return [...assignable, ...holders.filter((h) => !assignable.some((a) => sameLogin(a, h)))];
}

/** Whether two sets of logins name the same people, whatever the order or casing. */
export function sameAssignees(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.some((y) => sameLogin(x, y)));
}

/** Who the reader ticked and who they unticked, against the set they were shown. */
export interface AssigneeChange {
  add: string[];
  remove: string[];
}

export function assigneeChange(seen: readonly string[], chosen: readonly string[]): AssigneeChange {
  return {
    add: chosen.filter((c) => !seen.some((s) => sameLogin(s, c))),
    remove: seen.filter((s) => !chosen.some((c) => sameLogin(c, s))),
  };
}

/**
 * What Save will send, as the line under the list (#1049). The picker used to
 * explain in two sentences that Save adds the ticked and removes the unticked
 * and leaves everyone else alone. This shows it instead: it names exactly the
 * people `runChangeAssignees` will send, and nobody else, because the picker
 * builds both from `assigneeChange(held, chosen)`. Empty when nothing changed,
 * and Save is off then too — the picker draws `NOTHING_TO_SAVE` in its place.
 *
 * The two halves are joined with a COMMA and not a bare "and", because
 * `andList` has already spent one: "Save adds ann and bob and removes carol"
 * reads for a moment as a list of three people (#1054). The comma is what says
 * the second "and" starts a new verb.
 */
export function saveSummary(change: AssigneeChange, name: (login: string) => string = (login) => login): string {
  const said = [
    change.add.length ? `adds ${andList(change.add.map(name))}` : '',
    change.remove.length ? `removes ${andList(change.remove.map(name))}` : '',
  ].filter(Boolean);
  return said.length ? `Save ${said.join(', and ')}.` : '';
}

/**
 * What the live line says while the ticks still match what the picker was
 * shown, which is also every moment before the first tick.
 *
 * It exists so the line can be reserved with words rather than with blank
 * space. The line is always mounted, so a screen reader hears it change; before
 * #1054 it was `sr-only` while empty, which took it out of the dialog's flex
 * column and grew the centred dialog by 50.75px on the first tick, moving every
 * row under the reader's cursor up 25.4px and back. Reserving that height empty
 * is the other half of the trap: an always-present blank line is what
 * #944 is still open about on the Projects strip. A resting sentence holds the same height
 * and reads as the status it is, next to a Save that is off for the same
 * reason.
 */
export const NOTHING_TO_SAVE = 'Nothing to save yet.';

/**
 * Save what the reader changed in the `several` picker (#1009).
 *
 * It sends the change and never the whole set. The picker's ticks come from a
 * read taken when it opened, and somebody may assign or unassign on Github while
 * it is open. A save of the whole set would take off anyone assigned since, and
 * nobody would be told. A change names only the people the reader ticked or
 * unticked, so Github keeps everyone else as they are.
 *
 * Github's answer is the whole set it holds afterwards, which can name people
 * this change never mentioned. The row redraws with it and the flash names it.
 * Anyone Github would not add, or did not remove, is named and the picker stays
 * up.
 *
 * On a failure the board re-reads when the change had both halves. The service
 * removes first and then adds, so the removal may have landed before the add
 * was refused. The picker keeps what the reader was shown, so pressing Save
 * again sends the same change. Github's docs say an add leaves people already
 * assigned alone, and say nothing about removing somebody already gone.
 */
export async function runChangeAssignees(
  target: AssignTarget,
  seen: readonly string[],
  chosen: readonly string[],
  fx: AssignEffects,
): Promise<void> {
  const ref = `${target.repo}#${target.number}`;
  const change = assigneeChange(seen, chosen);
  try {
    const now = await fx.change(target, change);
    fx.bump();
    fx.assigned(now);
    const notAdded = change.add.filter((a) => !now.some((n) => sameLogin(n, a)));
    const kept = change.remove.filter((r) => now.some((n) => sameLogin(n, r)));
    if (notAdded.length || kept.length) {
      const said = [
        notAdded.length ? `GitHub didn’t accept ${andList(notAdded)}.` : '',
        kept.length ? `GitHub kept ${andList(kept)}.` : '',
      ].filter(Boolean);
      fx.say(`${said.join(' ')} ${ref} is now ${nameList(now)}.`, 'danger');
      return;
    }
    fx.say(`${ref} is now ${nameList(now)}`);
    fx.dismiss();
  } catch (err) {
    if (change.add.length && change.remove.length) fx.bump();
    fx.say(assignReason(err), 'danger');
  }
}

/** What a failed read says. A 403 is the board refusing this session rather
 *  than a blip, so it is not told to try again in a moment. Only the `several`
 *  picker reads the issue itself, so only it can find the issue gone, and its
 *  general sentence names both reads because either may be the one that failed. */
export function readFailure(err: unknown, several: boolean): string {
  const said = err instanceof Error ? err.message : '';
  if (said === 'forbidden') return 'This read was refused. Reload the page to check your access.';
  if (several && said === 'not-found') return 'That issue no longer exists on GitHub.';
  return several
    ? 'Couldn’t read who holds this issue and who can be assigned. Try again in a moment.'
    : 'Couldn’t read who this repo can assign. Try again on GitHub.';
}

/**
 * The real effects, as a hook, so the picker and the menu's one-click
 * `Assign to me` perform the same write the same way rather than keeping two
 * copies of it in step. `dismiss` is the only half that differs: the picker
 * shuts itself, and the menu item has nothing to shut.
 */
export function useAssignEffects({
  assigned,
  dismiss,
}: {
  assigned?: (logins: string[]) => void;
  dismiss: () => void;
}): AssignEffects {
  const bump = useRefreshBump();
  return {
    // The accepted set, projected to logins — `Actor` is what the route answers
    // with and a login is all either caller has to compare against.
    assign: (t, next) =>
      setIssueAssignees(t.owner, t.repo, t.number, next).then((r) => r.assignees.map((a) => a.login)),
    change: (t, delta) =>
      changeIssueAssignees(t.owner, t.repo, t.number, delta).then((r) => r.assignees.map((a) => a.login)),
    say: flash,
    bump,
    assigned: (logins) => assigned?.(logins),
    dismiss,
  };
}

const NOTE = 'px-2.5 py-2 text-[12.5px] text-dim';

export function AssignIssueDialog({
  target,
  open,
  onOpenChange,
  trigger,
  onAssigned,
  heldBy,
  gate,
  several = false,
}: {
  target: AssignTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The ⋯ handle this was raised from, so focus goes back to it on every way
   * out (#1077 review, S3).
   *
   * It was left out on the record that "Radix hands focus back to that handle as
   * it closes", and that is not what happens. Radix's focus scope captures
   * `document.activeElement` when the content MOUNTS, and `IssueActions` raises
   * this in a `requestAnimationFrame` after the menu has already unmounted and
   * dropped focus, so what the scope captures is `<body>` and what it restores
   * is `<body>`. Measured on `/queue`: Escape, the scrim and Cancel all left
   * focus there, with the handle on screen at full opacity the whole time.
   */
  trigger?: RefObject<HTMLElement | null>;
  /** The set the issue now holds, as Github reported it. */
  onAssigned?: (logins: string[]) => void;
  /** Who holds it at the moment of the pick — see `runAssign`'s `heldBy`. */
  heldBy?: readonly string[];
  /** The wire, shared with the menu's one-press `Assign to me` so the two cannot
   *  be in flight together (#752). `IssueActions` owns it; a picker mounted
   *  without one makes its own, which is still one gate per issue. */
  gate?: AssignGate;
  /**
   * Edit the whole set rather than hand the issue to one person (#1009). The
   * issue's assignees are a list, and Github takes up to `MAX_ASSIGNEES`, so a
   * surface that can say who holds an issue should not narrow that to one.
   *
   * The rows are ticked from who holds the issue on Github when the picker
   * opens, read past the service's issue cache, not from what the card drew. One
   * Github read per opening. That read can still age while the picker is open,
   * so Save sends only who the reader ticked and unticked (`runChangeAssignees`),
   * and anyone assigned on Github in the meantime stays assigned.
   */
  several?: boolean;
}) {
  const [held, setHeld] = useResponseState<string[] | null>(null, null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const fx = useAssignEffects({
    assigned: (next) => {
      onAssigned?.(next);
      setHeld(next);
      setChosen(next);
      // Github's answer can name somebody the rows do not: assigned elsewhere
      // while the picker was open. Where the picker stays up, they get a row, or
      // they would be ticked and counted with no row to untick.
      setLogins((rows) => (rows ? pickerRows(rows, next) : rows));
    },
    dismiss: () => onOpenChange(false),
  });
  const renewal = useRenewalSignal() + useAccessEpoch();
  const [logins, setLogins] = useResponseState<string[] | null>(null, null);
  const [failed, setFailed] = useState<string | null>(null);
  const ownGate = useRef<AssignGate>(undefined);
  if (!ownGate.current) ownGate.current = assignGate();
  const writing = gate ?? ownGate.current;
  const reads = useRef<LatestOnly>(undefined);
  if (!reads.current) reads.current = latestOnly();
  const owner = target?.owner;
  const repo = target?.repo;
  const number = target?.number;

  // The person, not the handle (#752). `issue/facet-editors.tsx` runs this same
  // `assignableLogins` list through the roster before drawing it, so a picker
  // that printed `login` made one person read as `octocat` in one place and as
  // their name in the other. Off the roster, the handle is still the best thing
  // there is — which is what `resolvePerson` returning null means.
  const people = usePeople();
  const nameOf = (login: string) => resolvePerson(people, login, null)?.displayName ?? login;

  // The keys are the list's own (#1021). The Radix `Dialog` owns Escape, the
  // scrim and the focus trap; the `PickList` inside it owns the search field,
  // the arrows and Enter, through the kit's `Command`. This used to borrow
  // `useDismiss` for its arrows alone, with a no-op close, because its rows were
  // `tabIndex={-1}` buttons and nothing else walked them (#752).

  // Who this repo will assign, read when the picker opens rather than on every
  // row that COULD open one. No `useRef` once-guard and no `let alive` cleanup
  // flag: the pair of them deadlocks under StrictMode and strands the value for
  // the life of the page. A `setState` after unmount is a no-op
  // in React 18, so the flag those guards existed for buys nothing here.
  //
  // `latestOnly` is a different question from either (#752): open, Escape,
  // reopen, and request #1 rejecting after #2 resolved left a failure banner
  // over a usable list. It takes a ticket per RUN, so StrictMode's second run is
  // the newest one and its answer is the one that lands.
  useEffect(() => { setLogins(null); setHeld(null); }, [open, owner, repo, number]);
  useEffect(() => {
    if (!open || !owner || !repo || !number) return;
    const newest = reads.current!.start();
    setFailed(null);
    // One ticket for both reads, so a stale answer to either cannot land.
    Promise.all([fetchEditOptions(owner, repo), several ? fetchIssueAssignees(owner, repo, number) : null]).then(
      ([options, holders]) => {
        if (!newest()) return;
        setHeld(holders);
        setChosen(holders ?? []);
        setLogins(holders ? pickerRows(options.assignableLogins, holders) : options.assignableLogins);
      },
      (err: unknown) => { if (newest()) setFailed(readFailure(err, several)); },
    );
  }, [open, owner, repo, number, several, renewal]);

  async function pick(login: string) {
    if (!target || !writing.begin()) return;
    try {
      await runAssign(target, login, fx, heldBy);
    } finally {
      writing.end();
    }
  }

  async function save() {
    if (!target || held === null || !writing.begin()) return;
    setSaving(true);
    try {
      // Against `held`, what the reader was shown, so only their own ticks go.
      await runChangeAssignees(target, held, chosen, fx);
    } finally {
      writing.end();
      setSaving(false);
    }
  }

  const changed = held !== null && !sameAssignees(held, chosen);
  const full = several && chosen.length >= MAX_ASSIGNEES;
  // From the two sets `save()` hands `runChangeAssignees`, so the line says
  // what the press will send.
  const summary = held === null ? '' : saveSummary(assigneeChange(held, chosen), nameOf);

  // The picker's own words, or the refusal in their place. A read that fails
  // after an earlier one succeeded must not draw a banner ABOVE the list it is
  // denying the existence of, so the two are one line and never two.
  const note = failed
    ? failed
    : !target
      ? ''
      : several
        ? `Choose up to ${MAX_ASSIGNEES} people for “${target.title}” (${target.repo}#${target.number}).`
        : `${target.repo}#${target.number} — “${target.title}” will be assigned to the person you pick, replacing anyone assigned now.`;

  return (
    // The shell every standalone picker takes since #1067. This dialog was the
    // one the other fourteen were shaped against, so what it gains here is the
    // shared box, the width, the reserved line and the reserved list height,
    // and none of what a reader reads changes.
    //
    // The close is guarded while the save is in flight, and the corner ✕ is not
    // drawn there: a write with an issue on the other end of it should not be
    // dismissed out from under itself, and a mark that looks pressable and
    // answers a press with nothing reads as the dialog being stuck. Cancel and
    // Save already grey themselves. `NewProjectDialog` rules the same way on the
    // same two lines (#982), and the two dialogs are one house rule rather than
    // two (#1077 review, S6).
    <PickDialog
      open={open}
      onOpenChange={(next) => { if (next || !saving) onOpenChange(next); }}
      showClose={!saving}
      trigger={trigger}
      title="Assign this issue on GitHub?"
      note={note}
      danger={!!failed}
      footer={
        <>
          {/* Always mounted, so a screen reader hears it change, and always in
              the dialog's flex column, so the first tick does not resize the
              dialog under the reader's cursor (#1054). `NOTHING_TO_SAVE` holds
              the height the summary will take, which is why it is a sentence and
              not a blank line. `data-dialog-pinned` keeps it out of the surface's
              scrolling rule: the list above is what scrolls, not this. */}
          {several && (
            <p data-dialog-pinned aria-live="polite" className={NOTE}>
              {summary || NOTHING_TO_SAVE}
            </p>
          )}
          {full && <p data-dialog-pinned className={NOTE}>GitHub takes at most {MAX_ASSIGNEES} people on one issue.</p>}
          {several && (
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={!changed || saving}>
                {saving ? 'Saving…' : 'Save assignees'}
              </Button>
            </DialogFooter>
          )}
        </>
      }
    >
      {/* The read that failed leaves NO list, and no box where one would be:
          its sentence is the line above, where every picker's refusal goes. It
          was drawn under the banner once, which put a refusal above a list it
          was denying the existence of (#752). One pick replaces the whole set,
          so that list marks nothing and leaves `selected` out. `several` ticks
          and unticks in place, and its ticks are matched whatever the casing. */}
      {failed ? null : (
        <PickList
          reserve
          noun="people"
          empty="Nobody on this repo can be assigned."
          items={
            logins?.map((login) => ({
              id: login,
              name: nameOf(login),
              mark: <Avatar name={nameOf(login)} login={login} px={40} className="pj-av-xs" showTitle={false} />,
            })) ?? null
          }
          selected={several && logins ? logins.filter((login) => chosen.some((c) => sameLogin(c, login))) : undefined}
          onPick={(login) => (several ? setChosen((c) => toggleAssignee(c, login)) : void pick(login))}
        />
      )}
    </PickDialog>
  );
}

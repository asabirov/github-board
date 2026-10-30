import { copyResponseDeadline, responseExpired } from '../auth/response-deadline';
import { useResponseDeadline } from '../auth/use-response-deadline';
/**
 * The optimistic-with-rollback edit engine behind every PropertiesPanel facet
 * editor (#384). One `edit(next)` snapshots the prior value, shows it applied at
 * once (`status:'saving'`), then commits to the server; on success it reconciles
 * to the value the server RETURNS — not the optimistic guess — and patches the
 * page's issue; on failure it rolls back and offers a `retry()`.
 *
 * B2 (reconcile-to-returned): GitHub coerces silently — `issues.update` drops a
 * non-assignable login, `setLabels` normalises names. So the authoritative truth
 * is whatever `commit` resolves with, and the hook snaps `value` + `apply` to that
 * returned value. The optimistic value is only ever a placeholder shown while the
 * write is in flight.
 *
 * As with `use-viewer-state`, the state machine is a pure, framework-free store
 * (`createFacetEdit`) so the transitions are unit-tested without a DOM; the hook
 * is the thin React wrapper that subscribes to it via `useSyncExternalStore`.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ApiError } from '../api/core';
import { REFUSED_REASON, type RefusalReason } from '../refusal';
import type { RowStatus } from './PropertyRow';

/** Why a write failed, in the only two terms a person at the control needs:
 *  what happened, and whether pressing the button again could change it. */
export interface EditFailure {
  /** One short true sentence. Replaces the generic wording — it does not sit
   *  beside it, because the generic wording is what said nothing. */
  text: string;
  /** Whether Retry is worth offering. False means no button at all: a control
   *  that cannot work must not look like one. */
  canRetry: boolean;
}

/** The one failure worth pressing a button over: the board or Github broke, or
 *  the request never arrived. Keeps the wording every refused write on this
 *  board has always used, for the case where it was the right wording.
 *
 *  Exported so ONE surface can tell this fallback from a real answer and say
 *  something truer of its own write: you do not save a comment (#693). It is
 *  recognised by IDENTITY — `describeEditFailure` returns this exact object on
 *  both fallback paths — so a table entry that happened to share the wording
 *  would not be mistaken for it. The sentence itself stays as it is: it is right
 *  for the eight facet writers that read it. */
export const RETRYABLE: EditFailure = { text: 'Couldn\u2019t save', canRetry: true };

/**
 * What each answer means to the person who pressed the control.
 *
 * Every string here has to fit the narrowest surface that shows one, which is
 * the repo tile. `FAILURE_TEXT_BUDGET` below is that constraint, measured — do
 * not re-derive it here. An earlier version of this paragraph quoted 274px and
 * a 25-character ceiling; 274px is what the tile happens to be on a wide screen,
 * the budget block explains why, and two calibrations in one file is how one of
 * them goes quietly wrong.
 *
 * The distinction between the two permanent refusals rides on the SUBJECT, with
 * the verb held constant. "Github doesn\u2019t allow that" is about the value that
 * was picked; "The board isn\u2019t allowed" is about the tool, and says plainly
 * that it is not the reader\u2019s doing. Moving only the verb hid the difference.
 *
 * 404 sits with 403 on purpose, and since #584 for the opposite reason. It used
 * to sit there because Github answers a write whose token lacks the scope with
 * 404 rather than 403 \u2014 which is precisely how #577 stayed invisible \u2014 so on a
 * write the two numbers meant the same refusal. Telling those two apart is now
 * the service's job: it re-reads the target before believing a 404, and answers
 * with a reason. So a 404 that still arrives here carries no reason, came from
 * somewhere below that classifier, and is as permanent as it looks.
 *
 * The three retryable entries have to be read carefully against the permanent
 * ones. 502 is the board failing to reach Github, to write or to read the
 * settings the write is gated on; neither is a statement about permission, and
 * both may work on the next press. 503 is not `/auth/me`'s reading of the write
 * flag \u2014 that folds into `writesEnabled`, which `mayWrite` composes with the
 * control's own capability, so a switched-off flag never draws the control at
 * all \u2014 it is an ingress answering during a rollout, which is over in seconds,
 * or `GITHUB_WRITE_ENABLED` reaching a route this control did not know was
 * gated, which the next press is as likely to survive.
 */
const BY_STATUS: Record<number, EditFailure> = {
  400: { text: 'GitHub doesn\u2019t allow that', canRetry: false },
  401: { text: 'Your session ended', canRetry: false },
  403: { text: 'The board isn\u2019t allowed', canRetry: false },
  404: { text: 'The board isn\u2019t allowed', canRetry: false },
  422: { text: 'GitHub doesn\u2019t allow that', canRetry: false },
  502: { text: 'Couldn\u2019t reach GitHub', canRetry: true },
  503: { text: 'Can\u2019t save right now', canRetry: true },
};
/**
 * How long a failure string may be, in characters, before the narrowest surface
 * that shows one breaks.
 *
 * That surface is the repo tile, and the width to measure at is NOT the 274px
 * it happens to be on a wide screen. The grid is
 * `repeat(auto-fill,minmax(236px,1fr))`, so the tile is 237px at a 1280
 * viewport and 236px at the grid\u2019s floor. Measured there, in the sentence-case
 * Latin this copy is written in: a note that renders "\u00b7 Retry" beside it holds
 * one line to 21 characters, one that does not to 30. Past that the card grows
 * from 112.546875 to 126.546875 \u2014 14px taller than every neighbour in its row.
 *
 * Two budgets rather than one because the suffix is the entire difference:
 * a single number would either permit a wrap or forbid a string that fits.
 * Characters are a proxy for width, calibrated on the alphabet actually in use;
 * the authority is the browser measurement, and a new string in an unusual
 * alphabet should be measured rather than counted.
 */
export const FAILURE_TEXT_BUDGET = { retryable: 21, permanent: 30 } as const;

/** The budget that applies to `failure`, given what renders beside it. */
export function failureTextBudget(failure: Pick<EditFailure, 'canRetry'>): number {
  return failure.canRetry ? FAILURE_TEXT_BUDGET.retryable : FAILURE_TEXT_BUDGET.permanent;
}

/**
 * What each REFUSAL means to the person who pressed the control (#584).
 *
 * The reason is what the service actually decided; the status is a lossy
 * projection of it. Three reasons answer 403 \u2014 `not-permitted`,
 * `not-permitted-yet` and `unauthenticated`, the last deliberately, so a dead
 * board credential does not sign the reader out \u2014 and read as a status they
 * collapse into one sentence, the flattest of the three. Read the reason when
 * there is one, and keep `BY_STATUS` for everything else: an older deploy, an
 * ingress, a 500.
 *
 * `not-permitted` is not typed out here. Its words are also what a control says
 * when it is withheld BEFORE anyone presses it, so `refusal.ts` declares them
 * once and both readers take them from there — reword the sentence and every
 * surface moves together, which three typed copies could not do.
 *
 * `not-found` names no subject on purpose. One row serves two surfaces — the
 * issue page and the repo tile both read it — and a repo whose owner write 404s
 * is not an issue, so any sentence that says "the issue" is wrong on one of them.
 *
 * The six names are `refusal.ts`'s, and this Record is exhaustive over them on
 * purpose: a seventh reason added there without a sentence here does not
 * compile. Every string is inside `FAILURE_TEXT_BUDGET` \u2014 "Couldn\u2019t reach
 * Github" is exactly the 21 a retryable one gets \u2014 and the spec asserts that
 * rather than trusting the count.
 */
const BY_REASON: Record<RefusalReason, EditFailure> = {
  'not-permitted': { text: REFUSED_REASON, canRetry: false },
  'not-permitted-yet': { text: 'Needs GitHub authorization', canRetry: false },
  'wrong-value': { text: 'GitHub doesn\u2019t allow that', canRetry: false },
  'try-again': { text: 'Couldn\u2019t reach GitHub', canRetry: true },
  'not-found': { text: 'Not found on GitHub', canRetry: false },
  unauthenticated: { text: 'GitHub rejected the board', canRetry: false },
};

/**
 * Read a rejected commit for what it can honestly tell someone (#577, #584).
 *
 * Before this, every failure — a missing scope, a dead session, a switched-off
 * write, a server fault — arrived at the control as the same four words beside
 * the same Retry, so the only sensible response to any of them was to press
 * Retry again. An error the fetchers do not describe falls back to the
 * retryable wording, which is the safe end of the guess: it offers an action
 * that costs one request rather than withholding one that would have worked.
 */
export function describeEditFailure(err: unknown): EditFailure {
  if (!(err instanceof ApiError)) return RETRYABLE;
  if (err.reason && BY_REASON[err.reason]) return BY_REASON[err.reason];
  return BY_STATUS[err.status] ?? RETRYABLE;
}

export interface FacetEditOptions<T> {
  /** The response that authorized this value, including scalar fields. */
  source?: unknown;
  /** The facet's current value — the resting display + the rollback target. */
  initial: T;
  /** Persist `next` and RESOLVE with the server's authoritative resulting value
   *  (B2). Reject to roll back. */
  commit: (next: T) => Promise<T>;
  /** Reflect the reconciled (server-returned) value into the page's issue, and do
   *  any success side effect (the #384 refresh-nonce bump). */
  apply: (actual: T, source?: unknown) => void;
}

/** The vanilla store the hook wraps — same observable behavior the spec asserts. */
export interface FacetEditStore<T> {
  readonly value: T;
  readonly status: RowStatus;
  /** Why the last write failed, or null when nothing has. Set alongside
   *  `status: 'error'` and cleared the moment another attempt starts. */
  readonly failure: EditFailure | null;
  /** Optimistically apply `next`, commit, then reconcile-or-roll-back. */
  edit(next: T): Promise<void>;
  /** Re-run the last requested edit (after a failure). */
  retry(): Promise<void>;
  /** Put a failed edit behind you: back to `idle`, showing the value that
   *  survived the failure. The way out for a failure that offers no Retry —
   *  without it, withholding the Retry button withholds the ONLY control that
   *  could call back into this store, and the surface is dead until it
   *  unmounts (#577). A no-op unless something has failed. */
  dismiss(): void;
  /** Force the resting value to `next` while IDLE — used to absorb an external
   *  change to `initial` (a background refetch, Sync now) without clobbering an
   *  in-flight edit, and without erasing a failure nobody has acknowledged.
   *
   *  It briefly cleared failures too, so that a refetch could rescue a surface
   *  with no other way out. `dismiss` is that way out, and it is deterministic;
   *  clearing on refetch was not, because the hook resets on `initial` changing
   *  IDENTITY — every poll for a facet holding an object, never for one holding
   *  a string. Same refusal, different fate, depending on a detail of the value.
   *  And on the surfaces where it did fire, the 120s poll could erase a refused
   *  write before anyone read it. */
  reset(next: T, source?: unknown): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): { value: T; status: RowStatus; failure: EditFailure | null };
}

export function createFacetEdit<T>(opts: FacetEditOptions<T>): FacetEditStore<T> {
  let source: unknown = opts.source ?? opts.initial;
  let value = opts.initial;
  let status: RowStatus = 'idle';
  let failure: EditFailure | null = null;
  let lastRequested = opts.initial;
  const listeners = new Set<() => void>();
  // A cached snapshot so getSnapshot returns a stable reference between changes
  // (useSyncExternalStore compares by identity and would loop otherwise).
  let snap: { value: T; status: RowStatus; failure: EditFailure | null } = copyResponseDeadline(source, { value, status, failure });
  const emit = () => {
    snap = copyResponseDeadline(source, { value, status, failure });
    listeners.forEach((l) => l());
  };

  const store: FacetEditStore<T> = {
    get value() {
      return value;
    },
    get status() {
      return status;
    },
    get failure() {
      return failure;
    },
    async edit(next: T) {
      if (responseExpired(source)) return;
      source = copyResponseDeadline(next, copyResponseDeadline(source, {}));
      const authorization = source;
      lastRequested = next;
      const prior = value;
      value = next;
      status = 'saving';
      failure = null;
      emit();
      try {
        const actual = await opts.commit(next);
        if (responseExpired(authorization)) return;
        value = actual;
        status = 'idle';
        emit();
        // B2 — the page reconciles to the server's truth, not the request.
        opts.apply(actual, authorization);
      } catch (err) {
        if (responseExpired(authorization)) return;
        value = prior;
        status = 'error';
        // The error is READ rather than swallowed (#577): a control that keeps
        // no reason can only ever offer one response to every failure.
        failure = describeEditFailure(err);
        emit();
      }
    },
    retry() {
      return store.edit(lastRequested);
    },
    dismiss() {
      if (status !== 'error') return;
      status = 'idle';
      failure = null;
      // `value` is already the one that survived — `edit` rolled it back.
      emit();
    },
    reset(next: T, nextSource: unknown = next) {
      // Idle only. A write in flight is about to land its own result, and a
      // failure is a thing a person has to see — `dismiss` and `retry` clear it.
      if (status !== 'idle' || (Object.is(value, next) && source === nextSource)) return;
      source = nextSource;
      value = next;
      lastRequested = next;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snap;
    },
  };
  return store;
}

export function useFacetEdit<T>(opts: FacetEditOptions<T>): {
  value: T;
  status: RowStatus;
  /** Why the last write failed, or null. Optional to read — a caller that
   *  ignores it keeps the generic wording it had before (#577). */
  failure: EditFailure | null;
  edit: (next: T) => Promise<void>;
  retry: () => Promise<void>;
  /** Clear a failed state. The way out where Retry is withheld — see the store. */
  dismiss: () => void;
} {
  // `commit`/`apply` close over the latest issue + refresh bump each render; hold
  // them in refs so the store (created once) always calls the current closures.
  const commitRef = useRef(opts.commit);
  commitRef.current = opts.commit;
  const applyRef = useRef(opts.apply);
  applyRef.current = opts.apply;

  const storeRef = useRef<FacetEditStore<T>>(undefined);
  if (!storeRef.current) {
    storeRef.current = createFacetEdit<T>({
      initial: opts.initial,
      source: opts.source,
      commit: (n) => commitRef.current(n),
      apply: (a, source) => applyRef.current(a, source),
    });
  }
  const store = storeRef.current;

  // Absorb an external change to the facet (e.g. the page's issue was patched by
  // another edit or a refetch) into the resting value while we're idle.
  useEffect(() => {
    store.reset(opts.initial, opts.source);
  }, [store, opts.initial, opts.source]);

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const expired = useResponseDeadline(snap);
  return {
    value: expired ? opts.initial : snap.value,
    status: snap.status,
    failure: snap.failure,
    edit: store.edit,
    retry: store.retry,
    dismiss: store.dismiss,
  };
}

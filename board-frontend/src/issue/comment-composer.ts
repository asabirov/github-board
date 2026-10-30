/**
 * The state behind the comment composer at the foot of an issue thread (#693) —
 * a plain, framework-free store, for the reason `use-facet-edit.ts` gives for
 * `createFacetEdit`: the transitions are then unit-tested without a DOM, and
 * this suite has none. The React wrapper is in `CommentComposer.tsx`.
 *
 * It is a second store rather than a reuse of `createFacetEdit` because the two
 * write different things. A facet edit shows its value applied at once and rolls
 * it back on failure; a comment is not applied optimistically at all — there is
 * nothing truthful to show until Github has stored it — and what must survive a
 * failure is the DRAFT, which a facet edit has no notion of. The failure
 * VOCABULARY is shared: `describeEditFailure` is the same table every refused
 * write on this board reads, so a reworded refusal moves here too.
 */
import { ApiError } from '../api/core';
import type { IssueComment, IssueDetail } from '../api/issues';
import { RETRYABLE, describeEditFailure } from './use-facet-edit';

export interface ComposerState {
  /** Is the editor grown, or is this the muted one-line prompt? */
  readonly open: boolean;
  /** What has been typed. Survives a failed send; discarded by Cancel. */
  readonly draft: string;
  /** Showing the draft as the thread will render it, rather than the field. */
  readonly previewing: boolean;
  /** A post is in flight — the send control is disabled so a second click
   *  cannot post the same paragraph twice. */
  readonly sending: boolean;
  /** Why the last send did not land, or null. Cleared when another starts. */
  readonly failure: string | null;
  /** The exact draft the board refused OUTRIGHT, or null. A 400 is a verdict on
   *  this text — too long, or carrying the signature line the board appends
   *  itself — so pressing Send again cannot change it, and `canSend` withholds
   *  the control until the draft moves. Every other failure leaves this null:
   *  a 403 that gets authorized, a 503 mid-rollout and a dropped request are all
   *  worth another press. */
  readonly refusedDraft: string | null;
}

/** What the view can do to the composer. The store satisfies it. */
export interface ComposerActions {
  open(): void;
  cancel(): void;
  setDraft(draft: string): void;
  togglePreview(): void;
  send(): Promise<void>;
}

export interface CommentComposerStore extends ComposerActions {
  getSnapshot(): ComposerState;
  subscribe(listener: () => void): () => void;
}

export interface CommentComposerOptions {
  failure?(err: unknown): string;
  /** Post the draft and RESOLVE with the comment the service stored — the
   *  authority on what the thread now holds, permalink included. */
  post(bodyMarkdown: string): Promise<IssueComment>;
  /** Put that comment in the thread it was written on. */
  onPosted(comment: IssueComment): void;
}

const REST: ComposerState = {
  open: false, draft: '', previewing: false, sending: false, failure: null, refusedDraft: null,
};

/**
 * May this draft be sent?
 *
 * An empty or whitespace-only one may not — the service refuses it with a 400,
 * and this stops a person meeting that refusal. Nor may the exact text the board
 * has already refused: that is #584's rule for this helper, that a write which
 * could never succeed must not go on inviting people to retry it. Editing the
 * draft is the way out, and it arms the control again by itself.
 */
export const canSend = (state: ComposerState): boolean =>
  state.draft.trim() !== '' && !state.sending && state.draft !== state.refusedDraft;

/**
 * Is the draft in the field the one the board refused OUTRIGHT?
 *
 * The same predicate `canSend` withholds the control on, named so the VIEW can
 * say which failure a person is in (#693 design review 5). Before this, the
 * refused state and the empty-draft state drew one appearance — a dimmed Send —
 * and the sentence that caused the refusal sat ~950px away from the only pixel
 * that differed. One reading, two callers, so the message and the control cannot
 * disagree about which failure this is.
 */
export const isRefused = (state: ComposerState): boolean =>
  state.refusedDraft !== null && state.draft === state.refusedDraft;

/** What the view says under a refusal, so "this can never send" does not have to
 *  be read off the Send button's fill. Lives here because `isRefused` decides
 *  when it is shown and the two belong together. */
export const PERMANENT_NOTE = 'Send stays off until the draft changes.';

/**
 * What the composer says where the shared failure table falls back to its
 * generic retryable sentence.
 *
 * That sentence is "Couldn\u2019t save", which is right for the eight facet writers
 * that share it and wrong beside a button that says Send — you do not save a
 * comment. Nothing else is overridden: every specific entry in that table names
 * what actually happened, and a second wording of any of them would be a second
 * copy to keep in step. It is inside `FAILURE_TEXT_BUDGET.retryable`, which the
 * spec checks against the shared constant rather than against the number.
 */
export const SEND_FAILED = 'Couldn\u2019t send it';

/**
 * What a failed send can honestly tell the person who pressed Send.
 *
 * A 400 is the board's verdict on THIS text, and the service says what is wrong
 * with it — the real number on an over-long body, the real line on a signature.
 * Restating either here would be a second copy of both, so the server's sentence
 * is what is shown, and the board's own wording answers only when a 400 arrives
 * without one (an older deploy, an ingress).
 *
 * Everything else reads `describeEditFailure`, the table every refused write on
 * this board shares, and stays retryable — including its permanent-looking
 * entries. A 403 that a person authorizes and a 503 mid-rollout both change on
 * their own, and the draft is still in the field, so the cost of offering Send
 * is one request.
 */
function readFailure(err: unknown): { text: string; permanent: boolean } {
  const answer = describeEditFailure(err);
  // The shared table's FALLBACK is the one sentence written for a different
  // write. Every specific entry it holds already says the right thing and is
  // taken unchanged.
  const board = answer === RETRYABLE ? SEND_FAILED : answer.text;
  if (!(err instanceof ApiError) || err.status !== 400) return { text: board, permanent: false };
  return { text: err.serverMessage?.trim() || board, permanent: true };
}

/**
 * The page patch that puts a just-posted comment in the thread (#693).
 *
 * `totalComments` moves with the append and is not optional. The foot of the
 * thread draws "N more comments on Github" from `totalComments - comments.length`
 * on a truncated thread, so appending a comment without it makes that line claim
 * one comment more than Github holds.
 */
export function appendComment(issue: IssueDetail, comment: IssueComment): Partial<IssueDetail> {
  return { comments: [...issue.comments, comment], totalComments: issue.totalComments + 1 };
}

/** Enough of an issue to say which one it is. */
export interface IssueName {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const sameIssue = (a: IssueName, b: IssueName) =>
  a.owner === b.owner && a.repo === b.repo && a.number === b.number;

/**
 * The patch a landed comment may make to the page — or null, because the page is
 * no longer showing the issue the comment was written on (#693, finding 7).
 *
 * `IssuePage` is not keyed and stays mounted across issue navigation; only the
 * composer is keyed, so a remount kills the DRAFT and not the request. A send
 * left in flight while somebody clicks through to the next issue therefore
 * resolves into a page showing a different thread, and appending there put #218's
 * whole conversation, plus a comment belonging to it, on #219 with a count to
 * match. No error and no warning: only navigating away cleared it.
 *
 * Two things are read at RESOLVE time rather than at send time, and both matter.
 * `showing` says which issue is on screen now — the composer's own refs are
 * frozen at unmount and cannot answer it. And the patch is built from `showing`
 * rather than from the copy the send closed over, so a comment that arrived
 * while the request was in flight is not undone by the reply to it.
 */
export function postedPatch(
  sentFor: IssueName,
  showing: IssueDetail | null,
  comment: IssueComment,
): Partial<IssueDetail> | null {
  if (!showing || !sameIssue(sentFor, showing)) return null;
  return appendComment(showing, comment);
}

/**
 * Where a just-posted comment sits on a thread the board has only part of
 * (#693, finding 10).
 *
 * A truncated thread holds the OLDEST N, so "M more comments on Github" means M
 * NEWER ones the board did not read — and a comment posted from here is the
 * newest of all. Rendered in the run above that line it is presented as older
 * than comments that predate it, and a reload puts it past the cut, where it
 * disappears. The author watches their comment land and then vanish.
 *
 * The arithmetic is untouched: the comment goes on the end of `comments` and
 * `totalComments` moves with it, so `totalComments - comments.length` still
 * names exactly the comments neither run is drawing. Only the ORDER changes.
 */
export function threadOrder(
  comments: readonly IssueComment[],
  commentsTruncated: boolean,
  postedHere: number,
): { before: IssueComment[]; after: IssueComment[] } {
  if (!commentsTruncated || postedHere <= 0) return { before: [...comments], after: [] };
  const cut = Math.max(0, comments.length - postedHere);
  return { before: comments.slice(0, cut), after: comments.slice(cut) };
}

export function createCommentComposer(opts: CommentComposerOptions): CommentComposerStore {
  let state = REST;
  const listeners = new Set<() => void>();
  // One state object, replaced only when something changes, so `getSnapshot`
  // returns a stable reference between changes — `useSyncExternalStore` compares
  // by identity and would loop otherwise.
  const emit = () => listeners.forEach((l) => l());
  const set = (next: Partial<ComposerState>) => {
    state = { ...state, ...next };
    emit();
  };
  /** Back to the muted row with an empty draft — where Cancel goes, and where a
   *  landed send goes. */
  const rest = () => {
    state = REST;
    emit();
  };

  const store: CommentComposerStore = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open() {
      if (state.open) return;
      set({ open: true });
    },
    cancel() {
      // NOT while a request is in flight (#693, finding 8). `rest()` puts
      // `sending` back to false, which is the double-submit latch itself: type,
      // Send, Cancel, reopen, retype, Send used to put two bodies on the wire and
      // call `onPosted` twice — two comments on Github from a composer somebody
      // cancelled. The reset also destroyed the second draft when the FIRST
      // request landed, and wrote a failure into a closed composer where nothing
      // renders it. There is no `AbortController` on this write and adding one
      // would not help: Github has already been asked. So the composer holds
      // still until the send it started answers.
      if (state.sending) return;
      // Otherwise nothing is kept — including a failure nobody needs to read once
      // the draft it was about is gone.
      rest();
    },
    setDraft(draft) {
      // A send in flight is about to replace the field's contents with the empty
      // one it rests to, so anything typed over it is lost with no undo (#693,
      // finding 9). The field is disabled for the same reason; this is the half
      // that holds whether or not a view remembers to draw it.
      if (state.sending) return;
      set({ draft });
    },
    togglePreview() {
      set({ previewing: !state.previewing });
    },
    async send() {
      if (!canSend(state)) return;
      const body = state.draft;
      set({ sending: true, failure: null, refusedDraft: null });
      try {
        const comment = await opts.post(body);
        rest();
        opts.onPosted(comment);
      } catch (err) {
        // The draft is NOT cleared: it is a paragraph somebody wrote, and the
        // send failing is not a reason to make them write it again.
        const { text, permanent } = readFailure(err);
        set({ sending: false, failure: opts.failure?.(err) ?? text, refusedDraft: permanent ? body : null });
      }
    },
  };
  return store;
}

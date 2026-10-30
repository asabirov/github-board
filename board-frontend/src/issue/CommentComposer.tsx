/**
 * Answering an issue from the board (#693) — the composer at the foot of the
 * thread, on the same rail a comment card hangs on.
 *
 * The shape is the one chosen from three rendered options: a quiet single-line
 * prompt that grows the editor in its place. Writing and previewing are one text
 * toggle in the footer rather than a tab strip, because at rest the composer is
 * a line and a tab strip would make it a panel.
 *
 * Nothing here renders markdown itself: the preview goes through `Markdown`, the
 * component that draws every comment in the thread above it. A second renderer
 * would agree with the thread only by coincidence, and stop agreeing the first
 * time a plugin moved.
 *
 * The state lives in `comment-composer.ts` as a framework-free store — see that
 * file for why — and this module is the React wrapper plus the markup.
 */
import { MentionField } from './MentionField';
import { Fragment, useRef, useSyncExternalStore } from 'react';
import { postIssueComment, type Actor, type IssueComment, type IssueDetail } from '../api/issues';
import { REFUSED_REASON } from '../refusal';
import type { Me } from '../use-me';
import { Avatar } from '../ui/avatar';
import { BLOCK as CARD } from '../ui/block';
import { CommentHeader, COMMENT_HEADER_ASIDE, COMMENT_HEADER_NOTE, COMMENT_PROSE } from './atoms';
import { ISSUE_CAP, issueControlVerdict } from './facet-editors';
import { Markdown } from './markdown';
import { type RepoRef } from './github-refs';
import {
  PERMANENT_NOTE,
  canSend,
  createCommentComposer,
  isRefused,
  type IssueName,
  type ComposerActions,
  type ComposerState,
  type CommentComposerStore,
} from './comment-composer';

/** A node on the thread's rail: the reader's avatar, then whatever the composer
 *  draws — the same `.iss-node` a comment card uses, so the composer sits at the
 *  same origin as the thread above it. */
function Rail({ author, children }: { author: Author; children: React.ReactNode }) {
  return (
    <div className="iss-node">
      <Avatar name={author.name} login={author.login} px={64} />
      {children}
    </div>
  );
}

function InlineFrame({ children }: { author: Author; children: React.ReactNode }) { return <Fragment>{children}</Fragment>; }

const FIELD =
  'w-full resize-y rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 text-[13.5px] leading-[1.62] ' +
  'text-fg placeholder:text-muted outline-none ' +
  'focus:bg-surface dark:focus:bg-elevated focus:border-line-strong focus:outline-none';

/**
 * The one filled control.
 *
 * Its label is `--accent-contrast`, the kit's ink for a fill of `--accent`. That
 * token follows the theme and the accent, so the label keeps its contrast on
 * every accent fill.
 */
const SEND =
  'cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-contrast ' +
  'hover:opacity-90 disabled:pointer-events-none disabled:opacity-40';

/** A quiet control: the weight the page already gives a pressable thing it does
 *  not want to shout — ReposPage's chip and ThemeSwitch both draw one this way.
 *  It sits a step above `text-muted` ON PURPOSE: the address note beside
 *  it is tertiary, and at rest the two would otherwise read as one run of grey
 *  with nothing saying which half can be pressed. */
const QUIET =
  'cursor-pointer rounded-lg px-2.5 py-1.5 text-[13px] text-dim ' +
  // AT REST, not only on hover (#693 design review 6). Everything used to live in
  // `hover:`, and Cancel survived that because it sits against the filled Send —
  // Preview does not, and its neighbour is static text at nearly the same grey,
  // so nothing said which half of that run could be pressed. The ring is the
  // page's own `--border` and is inset, so arming it moves no pixel.
  'ring-1 ring-inset ring-line ' +
  'hover:bg-elevated hover:text-fg ' +
  // Cancel is disabled while a send is in flight (#693, finding 8), and a
  // disabled control that looks pressable is the lie this whole review is
  // about. Same step Send takes when it is off.
  'disabled:pointer-events-none disabled:opacity-40';

/** The card's own left and right inset — the one the thread's comment header
 *  uses, so the composer's controls line up with the header above them. The PROSE
 *  inset is a different number and lives in `atoms.tsx`; see `COMMENT_PROSE`. */
const INSET = 'px-[18px]';

const PROMPT =
  `${CARD} block w-full cursor-pointer ${INSET} py-[13px] text-left text-[13.5px] ` +
  'text-muted hover:text-dim';

const POSTS_UNDER = 'Posts under your GitHub account';

/** What the muted row says, what the empty field repeats, and what the withheld
 *  card names as the withdrawn action. One string for all three: they are one
 *  offer — made, waiting, and not made — and a second spelling of it was two
 *  wordings to keep in step. */
const PROMPT_LABEL = 'Write a comment';

interface Author {
  name: string | null;
  login: string | null;
}

function Preview({ draft, here, editing }: { draft: string; here: RepoRef; editing?: boolean }) {
  return (
    <>
      <CommentHeader aside={<span className={COMMENT_HEADER_ASIDE}>Preview</span>}>
        {!editing && <span className={COMMENT_HEADER_NOTE}>{POSTS_UNDER}</span>}
      </CommentHeader>
      {draft.trim()
        ? (
          <div className={COMMENT_PROSE}>
            <Markdown here={here}>{draft}</Markdown>
          </div>
        )
        : <p className={`${COMMENT_PROSE} italic text-muted`}>Nothing to preview.</p>}
    </>
  );
}

/**
 * The composer's markup, drawn from one snapshot of its state.
 *
 * Split from the wiring below so the states can be rendered in a suite that has
 * no DOM: a test drives the real store and renders this from what driving it
 * produced, rather than photographing a state nothing can reach.
 */
export function ComposerView({ state, on, here, author, editing = false, participants = [] }: {
  editing?: boolean;
  state: ComposerState;
  on: ComposerActions;
  here: RepoRef;
  author: Author;
  participants?: (Actor | null)[];
}) {
  if (!state.open) {
    return (
      <Rail author={author}>
        <button type="button" onClick={on.open} className={PROMPT}>{PROMPT_LABEL}</button>
      </Rail>
    );
  }
  const Frame = editing ? InlineFrame : Rail;
  return (
    <Frame author={author}>
      {/* The card's padding is PER SECTION, not on the card: the preview's author
          line carries the thread's own divider, and a divider inside a padded box
          stops short of the edges it is meant to cross (#693 design review 3). */}
      <div className={CARD}>
        {state.previewing
          ? (
            <div className="min-h-[180px]">
              <Preview draft={state.draft} here={here} editing={editing} />
            </div>
          )
          : (
            <div className={`${INSET} pt-[18px]`}>
              <MentionField
                label={editing ? 'Edit text' : PROMPT_LABEL}
                className={FIELD} value={state.draft} placeholder={PROMPT_LABEL}
                disabled={state.sending} onChange={on.setDraft} here={here} participants={participants}
              />
            </div>
          )}
        {/* A failed send says so and changes nothing else: the draft is still in
            the field, and Send is still the way to try again — unless the board
            refused the TEXT, and then the message says so on its own line rather
            than leaving it to be read off the Send button's fill ~950px away
            (#693 design review 5). `px-2.5` is the quiet controls' own inset, so
            this text and "Preview" under it share one left edge instead of
            stacking 10px apart (design review 6). */}
        {state.failure && (
          <div className={`mt-2.5 ${INSET}`}>
            <div className="px-2.5">
              <div role="alert" className="text-[13px] leading-[1.5] text-danger">{state.failure}</div>
              {!editing && isRefused(state) && (
                <div className="mt-0.5 text-[12px] leading-[1.5] text-muted">{PERMANENT_NOTE}</div>
              )}
            </div>
          </div>
        )}
        <div className={`mt-3 flex items-center justify-between gap-3 ${INSET} pb-[18px]`}>
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" className={QUIET} onClick={on.togglePreview}>
              {state.previewing ? 'Back to writing' : 'Preview'}
            </button>
            {author.login && (
              <span className="min-w-0 truncate text-[12px] text-muted">Goes out as {author.login}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* Not while it sends (#693, finding 8) — cancelling mid-flight used
                to reset the double-submit latch and post the next draft twice. */}
            <button type="button" className={QUIET} disabled={state.sending} onClick={on.cancel}>Cancel</button>
            <button type="button" className={SEND} disabled={!canSend(state)} onClick={() => { void on.send(); }}>
              {editing ? (state.sending ? 'Saving…' : 'Save') : (state.sending ? 'Sending…' : 'Send')}
            </button>
          </div>
        </div>
      </div>
    </Frame>
  );
}

/**
 * The foot of the thread for a session whose credential cannot post.
 *
 * The action is WITHHELD, not offered and then refused: no field, no send
 * control, nothing to press. `REFUSED_REASON` names no subject (`refusal.ts`
 * argues why), so it needs one beside it or it reads as a sentence about the
 * thread — hence the withdrawn offer above it, the way `PropertyRow` sets a
 * withheld value back with the reason under it in its own line.
 *
 * `read-only` — a session that simply does not write — draws nothing at all,
 * because `REFUSED_REASON` is a statement about the board's credential and
 * nobody asked it anything on such a session.
 */
function Withheld({ author }: { author: Author }) {
  return (
    <Rail author={author}>
      <div className={`${CARD} ${INSET} py-[13px]`}>
        {/* `text-dim`, NOT `text-fg opacity-50` (#693 design
            review 2). Opacity on a text colour put the withdrawn offer at 4.5:1
            in dark and 3.57:1 in light — below the tertiary reason under it at
            5.15:1 and 6.87:1, so the thing being withheld read as less important
            than the note explaining why. `WithheldRow` in `facet-editors.tsx`
            dims a VALUE that way and can: a value is data, and the reason is the
            thing to read. Here the offer is the subject. A real token puts it
            back on top — 6.75:1 and 10.81:1 — and still a step under
            `--text`, which is what says it is withdrawn. */}
        <div className="text-[13px] leading-[1.5] text-dim">{PROMPT_LABEL}</div>
        <div className="mt-0.5 text-[12px] leading-[1.5] text-muted">{REFUSED_REASON}</div>
      </div>
    </Rail>
  );
}

/**
 * The composer as the issue page mounts it.
 *
 * It asks about its OWN write — `issue.comment`, through `issueControlVerdict`,
 * which composes `mayWrite` with the session (#635) — and never `me.canWrite`,
 * which folds in all nine issue refusals and would withdraw this composer over a
 * refused `issue.labels`.
 *
 * A landed comment is reflected into the page through `onPatch`, from what the
 * route RETURNED. Nothing is re-fetched: the service answers the write with the
 * stored comment, so a second read of the issue would cost a round trip to learn
 * what the board already holds.
 */
export function CommentComposer({ issue, me, onPosted }: {
  issue: IssueDetail;
  me: Me | null;
  /** Put the stored comment in the thread it was written on. It carries the
   *  issue the send was FOR, because by the time it resolves this component may
   *  be unmounted and the page showing something else (#693, finding 7) — only
   *  `IssuePage` can say which issue that is, and `postedPatch` is where the two
   *  are compared. */
  onPosted: (comment: IssueComment, sentFor: IssueName) => void;
}) {
  // `post`/`onPosted` close over the latest issue and callback each render; hold
  // them in refs so the store — created once — always calls the current ones.
  // They are frozen at unmount, which is exactly why neither may be trusted to
  // say which issue is on screen when a send resolves.
  const issueRef = useRef(issue);
  issueRef.current = issue;
  const postedRef = useRef(onPosted);
  postedRef.current = onPosted;

  const storeRef = useRef<CommentComposerStore>(undefined);
  if (!storeRef.current) {
    storeRef.current = createCommentComposer({
      post: (body) => {
        const { owner, repo, number } = issueRef.current;
        return postIssueComment(owner, repo, number, body);
      },
      onPosted: (comment) => {
        const { owner, repo, number } = issueRef.current;
        postedRef.current(comment, { owner, repo, number });
      },
    });
  }
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const author = { name: me?.name ?? null, login: me?.githubLogin ?? null };
  const verdict = issueControlVerdict(me, ISSUE_CAP.comment);
  if (verdict === 'read-only') return null;
  if (verdict === 'refused') return <Withheld author={author} />;
  return <ComposerView state={state} on={store} here={issue} author={author} participants={[issue.author, ...issue.assignees, ...issue.comments.map(comment => comment.author)]} />;
}

import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ApiError } from '../api/core';
import { editIssueText, type IssueDetail } from '../api/issues';
import { ComposerView } from './CommentComposer';
import { createCommentComposer, type CommentComposerStore } from './comment-composer';

export function EditableText({ issue, body, commentId, canEdit, onSaved, children }: {
  issue: IssueDetail;
  body: string;
  commentId?: number;
  canEdit?: boolean;
  onSaved(body: string): void;
  children(control: ReactNode, editor: ReactNode): ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [store, setStore] = useState<CommentComposerStore | null>(null);
  const finish = () => { setStore(null); requestAnimationFrame(() => trigger.current?.focus()); };
  const open = () => {
    const next = createCommentComposer({
      failure: err => {
        if (err instanceof ApiError && [400, 403, 404, 409].includes(err.status)) {
          return err.serverMessage || 'Could not save. Your draft is kept.';
        }
        return 'Could not save to GitHub. Your draft is kept. Try again.';
      },
      post: async draft => {
        const saved = await editIssueText(issue.owner, issue.repo, issue.number, draft, body, commentId);
        return { ...saved, author: null, createdAt: '', htmlUrl: null };
      },
      onPosted: saved => { onSaved(saved.bodyMarkdown); finish(); },
    });
    next.open(); next.setDraft(body); setStore(next);
  };
  return children(canEdit && <button ref={trigger} type="button" aria-label={commentId === undefined ? 'Edit issue body' : 'Edit comment'}
    className="ml-2 cursor-pointer rounded px-2 py-1 text-[13px] text-dim hover:bg-elevated focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none"
    onClick={open} disabled={store !== null}>Edit</button>, store && <Editor store={store} issue={issue} cancel={finish} />);
}

function Editor({ store, issue, cancel }: { store: CommentComposerStore; issue: IssueDetail; cancel(): void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <ComposerView editing state={state} on={{ ...store, cancel: () => { if (!state.sending) { store.cancel(); cancel(); } } }} here={issue} participants={[issue.author, ...issue.assignees, ...issue.comments.map(comment => comment.author)]} author={{ name: null, login: null }} />;
}

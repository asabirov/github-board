import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommentComposer, ComposerView } from './CommentComposer';
import {
  PERMANENT_NOTE,
  SEND_FAILED,
  appendComment,
  createCommentComposer,
  isRefused,
  postedPatch,
  threadOrder,
} from './comment-composer';
import { COMMENT_HEADER, COMMENT_HEADER_NOTE as HEADER_NOTE, COMMENT_PROSE } from './atoms';
import { failureTextBudget } from './use-facet-edit';
import { ApiError } from '../api/core';
import { postIssueComment, type IssueComment, type IssueDetail } from '../api/issues';
import { REFUSED_REASON } from '../refusal';
import { meFixture } from '../me-fixture';

// #693 — the composer at the foot of the thread. The suite has no DOM, so
// the behaviour is driven through the composer's own
// framework-free store — the shape `use-facet-edit.ts` already uses for exactly
// this reason — and the markup is rendered FROM the snapshot that driving
// produced. A picture of a state nothing can reach would prove nothing.

afterEach(() => vi.unstubAllGlobals());

const POSTED: IssueComment = {
  author: { login: 'octocat', name: 'Octocat' },
  bodyMarkdown: 'Confirmed — see #123.',
  createdAt: '2026-08-30T09:00:00Z',
  htmlUrl: 'https://github.com/acme/board.example.com/issues/218#issuecomment-9',
};

const EARLIER: IssueComment = {
  author: { login: 'anton', name: 'Anton' },
  bodyMarkdown: 'Raised the cap.',
  createdAt: '2026-08-26T09:00:00Z',
  htmlUrl: null,
};

/** A comment that arrives while a send is in flight — the refresh finding 7's
 *  patch must not undo. */
const LATER: IssueComment = {
  author: { login: 'IvanRoslov', name: 'Ivan Roslov' },
  bodyMarkdown: 'Verified on the live service.',
  createdAt: '2026-08-28T09:00:00Z',
  htmlUrl: null,
};

function issueFixture(over: Partial<IssueDetail> = {}): IssueDetail {
  return {
    owner: 'acme',
    repo: 'board.example.com',
    number: 218,
    title: "Board deploy didn't fire on merge",
    state: 'open',
    htmlUrl: 'https://github.com/acme/board.example.com/issues/218',
    author: { login: 'IvanRoslov', name: 'Ivan Roslov' },
    createdAt: '',
    updatedAt: '',
    bodyMarkdown: '',
    labels: [],
    assignees: [],
    milestone: null,
    issueType: null,
    relations: { parent: null, subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0, blockedBy: [], blocking: [] },
    linkedPrs: [],
    comments: [EARLIER],
    // Github says 4 while the page holds 1: the thread is truncated, and the
    // "N more comments on Github" line at the foot is `total - shown`. A comment
    // appended without moving `total` makes that line read one too many.
    totalComments: 4,
    commentsTruncated: true,
    projects: [],
    ...over,
  };
}

const AUTHOR = { name: 'Octocat', login: 'octocat', email: 'octocat@example.com' };

/** A composer wired to an injected `post`, so a test can hold a send open, fail
 *  it, or land it, without a network. */
function composer(post: (body: string) => Promise<IssueComment>, onPosted: (c: IssueComment) => void = () => {}) {
  return createCommentComposer({ post, onPosted });
}

function view(store: ReturnType<typeof composer>) {
  return renderToStaticMarkup(
    <ComposerView state={store.getSnapshot()} on={store} here={issueFixture()} author={AUTHOR} />,
  );
}

/** The `<button>` whose visible label is `label`, or null. There are no test
 *  hooks in this markup and this is not a reason to add any. */
function button(html: string, label: string): string | null {
  const m = html.match(new RegExp(`<button[^>]*>${label}</button>`));
  return m ? m[0] : null;
}

/** Is that button disabled? The ATTRIBUTE, never the substring: the send
 *  control's class list carries `disabled:opacity-40`, so `toContain('disabled')`
 *  passes on a button that is perfectly pressable. It did, on the first run of
 *  this file. */
function disabled(html: string, label: string): boolean {
  const b = button(html, label);
  expect(b, `no <button> labelled ${label}`).not.toBeNull();
  return /<button[^>]*\sdisabled=""/.test(b as string);
}

/** A composer whose route answers `status` with `body` — the real `postIssueComment`
 *  over a stubbed fetch, so the failure vocabulary is read off the wire and not
 *  from a hand-built ApiError. */
function refusing(status: number, body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
  );
  return composer((draft) => postIssueComment('acme', 'board.example.com', 218, draft));
}

describe('the muted row, and opening it (#693)', () => {
  it('rests as ONE row that reads like a prompt — no field, no send control', () => {
    const html = view(composer(async () => POSTED));
    expect(html).toContain('Write a comment');
    expect(html).not.toContain('<textarea');
    expect(button(html, 'Send')).toBeNull();
  });

  it('grows the editor in its place when the row is opened', () => {
    const store = composer(async () => POSTED);
    store.open();
    const html = view(store);
    expect(html).toContain('<textarea');
    expect(button(html, 'Cancel')).not.toBeNull();
    expect(button(html, 'Send')).not.toBeNull();
    expect(button(html, 'Preview')).not.toBeNull();
  });

  it('puts the row’s OWN line in the empty field — one wording, not two', () => {
    const store = composer(async () => POSTED);
    store.open();
    const html = view(store);
    expect(html).toContain('placeholder="Write a comment"');
    expect(html).not.toContain('Leave a comment');
  });

  it('Cancel returns to the muted row and discards the draft', () => {
    const store = composer(async () => POSTED);
    store.open();
    store.setDraft('half a thought');
    store.cancel();
    expect(store.getSnapshot()).toMatchObject({ open: false, draft: '' });
    expect(view(store)).not.toContain('half a thought');
  });

  it('previews the draft through the thread’s own renderer, and toggles back', () => {
    const store = composer(async () => POSTED);
    store.open();
    store.setDraft('Confirmed — see `main`.');
    store.togglePreview();
    const html = view(store);
    // `<code>` is the renderer's work, not the composer's: a second renderer
    // would have to reproduce it by coincidence.
    expect(html).toContain('<code>main</code>');
    expect(button(html, 'Back to writing')).not.toBeNull();
  });
});

describe('the GitHub account the comment goes out under (#1376)', () => {
  it('names the signed-in GitHub login in the editor’s footer, in the tense of a thing not yet done', () => {
    const store = composer(async () => POSTED);
    store.open();
    const html = view(store);
    expect(html).toContain('Goes out as octocat');
    // Nothing has been posted at the moment this line is read.
    expect(html).not.toContain('Posted as');
  });

  it('reads as a fact and not as a control, beside the toggle it sits next to', () => {
    const store = composer(async () => POSTED);
    store.open();
    const html = view(store);
    const note = html.match(/<span class="([^"]*)">Goes out as /);
    expect(note, 'no address note in the footer').not.toBeNull();
    const toggle = button(html, 'Preview') as string;
    // At REST the two must differ, so the pressable half is legible without
    // hovering it: the toggle takes the page's quiet-control weight (ReposPage's
    // chip, ThemeSwitch), the note stays at the tertiary weight of a note.
    expect(toggle).toContain('text-dim');
    expect(toggle).toContain('hover:bg-elevated');
    expect(note![1]).toContain('text-muted');
    expect(note![1]).not.toContain('hover:');
    // Cancel is the same control as the toggle and carries the same treatment.
    expect(button(html, 'Cancel')).toContain('text-dim');
  });

  it('says nothing about an address on the muted row', () => {
    expect(view(composer(async () => POSTED))).not.toContain('octocat@example.com');
  });

  it('sends the draft byte for byte — no signature is added in the browser', async () => {
    const post = vi.fn(async () => POSTED);
    const store = composer(post);
    store.open();
    store.setDraft('Confirmed — see #123.');
    await store.send();
    expect(post).toHaveBeenCalledWith('Confirmed — see #123.');
  });

  it('keeps the address out of the FIELD, which stays the author’s own markdown', () => {
    const store = composer(async () => POSTED);
    store.open();
    store.setDraft('Confirmed.');
    // Written where the person types, the line would be theirs to delete — and
    // deleting it is what the service's ordering exists to make impossible.
    expect(view(store)).toContain('<textarea');
    expect(view(store)).not.toContain('via the board');
    expect(store.getSnapshot().draft).toBe('Confirmed.');
  });
});

describe('sending a draft (#693)', () => {
  it('posts once — the thread is not re-read afterwards', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(POSTED), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = composer((body) => postIssueComment('acme', 'board.example.com', 218, body));
    store.open();
    store.setDraft('Confirmed — see #123.');
    await store.send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/issues/acme/board.example.com/218/comment');
  });

  it('hands the posted comment on, then rests back at the empty muted row', async () => {
    const landed: IssueComment[] = [];
    const store = composer(async () => POSTED, (c) => landed.push(c));
    store.open();
    store.setDraft('Confirmed — see #123.');
    await store.send();
    expect(landed).toEqual([POSTED]);
    expect(store.getSnapshot()).toMatchObject({ open: false, draft: '', sending: false, failure: null });
  });

  it('appends it to the thread it was written on, and moves the count with it', () => {
    const issue = issueFixture();
    expect(appendComment(issue, POSTED)).toEqual({
      comments: [EARLIER, POSTED],
      totalComments: 5,
    });
  });

  it('disables the send control while the post is in flight, and says so', async () => {
    let land: (c: IssueComment) => void = () => {};
    const store = composer(() => new Promise<IssueComment>((ok) => { land = ok; }));
    store.open();
    store.setDraft('Confirmed.');
    const sent = store.send();
    const html = view(store);
    expect(disabled(html, 'Sending…')).toBe(true);
    expect(button(html, 'Send')).toBeNull();
    land(POSTED);
    await sent;
  });

  it('will not send an empty or whitespace-only draft', () => {
    const store = composer(async () => POSTED);
    store.open();
    expect(disabled(view(store), 'Send')).toBe(true);
    store.setDraft('   \n\t ');
    expect(disabled(view(store), 'Send')).toBe(true);
    store.setDraft('x');
    expect(disabled(view(store), 'Send')).toBe(false);
  });

  it('sends nothing at all when the draft is whitespace, whoever calls send', async () => {
    const post = vi.fn(async () => POSTED);
    const store = composer(post);
    store.open();
    store.setDraft('   ');
    await store.send();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('a send that fails (#693)', () => {
  it('keeps the editor open with the draft still in it, and says it did not send', async () => {
    const store = composer(async () => { throw new ApiError(502, 'boom'); });
    store.open();
    store.setDraft('A paragraph nobody wants to retype.');
    await store.send();
    expect(store.getSnapshot()).toMatchObject({ open: true, draft: 'A paragraph nobody wants to retype.', sending: false });
    const html = view(store);
    expect(html).toContain('A paragraph nobody wants to retype.');
    expect(html).toContain('Couldn’t reach GitHub');
    expect(disabled(html, 'Send')).toBe(false);
  });

  it('says “send” where the shared table falls back to “save”', async () => {
    // The generic retryable sentence is written for eight facet writers, and you
    // do not save a comment. Only that fallback is overridden.
    const store = composer(async () => { throw new Error('the request never arrived'); });
    store.open();
    store.setDraft('x');
    await store.send();
    const html = view(store);
    expect(html).toContain('Couldn’t send it');
    expect(html).not.toContain('Couldn’t save');
  });

  it('the override fits the budget the shared table is held to', () => {
    expect(SEND_FAILED.length).toBeLessThanOrEqual(failureTextBudget({ canRetry: true }));
  });

  it('takes a specific sentence from the shared table unchanged', async () => {
    const store = composer(async () => { throw new ApiError(404, 'no', 'not-found'); });
    store.open();
    store.setDraft('x');
    await store.send();
    expect(view(store)).toContain('Not found on GitHub');
  });

  it('says what the refusal was, in the words every other refused write uses', async () => {
    const store = composer(async () => { throw new ApiError(403, 'no', 'not-permitted'); });
    store.open();
    store.setDraft('x');
    await store.send();
    expect(view(store)).toContain(REFUSED_REASON);
  });

  it('clears the failure the moment another send starts', async () => {
    let attempt = 0;
    const store = composer(async () => {
      if (++attempt === 1) throw new ApiError(502, 'boom');
      return POSTED;
    });
    store.open();
    store.setDraft('x');
    await store.send();
    expect(store.getSnapshot().failure).not.toBeNull();
    await store.send();
    expect(store.getSnapshot()).toMatchObject({ open: false, failure: null });
  });
});

describe('a refusal of the TEXT, which no retry can survive (#693)', () => {
  // The board signs every comment it posts, and refuses a body that has typed
  // that signature itself — a 400 whose message says what is wrong. Pressing
  // Send again cannot change the answer, so the composer stops offering it until
  // the draft changes. That is #584's rule for this helper: a write that could
  // never succeed must not go on inviting people to retry it.
  const REFUSAL = 'A comment may not end with the board’s signature line.';

  it('carries the server’s own sentence off the wire', async () => {
    refusing(400, { message: REFUSAL, reason: 'wrong-value' });
    const err = await postIssueComment('acme', 'board.example.com', 218, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.serverMessage).toBe(REFUSAL);
  });

  it('says that sentence rather than a second wording of the same rule', async () => {
    const store = refusing(400, { message: REFUSAL, reason: 'wrong-value' });
    store.open();
    store.setDraft('— board@example.com via the board');
    await store.send();
    expect(view(store)).toContain(REFUSAL);
  });

  it('stops offering Send for the text that was refused', async () => {
    const store = refusing(400, { message: REFUSAL });
    store.open();
    store.setDraft('— board@example.com via the board');
    await store.send();
    expect(disabled(view(store), 'Send')).toBe(true);
  });

  it('offers it again the moment the draft changes', async () => {
    const store = refusing(400, { message: REFUSAL });
    store.open();
    store.setDraft('— board@example.com via the board');
    await store.send();
    store.setDraft('Confirmed.');
    expect(disabled(view(store), 'Send')).toBe(false);
  });

  it('leaves Send offered on a failure that another press could survive', async () => {
    const store = refusing(503, { message: 'writes are off right now' });
    store.open();
    store.setDraft('Confirmed.');
    await store.send();
    expect(disabled(view(store), 'Send')).toBe(false);
  });

  it('falls back to the board’s own wording when a 400 carries no sentence', async () => {
    const store = refusing(400, {});
    store.open();
    store.setDraft('Confirmed.');
    await store.send();
    expect(view(store)).toContain('GitHub doesn’t allow that');
  });
});

describe('the composer a session cannot post with (#693)', () => {
  const render = (me: Parameters<typeof CommentComposer>[0]['me']) =>
    renderToStaticMarkup(<CommentComposer issue={issueFixture()} me={me} onPosted={() => {}} />);

  it('is offered when the capability is not refused', () => {
    const html = render(meFixture({ writesEnabled: true, capabilities: { 'issue.comment': 'unknown' } }));
    // `Write a comment` is PROMPT_LABEL, which the withheld card draws too — so
    // asserting it alone passes on a composer that was withdrawn (#693, finding
    // 11). What only the OFFER draws is a pressable row and no reason beside it.
    expect(button(html, 'Write a comment')).not.toBeNull();
    expect(html).not.toContain(REFUSED_REASON);
  });

  it('is WITHHELD — not offered and refused — when the board’s credential was told no', () => {
    const html = render(meFixture({ writesEnabled: true, capabilities: { 'issue.comment': 'refused' } }));
    expect(html).not.toContain('<textarea');
    expect(html).toContain(REFUSED_REASON);
    // A withheld composer says nothing about an address either: there is no
    // comment going out, so there is nothing for one to be signed with.
    expect(html).not.toContain('stranger@example.com');
  });

  it('a refusal on ANOTHER capability leaves it armed (#635)', () => {
    const me = meFixture({ writesEnabled: true, capabilities: { 'issue.labels': 'refused', 'issue.comment': 'available' } });
    const html = render(me);
    expect(button(html, 'Write a comment')).not.toBeNull();
    expect(html).not.toContain(REFUSED_REASON);
  });

  it('draws nothing at all for a session that does not write', () => {
    expect(render(meFixture({ writesEnabled: false }))).toBe('');
    expect(render(null)).toBe('');
  });
});

describe('the preview is the comment before it posts (#693 design review 1 and 3)', () => {
  const DRAFT = 'Confirmed — the deploy job never ran.';

  /** The preview markup for a draft, with the composer toggled into it. */
  function previewing(draft = DRAFT): string {
    const store = composer(async () => POSTED);
    store.open();
    store.setDraft(draft);
    store.togglePreview();
    return view(store);
  }

  it('previews the personal comment without a board signature', () => {
    const html = previewing();
    expect(html).not.toContain('via the board');
    expect(html).toContain('<p>Confirmed — the deploy job never ran.</p>');
    expect(html).toContain('Posts under your GitHub account');
  });

  it('says nothing at all when there is nothing to preview', () => {
    // A signature over an empty draft would be a preview of a comment that cannot
    // be sent — `canSend` withholds Send on a blank draft.
    const html = previewing('   ');
    expect(html).toContain('Nothing to preview.');
    expect(html).not.toContain('via the board');
  });

  it('carries the header strip and divider every posted comment carries', () => {
    // Drawn from the pieces `IssuePage`'s comment card uses — one header, one
    // divider, one prose inset — so a preview cannot look like something the
    // thread never draws.
    const html = previewing();
    expect(html).toContain(COMMENT_HEADER);
    expect(html).toContain(HEADER_NOTE);
  });

  it('describes personal-account posting in the header', () => {
    const html = previewing();
    expect(html).not.toContain('>Octocat</a>');
    expect(html).not.toContain('href="https://github.com/octocat"');
  });

  it('keeps the posting note muted without repeating an email', () => {
    const html = previewing();
    const header = html.slice(html.indexOf(COMMENT_HEADER), html.indexOf(COMMENT_PROSE));
    expect(header).not.toContain('octocat@example.com');
    expect(HEADER_NOTE).toContain('text-muted');
    expect(HEADER_NOTE).toContain('font-normal');
  });

  it('insets the prose where a POSTED comment insets it, not where the header is', () => {
    // The card was 2px misaligned with itself: the header sits at `px-[18px]` and
    // posted prose at `px-5`, so preview prose 18px in never lined up with the
    // paragraph it was previewing. The preview follows the PROSE.
    const html = previewing();
    expect(COMMENT_PROSE).toContain('px-5');
    expect(html).toContain(COMMENT_PROSE);
  });

  it('says it has not posted, where a posted comment says when it did', () => {
    // The card now looks exactly like one that landed. The one thing it must not
    // borrow is a timestamp: nothing has happened yet.
    const html = previewing();
    expect(html).toContain('Preview');
    expect(html).not.toContain('just now');
  });

  it('leaves the field and submitted draft unchanged', () => {
    const store = composer(async () => POSTED);
    store.open();
    store.setDraft(DRAFT);
    store.togglePreview();
    store.togglePreview();
    expect(store.getSnapshot().draft).toBe(DRAFT);
    expect(view(store)).not.toContain('via the board');
  });
});

// ── the three shipping bugs the staff review found (#693) ────────────────────

describe('a send in flight and the controls around it (#693, findings 8 and 9)', () => {
  /** A send that never settles, plus the bodies it was asked to post. */
  function held() {
    const posts: string[] = [];
    const store = composer((body) => { posts.push(body); return new Promise<IssueComment>(() => {}); });
    return { store, posts };
  }

  it('refuses Cancel while the request is in flight, so the latch cannot be broken', async () => {
    const { store, posts } = held();
    store.open();
    store.setDraft('First.');
    void store.send();
    store.cancel();
    // Still open, still sending — Cancel did not reset the composer under the
    // request. Pressing Send again cannot put a second body on the wire.
    expect(store.getSnapshot()).toMatchObject({ open: true, sending: true, draft: 'First.' });
    await store.send();
    expect(posts).toEqual(['First.']);
  });

  it('says so on the control: Cancel is disabled while it sends', () => {
    const { store } = held();
    store.open();
    store.setDraft('First.');
    void store.send();
    expect(disabled(view(store), 'Cancel')).toBe(true);
  });

  it('will not take a second paragraph while the first is in flight', () => {
    const { store } = held();
    store.open();
    store.setDraft('First para.');
    void store.send();
    store.setDraft('First para.\n\nSecond para.');
    expect(store.getSnapshot().draft).toBe('First para.');
  });

  it('says that on the field too, rather than swallowing what is typed', () => {
    const { store } = held();
    store.open();
    store.setDraft('First para.');
    void store.send();
    expect(/<textarea[^>]*\sdisabled=""/.test(view(store))).toBe(true);
  });
});

describe('a send that resolves after the page moved on (#693, finding 7)', () => {
  it('lands on the issue it was written on', () => {
    const on218 = issueFixture();
    expect(postedPatch(on218, on218, POSTED)).toEqual({
      comments: [EARLIER, POSTED], totalComments: 5,
    });
  });

  it('is DROPPED when the page is showing another issue', () => {
    const on218 = issueFixture();
    const on219 = issueFixture({ number: 219, comments: [], totalComments: 0, commentsTruncated: false });
    expect(postedPatch(on218, on219, POSTED)).toBeNull();
  });

  it('is dropped when the page is showing nothing at all', () => {
    expect(postedPatch(issueFixture(), null, POSTED)).toBeNull();
  });

  it('is built from the thread ON SCREEN, never from the copy the send closed over', () => {
    // The send closed over a thread with one comment. Another arrived while it
    // was in flight. The patch must carry both, or the refresh is undone.
    const sentOn = issueFixture();
    const now = issueFixture({ comments: [EARLIER, LATER], totalComments: 5 });
    expect(postedPatch(sentOn, now, POSTED)).toEqual({
      comments: [EARLIER, LATER, POSTED], totalComments: 6,
    });
  });
});

describe('where a just-posted comment sits on a truncated thread (#693, finding 10)', () => {
  const shown = [EARLIER, LATER];

  it('leaves an untruncated thread in one run', () => {
    expect(threadOrder(shown, false, 0)).toEqual({ before: shown, after: [] });
  });

  it('leaves an untruncated thread in one run even after posting', () => {
    expect(threadOrder([...shown, POSTED], false, 1)).toEqual({ before: [...shown, POSTED], after: [] });
  });

  it('puts a just-posted comment AFTER the truncation line — it is the newest of all', () => {
    expect(threadOrder([...shown, POSTED], true, 1)).toEqual({ before: shown, after: [POSTED] });
  });

  it('keeps a truncated thread untouched when nothing was posted here', () => {
    expect(threadOrder(shown, true, 0)).toEqual({ before: shown, after: [] });
  });
});

describe('a draft the board can never accept says so beside the message (#693, finding 5)', () => {
  it('is not refused while nothing has failed', () => {
    const store = composer(async () => POSTED);
    store.open();
    store.setDraft('Confirmed.');
    expect(isRefused(store.getSnapshot())).toBe(false);
  });

  it('is refused after a 400 on this exact text, and says so under the message', async () => {
    const store = refusing(400, { message: 'That carries the board’s own signature line.' });
    store.open();
    store.setDraft('— board@example.com via the board');
    await store.send();
    expect(isRefused(store.getSnapshot())).toBe(true);
    expect(view(store)).toContain(PERMANENT_NOTE);
  });

  it('is not refused after a failure another press could survive', async () => {
    const store = refusing(503, { message: 'writes are off right now' });
    store.open();
    store.setDraft('Confirmed.');
    await store.send();
    expect(isRefused(store.getSnapshot())).toBe(false);
    expect(view(store)).not.toContain(PERMANENT_NOTE);
  });

  it('re-arms the moment the draft moves', async () => {
    const store = refusing(400, { message: 'nope' });
    store.open();
    store.setDraft('— board@example.com via the board');
    await store.send();
    store.setDraft('Confirmed.');
    expect(isRefused(store.getSnapshot())).toBe(false);
  });
});

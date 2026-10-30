import { describe, it, expect, vi } from 'vitest';
import { createFacetEdit, describeEditFailure, failureTextBudget } from './use-facet-edit';
import { ApiError, safeAuthorizeUrl } from '../api/core';
import { REFUSED_REASON } from '../refusal';
import type { RefusalReason } from '../refusal';
import { reason } from '../ui/CloseIssueAlert';

// The board's test env is `node` (no DOM), and there's no @testing-library, so —
// as with use-viewer-state — we drive the pure store the hook wraps rather than
// render the hook. The store IS the state machine; the hook is a thin
// useSyncExternalStore wrapper over it, so this locks every observable behavior
// the plan's renderHook test asserts: B2 reconcile-to-returned, rollback, retry.

describe('createFacetEdit (#384)', () => {
  it('reconciles to the returned value on success (coercion), rolls back on failure, retries', async () => {
    // GitHub coerces: we request ['a','ghost'] but it stores only ['a'].
    const commit = vi
      .fn<(next: string[]) => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(['a']); // authoritative returned value
    const apply = vi.fn();
    const store = createFacetEdit<string[]>({ initial: ['a'], commit, apply });

    await store.edit(['a', 'ghost']);
    expect(store.value).toEqual(['a']); // rolled back to prior
    expect(store.status).toBe('error');
    expect(apply).not.toHaveBeenCalled(); // no reflection on failure

    await store.retry();
    expect(store.value).toEqual(['a']); // snapped to RETURNED value, not the requested ['a','ghost']
    expect(apply.mock.calls.at(-1)?.[0]).toEqual(['a']);
    expect(store.status).toBe('idle');
  });

  it('shows the optimistic value while saving, then the server truth', async () => {
    let resolve!: (v: string[]) => void;
    const commit = vi.fn(() => new Promise<string[]>((r) => (resolve = r)));
    const apply = vi.fn();
    const store = createFacetEdit<string[]>({ initial: ['a'], commit, apply });

    const pending = store.edit(['a', 'ghost']);
    expect(store.status).toBe('saving');
    expect(store.value).toEqual(['a', 'ghost']); // optimistic, in flight

    resolve(['a']); // server drops the non-assignable login
    await pending;
    expect(store.status).toBe('idle');
    expect(store.value).toEqual(['a']); // reconciled to server truth
    expect(apply.mock.calls[0]?.[0]).toEqual(['a']);
  });

  it('reset absorbs an external change only while idle', () => {
    const commit = vi.fn(async (v: string) => v);
    const store = createFacetEdit<string>({ initial: 'C4', commit, apply: () => {} });
    store.reset('C5');
    expect(store.value).toBe('C5'); // idle → absorbed
  });
});

describe('one refusal sentence, one declaration (#635 design review 7)', () => {
  // Three surfaces say these words: a write that comes back refused, a control
  // withheld before it is pressed, and the feedback form. They were three typed
  // copies, so rewording the failure table left the withheld row saying the old
  // thing with nothing failing. `refusal.ts` holds the one declaration — it is
  // already where the vocabulary both sides read lives.
  it('a refused write says exactly what a withheld control says', () => {
    expect(describeEditFailure(new ApiError(403, 'x', 'not-permitted')).text).toBe(REFUSED_REASON);
  });
});

describe('describeEditFailure — telling a person whether Retry could help (#577)', () => {
  it('says the session ended, and does not offer a retry that cannot fix it', () => {
    // Short on purpose: the app already shows a full-width banner with a Sign
    // in button, so the tile only has to connect a reader to it.
    expect(describeEditFailure(new ApiError(401, 'unauthenticated'))).toEqual({
      text: 'Your session ended',
      canRetry: false,
    });
  });

  it('puts the blame on the tool, not the reader, when permission is the problem', () => {
    expect(describeEditFailure(new ApiError(403, 'set dri 403'))).toEqual({
      text: 'The board isn’t allowed',
      canRetry: false,
    });
    // 404 is how Github answers a token missing the scope for a write (#577) —
    // the same refusal wearing a different number.
    expect(describeEditFailure(new ApiError(404, 'set dri 404'))).toEqual({
      text: 'The board isn’t allowed',
      canRetry: false,
    });
  });

  it('separates a value Github would not take from a permission it would not give', () => {
    // The SUBJECT carries the distinction — Github rejecting what you picked,
    // versus the board not being allowed to ask. A reader cannot see a verb
    // change while the subject stays put.
    for (const status of [400, 422]) {
      expect(describeEditFailure(new ApiError(status, `x ${status}`))).toEqual({
        text: 'GitHub doesn’t allow that',
        canRetry: false,
      });
    }
  });

  it('keeps a retry for a 503, which in practice is a rollout rather than the flag', () => {
    // `/auth/me` folds GITHUB_WRITE_ENABLED into `canWrite`, so a switched-off
    // flag never draws this control at all. A 503 that reaches a tile is an
    // ingress answering mid-deploy — over in seconds, and Retry is the fix.
    expect(describeEditFailure(new ApiError(503, 'x 503'))).toEqual({
      text: 'Can’t save right now',
      canRetry: true,
    });
  });

  it('separates a Github the board could not reach from a refusal, and keeps its retry', () => {
    // 502 is what this board answers when Github could not be reached — either
    // to make the write, or to read the settings the write is gated on. Neither
    // says anything about permission, and both may work on the next press.
    expect(describeEditFailure(new ApiError(502, 'x 502'))).toEqual({
      text: 'Couldn’t reach GitHub',
      canRetry: true,
    });
  });

  it('keeps the retryable failure — and only that one — offering a retry', () => {
    // A server fault or a dropped connection is the one case where pressing the
    // button again is a sensible thing to do.
    expect(describeEditFailure(new ApiError(500, 'x 500'))).toEqual({
      text: 'Couldn’t save',
      canRetry: true,
    });
    expect(describeEditFailure(new TypeError('Failed to fetch'))).toEqual({
      text: 'Couldn’t save',
      canRetry: true,
    });
  });
});

describe('createFacetEdit — carrying the reason, not just the fact (#577)', () => {
  it('exposes why the write failed, and clears it on the next attempt', async () => {
    const commit = vi
      .fn<(next: string) => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(403, 'set dri 403'))
      .mockResolvedValueOnce('b');
    const store = createFacetEdit<string>({ initial: 'a', commit, apply: vi.fn() });

    await store.edit('b');
    expect(store.status).toBe('error');
    expect(store.failure).toEqual({ text: 'The board isn’t allowed', canRetry: false });

    await store.retry();
    expect(store.status).toBe('idle');
    expect(store.failure).toBeNull();
  });

  it('puts the reason in the snapshot the view subscribes to', async () => {
    const commit = vi.fn(async () => {
      throw new ApiError(503, 'x 503');
    });
    const store = createFacetEdit<string>({ initial: 'a', commit, apply: vi.fn() });

    await store.edit('b');

    expect(store.getSnapshot().failure).toEqual({ text: 'Can’t save right now', canRetry: true });
  });
});

describe('createFacetEdit — a failure must not be a dead end (#577 round 2)', () => {
  const permanently = () =>
    createFacetEdit<string>({
      initial: 'a',
      commit: async () => {
        throw new ApiError(403, 'set dri 403');
      },
      apply: vi.fn(),
    });

  it('dismiss() puts a non-retryable failure back to the value that survived it', async () => {
    // A failure with no Retry withholds the only control that could call back
    // into the store, so without this the surface is dead for the session.
    const store = permanently();
    await store.edit('b');
    expect(store.status).toBe('error');

    store.dismiss();

    expect(store.status).toBe('idle');
    expect(store.failure).toBeNull();
    expect(store.value).toBe('a');
    expect(store.getSnapshot()).toEqual({ value: 'a', status: 'idle', failure: null });
  });

  it('a dismissed failure leaves the store editable again', async () => {
    const commit = vi
      .fn<(next: string) => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(403, 'set dri 403'))
      .mockResolvedValueOnce('c');
    const store = createFacetEdit<string>({ initial: 'a', commit, apply: vi.fn() });

    await store.edit('b');
    store.dismiss();
    await store.edit('c');

    expect(store.value).toBe('c');
    expect(store.status).toBe('idle');
  });

  it('dismiss() on a store that never failed changes nothing', () => {
    const store = createFacetEdit<string>({ initial: 'a', commit: async (v) => v, apply: vi.fn() });
    const before = store.getSnapshot();
    store.dismiss();
    expect(store.getSnapshot()).toBe(before);
  });

  it('a refetch leaves a failure standing — only a person clears it', async () => {
    // This used to clear the error, on the reasoning that a refetch is new
    // information. It is not new information about the write: the poll runs
    // every 120s, so a refused write could erase itself before anyone saw it,
    // leaving the old value on screen and no trace it was refused. `dismiss`
    // and `retry` are the ways out, and both are somebody deciding.
    const store = permanently();
    await store.edit('b');

    store.reset('z');

    expect(store.status).toBe('error');
    expect(store.failure).not.toBeNull();
    expect(store.value).toBe('a');
  });

  it('answers a refetch the same way for an object value and a primitive one', async () => {
    // The hook resets when `initial` changes IDENTITY, so a new object arrives
    // on every refetch and a string usually does not. While `reset` cleared
    // errors, that made the note vanish on assignees and labels and stay on
    // state and milestone — a rule nobody could predict from the surface.
    const seen: { label: string; status: string }[] = [];
    for (const [label, initial, next] of [
      ['object', { login: 'a' }, { login: 'a' }],
      ['primitive', 'a', 'a'],
    ] as const) {
      const store = createFacetEdit<unknown>({
        initial,
        commit: async () => {
          throw new ApiError(403, 'refused');
        },
        apply: vi.fn(),
      });
      await store.edit('b');
      store.reset(next); // a fresh object, or an equal string
      seen.push({ label, status: store.status });
    }
    expect(seen).toEqual([
      { label: 'object', status: 'error' },
      { label: 'primitive', status: 'error' },
    ]);
  });

  it('an external change still never clobbers an edit in flight', async () => {
    let settle!: (v: string) => void;
    const store = createFacetEdit<string>({
      initial: 'a',
      commit: () => new Promise<string>((r) => (settle = r)),
      apply: vi.fn(),
    });

    const pending = store.edit('b');
    store.reset('z');

    expect(store.status).toBe('saving');
    expect(store.value).toBe('b');
    settle('b');
    await pending;
  });
});

// #584 — the two halves of the same defect, pinned together because they are
// fixed in one commit: the writers now reject with a status (api.spec.ts), and
// these are the two readings of that status a person actually sees.
describe('a refusal is read as a refusal (#584)', () => {
  it('a permanent refusal is described as permanent, not as Couldn’t save', () => {
    const f = describeEditFailure(new ApiError(403, 'issue-write 403'));
    expect(f.canRetry).toBe(false);
    expect(f.text).toBe('The board isn’t allowed');
    // …and it still fits the surface it renders on.
    expect(f.text.length).toBeLessThanOrEqual(failureTextBudget(f));
  });

  it('an unrecognised status is still retryable (the safe end of the guess)', () => {
    // The fallback is deliberate: widening the status table without this would
    // let a later edit turn an unknown failure permanent, which withholds an
    // action that would have worked.
    expect(describeEditFailure(new ApiError(500, 'issue-write 500')).canRetry).toBe(true);
  });
});

// The other half of task 1's REFUSAL_CONTRACT. The two packages do not import
// each other, so the join is the six reason names and an exhaustive Record — a
// seventh reason added to the union without a row here does not compile, on
// either side, and a row whose text overruns the measured budget fails on the
// same line that asserts it.
const EXPECTED: Record<RefusalReason, { text: string; canRetry: boolean }> = {
  'not-permitted': { text: 'The board isn’t allowed', canRetry: false },
  'not-permitted-yet': { text: 'Needs GitHub authorization', canRetry: false },
  'wrong-value': { text: 'GitHub doesn’t allow that', canRetry: false },
  'try-again': { text: 'Couldn’t reach GitHub', canRetry: true },
  // Noun-neutral on purpose: this row serves the repo tile as well as the issue
  // surface, and a repo whose owner write 404s is not an issue.
  'not-found': { text: 'Not found on GitHub', canRetry: false },
  unauthenticated: { text: 'GitHub rejected the board', canRetry: false },
};

describe('a refusal reaches the person as the reason it was, not as its status (#584)', () => {
  it.each(Object.entries(EXPECTED))('reason %s reaches the person as its own sentence', (r, want) => {
    const f = describeEditFailure(new ApiError(403, 'refused', r as RefusalReason));
    expect(f).toEqual(want);
    expect(f.text.length).toBeLessThanOrEqual(failureTextBudget(f));
  });

  it('two reasons that share a status still read as two different sentences', () => {
    // The whole point of keying on the reason: `refusalToHttp` answers 403 for
    // three reasons, so a status-only read collapses them.
    const a = describeEditFailure(new ApiError(403, 'refused', 'not-permitted'));
    const b = describeEditFailure(new ApiError(403, 'refused', 'not-permitted-yet'));
    expect(a.text).not.toBe(b.text);
  });

  it('falls back to the status when the body carried no reason', () => {
    // An old backend, or a refusal that never went through `refusalToHttp`.
    expect(describeEditFailure(new ApiError(502, 'boom'))).toEqual({
      text: 'Couldn’t reach GitHub',
      canRetry: true,
    });
  });

  it('an unrecognised status with no reason is still retryable', () => {
    expect(describeEditFailure(new ApiError(500, 'boom')).canRetry).toBe(true);
  });
});

describe('safeAuthorizeUrl — a link the board renders is a link the board vouches for (#584)', () => {
  it('drops anything that is not a github.com origin', () => {
    // It arrives in a header, from a server.
    expect(safeAuthorizeUrl('https://evil.example/sso')).toBeNull();
    expect(safeAuthorizeUrl('javascript:alert(1)')).toBeNull();
    expect(safeAuthorizeUrl('https://github.com.evil.example/sso')).toBeNull();
    expect(safeAuthorizeUrl('http://github.com/orgs/x/sso')).toBeNull();
    expect(safeAuthorizeUrl('not a url')).toBeNull();
    expect(safeAuthorizeUrl(undefined)).toBeNull();
    expect(safeAuthorizeUrl(null)).toBeNull();
  });

  it('keeps a github.com one, unchanged', () => {
    expect(safeAuthorizeUrl('https://github.com/orgs/x/sso')).toBe('https://github.com/orgs/x/sso');
  });
});

// The close dialog's own reading of the same statuses. It used to match on the
// message strings `closeIssue` threw; once that throw carries a status instead,
// matching on the message would collapse all three sentences into the fallback.
// Every sentence below is word for word what it was — except the 404, whose
// branch was unreachable until now (#584, "What this breaks" item 5).
describe('CloseIssueAlert reason — the close dialog reads the status (#584)', () => {
  it('says the write path is off on a 503', () => {
    expect(reason(new ApiError(503, 'close 503'))).toBe('Issue writes are turned off right now.');
  });

  // Not "says permission": since #892 the close goes out under the READER's
  // token, so a bare 403 is provably neither the board's credential nor a
  // verdict on the person (#1103 review, B1). It says what did not happen.
  it('says what did not happen on a 403, and blames nobody for it', () => {
    const said = reason(new ApiError(403, 'close 403'));
    expect(said).toBe('This issue wasn’t closed. Trying again won’t change that.');
    expect(said).not.toMatch(/\byou\b|\byour\b|board/i);
  });

  it('says the issue is gone on a 404 — the branch that was dead until now', () => {
    expect(reason(new ApiError(404, 'close 404'))).toBe('That issue no longer exists on GitHub.');
  });

  it('falls back on a status it does not recognise, and on an error with no status at all', () => {
    expect(reason(new ApiError(500, 'close 500'))).toBe('Couldn’t close the issue. Try again on GitHub.');
    expect(reason(new TypeError('Failed to fetch'))).toBe('Couldn’t close the issue. Try again on GitHub.');
  });

  it('reads the reason before the status (#584)', () => {
    // 403 and 404 share a status table entry by coincidence; they do not share
    // a reason, and "somebody can authorize this" is the one a person can act
    // on. `not-found` is the branch that was dead before task 2.
    expect(reason(new ApiError(403, 'close 403', 'not-permitted-yet'))).toMatch(/authoriz/i);
    expect(reason(new ApiError(404, 'close 404'))).toMatch(/no longer exists/);
  });

  it('a reachability failure says so, whatever status it wore', () => {
    expect(reason(new ApiError(403, 'close 403', 'try-again'))).toMatch(/Try again in a moment/);
  });
});

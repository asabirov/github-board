/**
 * Handing an issue to somebody (#751), and the one thing about that write which
 * cannot be guessed from the request: Github answers with the set it ACCEPTED.
 *
 * `PATCH …/assignees` has replace-semantics and drops a login the repo will not
 * assign — silently, with a 200. So a client that believes its own input reports
 * an assignment that did not happen, and, worse, replaced whoever WAS assigned
 * with nobody. The tests below drive `runAssign` through that path, because it is
 * the path no error handler sees.
 *
 * The click itself cannot be driven here: the suite runs `environment: 'node'`,
 * so no event is dispatched and no effect fires. Hence the same
 * shape `CloseIssueAlert` uses — the body is a pure function with its effects
 * injected, and the wiring the tests cannot execute is read off the source at the
 * bottom of this file.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/core';
import { REFUSED_REASON } from '../refusal';
import {
  MAX_ASSIGNEES,
  NOTHING_TO_SAVE,
  assignGate,
  assignReason,
  assigneeChange,
  latestOnly,
  pickerRows,
  readFailure,
  runAssign,
  runChangeAssignees,
  sameAssignees,
  saveSummary,
  toggleAssignee,
  type AssignEffects,
  type AssignTarget,
  type AssigneeChange,
} from './AssignIssueDialog';

const target: AssignTarget = {
  owner: 'acme',
  repo: 'board',
  number: 12,
  title: 'The overview spends its top on two blocks',
};

/** The six effects, recorded, with the order they fired in. `change` answers
 *  with the people it added unless a test says what Github holds instead. */
function effects(
  assign: (t: AssignTarget, logins: string[]) => Promise<string[]>,
  change: (t: AssignTarget, c: AssigneeChange) => Promise<string[]> = (_t, c) => Promise.resolve(c.add),
) {
  const order: string[] = [];
  const track = <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    vi.fn((...a: A): R => { order.push(name); return fn(...a); });
  const fx: AssignEffects = {
    assign: track('assign', assign),
    change: track('change', change),
    say: track('say', () => {}),
    bump: track('bump', () => {}),
    assigned: track('assigned', () => {}),
    dismiss: track('dismiss', () => {}),
  };
  return { fx, order, mock: fx as { [K in keyof AssignEffects]: ReturnType<typeof vi.fn> } };
}

/** Github accepted exactly what it was sent — the ordinary case. */
const accepts = (t: AssignTarget, logins: string[]) => Promise.resolve(logins);

describe('runAssign — the write behind both assign items', () => {
  it('sends the whole desired set, which is the one person picked', async () => {
    const { fx, mock } = effects(accepts);

    await runAssign(target, 'octocat', fx);

    // Replace-semantics: the payload is the set the issue should END with, so a
    // one-name array is a hand-over and not an addition. `api.ts` says so at
    // `setIssueAssignees`, and the menu has no view of the current set to add to.
    expect(mock.assign).toHaveBeenCalledWith(target, ['octocat']);
  });

  it('says who has it, asks the rest of the board to re-read, and shuts', async () => {
    const { fx, order, mock } = effects(accepts);

    await runAssign(target, 'octocat', fx);

    expect(mock.say).toHaveBeenCalledWith('Assigned board#12 to octocat');
    expect(mock.bump).toHaveBeenCalledTimes(1);
    expect(mock.assigned).toHaveBeenCalledWith(['octocat']);
    expect(mock.dismiss).toHaveBeenCalledTimes(1);
    // After the write, never instead of it — the same order `runClose` keeps.
    expect(order.indexOf('bump')).toBeGreaterThan(order.indexOf('assign'));
  });

  // Github's answer is the truth and the request never is. Reporting the input
  // back would be the one lie this dialog is in a position to tell.
  it('reconciles to the set Github returned, not to the one it sent', async () => {
    const { fx, mock } = effects(() => Promise.resolve(['someone-else']));

    await runAssign(target, 'octocat', fx);

    expect(mock.assigned).toHaveBeenCalledWith(['someone-else']);
  });

  describe('when Github silently drops the login', () => {
    it('says so rather than claiming the assignment', async () => {
      const { fx, mock } = effects(() => Promise.resolve([]));

      await runAssign(target, 'octocat', fx);

      expect(mock.say).toHaveBeenCalledWith(
        'GitHub didn’t accept octocat. board#12 is now unassigned.',
        'danger',
      );
      expect(mock.say).not.toHaveBeenCalledWith('Assigned board#12 to octocat');
    });

    // The set DID change — a dropped login leaves the issue holding whatever
    // Github kept, which is usually nobody. So the board still re-reads, and the
    // sentence names the state the issue is actually in.
    it('still re-reads, because the replace happened anyway', async () => {
      const { fx, mock } = effects(() => Promise.resolve([]));

      await runAssign(target, 'octocat', fx);

      expect(mock.bump).toHaveBeenCalledTimes(1);
      expect(mock.assigned).toHaveBeenCalledWith([]);
    });

    it('names who is left where Github kept somebody else', async () => {
      const { fx, mock } = effects(() => Promise.resolve(['alice', 'bob']));

      await runAssign(target, 'octocat', fx);

      expect(mock.say).toHaveBeenCalledWith(
        'GitHub didn’t accept octocat. board#12 is now assigned to alice and bob.',
        'danger',
      );
    });

    // The picker stays up on a drop, so the reader can hand it to somebody the
    // repo will actually take — the same answer `runClose` gives a refusal.
    it('keeps the picker open', async () => {
      const { fx, mock } = effects(() => Promise.resolve([]));

      await runAssign(target, 'octocat', fx);

      expect(mock.dismiss).not.toHaveBeenCalled();
    });
  });

  it('leaves the board alone when the write is refused', async () => {
    const { fx, mock } = effects(() => Promise.reject(new ApiError(503, 'issue-write 503')));

    await runAssign(target, 'octocat', fx);

    expect(mock.say).toHaveBeenCalledWith('Issue writes are turned off right now.', 'danger');
    expect(mock.bump).not.toHaveBeenCalled();
    expect(mock.assigned).not.toHaveBeenCalled();
    expect(mock.dismiss).not.toHaveBeenCalled();
  });
});

/**
 * The refusal sentences. Same shape as `CloseIssueAlert`'s `reason` and for the
 * same reason (#584): the status alone cannot tell an outright refusal from
 * "this may go through once somebody authorizes it" — both answer 403, and only
 * the second is something a person can act on.
 *
 * The bare 403 names nobody (#1103 review, B1). `assignReason`'s own header
 * enumerates what reaches it; the test below holds the RULE rather than the
 * reasoning, so a future rewrite that reaches for either actor fails here
 * instead of shipping a sentence the board cannot support.
 */
describe('assignReason — what a refused assignment reads as', () => {
  it('separates the 403 that can be authorized from the one that cannot', () => {
    expect(assignReason(new ApiError(403, 'x', 'not-permitted-yet'))).toBe(
      'This needs GitHub authorization before it can be assigned.',
    );
    expect(assignReason(new ApiError(403, 'x'))).toBe('This issue wasn’t assigned. Trying again won’t change that.');
  });

  // Since #892 a browser write goes out under the READER's token, so a bare 403
  // is neither provably the board's credential nor provably a verdict on the
  // person. `auth/write-failure.ts` (#1079) holds the same line for the other
  // three writes on this board; these two must not disagree with it on screen.
  it('blames neither the reader nor the board for a bare 403', () => {
    const said = assignReason(new ApiError(403, 'x'));
    expect(said).not.toMatch(/\byou\b|\byour\b/i);
    expect(said).not.toContain(REFUSED_REASON);
    expect(said).not.toMatch(/board/i);
  });

  it('names the reachable causes', () => {
    expect(assignReason(new ApiError(502, 'x', 'try-again'))).toBe('Couldn’t reach GitHub. Try again in a moment.');
    expect(assignReason(new ApiError(503, 'x'))).toBe('Issue writes are turned off right now.');
    expect(assignReason(new ApiError(404, 'x'))).toBe('That issue no longer exists on GitHub.');
  });

  it('falls back for anything that did not come through the classifier', () => {
    expect(assignReason(new Error('offline'))).toBe('Couldn’t assign the issue. Try again on GitHub.');
    expect(assignReason(new ApiError(418, 'x'))).toBe('Couldn’t assign the issue. Try again on GitHub.');
  });
});

/**
 * The login crosses a system boundary, and until #752 it was compared exactly.
 *
 * `me.githubLogin` is "the handle somebody actually TYPED"
 * (`identity/github-login.resolver.ts`); `accepted` is Github's own canonical
 * casing, echoed back off the write. On a mis-cased roster row — and the fixture
 * ships `IvanRoslov` — the write SUCCEEDED, the row redrew correctly, and the
 * reader got a red flash saying Github had refused. `identity/team-roster.ts`
 * canonicalises spelling for exactly this reason.
 */
describe('runAssign reads Github’s answer however it is cased (#752)', () => {
  it('reports the success it got when Github answers in its own casing', async () => {
    const { fx, mock } = effects(() => Promise.resolve(['IvanRoslov']));

    await runAssign(target, 'ivanroslov', fx);

    expect(mock.say).toHaveBeenCalledWith('Assigned board#12 to ivanroslov');
    expect(mock.dismiss).toHaveBeenCalledTimes(1);
  });

  it('still reports a genuine drop', async () => {
    const { fx, mock } = effects(() => Promise.resolve(['someone-else']));

    await runAssign(target, 'ivanroslov', fx);

    expect(mock.say).toHaveBeenCalledWith(
      'GitHub didn’t accept ivanroslov. board#12 is now assigned to someone-else.',
      'danger',
    );
  });
});

/**
 * Who the write took it FROM (#752).
 *
 * `Assign to me` is one press with no confirm, and this write REPLACES the set —
 * so it can quietly take a report off whoever was triaging it. The picker warns
 * in as many words ("replacing anyone assigned now"); the menu item has no
 * dialog to warn in, so the sentence afterwards has to name the person, which is
 * what makes the hand-over reversible by somebody who did not intend it.
 *
 * The menu could not say it on its own: `ActionableIssue` is repo, number, title
 * and URL, with no assignees anywhere. The surface passes what it is already
 * drawing.
 */
describe('runAssign names whoever the write displaced (#752)', () => {
  it('says who it was taken from', async () => {
    const { fx, mock } = effects(accepts);

    await runAssign(target, 'octocat', fx, ['IvanRoslov']);

    expect(mock.say).toHaveBeenCalledWith('Assigned board#12 to octocat — taken from IvanRoslov');
  });

  it('names all of them where several held it', async () => {
    const { fx, mock } = effects(accepts);

    await runAssign(target, 'octocat', fx, ['alice', 'bob']);

    expect(mock.say).toHaveBeenCalledWith('Assigned board#12 to octocat — taken from alice and bob');
  });

  it('says nothing about a hand-over on a report nobody held', async () => {
    const { fx, mock } = effects(accepts);

    await runAssign(target, 'octocat', fx, []);

    expect(mock.say).toHaveBeenCalledWith('Assigned board#12 to octocat');
  });

  // Pressing it on a report you already hold is a no-op, not a hand-over from
  // yourself — case-folded, for the reason above.
  it('does not report taking it from the reader who already had it', async () => {
    const { fx, mock } = effects(accepts);

    await runAssign(target, 'octocat', fx, ['OctoCat']);

    expect(mock.say).toHaveBeenCalledWith('Assigned board#12 to octocat');
  });
});

/**
 * One write at a time per issue (#752).
 *
 * `Assign to me` had no busy guard at all while the picker had its own, so the
 * two could be in flight together — press the item, then pick somebody in
 * `Assign to…` — and `onAssigned` landed in ARRIVAL order rather than request
 * order, leaving the row showing whichever answer was slower. The guard is a
 * plain object rather than a hook so both paths can hold the SAME one: two
 * hooks would be two flags, which is the bug again.
 */
/**
 * The several picker saves a CHANGE, never a set (#1009 review).
 *
 * It used to send everyone ticked through the replace route, built from a read
 * taken when the picker opened. Somebody assigned on Github after that read was
 * not in the set, so Save took them off and nobody was told. Now the request
 * names only who the reader ticked and unticked, and Github's answer, which may
 * name people the request never mentioned, is what the row draws.
 */
describe('runChangeAssignees — the several picker saves what the reader changed (#1009)', () => {
  // The regression this function exists to prevent.
  it('keeps somebody assigned on Github after the picker opened', async () => {
    // The reader was shown ann. Carol was assigned on Github since. The reader
    // ticks bob and saves.
    const { fx, mock } = effects(accepts, () => Promise.resolve(['ann', 'carol', 'bob']));

    await runChangeAssignees(target, ['ann'], ['ann', 'bob'], fx);

    // Carol is on neither side of the request, so nothing asks Github to drop her.
    expect(mock.change).toHaveBeenCalledWith(target, { add: ['bob'], remove: [] });
    // The replace route is never used from here.
    expect(mock.assign).not.toHaveBeenCalled();
    // And the reader is told who holds it now, carol included.
    expect(mock.assigned).toHaveBeenCalledWith(['ann', 'carol', 'bob']);
    expect(mock.say).toHaveBeenCalledWith('board#12 is now assigned to ann, carol and bob');
    expect(mock.dismiss).toHaveBeenCalledTimes(1);
  });

  it('sends an untick as a removal and nothing else', async () => {
    const { fx, mock } = effects(accepts, () => Promise.resolve(['carol']));

    await runChangeAssignees(target, ['ann'], [], fx);

    expect(mock.change).toHaveBeenCalledWith(target, { add: [], remove: ['ann'] });
    expect(mock.say).toHaveBeenCalledWith('board#12 is now assigned to carol');
  });

  it('says unassigned when Github holds nobody afterwards', async () => {
    const { fx, mock } = effects(accepts, () => Promise.resolve([]));

    await runChangeAssignees(target, ['ann'], [], fx);

    expect(mock.say).toHaveBeenCalledWith('board#12 is now unassigned');
  });

  it('names who Github would not add, redraws with what it holds, and keeps the picker up', async () => {
    const { fx, mock } = effects(accepts, () => Promise.resolve(['ann']));

    await runChangeAssignees(target, ['ann'], ['ann', 'bob'], fx);

    expect(mock.say).toHaveBeenCalledWith('GitHub didn’t accept bob. board#12 is now assigned to ann.', 'danger');
    expect(mock.assigned).toHaveBeenCalledWith(['ann']);
    expect(mock.bump).toHaveBeenCalledTimes(1);
    expect(mock.dismiss).not.toHaveBeenCalled();
  });

  it('names anyone Github kept although the reader unticked them', async () => {
    const { fx, mock } = effects(accepts, () => Promise.resolve(['ann']));

    await runChangeAssignees(target, ['ann'], [], fx);

    expect(mock.say).toHaveBeenCalledWith('GitHub kept ann. board#12 is now assigned to ann.', 'danger');
    expect(mock.dismiss).not.toHaveBeenCalled();
  });

  it('reads Github’s casing as the same person', async () => {
    const { fx, mock } = effects(accepts, () => Promise.resolve(['IvanRoslov']));

    await runChangeAssignees(target, [], ['ivanroslov'], fx);

    expect(mock.say).toHaveBeenCalledWith('board#12 is now assigned to IvanRoslov');
    expect(mock.dismiss).toHaveBeenCalledTimes(1);
  });

  it('leaves the board alone when a one-sided change is refused', async () => {
    const { fx, mock } = effects(accepts, () => Promise.reject(new ApiError(403, 'issue-write 403')));

    await runChangeAssignees(target, [], ['ann'], fx);

    expect(mock.say).toHaveBeenCalledWith('This issue wasn’t assigned. Trying again won’t change that.', 'danger');
    expect(mock.bump).not.toHaveBeenCalled();
    expect(mock.assigned).not.toHaveBeenCalled();
    expect(mock.dismiss).not.toHaveBeenCalled();
  });

  it('asks the board to re-read when a two-sided change fails, since the removal may have landed', async () => {
    const { fx, mock } = effects(accepts, () => Promise.reject(new ApiError(502, 'issue-write 502', 'try-again')));

    await runChangeAssignees(target, ['ann'], ['bob'], fx);

    expect(mock.bump).toHaveBeenCalledTimes(1);
    expect(mock.say).toHaveBeenCalledWith('Couldn’t reach GitHub. Try again in a moment.', 'danger');
    expect(mock.dismiss).not.toHaveBeenCalled();
  });
});

describe('assigneeChange — who the reader ticked and unticked', () => {
  it('compares against what the reader was shown, whatever the casing', () => {
    expect(assigneeChange(['ann', 'IvanRoslov'], ['ivanroslov', 'bob'])).toEqual({ add: ['bob'], remove: ['ann'] });
  });

  it('never names a holder the reader left ticked, including one the repo no longer assigns', () => {
    // `gone` lost access and still holds the issue. Left ticked, it is on
    // neither side, so no request can drop them.
    expect(assigneeChange(['gone', 'ann'], ['gone', 'ann', 'bob'])).toEqual({ add: ['bob'], remove: [] });
  });

  it('is empty when nothing changed', () => {
    expect(assigneeChange(['ann'], ['Ann'])).toEqual({ add: [], remove: [] });
  });
});

/**
 * The line under the several picker's list, which replaced two sentences of
 * explanation (#1049). Those sentences told the reader that Save adds and
 * removes rather than replacing the set, because the first version of this
 * picker replaced it from a stale read and dropped whoever had been assigned on
 * Github since. This line has to carry the same fact by naming the change and
 * nothing else.
 */
describe('saveSummary — what Save will send, said before it is pressed (#1049)', () => {
  const names: Record<string, string> = { octocat: 'Octocat' };
  const name = (login: string) => names[login] ?? login;

  it('names who is added and who is removed, as the reader knows them', () => {
    expect(saveSummary({ add: ['octocat'], remove: ['anton'] }, name)).toBe(
      'Save adds Octocat, and removes anton.',
    );
  });

  it('says one half alone when there is only one', () => {
    expect(saveSummary({ add: ['ann', 'bob', 'carol'], remove: [] })).toBe('Save adds ann, bob and carol.');
    expect(saveSummary({ add: [], remove: ['ann'] })).toBe('Save removes ann.');
  });

  // "adds ann and bob and removes carol" reads for a moment as three people
  // being added, because `andList` has already spent the sentence's one "and"
  // (#1054). The comma is what tells the second one apart.
  it('marks where the adding stops and the removing starts', () => {
    expect(saveSummary({ add: ['ann', 'bob'], remove: ['carol'] })).toBe('Save adds ann and bob, and removes carol.');
  });

  it('says nothing when nothing changed', () => {
    expect(saveSummary({ add: [], remove: [] })).toBe('');
  });

  // Nothing is what the line SAYS then, not what it draws: the picker puts
  // `NOTHING_TO_SAVE` in its place, which holds the height a summary will take
  // so the first tick does not move the dialog (#1054).
  it('leaves the picker a resting line to hold its place', () => {
    expect(NOTHING_TO_SAVE).toBe('Nothing to save yet.');
    expect(NOTHING_TO_SAVE).not.toContain('Save adds');
  });

  // The fact the old sentence carried: a holder the reader left ticked is on
  // neither side, so the line never names them and Save never sends them.
  it('never names somebody the reader left alone', () => {
    expect(saveSummary(assigneeChange(['ann', 'gone'], ['ann', 'gone', 'bob']))).toBe('Save adds bob.');
  });
});

describe('the several picker’s rows and ticks (#1009)', () => {
  it('stops at Github’s cap of ten', () => {
    expect(MAX_ASSIGNEES).toBe(10);
    const ten = Array.from({ length: 10 }, (_, i) => `p${i}`);
    expect(toggleAssignee(ten, 'eleventh')).toEqual(ten);
    // Unticking still works at the cap, and makes room again.
    expect(toggleAssignee(ten, 'p3')).toHaveLength(9);
    expect(toggleAssignee(toggleAssignee(ten, 'p3'), 'eleventh')).toContain('eleventh');
  });

  it('ticks and unticks one person, whatever the casing', () => {
    expect(toggleAssignee([], 'ann')).toEqual(['ann']);
    expect(toggleAssignee(['IvanRoslov', 'ann'], 'ivanroslov')).toEqual(['ann']);
  });

  it('lists everyone the repo assigns, then any holder the list no longer names', () => {
    // Somebody who lost access still holds the issue. Left off the rows, the
    // reader could neither see that they hold it nor take them off.
    expect(pickerRows(['octocat', 'IvanRoslov'], ['ivanroslov', 'gone'])).toEqual(['octocat', 'IvanRoslov', 'gone']);
  });

  it('says what a failed read was, and never calls a refusal a blip', () => {
    const forbidden = new Error('forbidden');
    expect(readFailure(forbidden, true)).toMatch(/This read was refused/);
    expect(readFailure(forbidden, false)).toMatch(/This read was refused/);
    expect(readFailure(new Error('not-found'), true)).toBe('That issue no longer exists on GitHub.');
    // Either read may be the one that failed, so the sentence names both.
    expect(readFailure(new Error('issue 502'), true)).toBe(
      'Couldn’t read who holds this issue and who can be assigned. Try again in a moment.',
    );
    expect(readFailure(new Error('edit-options 502'), false)).toBe(
      'Couldn’t read who this repo can assign. Try again on GitHub.',
    );
  });

  it('knows an unchanged set, so Save stays off until something changes', () => {
    expect(sameAssignees(['ann', 'bob'], ['Bob', 'ann'])).toBe(true);
    expect(sameAssignees(['ann'], ['ann', 'bob'])).toBe(false);
    expect(sameAssignees([], [])).toBe(true);
  });
});

describe('assignGate — one assign in flight per issue', () => {
  it('lets the first write through', () => {
    expect(assignGate().begin()).toBe(true);
  });

  it('refuses a second while the first is in flight', () => {
    const gate = assignGate();
    expect(gate.begin()).toBe(true);
    expect(gate.begin()).toBe(false);
  });

  it('lets the next one through once the first has finished', () => {
    const gate = assignGate();
    gate.begin();
    gate.end();
    expect(gate.begin()).toBe(true);
  });

  it('reopens after a write that threw, or a refusal shuts the control for good', () => {
    const gate = assignGate();
    gate.begin();
    gate.end();
    gate.end();
    expect(gate.begin()).toBe(true);
  });
});

/**
 * The picker's read of who this repo will assign, and answers arriving out of
 * order (#752).
 *
 * Open, Escape, reopen: request #1 rejects AFTER request #2 resolves, and the
 * failure flag it sets is never cleared again — a permanent red banner over a
 * usable list. The effect's docblock retires the `alive` flag on unmount
 * grounds, which answers a different question: the component is still mounted
 * and still the same one, and the stale answer is a stale answer either way.
 *
 * This is a sequence, NOT the `useRef` once-guard that deadlocks under
 * StrictMode: every run of the effect takes a new ticket, so
 * StrictMode's second run is the latest one and its answer lands.
 */
describe('latestOnly — only the newest read may answer', () => {
  it('lets a single request answer', () => {
    const reads = latestOnly();
    expect(reads.start()()).toBe(true);
  });

  it('silences the earlier request when a later one has started', () => {
    const reads = latestOnly();
    const first = reads.start();
    const second = reads.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('does not silence a request that is still the newest, however long it takes', () => {
    const reads = latestOnly();
    const only = reads.start();
    expect(only()).toBe(true);
    expect(only()).toBe(true);
  });
});

// ── what the node environment cannot render, read off the source ─────────────
//
// `runAssign` can be perfect and reach nobody: the press has to run it, the
// writer it is handed has to be the real `setIssueAssignees`, and the bump has
// to be the provider's — a locally-defined one would satisfy every test above
// and move nothing on screen.

const SOURCES = import.meta.glob('./*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const self = SOURCES['./AssignIssueDialog.tsx'];

/** Undo one thing in the source, asserting that thing was there to undo: a
 *  mutant that changed nothing passes every matcher and proves nothing. */
function mutate(src: string, pattern: RegExp, replacement = ''): string {
  expect(src, `the source should contain ${pattern}`).toMatch(pattern);
  return src.replace(pattern, replacement);
}

function wiring(src: string) {
  return {
    // The picked login reaches `runAssign` — the CALL, not the declaration a
    // bare /runAssign\(/ would match in this very file.
    picksRunAssign: /await\s+runAssign\s*\(/.test(src),
    // The write is the one `api.ts` owns, not a fetch written again here.
    writesThroughApi: /assign:\s*\([^)]*\)\s*=>\s*setIssueAssignees\(/.test(src),
    // The several picker's save is the change route, never the replace (#1009).
    changesThroughApi: /change:\s*\([^)]*\)\s*=>\s*changeIssueAssignees\(/.test(src),
    // Save diffs against `held`, what the reader was shown, not against the card.
    savesTheChange: /await\s+runChangeAssignees\(\s*target,\s*held,\s*chosen,/.test(src),
    // The line under the list is built from those same two sets (#1049), so it
    // cannot name a change Save will not send. It is drawn in a live region.
    saysWhatSaveSends:
      /saveSummary\(assigneeChange\(held, chosen\)/.test(src) &&
      /aria-live="polite"[^>]*>\s*\{summary \|\| /.test(src),
    // And `several` is the ONLY thing that decides whether it is drawn (#1054).
    // A live region mounted when it has something to say is a live region no
    // screen reader announces, and an unmounted line is 50.75px the dialog
    // grows by the moment the first tick gives it one. The check above cannot
    // see either: `summary && <p aria-live>` still matches every part of it.
    liveLineAlwaysMounted: /\{several && \(\s*<p [^>]*aria-live="polite"/.test(src),
    // Somebody new in Github's answer gets a row where the picker stays up.
    rowsFollowTheAnswer: /setLogins\(\(rows\) => \(rows \? pickerRows\(rows, next\)/.test(src),
    // The ticks come from the uncached holder read, not the cached issue detail.
    ticksFromTheFreshRead: /fetchIssueAssignees\(owner, repo, number\)/.test(src) && !/fetchIssue\(/.test(src),
    // And the refresh is the context's, so every other view re-reads (#384).
    bumpFromContext: /const\s+\w+\s*=\s*useRefreshBump\(\s*\)/.test(src),
    // The list is drawn only when the read did NOT fail (#752) — it was the one
    // branch `!failed` did not guard, so a failed read drew its banner above
    // the list it was denying the existence of. Since #1067 the refusal is the
    // dialog's own line and the list is the whole of what the box holds, so the
    // guard is the box's: no list, no box.
    listGuardedByFailure: /\{failed \? null : \(/.test(src),
    // The list is the board's search list (#1021), which takes the field, the
    // arrows and Enter from the kit's `Command`. The rows used to be
    // `tabIndex={-1}` buttons, reachable by mouse only unless `useDismiss` was
    // borrowed to walk them (#752); a list drawn any other way loses both.
    searchesTheList: /<PickList\b/.test(src),
    // The person, not the handle — the same resolver `facet-editors.tsx` runs
    // this same list through (#752).
    namesFromTheRoster: /resolvePerson\(people,/.test(src),
  };
}

describe('the picker is wired to the real write', () => {
  it('reads its own source', () => {
    expect(self, 'ui/AssignIssueDialog.tsx').toBeTruthy();
    expect(self).toContain('export async function runAssign');
  });

  it('runs the chain from the picked login to the refresh', () => {
    expect(wiring(self)).toEqual({
      picksRunAssign: true,
      writesThroughApi: true,
      changesThroughApi: true,
      savesTheChange: true,
      saysWhatSaveSends: true,
      liveLineAlwaysMounted: true,
      rowsFollowTheAnswer: true,
      ticksFromTheFreshRead: true,
      bumpFromContext: true,
      listGuardedByFailure: true,
      searchesTheList: true,
      namesFromTheRoster: true,
    });
  });

  // A text check is the kind that quietly stops matching what it was written
  // for, so each link is run once against a source with that link cut.
  it('would notice each way the chain could come undone', () => {
    expect(wiring(mutate(self, /await runAssign\(/, 'await nothingAtAll(')).picksRunAssign).toBe(false);
    expect(wiring(mutate(self, /setIssueAssignees\(/, 'somethingElse(')).writesThroughApi).toBe(false);
    expect(
      wiring(mutate(self, /changeIssueAssignees\(t\.owner/, 'setIssueAssignees(t.owner')).changesThroughApi,
    ).toBe(false);
    expect(
      wiring(mutate(self, /runChangeAssignees\(target, held, chosen,/, 'runChangeAssignees(target, [], chosen,'))
        .savesTheChange,
    ).toBe(false);
    expect(
      wiring(mutate(self, /saveSummary\(assigneeChange\(held, chosen\)/, 'saveSummary(assigneeChange([], chosen)'))
        .saysWhatSaveSends,
    ).toBe(false);
    expect(wiring(mutate(self, /aria-live="polite" /, '')).saysWhatSaveSends).toBe(false);
    // The one the check above passes: the line still says what Save sends, and
    // says it only once there is something to say.
    expect(
      wiring(mutate(self, /\{several && \(\s*<p data-dialog-pinned/, '{several && summary && (<p data-dialog-pinned'))
        .liveLineAlwaysMounted,
    ).toBe(false);
    expect(
      wiring(mutate(self, /fetchIssueAssignees\(owner, repo, number\)/, 'fetchIssue(owner, repo, number)'))
        .ticksFromTheFreshRead,
    ).toBe(false);
    expect(
      wiring(mutate(self, /setLogins\(\(rows\) => \(rows \? pickerRows\(rows, next\) : rows\)\);/, '')).rowsFollowTheAnswer,
    ).toBe(false);
    expect(
      wiring(mutate(self, /const\s+\w+\s*=\s*useRefreshBump\(\s*\);/, 'const bump = () => {};')).bumpFromContext,
    ).toBe(false);
    expect(
      wiring(mutate(self, /\{failed \? null : \(/, '{true ? (')).listGuardedByFailure,
    ).toBe(false);
    expect(wiring(mutate(self, /<PickList\b/, '<div')).searchesTheList).toBe(false);
    expect(wiring(mutate(self, /resolvePerson\(people,/, 'nobody(people,')).namesFromTheRoster).toBe(false);
  });
});

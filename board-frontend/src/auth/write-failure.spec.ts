import { describe, expect, it, vi } from 'vitest';
import { ApiError, WithdrawnReadError } from '../api/core';
import { ACCESS_NOT_NOW_CODE } from '../projects/projects-last-good';
import { ADMIN_ACCESS_REQUIRED, FIXED_ROSTER, logWriteFailure, writeFailure } from './write-failure';

/**
 * The branch, pinned once (#1079). Three surfaces key their sentences on the
 * kind this returns and their button on `retry`, so what is asserted here is
 * every answer those three routes can actually give — enumerated in the
 * module's own header, per route, rather than assumed.
 */
describe('writeFailure (#1079)', () => {
  it('reads an expired session off the sentinel apiFetch raises', () => {
    // `apiFetch` throws this before any status reaches a write function, so the
    // message is what identifies it and the 401 is carried beside it.
    expect(writeFailure(new ApiError(401, 'unauthenticated'))).toEqual({
      kind: 'session-ended', serverSaid: null, retry: false,
    });
  });

  /**
   * The two 403s, which is the whole of #1102's first blocker. Three producers
   * answer 403 on these routes: `TeamAccessGuard` twice and `AdminGuard` once.
   * Only the last is a verdict the board may repeat, and the first cut called
   * all of them permanent and killed the button under them.
   */
  it('withdraws the control only on the one 403 the board can place', () => {
    // `AdminGuard` raises this after the admin roster was read successfully and
    // this caller was not in it. A second press gets the same answer. The body
    // is still not repeated: it is a log phrase, not a sentence for a reader.
    const refused = writeFailure(new ApiError(403, 'forbidden', undefined, undefined, ADMIN_ACCESS_REQUIRED));
    expect(refused).toEqual({ kind: 'refused', serverSaid: null, retry: false });
  });

  it('keeps the control armed on the 403 that is transient as often as not', () => {
    // `TeamAccessGuard` is a global APP_GUARD and answers this on every one of
    // the three routes. `DirectoryGroupMembership.isMember` fails closed without
    // caching, so a Directory timeout produces it on a loaded page and the next
    // press lands. Nothing on the wire separates that from a real removal.
    const team = 'Access restricted to the Acme team (team@example.com)';
    expect(writeFailure(new ApiError(403, 'forbidden', undefined, undefined, team))).toEqual({
      kind: 'access-unconfirmed', serverSaid: null, retry: true,
    });
    // The guard's other refusal, and an ingress or a proxy answering 403 with a
    // body the board cannot read at all. Neither is placed either.
    const noEmail = 'No email on token; cannot verify team membership';
    expect(writeFailure(new ApiError(403, 'forbidden', undefined, undefined, noEmail)).kind)
      .toBe('access-unconfirmed');
    expect(writeFailure(new ApiError(403, 'forbidden'))).toEqual({
      kind: 'access-unconfirmed', serverSaid: null, retry: true,
    });
  });

  it('keeps the service’s own words where the service is writing for the reader', () => {
    // The five mint 400s and the fifteen identity 400s are the only
    // instruction their reader gets, and the numbers in them live in the
    // service. The way out is editing the form, so the button stays armed.
    expect(writeFailure(new ApiError(400, 'tokens 400', undefined, undefined, 'A token needs a name.'))).toEqual({
      kind: 'failed', serverSaid: 'A token needs a name.', retry: true,
    });
    // The 409s `identity.controller.ts` refuses a board-losing write with. Also
    // about the payload: the way out is changing the role in this same dialog.
    const lockout = 'This would leave the board with no administrator who can sign in.';
    expect(writeFailure(new ApiError(409, 'identity 409', undefined, undefined, lockout))).toEqual({
      kind: 'failed', serverSaid: lockout, retry: true,
    });
  });

  it('withdraws the control where the service described a standing condition', () => {
    // A fixture roster cannot be edited and a grant that is gone stays gone, so
    // a second press is answered the same way.
    const fixed = 'This board is reading a fixed roster, so it cannot be edited here.';
    expect(fixed).toBe(FIXED_ROSTER);
    expect(writeFailure(new ApiError(503, 'identity 503', undefined, undefined, fixed))).toEqual({
      kind: 'standing', serverSaid: fixed, retry: false,
    });
    expect(writeFailure(new ApiError(404, 'clients 404', undefined, undefined, 'No such connected client.'))).toEqual({
      kind: 'standing', serverSaid: 'No such connected client.', retry: false,
    });
  });

  /**
   * The 503s, which is #1102's second blocker and the same blind spot as the
   * first: "start at the global providers" was applied to 403 alone, and the
   * same five `APP_GUARD`s answer 503 on all three routes. Four of those are
   * transient and say so in a machine code.
   */
  it('keeps the control armed on every 503 the auth layer codes “not now”', () => {
    // `SessionRevocationService:174`, and `GithubUserService` at :300, :312 and
    // :443. All four carry ACCESS_NOT_NOW_CODE; none of them is about this
    // reader's access, and all four clear without anybody doing anything.
    for (const said of [
      'The board cannot confirm your sign-in right now. Try again in a moment.',
      'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.',
      'Checking your GitHub access took too long. Try again.',
    ]) {
      expect(writeFailure(new ApiError(503, 'identity 503', undefined, undefined, said, ACCESS_NOT_NOW_CODE)), said)
        .toEqual({ kind: 'not-now', serverSaid: null, retry: true });
    }
    // The words are dropped on purpose. They are written for a log, and the
    // whole of #1079 is a log phrase reaching a screen — the surface's own
    // sentence for this kind is what the reader gets.
    expect(writeFailure(new ApiError(503, 'tokens 503', undefined, undefined, 'The board cannot confirm your sign-in right now. Try again in a moment.', ACCESS_NOT_NOW_CODE)).serverSaid)
      .toBeNull();
  });

  it('repeats a 503’s own sentence only where a code places it', () => {
    // `AdminGuard`'s unread roster is the one 503 sentence on these routes
    // written FOR a reader, and it is coded, so it is repeated.
    const unread = 'This board cannot read who its admins are, so nobody resolves as an admin — including you.';
    expect(writeFailure(new ApiError(503, 'identity 503', undefined, undefined, unread, 'admins_unread'))).toEqual({
      kind: 'standing', serverSaid: unread, retry: false,
    });
    // `github-user.service.ts:245` is the sentence this rule exists for: an
    // UNCODED 503, written for a log, whose own words ask for a press this arm
    // has just taken away. The board does not repeat what it cannot place
    // beside a control it has removed.
    expect(writeFailure(new ApiError(503, 'tokens 503', undefined, undefined, 'Your GitHub connection changed while this was running. Try again.'))).toEqual({
      kind: 'standing', serverSaid: null, retry: false,
    });
    // The roster fixture's is placed on the sentence, the way `AdminGuard`'s 403
    // is, and survives on all three routes.
    expect(writeFailure(new ApiError(503, 'identity 503', undefined, undefined, FIXED_ROSTER)).serverSaid)
      .toBe(FIXED_ROSTER);
  });

  /**
   * The status decides the arming; the body only decides whether the service's
   * sentence is available (#1102 review, S1). These used to fall past both
   * status tests onto the armed default, because the whole table sat inside
   * `if (words)` — so a 404 from an ingress left Revoke live under a standing
   * condition no press can clear, and `serverMessage` returns undefined for an
   * empty body AND for Nest's `message: string[]` validation shape (#1082).
   */
  it('still withdraws the control when the standing condition arrived with no words', () => {
    expect(writeFailure(new ApiError(404, 'clients 404'))).toEqual({
      kind: 'standing', serverSaid: null, retry: false,
    });
    // An uncoded 503 with no body at all: the board cannot place it, so it
    // stays on the withdrawing arm. Only the code moves it off (above).
    expect(writeFailure(new ApiError(503, 'identity 503'))).toEqual({
      kind: 'standing', serverSaid: null, retry: false,
    });
    // A whitespace-only body is no words either, and must not become a sentence.
    expect(writeFailure(new ApiError(404, 'clients 404', undefined, undefined, '   '))).toEqual({
      kind: 'standing', serverSaid: null, retry: false,
    });
  });

  it('keeps the payload statuses armed whether or not the body could be read', () => {
    expect(writeFailure(new ApiError(400, 'tokens 400'))).toEqual({
      kind: 'failed', serverSaid: null, retry: true,
    });
  });

  it('drops what a 500 carries, which is the string this issue is about', () => {
    // Nest answers an unhandled store failure with this body. It is the exact
    // shape of the leak: a sentence-looking string that is not for a reader.
    expect(writeFailure(new ApiError(500, 'tokens 500', undefined, undefined, 'Internal server error'))).toEqual({
      kind: 'failed', serverSaid: null, retry: true,
    });
  });

  it('offers the press again when nothing said the write was refused', () => {
    // A 502 from a proxy with no JSON body, and the network itself.
    expect(writeFailure(new ApiError(502, 'identity 502'))).toEqual({
      kind: 'failed', serverSaid: null, retry: true,
    });
    expect(writeFailure(new TypeError('Failed to fetch'))).toEqual({
      kind: 'failed', serverSaid: null, retry: true,
    });
  });

  it('treats the board withdrawing its own request as neither a refusal nor a hiccup', () => {
    // `forgetPayloads` moves the cache generation on a sign-out, a Github
    // disconnect and an expired session, and a write already in flight is
    // rejected without anybody knowing whether it landed. It is an ApiError
    // with status 409, so it has to be read before the 409 arm above.
    expect(writeFailure(new WithdrawnReadError('Your GitHub access changed; reload this view.'))).toEqual({
      kind: 'interrupted', serverSaid: null, retry: false,
    });
  });
});

describe('logWriteFailure (#1079)', () => {
  it('writes the detail the sentence stopped printing, once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logWriteFailure('the mint sheet', new ApiError(500, 'tokens 500', undefined, undefined, 'Internal server error'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('write failed: the mint sheet: tokens 500 (Internal server error)');
    warn.mockRestore();
  });

  it('says what it has when the answer carried no body', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logWriteFailure('the identity edit', new TypeError('Failed to fetch'));
    expect(warn).toHaveBeenCalledWith('write failed: the identity edit: Failed to fetch');
    warn.mockRestore();
  });
});

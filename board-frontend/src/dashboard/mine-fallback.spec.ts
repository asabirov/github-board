import { describe, expect, it } from 'vitest';
import { MINE_UNAVAILABLE, queueEmptyState } from './mine-fallback';

describe('MINE_UNAVAILABLE (#512)', () => {
  it('carries no sync time, so a failed fetch states no freshness at all', () => {
    // The bug in one line: this handler used to stamp `new Date().toISOString()`,
    // and a page's payload time went straight into the global clock — so a dead
    // session showed a green "Synced just now" over three zeros. The clock reads
    // the server's own per-source record now (#1169) and this payload could not
    // reach it, but a fabricated time on a failed read is still a fabricated time.
    expect(Date.parse(MINE_UNAVAILABLE.updatedAt)).toBeNaN();
  });

  it('is falsy, so nothing downstream reads it as a moment', () => {
    expect(Boolean(MINE_UNAVAILABLE.updatedAt)).toBe(false);
  });
});

describe('queueEmptyState (#512, #535)', () => {
  it('names the gap and the fix when a SUCCESSFUL response says there is no login', () => {
    // The genuine case: the server answered, and the answer is that nothing
    // places this person. #535 changed what that means — the board now also
    // tries to work the handle out from commit authorship, so by the time
    // somebody reads this, the automatic route has been tried and failed and
    // the cell really does need filling by hand.
    expect(queueEmptyState({ error: null, login: null })).toEqual({
      title: 'No GitHub login on your account',
      body: 'Nothing in your commits matched, so the login has to be typed in by hand. Ask an admin to add it on the Access page.',
    });
  });

  it('says the queue is clear when a successful response has a login and no issues', () => {
    expect(queueEmptyState({ error: null, login: 'octocat' })).toEqual({
      title: null,
      body: 'Nothing assigned to you right now.',
    });
  });

  it('never claims anything about the account when the fetch FAILED', () => {
    // The bug: a dead session produced `login: null` out of a rejection
    // handler, so the board told the person their account had no Github
    // identity — a specific, false, actionable claim that would send them to
    // Account settings to fix a problem they do not have.
    const expired = queueEmptyState({ error: 'unauthenticated', login: null });
    expect(expired.body).not.toContain('GitHub login');
    expect(expired.body).not.toContain('commits');
    expect(expired.title).toBeNull();
    expect(expired.body).toBe('Your session ended, so your queue stopped loading.');
  });

  it('names a server failure as a server failure, not as a missing identity', () => {
    const failed = queueEmptyState({ error: 'my-issues 502', login: null });
    expect(failed.body).not.toContain('GitHub login');
    expect(failed.body).not.toContain('commits');
    expect(failed.title).toBeNull();
    expect(failed.body).toBe('Couldn’t load your queue. Reload the page to try again.');
    // The route name and the status stay off the screen (#1055). They are on
    // the console instead, written by `Dashboard`'s rejection handler.
    expect(failed.body).not.toContain('my-issues');
    expect(failed.body).not.toMatch(/\d/);
  });

  it('lets the failure win even if a login was known before it failed', () => {
    expect(queueEmptyState({ error: 'my-issues 502', login: 'octocat' })).toEqual({
      title: null,
      body: 'Couldn’t load your queue. Reload the page to try again.',
    });
  });
});

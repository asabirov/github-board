import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ConnectedClientsBlock,
  loadOnce,
  revokeFailure,
  revokeOnce,
  type RevokeAttempt,
  type RevokeFailure,
} from './ConnectedClients';
import { ApiError } from '../api/core';
import type { ConnectedClient, ConnectedClients } from '../api/account';
import { ACCESS_NOT_NOW_CODE } from '../projects/projects-last-good';

// The board's test env is `node` (no DOM), so render to a static HTML string and
// assert against the markup.

const HOUR = 3600_000;

function client(over: Partial<ConnectedClient> = {}): ConnectedClient {
  return {
    id: 'g-1',
    clientId: 'c-1',
    clientName: 'Claude Desktop',
    scopes: ['board:read'],
    createdAt: new Date('2026-08-10T09:15:00Z').toISOString(),
    lastRefreshedAt: null,
    ...over,
  };
}

const markup = (
  data: ConnectedClients | null,
  errs: { loadError?: string | null; revokeError?: RevokeFailure | null } = {},
) =>
  renderToStaticMarkup(
    <ConnectedClientsBlock
      data={data}
      loadError={errs.loadError ?? null}
      revokeError={errs.revokeError ?? null}
      onRevoke={() => {}}
    />,
  );

/** How many buttons rendered with the `disabled` ATTRIBUTE. The class list
 *  carries `disabled:pointer-events-none`, so the bare word proves nothing. */
const withdrawnButtons = (html: string) =>
  html.split('<button').filter((chunk) => /^[^>]*\sdisabled(\s|=|>)/.test(chunk)).length;

describe('ConnectedClientsBlock', () => {
  it('renders nothing at all when the server has no database', () => {
    // Absent, not "unavailable": AccountView's own !enabled arm replaces the
    // whole page body and says why once, so a note here could never render — and
    // an empty state in its place would claim "no connected clients" when the
    // truth is "no database".
    expect(markup({ enabled: false, clients: [] })).toBe('');
  });

  it('renders nothing when the server has no database and there are grants behind it', () => {
    // The `enabled` flag decides on its own. A block that fell through to the
    // list whenever rows happened to be present would pass the test above.
    expect(markup({ enabled: false, clients: [client()] })).toBe('');
  });

  it('shows the empty state when there is a database and no grants', () => {
    const html = markup({ enabled: true, clients: [] });
    expect(html).toContain('No connected clients');
    expect(html).not.toContain('no database configured');
  });

  it('names the client and its scopes, and offers a revoke', () => {
    const html = markup({
      enabled: true,
      clients: [client({ scopes: ['board:read', 'board:admin'] })],
    });
    expect(html).toContain('Claude Desktop');
    expect(html).toContain('board:read');
    expect(html).toContain('board:admin');
    expect(html).toContain('Revoke');
  });

  it('falls back to the client id when the registration carried no name', () => {
    const html = markup({ enabled: true, clients: [client({ clientName: null, clientId: 'c-anon' })] });
    expect(html).toContain('c-anon');
  });

  it('keeps two grants from the same client name apart, by date', () => {
    // The theft-inside-the-grace-window case: one of these is the person's, one
    // is an attacker's, and the name is identical. If the rows collapsed, or the
    // grant date were dropped, the page could not be acted on at all.
    const html = markup({
      enabled: true,
      clients: [
        client({ id: 'g-mine', createdAt: new Date('2026-08-10T09:15:00Z').toISOString() }),
        client({ id: 'g-theirs', createdAt: new Date('2026-08-12T21:40:00Z').toISOString() }),
      ],
    });
    expect(html.match(/Claude Desktop/g)).toHaveLength(2);
    // Read out of the markup rather than compared to a literal: the stamp is
    // rendered in the reader's zone, and pinning a literal here would only
    // assert whatever zone this machine happens to run in. What must hold is
    // that both rows carry a stamp and the two are not the same stamp.
    const stamps = [...html.matchAll(/connected (\d{1,2} \w{3} \d{4}, \d{2}:\d{2})/g)].map((m) => m[1]);
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).not.toBe(stamps[1]);
  });

  it('carries a last-refreshed stamp, and says so when there is none', () => {
    const refreshed = markup({
      enabled: true,
      clients: [client({ lastRefreshedAt: new Date(Date.now() - 2 * HOUR).toISOString() })],
    });
    expect(refreshed).toContain('last refreshed 2h ago');
    // Never "last used" — only the refresh path writes the stamp, and the board
    // does not know when a token was last used.
    expect(refreshed).not.toContain('last used');

    expect(markup({ enabled: true, clients: [client()] })).toContain('never refreshed');
  });

  it('renders nothing while the first load is in flight', () => {
    expect(markup(null)).toBe('');
  });

  it('says the list failed to load rather than rendering nothing', () => {
    // A 500 from GET /api/account/clients used to render the empty string —
    // identical on screen to the deliberate no-database absence above. Someone
    // holding three grants was shown a page that said they held none.
    const html = markup(null, { loadError: 'clients 500' });
    expect(html).not.toBe('');
    expect(html).toContain('Couldn’t load your connected clients. Reload the page to try again.');
    // And not the status it failed with (#1055): "clients 500" names a route in
    // api.ts and a number, neither of which is on this reader's screen.
    expect(html).not.toContain('clients 500');
  });

  it('says the list failed to load when the error carried no message (#1082)', () => {
    // The inverse of the case above, and of #1055. `loadError` is `string |
    // null`, and both guards on it asked whether it was TRUTHY — so `''`, a
    // rejection with nothing to say, took the same branch as "no error" and this
    // block rendered the empty string again. That is the no-database picture,
    // over grants the reader still holds, which is the one thing the docblock on
    // this file forbids.
    const html = markup(null, { loadError: '' });
    expect(html).not.toBe('');
    expect(html).toContain('Couldn’t load your connected clients. Reload the page to try again.');
  });

  it('keeps the list on screen when a reload fails with no message (#1082)', () => {
    const html = markup({ enabled: true, clients: [client()] }, { loadError: '' });
    expect(html).toContain('Claude Desktop');
    expect(html).toContain('Couldn’t load your connected clients. Reload the page to try again.');
  });

  it('keeps saying it once the session is what failed', () => {
    // api.ts's internal 'unauthenticated' sentinel is not something to show a
    // person; loadFailureText is what turns it into a sentence, and this block
    // must go through it rather than printing the raw reason.
    const html = markup(null, { loadError: 'unauthenticated' });
    expect(html).toContain('Your session ended, so your connected clients stopped loading.');
    expect(html).not.toContain('Couldn’t load');
  });

  it('still renders nothing when there is no database, whatever a later reload did', () => {
    // The failure arm must not swallow the deliberate absence: no database is
    // the page's answer, said once by AccountView, and it outranks a stale
    // reload error on this block.
    expect(markup({ enabled: false, clients: [] }, { loadError: 'clients 500' })).toBe('');
  });

  it('keeps the list on screen when a reload fails, and says the reload failed', () => {
    const html = markup({ enabled: true, clients: [client()] }, { loadError: 'clients 503' });
    expect(html).toContain('Claude Desktop');
    expect(html).toContain('Couldn’t load your connected clients. Reload the page to try again.');
    expect(html).not.toContain('503');
  });

  it('tells the person when a revoke did not go through', () => {
    // The whole bar for this surface is that revoking a client stops it. A
    // revoke that failed and reloaded silently shows the row back, unchanged,
    // and reads exactly like a revoke that worked and was undone.
    const html = markup(
      { enabled: true, clients: [client()] },
      { revokeError: { id: 'g-1', sentence: 'Couldn’t revoke Claude Desktop. It still has access. Try again.', retry: true } },
    );
    expect(html).toContain('Couldn’t revoke Claude Desktop. It still has access. Try again.');
    // Retryable, so the row's own Revoke is still there to press. Counted as a
    // rendered attribute, not as the word: `disabled:` is in the class list too.
    expect(withdrawnButtons(html)).toBe(0);
  });

  it('withdraws that row\'s Revoke when a second press cannot clear the refusal (#1079)', () => {
    // The suite has no DOM and cannot press anything; what it CAN see is that
    // the button rendered disabled, which is the whole of the offer being
    // withdrawn. A live Revoke under "trying again won't change that" is the
    // page disagreeing with itself, which is the rule #1079 states and #1081's
    // review had to implement.
    const html = markup(
      { enabled: true, clients: [client({ id: 'g-1' }), client({ id: 'g-2', clientName: 'Other' })] },
      { revokeError: { id: 'g-1', sentence: 'Your session ended, so Claude Desktop wasn’t revoked. It still has access.', retry: false } },
    );
    expect(withdrawnButtons(html)).toBe(1);
    expect(html).toContain('Your session ended, so Claude Desktop wasn’t revoked. It still has access.');
  });
});

describe('loadOnce', () => {
  const data: ConnectedClients = { enabled: true, clients: [client()] };

  it('hands back the list when the fetch resolves', async () => {
    expect(await loadOnce(async () => data)).toEqual({ data, error: null });
  });

  it('keeps the reason the fetch threw instead of discarding it', async () => {
    expect(await loadOnce(async () => { throw new Error('clients 500'); })).toEqual({
      data: null,
      error: 'clients 500',
    });
  });
});

describe('revokeOnce', () => {
  const clients = [client({ id: 'g-1', clientName: 'Claude Desktop' })];
  // The line is `revokeFailure`'s now, not `revokeOnce`'s (#1102 review, B3):
  // the half about the grant is not known until the list has been re-read. These
  // read the sentence through the composer, with the grant still listed.
  const said = (a: RevokeAttempt | null) => (a ? revokeFailure(a, 'still-granted').sentence : null);

  it('says nothing when the revoke goes through', async () => {
    expect(await revokeOnce('g-1', clients, async () => {})).toBeNull();
  });

  it('names the client and says the grant survived when the revoke throws', async () => {
    const failure = await revokeOnce('g-1', clients, async () => { throw new Error('503'); });
    expect(said(failure)).toBe('Couldn’t revoke Claude Desktop. Try again. It still has access.');
    // Which row it was about, so that row's offer can go with it (#1079).
    expect(failure?.id).toBe('g-1');
  });

  it('names the client id when the registration carried no name', async () => {
    const anon = [client({ id: 'g-2', clientName: null, clientId: 'c-anon' })];
    const failure = await revokeOnce('g-2', anon, async () => { throw new Error('503'); });
    expect(said(failure)).toContain('c-anon');
  });

  it('still tells the person when the failed grant is not in the list it was given', async () => {
    const failure = await revokeOnce('g-gone', clients, async () => { throw new Error('503'); });
    expect(said(failure)).toBe('Couldn’t revoke this client. Try again. It still has access.');
  });
});

/**
 * What the line may claim about the grant, which is not known when the write
 * answers (#1102 review, B3). The first cut ended every arm on "It still has
 * access", and `ConnectedClients` draws this line when the reload failed too --
 * where a 404 means the grant is already gone and that clause is false.
 */
describe('revokeFailure says only what the reload settled', () => {
  const attempt: RevokeAttempt = { id: 'g-1', name: 'Claude Desktop', kind: 'failed', retry: true };

  it('claims the grant is live only when the reload said so', () => {
    expect(revokeFailure(attempt, 'still-granted').sentence).toContain('It still has access.');
  });

  it('says the board cannot tell when the reload failed too', () => {
    const line = revokeFailure(attempt, 'unknown').sentence;
    expect(line).toContain('The list didn’t reload, so the board can’t say whether it still has access.');
    expect(line).not.toContain('It still has access.');
  });

  it('leaves the interrupted arm alone, which has already declined to say', () => {
    const withdrawn: RevokeAttempt = { ...attempt, kind: 'interrupted', retry: false };
    expect(revokeFailure(withdrawn, 'unknown').sentence).toBe(
      'Your access was rechecked while this was in flight, so the board can’t say whether Claude Desktop was revoked. Reload the page to see.',
    );
  });

  it('never ends a withdrawn arm on Try again', () => {
    for (const kind of ['session-ended', 'refused', 'interrupted', 'standing'] as const) {
      const line = revokeFailure({ ...attempt, kind, retry: false }, 'still-granted').sentence;
      expect(line).not.toContain('Try again.');
    }
  });
});

/**
 * The sentences a failed REVOKE draws (#1079), pinned here because this is the
 * one write on this block. Added BEFORE the change that makes them true, on the
 * issue's own rule, and they went red against the line this file used to build:
 * "Couldn’t revoke Claude Desktop — unauthenticated. It still has access."
 */
describe('revokeOnce says what did not happen (#1079)', () => {
  const clients = [client({ id: 'g-1', clientName: 'Claude Desktop' })];
  const failing = (e: unknown) => async () => { throw e; };

  const said = (a: RevokeAttempt | null) => (a ? revokeFailure(a, 'still-granted').sentence : null);

  it('answers an expired session in the words every other surface uses', async () => {
    const failure = await revokeOnce('g-1', clients, failing(new ApiError(401, 'unauthenticated')));
    expect(said(failure)).toBe('Your session ended, so Claude Desktop wasn’t revoked. It still has access.');
    expect(failure?.retry).toBe(false);
  });

  it('never prints the status a write failed with', async () => {
    const failure = await revokeOnce('g-1', clients, failing(new ApiError(500, 'clients 500')));
    expect(said(failure)).toBe('Couldn’t revoke Claude Desktop. Try again. It still has access.');
    expect(said(failure)).not.toContain('500');
    expect(failure?.retry).toBe(true);
  });

  // The 403 this route can actually answer is `TeamAccessGuard`'s, and it is
  // transient as often as not (#1102 review, B1). Revoke stays live under it.
  it('keeps Revoke armed under a 403 it cannot place, and claims nothing final', async () => {
    const failure = await revokeOnce(
      'g-1',
      clients,
      failing(new ApiError(403, 'forbidden', undefined, undefined, 'Access restricted to the Acme team (team@example.com)')),
    );
    expect(failure?.retry).toBe(true);
    expect(said(failure)).toContain('so try again');
    expect(said(failure)).not.toContain('won’t change that');
  });

  // A 404 or a 503 whose body the board could not read withdraws Revoke, and the
  // line has to stop offering the press with it (#1102 review, S1 and B3).
  it('withdraws Revoke on an unreadable 404 body without saying Try again', async () => {
    const failure = await revokeOnce('g-1', clients, failing(new ApiError(404, 'clients 404')));
    expect(failure?.retry).toBe(false);
    expect(said(failure)).not.toContain('Try again.');
  });

  // And the 503 half of the same reading. `JwtAuthGuard` and
  // `GithubPrincipalGuard` are global APP_GUARDs, so this route meets their
  // four transient 503s too; the first two rounds withdrew this row's Revoke
  // under every one of them (#1102 review, the 503 round).
  it('keeps Revoke armed on a 503 the auth layer codes “not now”', async () => {
    const failure = await revokeOnce(
      'g-1',
      clients,
      failing(new ApiError(503, 'clients 503', undefined, undefined, 'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.', ACCESS_NOT_NOW_CODE)),
    );
    expect(failure?.retry).toBe(true);
    expect(said(failure)).toBe(
      'Claude Desktop wasn’t revoked. The board couldn’t confirm your access just then, ' +
      'which clears on its own, so try again in a moment. It still has access.',
    );
  });

  it('withdraws Revoke on an uncoded 503 and stops offering the press', async () => {
    const failure = await revokeOnce(
      'g-1', clients, failing(new ApiError(503, 'clients 503', undefined, undefined, 'Your GitHub connection changed while this was running. Try again.')),
    );
    expect(failure?.retry).toBe(false);
    expect(said(failure)).toBe(
      'Claude Desktop wasn’t revoked, and pressing Revoke again won’t change that. It still has access.',
    );
  });
});

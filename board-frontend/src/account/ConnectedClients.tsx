/**
 * Account › Connected clients (#456) — every client holding an OAuth grant on
 * your account, and the one place you cut one off.
 *
 * Two stamps sit on every row and neither is decoration. One person can hold
 * several grants from the same client — authorizing it twice, running it on two
 * machines, or re-authorizing after a stolen refresh token killed the last
 * grant — and in the worst of those cases one of the identically named rows is
 * a thief's. The date each was granted is the only thing on the row that
 * separates them, so rows are never collapsed by name and the date is never
 * dropped.
 *
 * The second stamp is "last refreshed", not "last used". Only the refresh path
 * writes it; the guard's read of an access-token row is the hot path on every
 * `/mcp` call and does not write. Labelling it "last used" would say something
 * the board does not know.
 *
 * **Availability is the page's answer, not this block's.** With no database the
 * block renders nothing and AccountView says once, for the whole page, why it is
 * empty. Do not add a per-section "not available" note here: `enabled` on this
 * response and `enabled` on the token response are both `IDENTITY_SOURCE ===
 * 'db'`, and AccountView's own `!enabled` arm replaces the entire page body — so
 * such a note could never render, and the first draft of this file shipped one
 * that could not. An empty state in its place would be worse than dead code: it
 * would say "no connected clients" when the truth is "no database".
 *
 * **Absent is not broken, and the two must never draw the same screen.** A block
 * that renders nothing on a failed load is indistinguishable from that
 * deliberate absence, so a 500 would tell someone holding three grants that they
 * hold none — and a revoke that failed would put the row back unchanged, which
 * reads exactly like a revoke that worked. Both failures are told, in the page's
 * existing words: `loadFailureText` for the load, the mint sheet's danger line
 * for the revoke.
 */

import { useEffect, useState } from 'react';
import { fetchConnectedClients, revokeConnectedClient, type ConnectedClient, type ConnectedClients as ConnectedClientsData } from '../api/account';
import { loadFailureText, logLoadFailure, reasonOf } from '../auth/session-copy';
import { logWriteFailure, writeFailure, type WriteFailureKind } from '../auth/write-failure';
import { BotIcon } from '../icons';
import { EmptyState } from '../ui/EmptyState';
import { CARD, CARD_ROW, rel, ScopeChip } from './chrome';
import { formatDateTime, usePreferredTimezone } from './prefs';

/** The row's revoke. The disabled variants are the withdrawn state (#1079): no
 *  hand, no hover, and the quietest text on the row, so it reads as an offer
 *  that has been taken away rather than a control that is broken.
 *  `disabled:pointer-events-none` is the guideline's own rule for a control that
 *  can be disabled, and `cursor-stated.spec.tsx` holds this file to it. */
const REVOKE_BUTTON =
  'flex-none cursor-pointer border-none bg-transparent text-[12px] text-muted hover:text-danger ' +
  'disabled:pointer-events-none disabled:opacity-40';
/** The page's line for a surface that failed to load — AccountView's, verbatim. */
const LOAD_FAILURE = 'px-0.5 py-6 text-[13px] text-muted';
/** The page's line for a write that failed — the mint sheet's, verbatim. */
const WRITE_FAILURE = 'mb-2.5 text-[12.5px] text-danger';
/** What this block is called on screen, for the sentence a failed load draws
 *  and for the console line beside it (#1055). */
const CLIENTS = 'your connected clients';

/**
 * What a failed revoke says, per kind (#1079). The line used to end on whatever
 * the rejection carried — "Couldn't revoke Claude Desktop - unauthenticated. It
 * still has access." — which named an api.ts sentinel on one arm and a bare
 * status on the next.
 *
 * None of these ends in "Try again" unless the kind it belongs to leaves Revoke
 * armed, and that is now structural rather than remembered: `retry` is a table
 * on the kind in `write-failure.ts`, so the sentence and the button read the
 * same value. The first cut hardcoded "Try again." into the `failed` arm while
 * a 404 came back withdrawn, and drew it over a dead Revoke (#1102 review, B3).
 *
 * `access-unconfirmed` keeps Revoke armed and says so. It is this route's only
 * 403, it comes from `TeamAccessGuard`, and a Directory call that never came
 * back produces it just as a person genuinely off the team does; the sentence
 * must not call that final. `write-failure.ts` carries the argument.
 *
 * The service's own words are deliberately NOT drawn here, unlike the other two
 * write surfaces. The one sentence this route can send a person is its 404, "No
 * such connected client." — and what a reader needs from a 404 is not that
 * sentence but the state of the grant, which the reload below settles.
 *
 * `not-now` is the four 503s the auth layer codes `access_not_now`, which are
 * transient by construction and used to withdraw this row's Revoke (#1102
 * review, the 503 round).
 */
const REVOKE_FAILURE: Record<WriteFailureKind, (name: string) => string> = {
  'session-ended': (name) => `Your session ended, so ${name} wasn’t revoked.`,
  refused: (name) =>
    `${name} wasn’t revoked, and a second press is refused the same way. Ask an admin about your access.`,
  'access-unconfirmed': (name) =>
    `${name} wasn’t revoked. The access check refused it, and it refuses the same way when it cannot run at all, so try again. If that keeps happening, ask an admin whether you are still on the team.`,
  interrupted: (name) =>
    `Your access was rechecked while this was in flight, so the board can’t say whether ${name} was revoked. Reload the page to see.`,
  // No "Reload the page" here, unlike the other two surfaces: the only reload
  // that answers this is the list's, and the block already draws that offer
  // under this line whenever the list is the thing that failed.
  standing: (name) => `${name} wasn’t revoked, and pressing Revoke again won’t change that.`,
  'not-now': (name) =>
    `${name} wasn’t revoked. The board couldn’t confirm your access just then, which clears on its own, so try again in a moment.`,
  failed: (name) => `Couldn’t revoke ${name}. Try again.`,
};

/** What the board knows about the grant once the reload that follows a failed
 *  revoke has answered. A grant the reload says is gone draws no line at all, so
 *  it is not one of these. */
export type GrantAfter = 'still-granted' | 'unknown';

/**
 * The half of the line that is about the credential rather than the write.
 *
 * "It still has access" used to be on every arm unconditionally, and the first
 * cut's own header said so. It is not always true: `ConnectedClients` draws this
 * line when the reload FAILED as well, and a 404 in that same frame means the
 * grant is already gone (#1102 review, B3). For a credential, saying the board
 * cannot tell is the honest version of erring on the safe side; claiming it is
 * still live is not.
 */
const GRANT_AFTER: Record<GrantAfter, string> = {
  'still-granted': 'It still has access.',
  unknown: 'The list didn’t reload, so the board can’t say whether it still has access.',
};

/** A revoke that did not go through, before the list has been re-read. */
export interface RevokeAttempt {
  /** Which row it was about — the Revoke offer is withdrawn on that row alone. */
  id: string;
  /** What the row calls this client. */
  name: string;
  kind: WriteFailureKind;
  /** Whether that row's Revoke may stay live under the line. */
  retry: boolean;
}

/** A revoke that did not go through, as the block has to draw it. */
export interface RevokeFailure {
  /** Which row it was about — the Revoke offer is withdrawn on that row alone. */
  id: string;
  /** The whole line, already a sentence. */
  sentence: string;
  /** Whether that row's Revoke may stay live under it. */
  retry: boolean;
}

/**
 * The whole line, composed once the reload has said what it can about the grant.
 * Split from `revokeOnce` because the two halves are known at different moments:
 * the write answers first, the list a request later, and the sentence needs both.
 *
 * `interrupted` takes no tail. It already says the board cannot tell whether the
 * revoke landed, and a clause about what the list shows would be answering a
 * question it has just declined to answer.
 */
export function revokeFailure(attempt: RevokeAttempt, after: GrantAfter): RevokeFailure {
  const line = REVOKE_FAILURE[attempt.kind](attempt.name);
  return {
    id: attempt.id,
    sentence: attempt.kind === 'interrupted' ? line : `${line} ${GRANT_AFTER[after]}`,
    retry: attempt.retry,
  };
}

/**
 * One attempt at the list: the rows, or the reason there are none to show.
 *
 * The reason is the point. Swallowing it rendered the block as nothing at all,
 * which on this page is the same picture as "no database" — so a 500 told
 * someone holding three grants that they held none.
 */
export async function loadOnce(
  fetchFn: () => Promise<ConnectedClientsData>,
): Promise<{ data: ConnectedClientsData | null; error: string | null }> {
  try {
    return { data: await fetchFn(), error: null };
  } catch (e) {
    return { data: null, error: reasonOf(e) };
  }
}

/**
 * One revoke attempt: null when the grant is gone, else what to tell the person.
 *
 * Naming the client matters more here than anywhere else on the page, because
 * the failure a reader most needs to see is a revoke of one of two grants that
 * carry the same name.
 */
export async function revokeOnce(
  id: string,
  clients: ConnectedClient[],
  revokeFn: (id: string) => Promise<void>,
): Promise<RevokeAttempt | null> {
  try {
    await revokeFn(id);
    return null;
  } catch (e) {
    // What the write actually answered, kept on the console and off the row
    // (#1079). Here and not in the render below, which runs again on every
    // state change.
    logWriteFailure(CLIENTS, e);
    const c = clients.find((x) => x.id === id);
    const name = c ? (c.clientName ?? c.clientId) : 'this client';
    const failure = writeFailure(e);
    return { id, name, kind: failure.kind, retry: failure.retry };
  }
}

function ClientRow({
  c,
  onRevoke,
  withdrawn = false,
}: {
  c: ConnectedClient;
  onRevoke: (id: string) => void;
  /** This row's revoke was refused in a way a second press cannot clear, so the
   *  offer goes rather than standing live under a line that says it will fail
   *  (#1079). */
  withdrawn?: boolean;
}) {
  const tz = usePreferredTimezone();
  return (
    <div className={CARD_ROW}>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-fg">
          {c.clientName ?? c.clientId}
        </div>
        <div className="mt-[3px] flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted">
          {c.scopes.map((s) => (
            <ScopeChip key={s} scope={s} />
          ))}
          {/* To the minute, and absolute. Two grants from the same client made
              the same afternoon are told apart here or nowhere. */}
          <span>connected {formatDateTime(c.createdAt, tz)}</span>
          <span>·</span>
          <span>
            {c.lastRefreshedAt ? `last refreshed ${rel(c.lastRefreshedAt)}` : 'never refreshed'}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRevoke(c.id)}
        disabled={withdrawn}
        className={REVOKE_BUTTON}
      >
        Revoke
      </button>
    </div>
  );
}

/** The card: every grant as a row, or the empty state when there are none. */
function ClientList({
  clients,
  onRevoke,
  withdrawnId = null,
}: {
  clients: ConnectedClient[];
  onRevoke: (id: string) => void;
  withdrawnId?: string | null;
}) {
  if (clients.length === 0) {
    return (
      <EmptyState
        className={CARD}
        icon={<BotIcon size={16} />}
        title="No connected clients"
      />
    );
  }
  return (
    <div className={`overflow-hidden ${CARD}`}>
      {clients.map((c) => (
        <ClientRow key={c.id} c={c} onRevoke={onRevoke} withdrawn={c.id === withdrawnId} />
      ))}
    </div>
  );
}

/**
 * The rendered block, given its data. Separate from the container below so every
 * screen it can draw — empty, listed, failed to load, failed to revoke — is
 * reachable in a test without a server, and so is its absence.
 */
export function ConnectedClientsBlock({
  data,
  loadError = null,
  revokeError = null,
  onRevoke,
}: {
  data: ConnectedClientsData | null;
  /** Why the last load failed, if it did. Told, never swallowed. */
  loadError?: string | null;
  /** Why the last revoke failed, if it did — already a sentence, and which row
   *  it was about, so that row's offer can go with it (#1079). */
  revokeError?: RevokeFailure | null;
  onRevoke: (id: string) => void;
}) {
  // No database is the page's answer and it outranks everything else here: the
  // block is absent, AccountView says why once for the whole page. See the file
  // docblock — a note here could not render.
  if (data && !data.enabled) return null;
  // Nothing loaded yet and nothing went wrong: the first load is in flight.
  //
  // `=== null` rather than `!loadError` (#1082). A rejection can carry an empty
  // message, `''` is falsy, and truthiness filed such a load failure under
  // "nothing went wrong" — so this block rendered nothing, which on this page is
  // the deliberate no-database picture and the one thing the docblock above
  // forbids. Whether the read failed is the question; whether it had words is
  // not, and `loadFailureText` answers for the ones with none.
  if (!data && loadError === null) return null;
  return (
    <div className="mt-9">
      <div className="mb-3.5">
        <div className="text-[13px] font-semibold">Connected clients</div>
      </div>

      {/* Both failures are said in the page's own words: the load line is the
          one AccountView shows over a failed token list, the revoke line the one
          the mint sheet shows over a failed write. A reader who has seen either
          elsewhere on this page has seen this one. */}
      {revokeError && <p className={WRITE_FAILURE}>{revokeError.sentence}</p>}
      {/* `!== null`, on the rule the first-load guard above states (#1082). */}
      {loadError !== null && (
        <div className={LOAD_FAILURE}>{loadFailureText(CLIENTS, loadError)}</div>
      )}

      {/* Rows survive a failed reload. Blanking them would say the grants are
          gone, which is the one thing a load failure does not know. */}
      {data && (
        <ClientList
          clients={data.clients}
          onRevoke={onRevoke}
          withdrawnId={revokeError && !revokeError.retry ? revokeError.id : null}
        />
      )}
    </div>
  );
}

/** The block, loading its own data. Mounted by AccountView. */
export function ConnectedClients() {
  const [data, setData] = useState<ConnectedClientsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<RevokeFailure | null>(null);

  const load = async () => {
    const next = await loadOnce(fetchConnectedClients);
    // Logged here and not in `loadOnce`, which the specs call directly, and not
    // in the block's render, which runs again on every state change (#1055).
    if (next.error !== null) logLoadFailure(CLIENTS, next.error);
    setLoadError(next.error);
    // Only a good response replaces the rows; a failed one leaves the last known
    // list standing under its failure line.
    if (next.data) setData(next.data);
    return next.data;
  };
  useEffect(() => { void load(); }, []);

  const revoke = async (id: string) => {
    setRevokeError(null);
    const attempt = await revokeOnce(id, data?.clients ?? [], revokeConnectedClient);
    const after = await load();
    if (!attempt) return;
    // The reload settles what the line may say about the grant. A list that came
    // back without it says the grant is gone, and there is nothing left to tell
    // anybody. A list that still carries it, or a reload that failed, both get a
    // line — but not the same one, because only the first knows the grant is live.
    if (after && !after.clients.some((c) => c.id === attempt.id)) return;
    setRevokeError(revokeFailure(attempt, after ? 'still-granted' : 'unknown'));
  };

  return (
    <ConnectedClientsBlock
      data={data}
      loadError={loadError}
      revokeError={revokeError}
      onRevoke={revoke}
    />
  );
}

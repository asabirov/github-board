/**
 * The Audit log section of the admin hub (#212): a read-only, newest-first trail
 * of the board's write + governance actions — identity edits, token mint/revoke,
 * the admin agent kill-switch, and feedback. Filter by actor (substring) or
 * action.
 *
 * An empty list is not one fact (#781): the board may have no database, or it
 * may be losing records to a store it cannot reach while its Github writes go
 * through regardless. `AuditHealthNotice` says which, above the list.
 */
import { useCallback, useEffect, useState } from 'react';
import { ADMINS_UNREAD, type AuditEvent, type AuditHealth, fetchAuditLog } from '../api/account';
import { Tip } from '../ui/Tip';
import { loadFailureText, logLoadFailure } from '../auth/session-copy';
import { formatDateTime, usePreferredTimezone } from '../account/prefs';

const PANE_CLS = 'px-[26px] py-[22px]';

/** What this pane is called on screen, for the sentence a failed read draws.
 *  The same words as the section's own nav label in `sections.tsx`, which
 *  `section-subjects.spec.ts` now holds the two panes to (#1081 review, S1). */
export const AUDIT_LOG = 'the audit log';

const ACTION_LABEL: Record<string, string> = {
  'identity.seed': 'Identity seeded',
  'goal.team.update': 'Team goal changed',
  'identity.upsert': 'Identity edit',
  'token.mint': 'Token minted',
  'token.revoke': 'Token revoked',
  'agent.revoke': 'Agent revoked',
  'feedback.submit': 'Feedback',
  'issue.close': 'Issue closed',
  'boot.alert': 'Boot error filed',
  // Not an action somebody took — a stretch of the trail that is missing, put
  // here by the board once its store came back (#812). It is in this list so it
  // is filterable: "show me every gap" is the question an operator arrives with.
  'audit.gap': 'Records lost',
};
const ACTIONS = Object.keys(ACTION_LABEL);

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.round(d / 30)}mo ago`;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; events: AuditEvent[]; health: AuditHealth | null }
  | { kind: 'forbidden' }
  /** The board could not read its admin roster, so it refused everybody rather
   *  than judging this reader (#811) — a different fact from 'forbidden', and
   *  the state this pane exists to be reachable in. */
  | { kind: 'admins-unread' }
  | { kind: 'error'; message: string };

export function AuditSection() {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(() => {
    fetchAuditLog({ actor: actor.trim() || undefined, action: action || undefined }).then(
      (log) => setState({ kind: 'ready', events: log.events, health: log.health }),
      (e: Error) => {
        if (e.message === 'forbidden') setState({ kind: 'forbidden' });
        else if (e.message === ADMINS_UNREAD) setState({ kind: 'admins-unread' });
        // Same one answer to an expired session as everywhere else (#512).
        // The message goes to the console rather than into the line the pane
        // draws (#1055): here, where the rejection was caught.
        else { logLoadFailure(AUDIT_LOG, e.message); setState({ kind: 'error', message: e.message }); }
      },
    );
  }, [actor, action]);

  // Debounce the actor filter; action changes apply immediately.
  useEffect(() => {
    const t = setTimeout(load, actor ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, actor]);

  return (
    <div className={PANE_CLS}>
      {/* The page H1 ("Audit log", #391) names this section; the inner label is
          dropped so it isn't said twice. The description stays. */}

      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <input
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="Filter by actor…"
          className="h-[32px] w-[200px] rounded-[8px] border border-line bg-field px-3 text-[12.5px] text-fg placeholder:text-muted focus:border-line-strong focus:outline-none"
        />
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="h-[32px] cursor-pointer rounded-[8px] border border-line bg-field px-2.5 text-[12.5px] text-dim focus:border-line-strong focus:outline-none"
        >
          <option value="">All actions</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
        </select>
      </div>

      {state.kind === 'loading' && <div className="rok-empty">Loading…</div>}
      {state.kind === 'forbidden' && <p className="text-muted">This section is for admins only. Ask an admin if you need access.</p>}
      {state.kind === 'admins-unread' && <AdminsUnreadPane />}
      {state.kind === 'error' && <p className="okr-err">{loadFailureText(AUDIT_LOG, state.message)}</p>}
      {state.kind === 'ready' && (
        <>
          <AuditHealthNotice health={state.health} />
          {state.events.length === 0 ? (
            <p className="rounded-[12px] bg-[var(--board-well)] px-[18px] py-[16px] text-[13px] text-muted">
              {emptyText(state.health, Boolean(actor || action))}
            </p>
          ) : (
            <div className="flex flex-col">
              {state.events.map((e) => <AuditRow key={e.id} event={e} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * What this pane says when the board cannot say who its admins are (#811).
 *
 * The three states #781 serves all assume the reader got through the gate. This
 * is the fourth, and until now it was the only one an operator could not reach:
 * a `db` board whose Postgres was unreachable before it booted has never read
 * its admin roster, so nobody resolves as admin, so the page carrying the
 * lost-record count answered `403 admin access only` — gated on the store whose
 * failure it exists to report.
 *
 * The API refuses this reader all the same, and must (#588). The sentence is
 * what changes: it names the store rather than the reader.
 *
 * Exported so `AuditSection.spec.tsx` can render it without a server.
 */
export function AdminsUnreadPane() {
  return (
    <p className="rounded-[12px] bg-[var(--board-well)] px-[18px] py-[16px] text-[13px] leading-[1.6] text-fg">
      <span className="font-medium">This board cannot read who its admins are.</span>{' '}
      Its identity store has not answered since the board started, so nobody resolves as an admin and
      this log cannot be shown — to you or to anyone. That store is where the trail is written too, so
      records made while it is down are being lost. The service log says what it returned.
    </p>
  );
}

/**
 * Why an empty log is empty (#781).
 *
 * Three boards used to render one sentence. A board with no database records
 * nothing by design; a board whose Postgres is unreachable performs its Github
 * writes and loses every row; a board that has simply done nothing is the only
 * one "No audit events yet" was ever true of. The first two now say so before
 * the list, because an operator reads the top of the pane and stops.
 *
 * Exported so `AuditSection.spec.tsx` can render it without a server.
 */
export function AuditHealthNotice({ health }: { health: AuditHealth | null }) {
  // `null` is an older deploy with no opinion — today's silence, not a claim.
  if (!health) return null;

  if (health.recording === 'disabled') {
    return (
      <p className="mb-3 text-[12.5px] leading-[1.5] text-muted">
        No database is configured on this board, so nothing is recorded here.
      </p>
    );
  }

  // A healthy trail is no longer silence (#812). `ok` is a claim about ONE
  // process since ONE boot, and drawn bare it read as a claim about the board:
  // an operator on a board whose other replica was losing rows, or one that had
  // restarted since the loss, was told nothing was wrong. The line below is the
  // narrower claim the count can actually support, said quietly.
  if (health.recording === 'ok') return <RecordingScope health={health} />;

  const n = health.failures;
  return (
    <div className="mb-3 flex items-start gap-2.5 rounded-[10px] bg-warn-fill p-3" role="status">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-px flex-none text-warn"
        aria-hidden="true"
      >
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      <p className="text-[12.5px] leading-[1.5] text-fg">
        <span className="font-medium">This log is incomplete.</span>{' '}
        {incompleteText(health)} The actions still happened. Check the service log for what the store
        returned.
      </p>
    </div>
  );
}

/**
 * What is missing, and whose account of it this is (#812).
 *
 * Two counts, deliberately not added together. `failures` is what THIS process
 * has lost since it booted — a live number, and the only one that is current.
 * `gaps` is what the trail itself records: one row per stretch, written by
 * whichever instance suffered it once its store came back, so it survives a
 * restart and is readable from every replica. They overlap while a gap this
 * process is carrying has already been written down, and summing them would
 * double-count exactly the case the marker exists to cover.
 */
export function incompleteText(health: AuditHealth): string {
  const n = health.failures;
  const mine = n
    ? `${n === 1 ? '1 event' : `${n} events`} could not be recorded by this instance` +
      `${health.since ? ` since it started ${ago(health.since)}` : ''}` +
      `${health.lastFailureAt ? `, the last ${ago(health.lastFailureAt)}` : ''}.`
    : '';
  const g = health.gaps?.events ?? 0;
  const trail = g
    ? `The trail records ${g === 1 ? '1 stretch' : `${g} stretches`} of lost records` +
      `${health.gaps?.lastAt ? `, the last ${ago(health.gaps.lastAt)}` : ''}` +
      `${n ? '' : ' — left by this board before a restart, or by another instance of it'}.`
    : '';
  return [mine, trail].filter(Boolean).join(' ');
}

/**
 * The quiet line under a healthy trail (#812) — what `ok` is actually a claim
 * about.
 *
 * It is one process's count since one boot. `deploy/Caddyfile.platform` sends
 * `/api/*` to a single upstream, but that upstream is an environment variable
 * set outside the repo and Caddy takes a list, and a rolling deploy overlaps two
 * processes whatever the target count is —
 * `docs/ops/board-api-replicas.md` is what this repo can say about that. Naming
 * the window is also what makes a restart visible: the same board reporting `ok`
 * from 02:05 rather than from yesterday is an operator's cue that a counter went
 * back to zero.
 *
 * `gaps: null` is a store that would not answer the question, which is not an
 * all-clear, so it says so rather than staying silent.
 */
export function RecordingScope({ health }: { health: AuditHealth }) {
  const tz = usePreferredTimezone();
  // An older board-api sends the count with no window and no trail read (#812).
  // There is nothing narrower to say than what #781 already said with silence,
  // so this says nothing rather than inventing a scope for a number that has none.
  if (!health.since && health.gaps) return null;
  return (
    <p className="mb-3 text-[12.5px] leading-[1.5] text-muted">
      {health.since
        ? `Recording normally on this instance since ${formatDateTime(health.since, tz)}. A loss on another instance, or one recovered before a restart, shows as a lost-records row.`
        : 'Recording normally.'}
      {health.gaps ? '' : ' The trail could not be asked whether it already has gaps in it.'}
    </p>
  );
}

/** The line under the notice, which must not say "yet" when records are failing. */
export function emptyText(health: AuditHealth | null, filtered: boolean): string {
  if (filtered) return 'No audit events match those filters.';
  if (health?.recording === 'failing') return 'Nothing reached the log.';
  if (health?.recording === 'disabled') return 'Nothing is recorded on this board.';
  return 'No audit events yet.';
}

function AuditRow({ event }: { event: AuditEvent }) {
  const tz = usePreferredTimezone();
  return (
    <div className="flex items-center gap-3 rounded-[8px] px-3 py-[9px] odd:bg-[var(--board-well)]">
      <Tip label={formatDateTime(event.at, tz)}><span className="w-[70px] flex-none text-[11.5px] tabular-nums text-muted">{ago(event.at)}</span></Tip>
      <span className="flex-none rounded-[5px] bg-elevated px-1.5 py-px text-[11px] font-medium text-dim">
        {ACTION_LABEL[event.action] ?? event.action}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{event.summary}</span>
      <span className="flex-none truncate text-[11.5px] text-muted">{event.actorEmail}</span>
    </div>
  );
}

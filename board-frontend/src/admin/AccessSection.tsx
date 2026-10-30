import { Fragment, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/kit';
import { type AccessModel, type AccessPerson, type AccessRole, type OrgAgent, fetchAdminAccess, fetchAdminAgents, revokeAdminAgent, upsertIdentity } from '../api/account';
import { Avatar } from '../ui/avatar';
import { Tip } from '../ui/Tip';
import { loadFailureText, logLoadFailure } from '../auth/session-copy';
import { logWriteFailure, writeFailure, type WriteFailureKind } from '../auth/write-failure';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; model: AccessModel; agents: OrgAgent[] }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

const ROLE_LABEL: Record<AccessRole, string> = { admin: 'Admin', writer: 'Writer', reader: 'Reader' };
const ROLE_HINT: Record<AccessRole, string> = {
  // No "DRI" since #979. It is the GitHub organization property this board
  // writes a repo's owner into, and the Repos page — the only place a reader
  // ever meets it — calls it the owner. The hint's two facts are unchanged:
  // this role writes, and it needs a linked GitHub login to be recorded as an
  // owner at all (README § dri).
  //
  // One verb for the one power (#1101 review, S5). These two sentences are read
  // side by side in the role control, so "write" here and "make changes" there
  // would read as two different permissions rather than the same one at two
  // reaches. `reader`'s "Read-only" is the other half of that pair.
  admin: 'Full board access. Can write anything and open the Admin hub',
  writer: 'Can write, and be named a repo owner (needs a linked GitHub login)',
  reader: 'Read-only',
};
/** border-transparent + a tinted bg/text pair — same subtle-badge convention as
 * `ui/StatusChip.tsx`, which is where that convention lives now. It named
 * RoadmapRows' STATUS_CLASS and ProjectsView's STATUS_PILL_CLASS instead; both
 * were gone before #785, and StatusChip's own comment carries the RoadmapRows
 * lineage. */
const ROLE_BADGE_CLASS: Record<AccessRole, string> = {
  admin: 'border-transparent bg-accent-fill text-accent',
  writer: 'border-transparent bg-success-fill text-success',
  reader: 'border-transparent bg-elevated text-muted',
};

// Pane wrapper inside the admin hub (#183): the hub owns the page header and
// the left rail, so this section drops the old centered-page chrome and sits
// flush in the content pane.
const PANE_CLS = 'px-[26px] py-[22px]';
/** What this pane is called in a sentence a person reads (#1055). It used to be
 *  said as "the access model", which is `AccessModel`, the type this file
 *  fetches — an internal name inside the sentence, the same leak as the status
 *  code that used to end it.
 *
 *  The words are the section's OWN nav label in `sections.tsx`, which is also
 *  its H1 directly above this sentence, on `AuditSection`'s rule (#1081 review,
 *  S1). The first cut said "people and roles" — a true description of the table
 *  under it, and a third name for a surface the chrome calls "Access" twice.
 *  A sentence about a thing on the screen has to use the name that is on the
 *  screen. Capitalised for the same reason: it is the label, not a common noun,
 *  and "couldn't load access" reads as access to something unnamed. */
export const ACCESS_SUBJECT = 'Access';

/** What the edit dialog is called in the console line beside a failed save
 *  (#1079). The pane's own subject is `ACCESS_SUBJECT` above, and this is a
 *  different thing failing: one is the roster read, the other is one person's
 *  row being written. */
const EDIT_SUBJECT = 'the identity edit';

/**
 * What a failed SAVE says, per kind (#1079). The dialog used to print `err`
 * whole, and `err` was whatever the rejection carried — the seventeen sentences
 * the service writes for this dialog on a 400 or a 409, and on everything else
 * an api.ts sentinel or Nest's own "Internal server error".
 *
 * The service's own words still reach the reader on those two statuses:
 * `identity.validation.ts` says which field is wrong and what it takes, and
 * `identity.controller.ts` refuses a write that would hand over the board with
 * the instruction for climbing back out. Both are the only instruction their
 * reader gets, and both are about the payload, so Save stays armed under them.
 *
 * This is the one of the three write surfaces where BOTH 403s are reachable,
 * and they are different answers. `refused` is `AdminGuard`'s, which is raised
 * only after the admin roster was read and this caller was not in it — a stated
 * verdict on a stable fact, which an admin demoted while this dialog stood open
 * meets, and which a second press gets again. `access-unconfirmed` is
 * `TeamAccessGuard`'s, which answers the same 403 whether the person is off the
 * team or a Directory call simply never came back, so it keeps Save armed and
 * claims nothing about permanence. `write-failure.ts` carries the whole
 * argument and the discriminator; it was getting this dialog wrong in the
 * transient direction until #1102's review (B2).
 *
 * This is also the one route where both halves of 503 are met. `not-now` is the
 * four the auth layer codes `access_not_now`, and it keeps Save armed because
 * they clear on their own. `standing` is `AdminGuard`'s unread roster, whose own
 * sentence is repeated because its code places it, and the fixture roster's,
 * whose is not because nothing does.
 */
const EDIT_FAILURE: Record<WriteFailureKind, string> = {
  'session-ended': 'Your session ended, so these changes weren’t saved.',
  refused:
    'These changes weren’t saved. Saving a person needs admin access, and this request was refused it. Ask an admin to make the change, or to give you the role.',
  'access-unconfirmed':
    'These changes weren’t saved. The access check refused the write, and it refuses the same way when it cannot run at all, so try again. If that keeps happening, ask an admin whether you are still on the team.',
  interrupted:
    'Your access was rechecked while this was in flight, so the board can’t say whether these changes were saved. Reload the page and read the row before editing it again.',
  standing:
    'These changes weren’t saved, and pressing Save again won’t change that. Reload the page.',
  'not-now':
    'These changes weren’t saved. The board couldn’t confirm your access just then, which clears on its own, so try again in a moment.',
  failed: 'Couldn’t save these changes. Try again.',
};

/** The dialog's whole answer to a rejected save: the line, and whether Save may
 *  stay armed under it. Exported for the same reason `mintFailure` is. */
export function editFailure(e: unknown): { sentence: string; retry: boolean } {
  const failure = writeFailure(e);
  return { sentence: failure.serverSaid ?? EDIT_FAILURE[failure.kind], retry: failure.retry };
}
// Sentence case, not uppercase — an uppercased micro-label reads as eyebrow-kicker
// slop. No check enforces it: the detector's `eyebrow-kicker` reads markup, not
// components (#731, docs/comments.md). Matches the dashboard's BlockHeader.
const SEC_TITLE_CLS = 'flex items-center gap-2 text-[12.5px] font-semibold tracking-[-0.005em] text-dim';

/**
 * The Access section of the admin hub (#11, #183): the People table shows each
 * teammate's board-assigned role (#332) and opens an edit panel per person, where
 * an admin sets the role + identity mapping. Rendered inside AdminHub's content
 * pane; the API 403s a non-admin → forbidden state (defence in depth — the hub
 * also gates on admin).
 */
export function AccessSection() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [editing, setEditing] = useState<AccessPerson | null>(null);
  const [openAgents, setOpenAgents] = useState<string | null>(null);

  // Optimistic revoke — drop the row now, call the kill-switch; on failure the
  // reload restores the true roster rather than leaving a stale removal.
  function revoke(id: string) {
    setState((s) =>
      s.kind === 'ready' ? { ...s, agents: s.agents.filter((a) => a.id !== id) } : s,
    );
    revokeAdminAgent(id).catch(() => load());
  }

  function load() {
    fetchAdminAccess().then(
      async (model) => {
        // Agents ride alongside the roster now (#263) — each person shows their
        // connected-agent count; the standalone Agents tab is gone. A failed
        // agents fetch degrades to zero counts rather than blanking the roster.
        const agents = await fetchAdminAgents().then((m) => m.agents, () => []);
        setState({ kind: 'ready', model, agents });
      },
      (e: Error) => {
        if (e.message === 'forbidden') setState({ kind: 'forbidden' });
        // An expired session is answered once, app-wide (#512) — this pane just
        // says why it stopped, in the same words every other surface uses. The
        // message itself goes to the console and not to the pane (#1055), from
        // here rather than from the render below.
        else { logLoadFailure(ACCESS_SUBJECT, e.message); setState({ kind: 'error', message: e.message }); }
      },
    );
  }
  useEffect(() => { load(); }, []);

  if (state.kind === 'loading') return <div className={PANE_CLS}><div className="rok-empty">Loading…</div></div>;
  if (state.kind === 'forbidden')
    return (
      <div className={PANE_CLS}>
        <p className="text-muted">This section is for admins only. Ask an admin if you need a role change.</p>
      </div>
    );
  if (state.kind === 'error')
    return <div className={PANE_CLS}><p className="okr-err">{loadFailureText(ACCESS_SUBJECT, state.message)}</p></div>;

  const { people } = state.model;

  // Attribute each agent to its owner by email (OrgAgent.owner is the human's
  // email; a person's `emails` is the match set, keyed by the roster id).
  const agentsFor = (p: AccessPerson): OrgAgent[] => {
    const mine = new Set(p.emails.map((e) => e.toLowerCase()));
    return state.agents.filter((a) => mine.has(a.owner.toLowerCase()));
  };

  return (
    <div className={PANE_CLS}>
      {/* People & effective role — the single roster+role view; click to edit. */}
      <section>
        <h2 className={SEC_TITLE_CLS}>
          People
          <Badge
            variant="secondary"
            className="rounded-full bg-elevated px-2 py-px text-[11px] font-semibold normal-case tracking-normal text-muted"
          >
            {people.length}
          </Badge>
        </h2>
        <div className="mt-[14px]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-auto px-1 pb-2.5 text-[11px] font-semibold text-muted">
                Person
              </TableHead>
              <TableHead className="hidden h-auto px-1 pb-2.5 text-[11px] font-semibold text-muted sm:table-cell">
                GitHub
              </TableHead>
              <TableHead className="hidden h-auto px-1 pb-2.5 text-[11px] font-semibold text-muted sm:table-cell">
                ClickUp
              </TableHead>
              <TableHead className="h-auto px-1 pb-2.5 text-right text-[11px] font-semibold text-muted">
                Agents
              </TableHead>
              <TableHead className="h-auto px-1 pb-2.5 text-right text-[11px] font-semibold text-muted">
                Role
              </TableHead>
              <TableHead className="h-auto w-6 px-0 pb-2.5" aria-hidden="true" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((p) => {
              const mine = agentsFor(p);
              const expanded = openAgents === p.id;
              return (
                <Fragment key={p.id}>
                  <PersonRow
                    p={p}
                    agentCount={mine.length}
                    expanded={expanded}
                    onEdit={() => setEditing(p)}
                    onToggleAgents={mine.length ? () => setOpenAgents(expanded ? null : p.id) : undefined}
                  />
                  {expanded && mine.length > 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="p-0 pb-1.5">
                        {/* Indented under the person's name + a brand left-rule so the
                            panel stays visibly tied to its owner on a denser roster (jony). */}
                        <div className="ml-[46px] flex flex-col gap-1 rounded-[10px] border-l-2 border-accent/40 bg-[var(--board-well)] py-2 pl-3 pr-2">
                          {mine.map((a) => <AgentLine key={a.id} agent={a} onRevoke={() => revoke(a.id)} />)}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
        </div>
      </section>

      {editing && <EditPanel person={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function PersonRow({
  p, agentCount, expanded, onEdit, onToggleAgents,
}: {
  p: AccessPerson;
  agentCount: number;
  expanded: boolean;
  onEdit: () => void;
  /** Present only when the person has ≥1 agent — toggles the revoke sub-row (#263). */
  onToggleAgents?: () => void;
}) {
  return (
    <TableRow
      role="button"
      tabIndex={0}
      className="group cursor-pointer"
      onClick={onEdit}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(); } }}
    >
      <TableCell className="p-2.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={p.displayName} login={p.githubLogin} />
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-medium text-fg">
            {p.displayName}
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden p-2.5 font-mono text-[12.5px] text-dim sm:table-cell">
        {p.githubLogin
          ? <GithubCell login={p.githubLogin} derived={p.githubLoginSource === 'derived'} />
          : <span className="text-muted">—</span>}
      </TableCell>
      <TableCell className="hidden max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap p-2.5 text-[12.5px] text-dim sm:table-cell">
        {p.clickupNames.length ? p.clickupNames.join(', ') : <span className="text-muted">—</span>}
      </TableCell>
      {/* Connected-agent count (#263). Clickable to reveal that person's agents +
          Revoke; stops propagation so it doesn't also open the edit modal. */}
      <TableCell className="p-2.5 text-right tabular-nums">
        {onToggleAgents ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleAgents(); }}
            className={`inline-flex cursor-pointer items-center gap-1 rounded-[6px] px-2 py-0.5 text-[12.5px] transition-colors hover:bg-elevated hover:text-fg ${expanded ? 'bg-elevated text-accent' : 'text-dim'}`}
            aria-expanded={expanded}
          >
            {agentCount}
            <span className={`text-[10px] leading-none transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
          </button>
        ) : (
          <span className="text-[12.5px] text-muted">0</span>
        )}
      </TableCell>
      <TableCell className="p-2.5 text-right">
        <Tip label={ROLE_HINT[p.role]}>
          <Badge variant="outline" className={ROLE_BADGE_CLASS[p.role]}>
            {ROLE_LABEL[p.role]}
          </Badge>
        </Tip>
      </TableCell>
      <TableCell
        className="w-6 p-2.5 pl-0 text-[15px] text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        aria-hidden="true"
      >›</TableCell>
    </TableRow>
  );
}

/** One connected agent under an expanded person (#263): label + scopes + the
 *  admin kill-switch. Owner is implicit (it's the person's row). */
function AgentLine({ agent, onRevoke }: { agent: OrgAgent; onRevoke: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-[8px] px-2.5 py-1.5">
      <span className="truncate text-[12.5px] font-medium text-fg">{agent.name}</span>
      <span className="flex flex-wrap items-center gap-1">
        {agent.scopes.map((s) => (
          <code key={s} className="rounded-[5px] bg-elevated px-1.5 py-px font-mono text-[10.5px] text-dim">{s}</code>
        ))}
      </span>
      {/* Quiet ghost button — Revoke is destructive but rare, so it stays muted
          until hover rather than out-weighting the roster (jony). */}
      <button
        type="button"
        disabled={busy}
        onClick={() => { setBusy(true); onRevoke(); }}
        className="ml-auto flex-none cursor-pointer rounded-[6px] px-2 py-1 text-[11.5px] text-muted transition-colors hover:bg-elevated hover:text-danger disabled:pointer-events-none disabled:opacity-60"
      >
        {busy ? 'Revoking…' : 'Revoke'}
      </button>
    </div>
  );
}

/**
 * A person's Github handle on the roster (#535).
 *
 * A handle the board worked out from commit authorship is a guess, and an admin
 * has to be able to tell it from one somebody typed — otherwise they either
 * "correct" a good guess or trust a bad one. The dashed outline is the board's
 * existing "not real yet" idiom, so it reads as provisional without a legend,
 * and it keeps every row the same height, which a second line of text would not.
 */
function GithubCell({ login, derived }: { login: string; derived: boolean }) {
  const link = (
    <a
      className={derived ? 'text-dim text-link' : 'text-accent text-link'}
      href={`https://github.com/${encodeURIComponent(login)}`}
      target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
    >{login}</a>
  );
  if (!derived) return link;
  return (
    <Tip label="Worked out from this person’s commits, not typed in by anyone">
      <span className="inline-flex rounded-[5px] border border-dashed border-line-strong px-1.5 py-0.5">
        {link}
      </span>
    </Tip>
  );
}

function EditPanel({ person, onClose, onSaved }: { person: AccessPerson; onClose: () => void; onSaved: () => void }) {
  const [displayName, setName] = useState(person.displayName);
  const [emails, setEmails] = useState(person.emails.join(', '));
  // A derived handle is not stored on this person, so the field opens EMPTY —
  // it edits the roster, and the roster has no answer here (#535). Pre-filling
  // it would turn Save into "accept this guess", which is not this issue's work.
  const typedLogin = person.githubLoginSource === 'derived' ? '' : person.githubLogin ?? '';
  const [githubLogin, setGh] = useState(typedLogin);
  const [clickupUserId, setCu] = useState(person.clickupUserId ?? '');
  const [clickupNames, setCun] = useState(person.clickupNames.join(', '));
  // Role override (#332): null = "Default" (the derived role). Starts at the
  // stored override, so the control opens on what's actually saved, not the
  // effective role (a bootstrap admin with no override opens on Default).
  const [role, setRole] = useState<AccessRole | null>(person.roleOverride);
  const [busy, setBusy] = useState(false);
  /** The failed save, as a line and a verdict on Save beneath it (#1079). Not
   *  cleared when a field changes: no arm that withdraws Save is about what was
   *  typed, so an edit answers none of them. `save` clears it on the next press,
   *  which is the only press the dialog can still be offering. */
  const [err, setErr] = useState<{ sentence: string; retry: boolean } | null>(null);

  // Save only writes when something changed (jony: a solid-blue Save on an
  // untouched form is a lie). GitHub is flagged amber when the person is
  // currently unlinked and the field is still empty — the field is the cause of
  // the "no GitHub identity" health finding, so tie the two together.
  const dirty =
    displayName !== person.displayName ||
    emails !== person.emails.join(', ') ||
    githubLogin !== typedLogin ||
    clickupUserId !== (person.clickupUserId ?? '') ||
    clickupNames !== person.clickupNames.join(', ') ||
    role !== person.roleOverride;
  const ghUnlinked = !typedLogin && !githubLogin.trim();

  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await upsertIdentity({
        email: person.id,
        displayName: displayName.trim(),
        emails: split(emails),
        githubLogin: githubLogin.trim() || null,
        clickupUserId: clickupUserId.trim() || null,
        clickupNames: split(clickupNames),
        role,
      });
      onSaved();
    } catch (e) {
      // The failure's own words on the console, from the handler that caught it
      // rather than from the render below (#1079).
      logWriteFailure(EDIT_SUBJECT, e);
      setErr(editFailure(e));
      setBusy(false);
    }
  }

  return (
    // Centered modal (#262) — the form is short and reads better focused than in a
    // right-side slideover. Dialog gives the scrim + focus-trap + Escape for free;
    // `open` is always true while mounted (the caller renders <EditPanel> only while
    // editing), and every dismiss path is gated on `!busy`.
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="flex max-h-[88vh] w-[420px] max-w-[92vw] max-sm:w-auto flex-col gap-0 p-0">
        <DialogHeader className="flex-none flex-row items-center gap-[11px] space-y-0 px-[22px] pb-4 pt-5 text-left">
          <Avatar name={person.displayName} login={person.githubLogin} />
          {/* Just the person — the "Role X — derived from…" subtitle was slop (#331);
              the role becomes a real control with editable roles (#332). */}
          <DialogTitle className="min-w-0 truncate text-base">{person.displayName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-1 flex-col gap-[15px] overflow-y-auto px-[22px] py-1.5">
          {/* Role leads — the point of #332. A board-assigned role that grants real
              access; "Default" clears the override back to the derived role. */}
          <RoleControl value={role} derived={person.derivedRole} onChange={setRole} />
          <Field id="adm-f-name" label="Display name" value={displayName} onChange={setName} />
          {/* Only load-bearing hints survive (#331): "Comma-separated" is a real
              format instruction; the explanatory tails ("the join key to…", "DRI
              names as they appear in…", "Enables the ClickUp profile link") were
              decorative chrome and are gone. */}
          <Field
            id="adm-f-emails" label="Emails" value={emails} onChange={setEmails}
            hint="Comma-separated"
          />
          <Field
            id="adm-f-gh" label="GitHub login" value={githubLogin} onChange={setGh} placeholder="e.g. octocat"
            warn={ghUnlinked}
            warnHint={
              person.githubLoginSource === 'derived'
                ? 'A match from their commits. Nothing is saved here, so they are still a reader.'
                : 'Not linked. A repo owner has to have one.'
            }
          />
          <Field
            id="adm-f-cuid" label="ClickUp user ID" value={clickupUserId} onChange={setCu} placeholder="numeric id"
          />
          <Field
            id="adm-f-cunames" label="ClickUp names" value={clickupNames} onChange={setCun}
            hint="Comma-separated"
          />
          {err && <p className="mt-0.5 text-[12.5px] text-danger">{err.sentence}</p>}
        </div>
        <DialogFooter className="flex-none flex-row justify-end gap-2.5 px-[22px] pb-[22px] pt-3.5">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          {/* Neutral foreground fill, not blue — blue is reserved for links (the
              Github logins) so one hue means one thing across the panel (jony). */}
          <Button
            className="bg-fg text-bg hover:bg-fg hover:opacity-[0.88]"
            onClick={save}
            // Withdrawn under a refusal a second press cannot clear (#1079).
            disabled={busy || !dirty || err?.retry === false}
          >{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The board-assigned role control (#332): a quiet segmented switcher over the
 *  three roles plus "Default", which clears the override back to the derived role.
 *  A board-assigned role is authoritative — Admin grants real board admin. */
function RoleControl({ value, derived, onChange }: {
  value: AccessRole | null;
  derived: AccessRole;
  onChange: (r: AccessRole | null) => void;
}) {
  // Neutral raise for the active segment + a neutral focus ring — the switcher
  // spends no accent (blue is reserved for the one accent, jony).
  const segCls = (on: boolean, muted?: boolean) =>
    `cursor-pointer rounded-[7px] px-3 py-[7px] text-[12.5px] font-medium transition-colors focus:outline-none ${
      'focus-visible:ring-2 focus-visible:ring-[color:var(--border-strong)] '
    }${on ? 'bg-elevated text-fg' : `${muted ? 'text-muted' : 'text-dim'} hover:text-fg`}`;
  const hint =
    value === null
      ? `Nothing set here, so the role is ${ROLE_LABEL[derived]}: writer with a linked GitHub login, reader without one.`
      : ROLE_HINT[value];
  return (
    <div className="flex flex-col gap-[6px]">
      <Label className="text-[12.5px] font-medium text-dim">Role</Label>
      <div className="inline-flex w-fit items-stretch gap-[2px] rounded-[9px] bg-[var(--board-well)] p-[3px]">
        {(['admin', 'writer', 'reader'] as AccessRole[]).map((r) => (
          <button key={r} type="button" onClick={() => onChange(r)} className={segCls(value === r)}>
            {ROLE_LABEL[r]}
          </button>
        ))}
        {/* Divider — "Default" clears the override, it isn't a fourth role tier (jony). */}
        <span className="mx-0.5 my-1 w-px self-stretch bg-line" aria-hidden="true" />
        <button type="button" onClick={() => onChange(null)} className={segCls(value === null, true)}>
          Default
        </button>
      </div>
      <span className="text-[11px] leading-[1.5] text-muted">{hint}</span>
    </div>
  );
}

function Field({ id, label, value, onChange, hint, placeholder, warn, warnHint }: {
  id: string; label: string; value: string; onChange: (v: string) => void;
  hint?: string; placeholder?: string; warn?: boolean; warnHint?: string;
}) {
  return (
    <div className="flex flex-col gap-[5px]">
      <Label htmlFor={id} className="text-[12.5px] font-medium text-dim">
        {label}
      </Label>
      <Input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={warn ? 'border-warn/60 focus-visible:ring-warn' : undefined}
      />
      {warn && warnHint
        ? <span className="text-[11px] text-warn">{warnHint}</span>
        : hint && <span className="text-[11px] text-muted">{hint}</span>}
    </div>
  );
}

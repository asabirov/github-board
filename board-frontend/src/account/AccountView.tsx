/**
 * Account › Access & agents (#210) — a user's own personal access tokens for
 * reaching the board from local agents (REST + MCP). Mint (scoped, optionally
 * time-bounded), list, and revoke your own; org-wide governance stays in the
 * admin hub. Read-only mirror as always — the token authenticates an agent, it
 * doesn't grant new write surface. Degrades: no DB → an "unavailable" note.
 */

import { useEffect, useState } from 'react';
import {
  Button,
  Input,
  Label,
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../ui/kit';
import { fetchMyTokens, mintToken, revokeToken, type AccountTokens, type PersonalToken } from '../api/account';
import { CheckIcon, CopyIcon, KeyRoundIcon } from '../icons';
import { EmptyState } from '../ui/EmptyState';
import { loadFailureText, logLoadFailure, reasonOf } from '../auth/session-copy';
import { logWriteFailure, writeFailure, type WriteFailureKind } from '../auth/write-failure';
import { CARD, CARD_ROW, rel, ScopeChip } from './chrome';
import { ConnectedClients } from './ConnectedClients';
import { PageHeading, PAGE_READING } from '../ui/PageHeading';
import { useOpenPanel } from '../area-panel/panel-ctx';
import { ACCOUNT_LABEL } from './sections';
import { ACCOUNT_RAIL } from './layout';
import { formatDate, usePreferredTimezone } from './prefs';

// The shared Account rail (#450) with the token list narrowed inside it.
const ROOT = ACCOUNT_RAIL;
/** What the token list is called on screen, for the sentence a failed load
 *  draws and for the console line beside it (#1055). */
const TOKENS = 'your tokens';
const COLUMN = PAGE_READING;
/** What this sheet is called in the console line beside a failed mint (#1079). */
const MINT_SUBJECT = 'the mint sheet';

/**
 * What a failed MINT says, per kind (#1079). The sheet used to print `err`
 * whole, and `err` was whatever the rejection carried: the five sentences
 * `personal-token.service.ts` writes for this exact spot on a 400, and on
 * everything else an api.ts sentinel or Nest's own "Internal server error".
 *
 * The service's 400s still reach the reader word for word — `writeFailure`
 * hands them back on `serverSaid` — because each of them is the service telling
 * the person what is wrong with what they typed, and the numbers in them (the
 * name cap, the expiry range) live there and not here. `new-project.tsx` keeps
 * a 400 for the same reason.
 *
 * `access-unconfirmed` is the arm this route's only 403 actually lands on, and
 * it keeps Create token armed. `write-failure.ts` carries the argument: that
 * refusal comes from `TeamAccessGuard`, which answers the same 403 for a
 * Directory call that never came back as for a person genuinely off the team,
 * so the one thing this sheet must not do is call it final. `refused` is
 * unreachable here — `AdminGuard`, the only producer of a 403 the board can
 * place, gates the admin surface and not /api/account — and is written out
 * anyway, because the record is exhaustive on purpose and a kind that stops
 * being unreachable should find a sentence waiting for it.
 *
 * `not-now` is the four 503s the auth layer codes `access_not_now` (#1102
 * review, the 503 round). They say nothing about this person's access, they
 * clear without anybody doing anything, and they used to come out `standing` —
 * Create token dead under the service's own "retry or reconnect".
 */
const MINT_FAILURE: Record<WriteFailureKind, string> = {
  'session-ended': 'Your session ended, so the token wasn’t created.',
  refused:
    'The token wasn’t created, and a second press is refused the same way. Ask an admin about your access.',
  'access-unconfirmed':
    'The token wasn’t created. The access check refused it, and it refuses the same way when it cannot run at all, so try again. If that keeps happening, ask an admin whether you are still on the team.',
  interrupted:
    'Your access was rechecked while this was in flight, so the board can’t say whether the token was created. Reload the page and read the list before minting another.',
  standing:
    'The token wasn’t created, and pressing Create token again won’t change that. Reload the page.',
  'not-now':
    'The token wasn’t created. The board couldn’t confirm your access just then, which clears on its own, so try again in a moment.',
  failed: 'Couldn’t create the token. Try again.',
};

/** The sheet's whole answer to a rejected mint: the line, and whether Create
 *  token may stay armed under it. Exported because the suite has no DOM and
 *  cannot press anything — a pure function is what a spec can pin. */
export function mintFailure(e: unknown): { sentence: string; retry: boolean } {
  const failure = writeFailure(e);
  return { sentence: failure.serverSaid ?? MINT_FAILURE[failure.kind], retry: failure.retry };
}

const SCOPE_BLURB: Record<string, string> = {
  'board:read': 'Read the mirror — issues, projects, metrics',
  'board:admin': 'Manage — admin-only writes',
};

const EXPIRY_OPTS: { label: string; days: number | null }[] = [
  { label: '30 days', days: 30 },
  { label: '60 days', days: 60 },
  { label: '90 days', days: 90 },
  { label: 'No expiry', days: null },
];

// A one-tap copy affordance, matching the admin ConnectCard / dashboard StackCopy.
function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
      className="h-auto gap-1.5 rounded-[7px] px-2.5 py-[5px] text-[12px] font-medium"
    >
      {done ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      {done ? 'Copied' : label}
    </Button>
  );
}

function TokenRow({ t, onRevoke }: { t: PersonalToken; onRevoke: (id: string) => void }) {
  const tz = usePreferredTimezone();
  const expired = t.expiresAt != null && Date.parse(t.expiresAt) <= Date.now();
  return (
    <div className={CARD_ROW}>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-fg">{t.name}</div>
        {/* The gap divides these, and nothing is drawn between them: three
            dots in a run is the chain the kit's No slop page bans (#1022). */}
        <div className="mt-[3px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
          {t.scopes.map((s) => (
            <ScopeChip key={s} scope={s} />
          ))}
          <code className="font-mono text-muted">{t.prefix}…</code>
          <span>created {rel(t.createdAt)}</span>
          {t.expiresAt == null ? (
            <span>no expiry</span>
          ) : expired ? (
            <span className="text-danger">expired</span>
          ) : (
            <span>expires {formatDate(t.expiresAt, tz)}</span>
          )}
          <span>{t.lastUsedAt ? `last used ${rel(t.lastUsedAt)}` : 'never used'}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRevoke(t.id)}
        className="flex-none cursor-pointer border-none bg-transparent text-[12px] text-muted hover:text-danger"
      >
        Revoke
      </button>
    </div>
  );
}

// The mint slide-over: form, then the show-once secret in the same panel.
function MintSheet({
  grantableScopes,
  onClose,
  onMinted,
}: {
  grantableScopes: string[];
  onClose: () => void;
  onMinted: () => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['board:read']);
  const [days, setDays] = useState<number | null>(90);
  const [busy, setBusy] = useState(false);
  /** The failed mint, as a line and a verdict on the button beneath it (#1079).
   *  Not cleared when a field changes: no arm that withdraws the button is about
   *  what was typed, so an edit answers none of them. */
  const [err, setErr] = useState<{ sentence: string; retry: boolean } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const toggle = (s: string) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const { token } = await mintToken({ name: name.trim(), scopes, expiresInDays: days });
      setSecret(token);
    } catch (e) {
      // The failure's own words on the console, from the handler that caught it
      // rather than from the render below (#1079).
      logWriteFailure(MINT_SUBJECT, e);
      setErr(mintFailure(e));
      setBusy(false);
    }
  }

  const dismiss = (next: boolean) => {
    if (next || busy) return;
    // Closing after a secret was shown must refresh the list to show the new row.
    secret ? onMinted() : onClose();
  };

  return (
    <Sheet open onOpenChange={dismiss}>
      <SheetContent className="flex w-[400px] max-w-[92vw] flex-col gap-0 p-0 sm:max-w-[400px]">
        <SheetHeader className="flex-none px-[22px] pb-3 pt-5 text-left">
          <SheetTitle className="text-base">
            {secret ? 'Token created' : 'New personal token'}
          </SheetTitle>
        </SheetHeader>

        {secret ? (
          <div className="flex flex-1 flex-col gap-3.5 px-[22px] py-2">
            <div className="flex items-center gap-2.5 rounded-[9px] bg-[var(--board-well)] p-3">
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{secret}</code>
              <CopyButton value={secret} />
            </div>
            {/* Irreversible reveal → primary-weight warning, tied to the token (jony). */}
            <div className="flex items-start gap-2.5 rounded-[10px] bg-warn-fill p-3">
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
                Copy it now. You won’t see it again.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-[22px] py-2">
            <div className="flex flex-col gap-[7px]">
              <Label htmlFor="tok-name" className="text-[12.5px] font-medium text-dim">
                Name
              </Label>
              <Input
                id="tok-name"
                value={name}
                placeholder="e.g. my-laptop-agent"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-[7px]">
              <Label className="text-[12.5px] font-medium text-dim">Scopes</Label>
              <div className="flex flex-col gap-2">
                {grantableScopes.map((s) => {
                  const on = scopes.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggle(s)}
                      aria-pressed={on}
                      className={`flex cursor-pointer items-start gap-2.5 rounded-[9px] p-2.5 text-left ${
                        on ? 'bg-accent-fill' : 'bg-[var(--board-well)] hover:bg-elevated'
                      }`}
                    >
                      <span
                        className={`mt-px grid h-4 w-4 flex-none place-items-center rounded-[5px] border-[1.5px] ${
                          on ? 'border-accent bg-accent' : 'border-muted'
                        }`}
                      >
                        {on && <CheckIcon size={11} className="text-bg" />}
                      </span>
                      <span className="min-w-0">
                        <code className="block font-mono text-[12.5px] font-semibold text-fg">{s}</code>
                        <span className="mt-0.5 block text-[11.5px] text-muted">
                          {SCOPE_BLURB[s] ?? ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-[7px]">
              <Label htmlFor="tok-exp" className="text-[12.5px] font-medium text-dim">
                Expires
              </Label>
              <select
                id="tok-exp"
                value={days === null ? 'none' : String(days)}
                onChange={(e) => setDays(e.target.value === 'none' ? null : Number(e.target.value))}
                className="h-9 cursor-pointer rounded-[9px] border border-line bg-[var(--board-well)] px-3 text-[13px] text-fg outline-none focus:border-accent"
              >
                {EXPIRY_OPTS.map((o) => (
                  <option key={o.label} value={o.days === null ? 'none' : String(o.days)}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {err && <p className="text-[12.5px] text-danger">{err.sentence}</p>}
          </div>
        )}

        <SheetFooter className="flex-none flex-row justify-end gap-2.5 px-[22px] pb-[22px] pt-3.5">
          {secret ? (
            <Button
              className="bg-fg text-bg hover:bg-fg hover:opacity-[0.88]"
              onClick={onMinted}
            >
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                className="bg-fg text-bg hover:bg-fg hover:opacity-[0.88]"
                onClick={create}
                // Withdrawn under a refusal a second press cannot clear (#1079),
                // on the button this sheet's own failure line sits above.
                disabled={busy || !name.trim() || scopes.length === 0 || err?.retry === false}
              >
                {busy ? 'Creating…' : 'Create token'}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ── Connect an agent (#342) — a mint → configure → verify stepper with a client
// switcher. The config snippets are real and per-client; the URLs come from the
// live origin so they're correct in any environment. `board_pat_…` is a template
// placeholder the user swaps for a token minted above.
interface ConnectClient {
  id: string;
  label: string;
  /** The client's config, a real code block. */
  config: string;
  /** A one-line note under the config (plain prose). */
  note: string;
  /** Verify: a command to run + its success line, or a plain instruction. */
  verify: { code: string; result: string } | { text: string };
}

function connectClients(mcpUrl: string, apiBase: string): ConnectClient[] {
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      config: `claude mcp add --transport http board ${mcpUrl} \\\n  --header "Authorization: Bearer board_pat_…"`,
      note: 'Add --scope project to share it via .mcp.json.',
      verify: { code: 'claude mcp list', result: 'board · Connected' },
    },
    {
      id: 'codex',
      label: 'Codex',
      config: `[mcp_servers.board]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${mcpUrl}", "--header", "Authorization: Bearer board_pat_…"]`,
      note: 'In ~/.codex/config.toml.',
      verify: { text: "Restart Codex. The board’s tools load from the config." },
    },
    {
      id: 'mcp',
      label: 'Other MCP client',
      config: `{\n  "mcpServers": {\n    "board": {\n      "type": "http",\n      "url": "${mcpUrl}",\n      "headers": { "Authorization": "Bearer board_pat_…" }\n    }\n  }\n}`,
      note: 'Any client that reads .mcp.json — Cursor, Windsurf, and the like.',
      verify: { text: "Restart your client. The board’s tools appear in its MCP list." },
    },
    {
      id: 'rest',
      label: 'REST / curl',
      config: `curl -H "Authorization: Bearer board_pat_…" ${apiBase}/api/issues/mine`,
      note: 'The same token authenticates the REST API.',
      verify: { text: "A 200 with JSON means the token works. You’re connected." },
    },
  ];
}

/** A recessed code block with a corner Copy — the well treatment, mono for real code.
 *  The right padding clears the Copy button (which widens to "Copied" on click), so a
 *  long single line and its scrollbar never run under it — they scroll within the
 *  gutter instead (jony #342). */
function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative rounded-[10px] bg-[var(--board-well)] py-3 pl-3.5 pr-[104px]">
      <pre className="overflow-x-auto whitespace-pre font-mono text-[12.5px] leading-[1.6] text-dim">{code}</pre>
      <div className="absolute right-2.5 top-2.5">
        <CopyButton value={code} />
      </div>
    </div>
  );
}

/** The quiet step number — a small neutral badge, tabular. */
function StepNum({ n }: { n: number }) {
  return (
    <span className="flex size-[22px] flex-none items-center justify-center rounded-full bg-elevated text-[11px] font-semibold tabular-nums text-dim">
      {n}
    </span>
  );
}

function ConnectAgent() {
  // The reference REPLACES this panel rather than stacking a second one on it
  // (#712) — exactly one panel is ever open, and one X ever on screen.
  const openPanel = useOpenPanel();
  const mcpUrl = `${window.location.origin}/mcp`;
  const apiBase = window.location.origin;
  const clients = connectClients(mcpUrl, apiBase);
  const [active, setActive] = useState(clients[0].id);
  const client = clients.find((c) => c.id === active) ?? clients[0];

  return (
    <div className={`mt-8 ${CARD} p-[22px]`}>
      <div className="text-[13px] font-semibold">Connect an agent</div>

      <div className="mt-5 flex flex-col gap-5">
        {/* Step 1 — no scope line (#342, per Artur): the token list above already
            handles scopes, so restating "board:read" here was noise. */}
        <div className="flex gap-3">
          <StepNum n={1} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-[13px] font-semibold text-fg">Mint a token</div>
          </div>
        </div>

        {/* Step 2 — the client switcher + its config. */}
        <div className="flex gap-3">
          <StepNum n={2} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-[13px] font-semibold text-fg">Configure your client</div>
            <div className="mt-1 text-[12.5px] text-muted">
              Replace{' '}
              <code className="rounded bg-elevated px-1 py-px font-mono text-[11.5px] text-dim">board_pat_…</code>{' '}
              with your token.
            </div>
            <div className="mt-3 inline-flex rounded-lg bg-[var(--board-well)] p-0.5">
              {clients.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setActive(c.id)}
                  className={`cursor-pointer rounded-md px-3 py-1 text-[12px] transition-colors ${
                    active === c.id ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-dim'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="mt-3">
              <CodeBlock code={client.config} />
            </div>
            <div className="mt-2 text-[11.5px] text-muted">{client.note}</div>
          </div>
        </div>

        {/* Step 3 — verify, tailored to the chosen client. */}
        <div className="flex gap-3">
          <StepNum n={3} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-[13px] font-semibold text-fg">Verify</div>
            {'text' in client.verify ? (
              <div className="mt-1 text-[12.5px] text-muted">{client.verify.text}</div>
            ) : (
              <>
                <div className="mt-3">
                  <CodeBlock code={client.verify.code} />
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
                  <CheckIcon size={13} className="text-success" />
                  <code className="font-mono text-dim">{client.verify.result}</code>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Every endpoint + scope lives on the full reference (#343). No trailing
          arrow (#448) — the house rule bans the glyph. A button rather than a
          link since #712: the reference has no address to point an href at. */}
      <div className="mt-6 text-[12px] text-muted">
        <button
          type="button"
          onClick={() => openPanel({ area: 'docs' })}
          className="cursor-pointer text-accent hover:underline"
        >
          API reference
        </button>
      </div>
    </div>
  );
}

/**
 * Which of the page body's three pre-list arms draws, or null when the token
 * list itself is what draws.
 *
 * Lifted out of the JSX so every arm can be driven (#1082). The page's `err` is
 * set from a `.catch` inside an effect, and the suite has no DOM and fires no
 * effects, so the arm this chooses was the one thing on this page a test could
 * not reach — and it was the one that was wrong.
 *
 * The failed-read arm asks whether the read FAILED, never whether the error had
 * anything to say. `err && !data` was the JSX, and `''` is falsy: a rejection
 * carrying no message was filed under "nothing has failed yet" and the page
 * drew `Loading…` over a list that was never going to arrive. `!== null` here
 * rather than a truthiness test, for that reason and no other. What the read
 * rejected with reaches `err` through `reasonOf`, which answers a string for
 * every rejection there is, including the ones carrying nothing.
 */
export function tokensPaneArm(o: {
  data: AccountTokens | null;
  error: string | null;
}): 'failed' | 'loading' | 'unavailable' | null {
  if (o.error !== null && o.data === null) return 'failed';
  if (o.data === null) return 'loading';
  if (!o.data.enabled) return 'unavailable';
  return null;
}

export function AccountView() {
  const [data, setData] = useState<AccountTokens | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  const load = () =>
    fetchMyTokens()
      .then((d) => { setData(d); setErr(null); })
      // What the read answered is kept on the console (#1055), from the handler
      // that caught it — the line below says what is missing, not what api.ts
      // called it. `err` goes on holding the message because `loadFailureText`
      // is what it is read through and that takes the message to branch on; it
      // is the branch that reaches a screen, never the string (#1081 review,
      // S6). The mint sheet's failure line is a different variable on a
      // different component and prints a WRITE whole, which this is not.
      .catch((e: unknown) => { const m = reasonOf(e); logLoadFailure(TOKENS, m); setErr(m); });
  useEffect(() => { load(); }, []);

  const revoke = async (id: string) => {
    await revokeToken(id).catch(() => {});
    load();
  };

  const live = (data?.tokens ?? []).filter((t) => t.revokedAt == null);
  const arm = tokensPaneArm({ data, error: err });

  // ONE mint action (#452), and only ever ONE of it on screen. With tokens listed
  // it lives in the section header; with none it lives inside the empty state, so
  // a first token is asked for where the page is otherwise blank instead of in a
  // header you have to find. Rendering both on the empty screen put two identical
  // white primaries a few hundred pixels apart, each looking like the other's
  // duplicate — so the header slot stands down while the list is empty. Same
  // element, same handler, either way: there is no second path to minting.
  const newTokenButton = (
    <Button
      className="bg-fg text-bg hover:bg-fg hover:opacity-[0.88]"
      onClick={() => setMinting(true)}
    >
      New token
    </Button>
  );

  return (
    <div className={ROOT}>
      <div className={COLUMN}>
        {/* No sub-headline (#448): "Mint tokens for your local agents" only
            described the New token button below it, and the org half of the
            sentence was about an admin's permissions, not the reader's. */}
        <PageHeading className="mb-7">{ACCOUNT_LABEL.account}</PageHeading>

        {arm === 'failed' ? (
          <div className="px-0.5 py-6 text-[13px] text-muted">{loadFailureText(TOKENS, err)}</div>
        ) : arm === 'loading' ? (
          <div className="px-0.5 py-6 text-[13px] text-muted">Loading…</div>
        ) : arm === 'unavailable' ? (
          // The page's condition, said once. This arm replaces the whole body,
          // so it speaks for connected clients (#456) as much as for tokens —
          // both are gone for the same reason, and a reader who lands here needs
          // that reason, not an inventory of what is missing. Naming only tokens
          // was true when tokens were the only thing on the page.
          <div className={`${CARD} p-6 text-[13px] text-muted`}>
            Access &amp; agents needs a database. This environment has none.
          </div>
        ) : (
          <>
            <div className="mb-3.5 flex items-center">
              <div>
                <div className="text-[13px] font-semibold">Personal access tokens</div>
              </div>
              {live.length > 0 && <div className="ml-auto">{newTokenButton}</div>}
            </div>

            {live.length === 0 ? (
              <EmptyState
                className={CARD}
                icon={<KeyRoundIcon size={16} />}
                title="No tokens yet"
                description="A token lets a local agent reach the board over REST or MCP."
                action={newTokenButton}
              />
            ) : (
              <div className={`overflow-hidden ${CARD}`}>
                {live.map((t) => (
                  <TokenRow key={t.id} t={t} onRevoke={revoke} />
                ))}
              </div>
            )}

            {/* The second list of things holding access to this account (#456),
                directly beneath the first: both are credentials the reader can
                cut off, and the connect guide below is a different kind of
                thing. It loads itself — the two lists share no request. */}
            <ConnectedClients />

            <ConnectAgent />
          </>
        )}

        {minting && data && (
          <MintSheet
            grantableScopes={data.grantableScopes}
            onClose={() => setMinting(false)}
            onMinted={() => { setMinting(false); load(); }}
          />
        )}
      </div>
    </div>
  );
}

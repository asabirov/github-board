import { useEffect, useRef, useState } from 'react';
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger, Input,
} from '../ui/kit';
import { BoardIcon, ChevronUpIcon } from '../icons';
import type { MeResponse } from '../api/types';
import { useOpenPanel } from '../area-panel/panel-ctx';
import { gotoPath } from '../route';
import { tileOpens } from '../repos/tile-nav';

/* The disconnect used to reload onto `?github_disconnect=check` and read its
   outcome off that address. Account > GitHub disconnects in place and says so
   there, so nothing produces that address any more and the notice that read it
   could only ever have fired on a stale bookmark, telling a healthy connection
   it had failed to disconnect (#892 review, low 4). */

/** A link that carries the weight of a button — the board's own primitive, not
 *  an underlined anchor beside it (#892 review, F11). */
function ConnectAction({ children, variant = 'default' }: { children: string; variant?: 'default' | 'secondary' }) {
  return (
    <Button asChild variant={variant}>
      <a href="/api/auth/github/login">{children}</a>
    </Button>
  );
}

/** A scope the switcher can be in: a granted owner, the union above them, or the
 *  owner in the address Github refuses. */
export type Scope = {
  value: string;
  label: string;
  /** Off the LOGIN, never off the label, which gave `Personal (alice)` a P for
   *  the word and every p-org the same square (#892 review, M1). Absent takes a
   *  glyph: the union is not an owner. */
  initial?: string;
  /** Stated on its own line, because a name long enough to truncate took the
   *  qualifier with it (M2). */
  noAccess?: boolean;
  /** #1167 — and where it went, when the board proved this owner was RENAMED
   *  rather than refused. It takes the same line `noAccess` takes, because it
   *  answers the same question and the two are never both true: the switcher
   *  saying "No access" beside a page saying the organisation was renamed and
   *  is still reachable is the board contradicting itself in one screen. */
  renamedTo?: string;
};

/** The line under a name in the switcher, in both places it is drawn. */
function scopeNote(scope: Scope): string | null {
  if (scope.renamedTo) return `Now ${scope.renamedTo}`;
  return scope.noAccess ? 'No access' : null;
}

/** The union's value: every granted owner at once. */
const ALL = '*all';

function ScopeMark({ initial }: { initial?: string }) {
  return (
    <span aria-hidden="true" className="flex h-7 w-7 rounded-md text-[14px] flex-none items-center justify-center bg-accent-fill font-semibold text-accent">
      {initial ?? <BoardIcon size={15} />}
    </span>
  );
}

export function GithubConnection({
  github,
  owner,
  navigate,
  renamedTo,
  disabled = false,
}: {
  github: Pick<NonNullable<MeResponse['github']>, 'configured' | 'connected' | 'owners'>;
  disabled?: boolean;
  owner: string | null;
  navigate: (owner: string | null) => void;
  /** #1167 — where the owner in the address went, when the board proved it was
   *  renamed. The page beside this switcher says so; without it the switcher
   *  went on saying "No access" about the same organisation. */
  renamedTo?: string | null;
}) {
  const openPanel = useOpenPanel();
  const openedPanel = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => search.current?.focus());
    return () => window.clearTimeout(timer);
  }, [open]);

  // Below the hooks, above the scopes: neither state draws a switcher (N1).
  if (github.configured === false) {
    return <p className="px-3 py-3 text-[13px]">The GitHub app isn’t set up on this board.</p>;
  }
  if (!github.connected) {
    return (
      <div className="px-3 py-3">
        <Button disabled={disabled} variant="outline" onClick={() => openPanel({ area: 'account', section: 'github' })}>Set up GitHub</Button>
      </div>
    );
  }

  // Case-insensitively, and the match is what gets named: `/Acme` against a
  // granted `acme` passed the reachability test and matched no option, so the
  // picker read "nothing selected" over a page that was working.
  const selectedOwner = github.owners.find((o) => o.login.toLowerCase() === owner?.toLowerCase());
  const unreachable = owner !== null && !selectedOwner;
  const scopes: Scope[] = [
    { value: ALL, label: 'All GitHub orgs' },
    ...github.owners.map((o) => ({
      value: o.login,
      label: o.login,
      initial: o.login.slice(0, 1).toUpperCase(),
    })),
    ...(unreachable
      ? [{
        value: owner,
        label: owner,
        initial: owner.slice(0, 1).toUpperCase(),
        ...(renamedTo ? { renamedTo } : { noAccess: true }),
      }]
      : []),
  ];
  const value = selectedOwner?.login ?? owner ?? ALL;
  const selected = scopes.find((scope) => scope.value === value)!;
  const matches = scopes.filter((scope) => scope.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="mb-[14px]">
      <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            // Nothing's label target since the Select went; kept as the browser
            // proofs' anchor, which has to be stable.
            id="github-organization"
            disabled={disabled}
            aria-label={`Switch organization, ${selected.label}${scopeNote(selected) ? `, ${scopeNote(selected)!.toLowerCase()}` : ''}`}
            title={selected.label}
            className={`flex min-h-12 w-full cursor-pointer disabled:pointer-events-none items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[15px] text-fg hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent${open ? ' bg-surface-3' : ''}`}
          >
            <ScopeMark initial={selected.initial} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-semibold">{selected.label}</span>
              {/* The name may shorten; this may not (M2). */}
              {scopeNote(selected) && <span className="text-[12px] font-normal leading-tight text-dim">{scopeNote(selected)}</span>}
            </span>
            <ChevronUpIcon size={16} className="rotate-180 flex-none text-dim" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          ref={content}
          align="start"
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (openedPanel.current) {
              event.preventDefault();
              openedPanel.current = false;
            }
          }}
        >
          <Input
            ref={search}
            aria-label="Search organizations"
            placeholder="Search organizations"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                content.current?.querySelector<HTMLElement>('[role="menuitemradio"], [role="menuitem"]:not([data-disabled])')?.focus();
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                content.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.click();
              }
              // Typing belongs to the field, not the menu's typeahead.
              if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation();
            }}
          />
          <DropdownMenuRadioGroup value={value} onValueChange={(next) => navigate(next === ALL ? null : next)}>
            {matches.map((scope) => (
              <DropdownMenuRadioItem key={scope.value} value={scope.value}>
                <span>
                  <span>{scope.label}</span>
                  {scopeNote(scope) && <span className="block text-dim">{scopeNote(scope)}</span>}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {matches.length === 0 && <DropdownMenuItem disabled>No organizations match.</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => {
            openedPanel.current = true;
            openPanel({ area: 'account', section: 'github' });
          }}>
            Manage GitHub access
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The way to the same page under the new name (#1167) — an anchor and not a
 *  press, because it has an address: a reader who wants it in a new tab, or
 *  wants to send it to whoever gave them the old link, gets both. `tileOpens`
 *  is the board's one rule for which press belongs to this app, and every
 *  modified one is left to the browser. */
function OpenRenamed({ owner, path }: { owner: string; path: string }) {
  return (
    <Button asChild>
      <a
        href={path}
        onClick={(e) => {
          if (!tileOpens(e)) return;
          e.preventDefault();
          gotoPath(path);
        }}
      >
        {`Open ${owner}`}
      </a>
    </Button>
  );
}

/**
 * What a person reads when the board will not draw the owner in their address.
 *
 * FIVE STATES, and #1167 added the one that is not a refusal. A Github app
 * nobody finished setting up, a session with no Github on it, a person who
 * reaches no owner at all, and an owner they cannot reach are the four this
 * screen was written for. The fifth is an owner that MOVED: the organisation
 * was renamed on Github (`auth/owner-rename.ts` names it), every address under
 * the old name still opens this board, and until now all of them read
 * "Github hasn't given this account access" — which was not true, and which
 * sent people to check a permission nobody had taken away.
 *
 * `renamedTo` is a name board-service PROVED, never a guess it would like to
 * make; `auth/owner-rename.ts` on either side of the wire holds what the proof
 * is. So the rename arm is drawn only where the board can stand behind the
 * sentence, and a person whose access really is missing reads exactly the
 * refusal they read before — which is the whole of acceptance criterion 2.
 *
 * The rename arm offers no Reconnect. Nothing is wrong with this person's
 * connection, and a control implying otherwise is the same wrong advice in a
 * smaller place.
 */
export function GithubAccessState({
  owner,
  connected,
  configured = true,
  renamedTo,
  renamedPath,
}: {
  owner?: string;
  connected: boolean;
  configured?: boolean;
  /** Where this owner's work is now, when the board can prove it moved. */
  renamedTo?: string | null;
  /** This same page under that name. Absent leaves the sentence standing
   *  without a way out, which is still better than the refusal it replaces. */
  renamedPath?: string;
}) {
  const renamed = configured && connected && owner && renamedTo ? renamedTo : null;
  return (
    <main className="p-8" aria-labelledby="github-access-title">
      <h1 id="github-access-title" className="text-xl font-semibold">
        {renamed
          ? `${owner} is now ${renamed}`
          : !configured
            ? 'GitHub isn’t set up on this board'
            : !connected
              ? 'Connect your GitHub account'
              : owner
                ? `You can’t access ${owner}`
                : 'No owners you can reach'}
      </h1>
      <p className="mt-3 mb-4 text-dim">
        {renamed
          ? 'This organization was renamed on GitHub. You still reach it under the new name.'
          : !configured
            ? 'An administrator has to finish the setup before you can connect.'
            : !connected
              ? 'Connect GitHub to see your repositories and act under your own name.'
              : 'GitHub hasn’t given this account access. Check the app installation and your own access on GitHub.'}
      </p>
      {renamed && renamedPath ? (
        <OpenRenamed owner={renamed} path={renamedPath} />
      ) : (
        configured && !renamed && <ConnectAction>{connected ? 'Sign in again' : 'Sign in with GitHub'}</ConnectAction>
      )}
    </main>
  );
}

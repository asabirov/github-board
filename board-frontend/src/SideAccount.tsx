import type { SavedShell } from './auth/saved-shell';
import { cachedOwner, rememberShellAccount } from './cache/payload-cache';
/**
 * Sidebar footer account menu (#107, #183, redesigned #200/#201). The signed-in
 * account row is a dropdown trigger; the menu is deliberately quiet — a uniform
 * set of label-only rows, no row set apart (#269, icons dropped #341):
 *   - an identity header (avatar + name + email)
 *   - Your access & agents, Preferences (#417), Admin Hub (admins only),
 *     Report an issue (#1450), API reference (#712)
 *   - Sign out (below a separator)
 * Report an issue opens the public repo's issues in a new tab. Each of the
 * others opens the area panel over the board (#712); none of them navigates,
 * because none of those areas has an address any more.
 * The Account/Admin split lands with #210. The theme toggle was dropped — board
 * is dark-first, so it's pinned dark (no switch to maintain; see main.tsx).
 * Identity comes from /api/auth/me; the person table upgrades the email to a name
 * + GitHub photo. Degrades: no /me (deploy skew, error) → a minimal sign-out row.
 * Sign out redirects only when the board confirms it; anything else stops on
 * `SignOutNotice` first (#682).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/kit';
import { useIdentity } from './auth/identity-context';
import { logout } from './api/core';
import { resolvePerson, usePeople } from './people-ctx';
import { avatarColor, initialOf } from './ui/avatar';
import { useOpenPanel } from './area-panel/panel-ctx';
import type { Panel } from './area-panel/panel';
import { writeOrgPref } from './org-scope/org-pref';
import { ChevronUpIcon } from './icons';
import { SignOutNotice } from './auth/SignOutNotice';
import type { SignOutNoticeState } from './auth/sign-out-copy';
import { createSignOut } from './auth/sign-out-run';

/** Where a reader reports a problem with the board (#1450). */
export const ISSUES_URL = 'https://github.com/asabirov/github-board/issues';

/**
 * Where a finished sign-out lands.
 *
 * It is a full page load, so nothing IN MEMORY survives it — but localStorage
 * does, and since #714 one of the things in there is the org this device was
 * last narrowed to. Left behind, it opens the next person's `/` on the previous
 * person's org, on a shared machine, under their name. So the scope is dropped
 * before leaving; the rest of `board_*` is a preference rather than a place
 * somebody was, and is deliberately left alone.
 */
const leave = () => {
  writeOrgPref(null);
  window.location.href = '/';
};

export function SideAccount({ preview }: { preview?: SavedShell } = {}) {
  const people = usePeople();
  // These areas have no addresses any more (#712), so a row below is the only way
  // into four of the five. The reference has a second door: the link inside
  // Access & agents, which REPLACES the open panel rather than stacking on it.
  const open = useOpenPanel();
  // Radix hands focus back to this trigger as the menu closes, which lands AFTER
  // the panel has taken it — so the panel opens with focus outside it and the
  // next Tab walks the dimmed board. Suppress the restore for a row that opened
  // a panel, and only for one: closing the menu any other way still returns
  // focus here, which is where a keyboard user left it.
  const opened = useRef(false);
  const openPanel = (panel: Panel) => { opened.current = true; open(panel); };
  const identity = useIdentity();
  const email = preview?.email ?? identity?.email ?? null;
  const isAdmin = identity?.isAdmin ?? false;
  const adminsUnread = identity?.adminsUnread ?? false;
  const [notice, setNotice] = useState<SignOutNoticeState | null>(null);

  const person = email ? resolvePerson(people, null, email) : null;
  const saved = preview ?? cachedOwner()?.shell;
  const account = saved?.email === email ? saved.account : undefined;
  const name = person?.displayName ?? account?.name ?? email?.split('@')[0] ?? null;
  const githubLogin = person ? person.githubLogin : account?.githubLogin;
  useEffect(() => {
    if (!preview && identity && email && person) rememberShellAccount(email, person.displayName, person.githubLogin ?? null);
  }, [preview, identity, email, person]);

  // Nothing to say means the sign-out landed, and only then the redirect: a full
  // page load would take any message with it (#682). The sequence, and the gate
  // that keeps a second press from settling over the first, are in
  // `auth/sign-out-run` — testable there, untestable as a callback here.
  const signOut = useMemo(() => createSignOut({ logout, show: setNotice, leave }), []);

  // Fallback: identity unavailable (deploy skew / error). Keep the user able to
  // sign out — no account row to hang a menu off.
  if (!email) {
    return (
      <div className="side-foot">
        <div className="side-foot-row">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={signOut}
            className="ml-auto h-auto rounded-[7px] border-line px-2.5 py-[3px] text-[12px] font-normal text-dim hover:bg-surface-3 hover:text-fg"
          >
            Sign out
          </Button>
        </div>
        <SignOutNotice notice={notice} />
      </div>
    );
  }

  const avatar = (size: string) => (
    <Avatar className={`${size} flex-none`}>
      {githubLogin && (
        <AvatarImage
          src={`https://github.com/${encodeURIComponent(githubLogin)}.png?size=96`}
          alt=""
          referrerPolicy="no-referrer"
          // The kit's AvatarImage keeps the radius only on the parent and leans on
          // overflow-clip to round the photo — but Chromium doesn't anti-alias an
          // overflow-clipped <img>, so the circle came out speckled/notched (#310).
          // Rounding the image element itself is anti-aliased, matching .rok-av-img.
          className="rounded-full object-cover"
        />
      )}
      <AvatarFallback className="font-semibold text-white" style={{ background: avatarColor(name) }}>
        {initialOf(name)}
      </AvatarFallback>
    </Avatar>
  );

  if (preview) return <div className="side-foot">
    <button type="button" disabled data-saved-account title={email}
      className="flex min-w-0 w-full cursor-default items-center gap-[9px] rounded-[9px] px-1.5 py-1.5 text-left">
      {avatar('h-6 w-6 text-[11px]')}
      <span className="side-acct-who">
        <span className="side-acct-name">{name}</span>
        <span className="side-acct-mail">{email}</span>
      </span>
      <ChevronUpIcon size={15} className="ml-auto flex-none text-muted" />
    </button>
  </div>;

  return (
    <div className="side-foot">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={email}
            className="side-acct w-full cursor-pointer rounded-[9px] px-1.5 py-1.5 text-left hover:bg-elevated data-[state=open]:bg-elevated"
          >
            {avatar('h-6 w-6 text-[11px]')}
            <span className="side-acct-who">
              <span className="side-acct-name">{name}</span>
              <span className="side-acct-mail">{email}</span>
            </span>
            <ChevronUpIcon size={15} className="ml-auto flex-none text-muted" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-[252px] p-1.5"
          onCloseAutoFocus={(e) => {
            if (!opened.current) return;
            opened.current = false;
            e.preventDefault();
          }}
        >
          {/* Identity header — a recessed card, echoing the account chip below it. */}
          <div className="mb-1 flex items-center gap-[11px] rounded-[10px] bg-[var(--board-well)] p-2.5">
            {avatar('h-10 w-10 text-[15px]')}
            <div className="min-w-0">
              <div className="text-[14px] font-semibold leading-tight text-fg">{name}</div>
              <div className="truncate text-[12px] text-muted">{email}</div>
            </div>
          </div>

          {/* Label-only items, one uniform hover across all of them (#269, icons
              dropped #341) — the leading icons, descriptions, and admin brand-rule
              block were all removed as noise; the words carry the menu. */}
          <DropdownMenuItem onSelect={() => openPanel({ area: 'account', section: 'account' })} className="py-2">
            Your access &amp; agents
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={() => openPanel({ area: 'account', section: 'github' })} className="py-2">
            GitHub
          </DropdownMenuItem>

          {/* Preferences (#417) — promoted out from under "Your access & agents"
              so theme/timezone isn't buried a level down. */}
          <DropdownMenuItem onSelect={() => openPanel({ area: 'account', section: 'preferences' })} className="py-2">
            Preferences
          </DropdownMenuItem>

          {/* Also shown when the board cannot read who its admins are (#811).
              The row grants nothing — every admin API still refuses, and the hub
              behind it says the board cannot answer rather than drawing a panel
              — but it is the only door to the Audit pane, which is where the
              lost-record count lives (#781). Withholding it from a teammate who
              is not an admin costs nothing while the roster reads; withholding
              it while the roster does not costs the operator the page that would
              name the outage, because the hub has no address of its own. */}
          {(isAdmin || adminsUnread) && (
            <DropdownMenuItem onSelect={() => openPanel({ area: 'admin', section: 'access' })} className="py-2">
              Admin hub
            </DropdownMenuItem>
          )}

          {/* The in-app feedback form went with #1450. Reports go to the public
              repo's issues, in a new tab so the board stays open. */}
          <DropdownMenuItem asChild className="py-2">
            <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">Report an issue</a>
          </DropdownMenuItem>

          {/* The reference had no row of its own until #712 — it was reachable
              only from a link inside Access & agents, a level down from a menu
              that lists everything else it sits beside. */}
          <DropdownMenuItem onSelect={() => openPanel({ area: 'docs' })} className="py-2">
            API reference
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={signOut} className="py-2">
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SignOutNotice notice={notice} />
    </div>
  );
}

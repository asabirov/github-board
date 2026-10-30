import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/kit';
import { Tip } from '../ui/Tip';
import { disconnectGithub, refreshGithubAccess } from '../api/account';
import type { MeResponse } from '../api/types';
import { forgetPayloads } from '../cache/payload-cache';
import { PageHeading, PAGE_READING } from '../ui/PageHeading';
import { ACCOUNT_RAIL } from './layout';
import { SettingsHelp } from './SettingsHelp';
import { ACCOUNT_LABEL } from './sections';
import { CARD } from './chrome';

type Github = NonNullable<MeResponse['github']>;

/** App's mount probe listens for this and re-runs the server's access check. */
const askForRecheck = () => window.dispatchEvent(new Event('board-github-changed'));

export function GithubAccountView({ github, verified, checkFailed = false }: {
  github?: Github;
  verified: boolean;
  /** The board's own access check answered with a fault rather than an answer.
   *  App owns that outcome; this page only says so and offers another try. */
  checkFailed?: boolean;
}) {
  const [busy, setBusy] = useState<'refresh' | 'disconnect' | null>(null);
  const [disconnectAttempted, setDisconnectAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether a verified answer has ever been drawn here. Before it has there is
  // nothing to keep, and nothing is mounted — a cold page holds no consent data
  // at all. After it has, the block stays in the tree through every recheck, so
  // an open disclosure and the panel's scroll survive one (#892 review, M1).
  const [drawn, setDrawn] = useState(false);
  useEffect(() => { if (verified) setDrawn(true); }, [verified]);

  const status = useRef<HTMLParagraphElement>(null);
  const reading = useRef<HTMLDivElement>(null);
  /** The control the reader was on inside the block a check hides. */
  const lastInside = useRef<HTMLElement | null>(null);

  const ready = verified && !busy;

  // A hidden block cannot hold focus, so whatever was in it is dropped on
  // `<body>` — outside the dialog, which is the one place focus may not go
  // while a modal panel is open. Park the reader on the line that says what is
  // happening, and put them back on the control they pressed once the check has
  // answered (#892 review, M3). Only when focus was in the block: a reader on
  // the rail or the X is left where they are.
  useEffect(() => {
    if (!ready) {
      const active = document.activeElement as HTMLElement | null;
      const orphaned = !active || active === document.body;
      if (!orphaned && !reading.current?.contains(active)) return;
      if (!orphaned) lastInside.current = active;
      status.current?.focus({ preventScroll: true });
      return;
    }
    const back = lastInside.current;
    lastInside.current = null;
    const active = document.activeElement;
    if (active === status.current || active === document.body) {
      const target = back?.isConnected ? back : reading.current?.querySelector<HTMLElement>('a[href], button:not([disabled])');
      target?.focus({ preventScroll: true });
    }
  }, [ready]);

  async function update(action: 'refresh' | 'disconnect') {
    setBusy(action);
    setError(null);
    if (action === 'disconnect') setDisconnectAttempted(true);
    try {
      if (action === 'disconnect') await disconnectGithub();
      else await refreshGithubAccess();
    } catch {
      setError(action === 'disconnect'
        ? 'Could not confirm disconnection. Check the refreshed connection status before trying again.'
        : 'Could not refresh GitHub access. Try again.');
    } finally {
      if (action === 'disconnect') forgetPayloads();
      askForRecheck();
      setBusy(null);
    }
  }

  // The authoritative /me has answered since the attempt and says the connection
  // is gone. Whatever the POST reported — a 409 raised by a cache clear that
  // landed mid-request, a dropped socket — the outcome is settled, and a page
  // drawing the disconnected state must not also say the disconnect failed
  // (#892 review, low 8).
  const settled = disconnectAttempted && verified && github?.connected === false;
  // What the check is doing, or what the last thing the reader pressed did, in
  // one region that is mounted whatever it says: a live region inserted at the
  // same moment as its text is announced by nothing. It is also where focus is
  // parked while the block below is hidden, so the outcome is read out there.
  const notice = !verified
    ? (checkFailed
      ? 'Couldn’t check your GitHub access. Try again.'
      : 'Checking GitHub access…')
    : busy === 'disconnect' ? 'Disconnecting GitHub…'
      : busy === 'refresh' ? 'Refreshing GitHub access…'
        : settled ? 'Disconnected from Board. Check your GitHub settings to confirm the consent was revoked.'
          : '';
  const shownError = settled ? null : error;
  const retryable = !verified && checkFailed;

  const installations = github?.installations;
  return (
    <section className={ACCOUNT_RAIL} aria-label="GitHub account">
      <PageHeading>{ACCOUNT_LABEL.github}</PageHeading>
      <div className={`${PAGE_READING} mt-5`}>
        <div className={notice || shownError || retryable ? 'mt-7 space-y-3' : ''}>
          <p ref={status} tabIndex={-1} role="status" className="text-sm text-dim">{notice}</p>
          {shownError && <p role="alert" className="text-sm text-danger">{shownError}</p>}
          {retryable && <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={askForRecheck}>Try again</Button>
            <Button asChild variant="outline"><a href="https://github.com/settings/apps/authorizations" target="_blank" rel="noopener noreferrer">Manage consent</a></Button>
          </div>}
        </div>
        {(verified || drawn) && (
          // Hidden while a check is in flight, which the board itself no longer
          // does (#1063): this panel is ABOUT the Github connection, so it waits
          // for the answer. It keeps its layout box, because dropping the box
          // collapses the panel's scroll height and takes the reader's position
          // with it. `invisible` draws nothing, holds no focus and is out of the
          // accessibility tree; `inert` says the same to anything that reads the
          // attribute rather than the style.
          <div
            ref={reading}
            className={`mt-7 space-y-7${ready ? '' : ' invisible'}`}
            inert={!ready}
            onFocus={(e) => { lastInside.current = e.target as HTMLElement; }}
          >
            {!github || github.configured === false ? (
              <p className="text-sm text-dim">The GitHub app isn’t set up on this board. An administrator has to finish the setup.</p>
            ) : !github.connected ? (
              <div className="space-y-4">
                <h2 className="text-base font-semibold">Connect your GitHub account</h2>

                <div className="flex flex-wrap gap-2">
                  <Button asChild><a href="/api/auth/github/login">Sign in with GitHub</a></Button><SettingsHelp label="Sign in with GitHub" text="Sign in again to reconnect and see the repositories you can access." />
                  <Button asChild variant="outline"><a href={github.authorizationsUrl ?? 'https://github.com/settings/apps/authorizations'} target="_blank" rel="noopener noreferrer">Manage consent</a></Button>
                </div>
              </div>
            ) : (
              <>
                <section className={`${CARD} p-5`} aria-labelledby="github-connection-heading">
                  <h2 id="github-connection-heading" className="text-base font-semibold">Connected account</h2>
                  <p className="text-sm">{github.login ? `@${github.login}` : 'GitHub connected'}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline"><a href={github.authorizationsUrl ?? 'https://github.com/settings/apps/authorizations'} target="_blank" rel="noopener noreferrer">Manage consent</a></Button>
                    <Button variant="outline" onClick={() => void update('disconnect')}>Disconnect</Button><SettingsHelp label="Disconnect GitHub" text="Disconnecting removes Board’s connection to your account across all organizations. It does not uninstall the app for other people." />
                  </div>

                </section>
                <section className="space-y-4" aria-labelledby="github-access-heading">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 id="github-access-heading" className="text-base font-semibold">Organization access <SettingsHelp label="Organization access" text="An installation belongs to the organization, so a change to it changes what Board can reach for everyone in that organization. An organization owner or app manager may need to make the change on GitHub." /></h2>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => void update('refresh')}>Refresh</Button>
                      {github.installUrl ? <Button asChild><a href={github.installUrl} target="_blank" rel="noopener noreferrer">Add organization</a></Button> : <Tip label="The app has no install link. An administrator has to finish the setup."><span tabIndex={0} className="inline-flex"><Button disabled>Add organization</Button></span></Tip>}
                    <SettingsHelp label="Add organization" text="Choose an organization on GitHub, then return and refresh access. An organization owner may need to approve the installation." /></div>
                  </div>


                  {!installations ? <p className="text-sm text-dim">Access details are unavailable. Refresh to try again.</p> : installations.length === 0 ? <p className="text-sm text-dim">No organization or personal installation is available to this account yet.</p> : (
                    <ul className="space-y-3">
                      {installations.map((installation) => (
                        <li key={installation.id} className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <h3 className="break-words text-base font-semibold">{installation.account.login}</h3>
                              <p className="mt-1 text-sm text-dim">
                                {installation.account.type === 'User' ? 'Personal account' : 'Organization'}
                                {installation.suspended ? ', suspended' : installation.repositoryCount !== null ? ` with ${installation.repositoryCount} repositories available to you` : ''}
                              </p>
                            </div>
                            <Button asChild variant="outline"><a href={installation.manageUrl} target="_blank" rel="noopener noreferrer">Manage</a></Button>
                          </div>
                          <p className="mt-3 text-sm text-dim">{installation.repositorySelection === 'all' ? 'App installed for all repositories.' : installation.repositorySelection === 'selected' ? 'App installed for selected repositories.' : 'Repository selection is unavailable.'}</p>
                          <div className="mt-3 flex items-center gap-1"><span className="text-sm text-dim">App permissions</span><SettingsHelp label="App permissions" text="These permissions were granted to the app. Board can only act within your own GitHub access." /></div>
                          <details className="mt-1 text-sm">
                            <summary className="cursor-pointer text-dim">View</summary>

                            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2">
                              {Object.entries(installation.permissions).map(([name, level]) => <div key={name} className="contents"><dt className="capitalize">{name.replaceAll('_', ' ')}</dt><dd className="capitalize text-dim">{level}</dd></div>)}
                            </dl>
                          </details>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

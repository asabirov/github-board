import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup as renderBare } from 'react-dom/server';
import { TooltipProvider } from '../ui/kit';
import type { ReactNode } from 'react';
const renderToStaticMarkup = (node: ReactNode) => renderBare(<TooltipProvider>{node}</TooltipProvider>);
import { GithubAccountView } from './GithubAccountView';
import type { MeResponse } from '../api/types';

const github: NonNullable<MeResponse['github']> = {
  configured: true, connected: true, owners: [], visibilityKey: 'synthetic', login: 'alice',
  installUrl: 'https://github.com/apps/test-board/installations/new',
  installations: [{ id: 42, account: { login: 'acme', type: 'Organization' }, repositorySelection: 'selected', repositoryCount: 2, permissions: { issues: 'write', metadata: 'read' }, suspended: false, manageUrl: 'https://github.com/organizations/acme/settings/installations/42' }],
};

describe('Account GitHub', () => {
  it('withholds account and consent details while access is unverified', () => {
    const html = renderToStaticMarkup(<GithubAccountView github={github} verified={false} />);
    expect(html).toContain('Checking GitHub access');
    expect(html).not.toContain('@alice');
    expect(html).not.toContain('acme');
    expect(html).not.toContain('installations/42');
    expect(html).not.toContain('Disconnect GitHub');
  });

  it('distinguishes app grants from the user access and offers GitHub management', () => {
    const html = renderToStaticMarkup(<GithubAccountView github={github} verified />);
    expect(html).toContain('aria-labelledby="github-connection-heading"');
    expect(html).toContain('rounded-2xl border border-line bg-surface p-5 shadow-sm');
    expect(html).toContain('@alice');
    expect(html).toContain('2 repositories available to you');
    expect(html).toContain('App installed for selected repositories');
    expect(html).toContain('Board can only act within your own GitHub access');
    expect(html).toContain(github.installUrl);
    expect(html).toContain(github.installations![0].manageUrl);
    expect(html).toContain('>Refresh</button>');
    // An installation is the organization's, and a reader deciding whether to
    // touch one has to be told that before they do (#892).
    expect(html).toContain('changes what Board can reach for everyone in that organization');
    expect(html).toContain('organization owner or app manager');
  });

  it('gives every installation its own grouped surface without dropping its details', () => {
    const second = { ...github.installations![0], id: 43, account: { login: 'acme', type: 'Organization' as const }, repositorySelection: 'all' as const, repositoryCount: 9 };
    const html = renderToStaticMarkup(<GithubAccountView github={{ ...github, installations: [...github.installations!, second] }} verified />);
    expect((html.match(/rounded-2xl border border-line bg-surface/g) ?? []).length).toBe(3);
    expect(html).toContain('acme');
    expect(html).toContain('acme');
    expect(html).toContain('App installed for all repositories');
    expect(html).toContain('App installed for selected repositories');
    expect(html).toContain('issues');
    expect(html).toContain('metadata');
  });

  it('keeps add organization available with no installations and shows suspended installations honestly', () => {
    const empty = renderToStaticMarkup(<GithubAccountView github={{ ...github, installations: [] }} verified />);
    expect(empty).toContain('No organization or personal installation');
    expect(empty).toContain(github.installUrl);
    const suspended = renderToStaticMarkup(<GithubAccountView github={{ ...github, installations: [{ ...github.installations![0], suspended: true, repositoryCount: null }] }} verified />);
    expect(suspended).toContain('Organization, suspended');
    expect(suspended).not.toContain('repositories available to you');
  });

  it('offers reconnection and consent settings after disconnect, and never invents setup', () => {
    const disconnected = renderToStaticMarkup(<GithubAccountView github={{ ...github, connected: false, login: null, installations: [] }} verified />);
    expect(disconnected).toContain('href="/api/auth/github/login"');
    expect(disconnected).toContain('>Manage consent</a>');
    expect(disconnected).not.toContain('Disconnect GitHub');
    const unconfigured = renderToStaticMarkup(<GithubAccountView github={{ ...github, configured: false }} verified />);
    expect(unconfigured).toContain('isn’t set up on this board');
    expect(unconfigured).not.toContain('href=');
    const noSlug = renderToStaticMarkup(<GithubAccountView github={{ ...github, installUrl: null }} verified />);
    expect(noSlug).toMatch(/<button[^>]*disabled[^>]*>Add organization<\/button>/);
    expect(noSlug).not.toContain('/apps/test-board');
  });
});

describe('GitHub check feedback', () => {
  it('keeps a focusable status region present before and after checking', () => {
    for (const verified of [false, true]) {
      const html = renderToStaticMarkup(<GithubAccountView github={github} verified={verified} />);
      expect(html).toContain('role="status"');
      expect(html).toContain('tabindex="-1"');
    }
  });

  it('offers retry and GitHub consent settings during an outage without revealing grants', () => {
    const failed = renderToStaticMarkup(<GithubAccountView github={github} verified={false} checkFailed />);
    expect(failed).toContain('Couldn’t check your GitHub access');
    expect(failed).toContain('Try again');
    expect(failed).toContain('href="https://github.com/settings/apps/authorizations"');
    expect(failed).not.toContain('Checking GitHub access');
    expect(failed).not.toContain('@alice');
    expect(failed).not.toContain('acme');
    expect(failed).not.toContain('installations/42');
  });
});

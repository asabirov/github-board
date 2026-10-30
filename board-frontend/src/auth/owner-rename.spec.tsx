import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GithubAccessState, GithubConnection } from './GithubConnection';
import { unreachedOwner } from './owner-rename';
import type { MeResponse } from '../api/types';

/**
 * The four addresses a person can open, and the two sentences they may read
 * (#1167).
 *
 * The board serves `acme`. A bookmark under `globex` is the same
 * organisation before its rename on 2026-09-16; `private-org` is a live
 * organisation this person is not in; `zzq-never-existed-org` is nobody's.
 * Only the first of those three may read "renamed", and the other two must read
 * what the board read before this issue, which is acceptance criterion 2.
 */
const github = (over: Partial<NonNullable<MeResponse['github']>> = {}): NonNullable<MeResponse['github']> =>
  ({
    configured: true,
    connected: true,
    visibilityKey: 'synthetic',
    owners: [{ login: 'acme', type: 'Organization' }],
    ...over,
  }) as NonNullable<MeResponse['github']>;

describe('which owner the board is about to refuse', () => {
  it('asks nothing about an organisation the board serves', () => {
    expect(unreachedOwner(github(), 'acme')).toBeNull();
  });

  it('asks nothing about it under another casing either, because Github folds a login', () => {
    expect(unreachedOwner(github(), 'ACME')).toBeNull();
  });

  it('asks about the old name, the private org and the name nobody registered', () => {
    expect(unreachedOwner(github(), 'globex')).toBe('globex');
    expect(unreachedOwner(github(), 'private-org')).toBe('private-org');
    expect(unreachedOwner(github(), 'zzq-never-existed-org')).toBe('zzq-never-existed-org');
  });

  it('asks nothing when the address names no organisation', () => {
    expect(unreachedOwner(github(), null)).toBeNull();
  });

  it('asks nothing about a session with no Github on it, which has no owner to ask about', () => {
    expect(unreachedOwner(undefined, 'globex')).toBeNull();
    expect(unreachedOwner(github({ connected: false }), 'globex')).toBeNull();
    expect(unreachedOwner(github({ configured: false }), 'globex')).toBeNull();
  });
});

describe('what a person reads at each of the four addresses', () => {
  it('says the organisation was renamed, and offers the new name as a link', () => {
    const html = renderToStaticMarkup(
      <GithubAccessState connected owner="globex" renamedTo="acme" renamedPath="/acme/repos" />,
    );
    expect(html).toContain('globex is now acme');
    expect(html).toContain('This organization was renamed on GitHub. You still reach it under the new name.');
    // The sentence this issue is about must be gone from this screen, not
    // merely pushed below something kinder.
    expect(html, 'the refusal is not shown beside the rename').not.toContain('GitHub hasn’t given this account access');
    expect(html, 'nor is a control implying the connection is at fault').not.toContain('href="/api/auth/github/login"');
  });

  it('offers the link as an anchor to the same page under the new name', () => {
    const html = renderToStaticMarkup(
      <GithubAccessState connected owner="globex" renamedTo="acme" renamedPath="/acme/repos" />,
    );
    const anchor = /<a [^>]*href="\/acme\/repos"[^>]*>/.exec(html)?.[0] ?? '';
    expect(anchor, 'a real address, so it can be opened in a tab or sent on').not.toBe('');
    expect(anchor, 'styled by the kit Button through asChild, as every call to action here is').toContain('inline-flex');
    expect(html).toContain('Open acme');
  });

  it('still refuses an organisation this person genuinely cannot access', () => {
    const html = renderToStaticMarkup(<GithubAccessState connected owner="private-org" />);
    expect(html).toContain('You can’t access private-org');
    expect(html).toContain('GitHub hasn’t given this account access. Check the app installation and your own access on GitHub.');
    expect(html).toContain('href="/api/auth/github/login"');
    expect(html).not.toContain('is now');
  });

  it('refuses a name that never existed in exactly the same words', () => {
    // Github answers a former login and a login nobody registered identically,
    // so the board has nothing to add here. Saying "renamed" would be this
    // issue's own defect pointing the other way.
    const html = renderToStaticMarkup(<GithubAccessState connected owner="zzq-never-existed-org" />);
    expect(html).toContain('You can’t access zzq-never-existed-org');
    expect(html).not.toContain('is now');
  });

  it('refuses rather than renames while the board has proved nothing', () => {
    // `null` is also what the screen holds for the round trip before the answer
    // lands, so this is the first thing a person sees at every address.
    const html = renderToStaticMarkup(<GithubAccessState connected owner="globex" renamedTo={null} />);
    expect(html).toContain('You can’t access globex');
  });

  it('stops the switcher saying "No access" about the organisation the page calls renamed', () => {
    // One screen, two claims, and they were opposite: the page said the
    // organisation had moved and was still reachable while the switcher three
    // lines away went on refusing it.
    const html = renderToStaticMarkup(
      <GithubConnection github={github()} owner="globex" renamedTo="acme" navigate={() => {}} />,
    );
    expect(html).toContain('aria-label="Switch organization, globex, now acme"');
    expect(html).toMatch(/>Now acme</);
    expect(html).not.toContain('No access');
  });

  it('keeps the switcher refusing an owner nothing was proved about', () => {
    const html = renderToStaticMarkup(
      <GithubConnection github={github()} owner="private-org" navigate={() => {}} />,
    );
    expect(html).toContain('aria-label="Switch organization, private-org, no access"');
    expect(html).toContain('No access');
    expect(html).not.toContain('Now ');
  });

  it('never renames a screen that is not about an owner at all', () => {
    // A proven name arriving late must not rewrite the unconnected gate or the
    // one for a person who reaches nothing: neither is about an organisation.
    expect(
      renderToStaticMarkup(<GithubAccessState connected={false} renamedTo="acme" renamedPath="/acme" />),
    ).toContain('Connect your GitHub account');
    expect(
      renderToStaticMarkup(<GithubAccessState connected renamedTo="acme" renamedPath="/acme" />),
    ).toContain('No owners you can reach');
  });
});

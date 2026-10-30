import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GithubAccessState, GithubConnection } from './GithubConnection';
import { ownerShortName, ownerControlOffered, securityLevel } from '../repos/repos-vm';

describe('per-user Github access states', () => {
  it('names the organization switcher and its current personal scope', () => {
    const html = renderToStaticMarkup(<GithubConnection github={{ connected: true, owners: [{ login: 'acme', type: 'Organization' }, { login: 'alice', type: 'User' }] }} owner="alice" navigate={() => {}} />);
    expect(html).toContain('aria-label="Switch organization, alice"'); expect(html).not.toContain('<label'); expect(html).toContain('>alice</span>'); expect(html).not.toContain('Personal ('); expect(html).toContain('aria-haspopup="menu"'); expect(html).not.toContain('Disconnect GitHub');
  });
  it('marks a personal owner with the login it belongs to, not the word Personal', () => {
    // `Personal (alice)` starting with a P handed alice a square reading P, and
    // gave every org starting with p the same one (#892 review, M1).
    const html = renderToStaticMarkup(<GithubConnection github={github()} owner="alice" navigate={() => {}} />);
    expect(html, "alice's square reads A").toContain('>A</span>');
    expect(html, 'and never P, which named the label template').not.toContain('>P</span>');
  });
  it('marks the union with a glyph, because All GitHub orgs is not an owner beginning with A', () => {
    const html = renderToStaticMarkup(<GithubConnection github={github()} owner={null} navigate={() => {}} />);
    expect(html).toContain('All GitHub orgs');
    // An svg in the square, not a letter that collides with `acme`.
    expect(/<span aria-hidden="true"[^>]*>\s*<svg/.test(html), 'the square holds a glyph').toBe(true);
    expect(html).not.toContain('>A</span>');
  });
  it('renders an unconnected prompt with no figures, and an explicit refused owner', () => {
    expect(renderToStaticMarkup(<GithubAccessState connected={false} />)).toContain('Connect your GitHub account');
    expect(renderToStaticMarkup(<GithubAccessState connected owner="private-org" />)).toContain('You can’t access private-org');
  });
  it('treats personal-owner security and dri as not applicable, never clean or writable', () => {
    expect(ownerShortName(null, 'not-applicable')).toBe('Not applicable');
    expect(ownerControlOffered('not-applicable')).toBe(false);
    expect(securityLevel({ state: 'not-applicable', depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null })).not.toBe('clean');
  });
});

const OWNERS = [
  { login: 'acme', type: 'Organization' as const },
  { login: 'alice', type: 'User' as const },
];
const github = (over: Partial<Parameters<typeof GithubConnection>[0]['github']> = {}) => ({
  connected: true,
  visibilityKey: 'synthetic',
  owners: OWNERS,
  ...over,
});

/**
 * The calls to action, and the address the disconnect no longer reloads onto
 * (#892 review, F11 and low 4).
 */
describe('the disconnect outcome and the calls to action', () => {
  it('offers connect and reconnect as board buttons, not underlined anchors', () => {
    for (const html of [
      renderToStaticMarkup(<GithubAccessState connected={false} />),
      renderToStaticMarkup(<GithubAccessState connected owner="private-org" />),
    ]) {
      expect(html).toContain('href="/api/auth/github/login"');
      // The board's own Button, handed the anchor through `asChild` — one
      // anchor carrying the class Button stamps, and never a bare `underline`.
      const anchor = /<a [^>]*href="\/api\/auth\/github\/login"[^>]*>/.exec(html)?.[0] ?? '';
      expect(anchor, 'the call to action is an anchor').not.toBe('');
      expect(anchor, 'styled by the kit Button through asChild').toContain('inline-flex');
      expect(anchor).not.toContain('underline');
    }
  });

  it('opens Account setup from the unconnected sidebar', () => {
    const html = renderToStaticMarkup(<GithubConnection github={github({ connected: false })} owner={null} navigate={() => {}} />);
    expect(html).toContain('Set up GitHub');
    expect(html).not.toContain('href=');
  });

  it('carries no reader of the disconnect reload, which nothing produces now', async () => {
    const module = await import('./GithubConnection');
    expect(Object.keys(module)).not.toContain('DISCONNECT_PARAM');
    expect(Object.keys(module)).not.toContain('disconnectAttempted');
    expect(Object.keys(module)).not.toContain('GithubDisconnectNotice');
  });

  it('draws nothing to connect when the deployment has no Github app', () => {
    const html = renderToStaticMarkup(<GithubAccessState connected={false} configured={false} />);
    expect(html).toContain('isn’t set up on this board');
    expect(html).not.toContain('href="/api/auth/github/login"');
  });
});

/**
 * An owner in the address that Github does not grant (#892 review, F10).
 */
describe('the owner picker over an owner it cannot reach', () => {
  it('names the refused owner rather than falling back to a placeholder', () => {
    const html = renderToStaticMarkup(
      <GithubConnection github={github()} owner="globex" navigate={() => {}} />,
    );
    expect(html).toContain('globex');
  });

  it('states the refusal on a line of its own, which no truncation can shorten', () => {
    // The name truncates and the qualifier must not go with it: inside
    // `globex (no access)` the sidebar's width ate the half that mattered
    // (#892 review, M2). The accessible name still carries both.
    const html = renderToStaticMarkup(
      <GithubConnection github={github()} owner="globex" navigate={() => {}} />,
    );
    expect(html).toContain('aria-label="Switch organization, globex, no access"');
    expect(html, 'the name truncates').toMatch(/class="truncate[^"]*"[^>]*>globex</);
    expect(html, 'the refusal is a sibling of it, not part of it').toMatch(/>No access</);
  });

  it('offers only the granted owners when the address names one of them', () => {
    const html = renderToStaticMarkup(
      <GithubConnection github={github()} owner="alice" navigate={() => {}} />,
    );
    expect(html).not.toContain('No access');
    expect(html).toContain('>alice</span>'); expect(html).not.toContain('Personal (');
  });

  it('reads a differently cased address as the owner it names, not one it refuses', () => {
    // `/Acme` against a granted `acme` satisfied the reachability test and then
    // matched no option, so the old picker fell back to its placeholder over a
    // page that was working perfectly.
    const html = renderToStaticMarkup(
      <GithubConnection github={github()} owner="Acme" navigate={() => {}} />,
    );
    expect(html, 'named by the granted login, in its own casing').toContain('aria-label="Switch organization, acme"');
    expect(html).not.toContain('No access');
    expect(html).not.toContain('All GitHub orgs');
  });
});

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocsPage } from './DocsPage';
import { MCP_TOOLS } from './docs-data';

// The board's test env is `node` (no DOM), so render to a static HTML string and
// assert against the markup — the same shape Pulse.spec.tsx uses.

const markup = () => renderToStaticMarkup(<DocsPage />);

describe('DocsPage — the MCP section', () => {
  it('names every MCP tool', () => {
    // Iterating the array rather than hard-coding a name means tool two is
    // covered the moment it lands in docs-data.
    const html = markup();
    expect(MCP_TOOLS.length).toBeGreaterThan(0);
    for (const tool of MCP_TOOLS) expect(html).toContain(tool.name);
  });

  it('no longer claims an empty tool surface', () => {
    expect(markup()).not.toContain('No tools are exposed yet');
  });
});

describe('DocsPage — the OAuth handshake (#456)', () => {
  // The only automated check that /docs covers the handshake end to end.
  // `docs-surface.spec.ts` asserts every registered MCP TOOL is documented and
  // says nothing about this section, so without these a step could be dropped
  // and every test would stay green.
  //
  // Every assertion reads the AUTH section alone. Against the whole page they
  // would pass on words the Scopes and MCP sections already carry — the preset
  // assertion below did exactly that before this slice existed.
  function authSection(): string {
    const html = markup();
    const start = html.indexOf('data-docs-section="auth"');
    const end = html.indexOf('data-docs-section="scopes"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return html.slice(start, end);
  }

  it('names all four endpoints of the handshake', () => {
    const html = authSection();
    for (const path of ['/register', '/authorize', '/token', '/revoke']) {
      expect(html).toContain(path);
    }
  });

  it('walks the six steps in order', () => {
    const html = authSection();
    const steps = ['Register', 'Authorize', 'Consent', 'Exchange the code', 'Refresh', 'Revoke'];
    const positions = steps.map((s) => html.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('states both lifetimes', () => {
    const html = authSection();
    expect(html).toContain('one hour');
    expect(html).toContain('thirty days');
  });

  it('says every client is public and uses PKCE', () => {
    const html = authSection();
    expect(html).toContain('PKCE');
    expect(html).toContain('public');
    expect(html).toContain('no client secret');
  });

  it('names the two consent presets and what each grants', () => {
    const html = authSection();
    expect(html).toContain('agent');
    expect(html).toContain('full');
    expect(html).toContain('board:read');
    expect(html).toContain('board:admin');
  });

  it('says what a reused refresh token costs, and that no grace period softens it', () => {
    // Both halves, because either alone would pass against a page that told only
    // half the truth. A reader who takes away "it kills the grant" but not "there
    // is no window" will build a client that retries a failed refresh with the
    // same token, which is the one thing that cuts them off.
    const auth = authSection();
    expect(auth).toContain('kills the whole grant');
    expect(auth).toContain('no grace period');
  });
});

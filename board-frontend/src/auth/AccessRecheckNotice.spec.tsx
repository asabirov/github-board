import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import source from '../sync/sync-status.tsx?raw';
import { SavedDataStatus } from './SavedDataStatus';

// Replaces the #1004/#1063 recheck notice assertions after #1278.
describe('saved data status without automatic recheck UI', () => {
  it('marks saved data without claiming a permission check is running', () => {
    const html = renderToStaticMarkup(<SavedDataStatus savedData />);
    expect(html).toContain('Saved data');
    expect(html).toContain('Showing the last data loaded.');
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/Rechecking|trying again|<button/);
  });
  // #1410: below 901px the label was `sr-only`, so a sighted reader on a phone
  // saw a bare dot, and the tooltip that would have explained it never opens on
  // touch. The bug is any class that takes the words away at any width, not the
  // one class that caused it, so read the label's own classes.
  it('shows the label at every width, not only to a screen reader', () => {
    const html = renderToStaticMarkup(<SavedDataStatus savedData />);
    const label = /<span class="([^"]*)"[^>]*>Saved data</.exec(html);
    expect(label, `no element carries the label: ${html}`).not.toBeNull();
    const takesTheWordsAway = label![1]
      .split(/\s+/)
      .filter((name) => /(^|:)(sr-only|hidden|invisible|opacity-0)$/.test(name));
    expect(takesTheWordsAway).toEqual([]);
  });
  it('leaves a quiet live region when no saved data is shown', () => {
    const html = renderToStaticMarkup(<SavedDataStatus />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('Saved data');
  });
  it('never sends an auth request with automatic data refresh', () => {
    expect(source).not.toContain('fetchMe');
    expect(source).not.toContain('/api/auth/');
  });
});

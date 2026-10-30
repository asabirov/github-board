import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IssueLoading } from './IssueLoading';

describe('IssueLoading', () => {
  it('announces one busy region and keeps placeholder content hidden', () => {
    const html = renderToStaticMarkup(<IssueLoading />);
    expect(html).toContain('aria-busy="true" aria-label="Loading issue"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('<p role="status" class="sr-only">Loading issue…</p>');
    expect(html).not.toMatch(/<(?:button|input|a|h1)\b/);
    const placeholders = [...html.matchAll(/class="([^"]*animate-pulse[^"]*)"/g)];
    expect(placeholders.length).toBeGreaterThan(0);
    for (const [, classes] of placeholders) {
      expect(classes.split(/\s+/)).toContain('motion-reduce:animate-none');
    }
  });
});

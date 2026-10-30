import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoadingStructure, ProjectStripShape } from './LoadingStructure';

describe('LoadingStructure', () => {
  it.each([
    ['overview', 'overview'], ['work', 'your work'], ['queue', 'your queue'], ['repos', 'repositories'],
    ['project', 'project'], ['repo', 'repository'],
  ] as const)('keeps the %s surface shaped and data-free', (surface, label) => {
    const html = renderToStaticMarkup(<LoadingStructure surface={surface} label={label} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(`aria-label="Loading ${label}"`);
    expect(html).toContain('role="status"');
    expect(html).toContain('sr-only');
    expect(html).not.toContain('text-muted">Loading ');
    expect(html).not.toMatch(/\b\d+%|\b\d+ open|\b\d+ closed/);
    // The kit's pulse, held still under reduced motion (#1033). Markup only:
    // whether it pulses in a browser was read on #1033.
    expect(html).toContain('animate-pulse');
    expect(html).toContain('motion-reduce:animate-none');
    expect(html).not.toContain('!animate-none');
  });

  it('pulses the strip shape while loading, and holds it still when it is not (#1033)', () => {
    const count = (html: string, cls: string) => html.split(cls).length - 1;
    const loading = renderToStaticMarkup(<ProjectStripShape />);
    const still = renderToStaticMarkup(<ProjectStripShape still />);
    expect(count(loading, 'animate-pulse')).toBe(3);
    expect(count(loading, 'motion-reduce:animate-none')).toBe(3);
    expect(count(still, '!animate-none')).toBe(3);
    expect(still).not.toContain('motion-reduce:animate-none');
  });

  it('keeps repos placeholders as individually padded cards', () => {
    const html = renderToStaticMarkup(<LoadingStructure surface="repos" label="repositories" />);
    expect(html).toContain('grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3');
    expect(html).toContain('min-h-[112px]');
    expect(html).toContain('px-4 pb-3 pt-3.5');
    expect(html).not.toContain('sm:grid-cols-2');
    expect(html).not.toContain('lg:grid-cols-3');
    expect(html).not.toMatch(/<section[^>]+bg-surface/);
  });
});

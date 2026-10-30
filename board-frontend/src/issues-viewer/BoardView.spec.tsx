import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardView } from './BoardView';
import { NO_PROJECT_KEY, NO_PROJECT_LABEL } from './filter-group';
import type { RenderGroup } from './viewer-groups';

/**
 * What the Queue's column headings are (#1191). The suite has no DOM, so this
 * renders the markup rather than driving the page —
 * the live accessibility tree is checked in the browser, which is where the
 * focus ring and the underline can be seen at all.
 */
const CATALOG = [
  { org: 'acme', number: 12, name: 'Acme Compliance' },
  { org: 'acme', number: 7, name: 'Acme Go-To-Market' },
];

const column = (key: string, label = key): RenderGroup => ({ key, label, tone: 'neutral', rows: [] });

const board = (groups: RenderGroup[], dim: Parameters<typeof BoardView>[0]['dim'] = 'project') =>
  renderToStaticMarkup(
    <BoardView groups={groups} dim={dim} boards={CATALOG} mayClose={false} mayAssign={false} />,
  );

/** Every anchor the board drew, as `href` → the text inside it. */
const links = (html: string): Record<string, string> =>
  Object.fromEntries(
    [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map(([, href, inner]) => [href, inner.replace(/<[^>]*>/g, '')]),
  );

describe('Queue column headings', () => {
  it('names each project column with a link to that project page', () => {
    const html = board([column('Acme Compliance'), column('Acme Go-To-Market')]);
    expect(links(html)).toEqual({
      '/acme/projects/12': 'Acme Compliance',
      '/acme/projects/7': 'Acme Go-To-Market',
    });
  });

  // The whole point of the report: a name that only responds to a click is not
  // a link. It has to be an anchor with a real href, so the browser's own
  // gestures — a new tab, Copy link, a Tab press and Enter — all work on it.
  it('reads as a link rather than as text that responds, in the board link treatment', () => {
    const html = board([column('Acme Compliance')]);
    const [, className] = /<a [^>]*class="([^"]*)"/.exec(html) ?? [];
    expect(className?.split(' ')).toContain('text-dim');
    expect(className?.split(' ')).not.toContain('text-accent');
    expect(className?.split(' ')).toContain('font-medium');
    expect(className?.split(' ')).toContain('text-link');
    expect(html).toContain('data-link-cue=""');
    expect(className).toContain('focus-visible:outline-[var(--accent)]');
    // Inside the chip, because the box around it clips — see FOCUS_RING_INSIDE.
    expect(className).toContain('focus-visible:-outline-offset-2');
  });

  it('leaves "No project" as plain text, since there is no page to open', () => {
    const html = board([column('Acme Compliance'), column(NO_PROJECT_KEY, NO_PROJECT_LABEL)]);
    expect(html).toContain(NO_PROJECT_LABEL);
    expect(Object.keys(links(html))).toEqual(['/acme/projects/12']);
    // And it must not read as clickable either: the ink is the chip's own.
    const [, plainClass, plainBody] = /<span class="([^"]*)">([^<]*(?:<[^>]*>[^<]*<\/span>)?No project)<\/span>/.exec(html) ?? [];
    expect(plainClass?.split(' ')).toContain('text-dim');
    expect(plainClass?.split(' ')).toContain('font-medium');
    expect(plainBody).toBeDefined();
    expect(plainBody).not.toContain('data-link-cue');
  });

  it('links nothing under a grouping whose columns are not boards', () => {
    expect(links(board([column('Acme Compliance')], 'label'))).toEqual({});
  });
});

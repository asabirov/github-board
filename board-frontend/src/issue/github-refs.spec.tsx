import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { githubRefs, type RemarkPlugins } from './github-refs';
import { isTaskListItem, taskLineOf } from './body-tasks';

// Render through the SAME pipeline the issue page uses — remark-gfm plus our
// reference plugin — so every assertion is about what a reader actually sees,
// not about an intermediate tree. The "current repo" here is a stand-in: the
// page threads the issue's own owner/repo, never a hardcoded one.
const HERE = { owner: 'acme', repo: 'board' };

function html(md: string, repo = HERE): string {
  const plugins: RemarkPlugins = [remarkGfm, [githubRefs, repo]];
  return renderToStaticMarkup(<ReactMarkdown remarkPlugins={plugins}>{md}</ReactMarkdown>);
}

/** Every href the render emits, in order. */
function hrefs(md: string, repo = HERE): string[] {
  return [...html(md, repo).matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]);
}

const ISSUES = 'https://github.com/acme/board/issues';

describe('references that must become links (#468)', () => {
  it('links #123 to that issue in the CURRENT repository', () => {
    expect(hrefs('Fixed in #123.')).toEqual([`${ISSUES}/123`]);
    expect(html('Fixed in #123.')).toContain('>#123</a>');
  });

  it('takes the current repository from the issue, not a hardcoded one', () => {
    expect(hrefs('see #7', { owner: 'acme', repo: 'widgets' }))
      .toEqual(['https://github.com/acme/widgets/issues/7']);
  });

  it('links owner/repo#123 cross-repo, keeping the written label', () => {
    const md = 'upstream — CardTitle / EmptyState heading levels (acme/acme-ui#383)';
    expect(hrefs(md)).toEqual(['https://github.com/acme/acme-ui/issues/383']);
    expect(html(md)).toContain('>acme/acme-ui#383</a>');
  });

  it('links @login to that person’s Github profile', () => {
    expect(hrefs('cc @octocat')).toEqual(['https://github.com/octocat']);
    expect(html('cc @octocat')).toContain('>@octocat</a>');
  });

  it('links GH-123 to the current repository', () => {
    expect(hrefs('see GH-42')).toEqual([`${ISSUES}/42`]);
  });

  it('links several references in one paragraph, in order, keeping the prose', () => {
    const out = html('Closes #12 and #13, cc @ivan.');
    expect(hrefs('Closes #12 and #13, cc @ivan.')).toEqual([
      `${ISSUES}/12`, `${ISSUES}/13`, 'https://github.com/ivan',
    ]);
    expect(out).toContain('Closes ');
    expect(out).toContain(' and ');
    expect(out).toContain(', cc ');
    expect(out).toContain('.</p>');
  });

  it('links a reference in a list item, a heading and a table cell', () => {
    expect(hrefs('- blocked by #5')).toEqual([`${ISSUES}/5`]);
    expect(hrefs('## Fix #5')).toEqual([`${ISSUES}/5`]);
    expect(hrefs('| a |\n| --- |\n| #5 |')).toEqual([`${ISSUES}/5`]);
  });

  it('links a reference nested in emphasis and in a blockquote', () => {
    expect(hrefs('**bold #5**')).toEqual([`${ISSUES}/5`]);
    expect(hrefs('> quoted #5')).toEqual([`${ISSUES}/5`]);
  });

  it('survives punctuation around the reference', () => {
    expect(hrefs('(#5), [#6]; “#7”')).toEqual([`${ISSUES}/5`, `${ISSUES}/6`, `${ISSUES}/7`]);
  });

  it('opens references on Github in a new tab, like every other Github link here', () => {
    const out = html('see #1');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});

describe('text that must NOT become a link (#468)', () => {
  it('leaves a reference inside a code span alone', () => {
    expect(hrefs('use `#123` and `@me` and `a/b#9`')).toEqual([]);
  });

  it('leaves a reference inside a fenced code block alone', () => {
    expect(hrefs(['```', '# comment', 'curl /issues/#123 @me', '```'].join('\n'))).toEqual([]);
  });

  it('leaves a reference inside an indented code block alone', () => {
    expect(hrefs('prose\n\n    ping @me about #12\n')).toEqual([]);
  });

  it('leaves a markdown heading’s own # alone', () => {
    const out = html('# Heading\n');
    expect(hrefs('# Heading\n')).toEqual([]);
    expect(out).toContain('<h1>Heading</h1>');
  });

  it('leaves hex colours alone', () => {
    expect(hrefs('brand #0af on #00aaff over #fff')).toEqual([]);
  });

  it('leaves an email address alone', () => {
    // GFM autolinks the address itself; nothing points at a Github profile.
    expect(hrefs('write to octocat@example.com')).toEqual(['mailto:octocat@example.com']);
  });

  it('leaves a # that is glued to a word alone', () => {
    expect(hrefs('build#42 and rev-#42')).toEqual([]);
  });

  it('leaves a bare commit SHA alone', () => {
    expect(hrefs('shipped in 2124088 / c4c61d9f1e0b4a7d3c2e5f6a8b9c0d1e2f3a4b5c')).toEqual([]);
  });
});

describe('links that already exist keep working unchanged (#468)', () => {
  it('leaves a GFM autolinked bare URL as one link, fragment intact', () => {
    const md = 'see https://github.com/acme/board/issues/468#issuecomment-1';
    expect(hrefs(md)).toEqual(['https://github.com/acme/board/issues/468#issuecomment-1']);
  });

  it('leaves an anchor-only URL alone', () => {
    expect(hrefs('read https://example.com/docs#123 first')).toEqual(['https://example.com/docs#123']);
  });

  it('never nests a link inside a markdown link whose TEXT is a reference', () => {
    const out = html('[#123](https://example.com/x)');
    expect(hrefs('[#123](https://example.com/x)')).toEqual(['https://example.com/x']);
    expect(out).toContain('>#123</a>');
  });

  it('leaves a link destination’s fragment alone', () => {
    expect(hrefs('[docs](https://example.com/a#123)')).toEqual(['https://example.com/a#123']);
  });

  it('leaves an image alone', () => {
    expect(hrefs('![alt #1](https://example.com/i.png#123)')).toEqual([]);
  });

  it('still renders task lists, tables and strikethrough (remark-gfm untouched)', () => {
    expect(html('- [x] done #1')).toContain('type="checkbox"');
    expect(html('~~gone~~ #1')).toContain('<del>gone</del>');
  });
});

describe('the editable body keeps its task lines (#426 × #468)', () => {
  // The writer's body wires each checkbox to its SOURCE LINE off the `li` node's
  // position. Splitting a text node drops that text node's position, so this is
  // the guard that the LINE the toggle writes back to is still the right one.
  it('reports the same task source lines with references in the task text', () => {
    const md = ['- [ ] land #12', '', 'prose @ivan', '', '- [x] verify acme/acme-ui#383'].join('\n');
    const lines: number[] = [];
    const components: Components = {
      li(props) {
        if (isTaskListItem(props.node)) lines.push(taskLineOf(props.node)!);
        return <li>{props.children}</li>;
      },
    };
    const plugins: RemarkPlugins = [remarkGfm, [githubRefs, HERE]];
    renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={plugins} components={components}>{md}</ReactMarkdown>,
    );
    expect(lines).toEqual([1, 5]);
  });
});

describe('login shapes (#468)', () => {
  it('stops a login at a trailing hyphen or apostrophe', () => {
    expect(hrefs('@foo-bar’s note, @baz- too')).toEqual([
      'https://github.com/foo-bar', 'https://github.com/baz',
    ]);
  });

  it('ignores an @ that opens nothing usable', () => {
    expect(hrefs('@ alone, and @-lead')).toEqual([]);
  });

  it('ignores a run longer than a Github login', () => {
    expect(hrefs(`@${'a'.repeat(40)}`)).toEqual([]);
  });
});

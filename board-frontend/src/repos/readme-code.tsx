/**
 * The readme's fenced code, drawn by the kit's `CodeBlock` (#963).
 *
 * The override is on `pre`, not on `code`. react-markdown hands `code` both a
 * fence's inner element and every inline span, and since v9 it no longer says
 * which is which; a `pre` is only ever a block. So inline code never reaches
 * this file and stays the `.pj-md` inline chip.
 *
 * What the kit is given is text read off react-markdown's own tree, and the kit
 * draws it as React children, so a readme from any repository stays escaped
 * exactly as it was: nothing here, and nothing in the kit's block, sets inner
 * HTML.
 */
import type { ComponentProps } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import { CodeBlock, type CodeLang, type CodeVariant } from '../ui/kit';

type HastElement = NonNullable<ExtraProps['node']>;
type HastChild = HastElement['children'][number];

/** Fence labels the kit has a grammar for, by the names readmes use. JavaScript
 *  draws with the TypeScript grammar, whose keywords are a superset of its own.
 *
 *  The last row is languages whose comments start with `#`, which the kit has no
 *  grammar for. Its shell grammar draws their comments as comments and their
 *  strings as strings, and also paints its eighteen command names (`set`,
 *  `source`, `node`…) wherever one stands as a word. The fallback below would
 *  instead read an apostrophe in a comment as the start of a string, and paint
 *  every line down to the next one. */
const KIT_LANG = new Map<string, CodeLang>([
  ['ts', 'ts'], ['typescript', 'ts'], ['js', 'ts'], ['javascript', 'ts'], ['mjs', 'ts'], ['cjs', 'ts'],
  ['tsx', 'tsx'], ['jsx', 'tsx'],
  ['bash', 'bash'], ['sh', 'bash'], ['shell', 'bash'], ['zsh', 'bash'], ['console', 'bash'],
  ['json', 'json'], ['jsonc', 'json'], ['json5', 'json'],
  ['css', 'css'], ['scss', 'css'], ['less', 'css'],
  ['python', 'bash'], ['py', 'bash'], ['yaml', 'bash'], ['yml', 'bash'], ['toml', 'bash'],
  ['ruby', 'bash'], ['rb', 'bash'], ['dockerfile', 'bash'], ['makefile', 'bash'],
]);

/** Labels the kit's `diff` variant draws: a line starting `+` or `-` is tinted
 *  and its marker moves to a gutter. The kit tints a `+++`/`---` file header the
 *  same way, having no notion of one. */
const DIFF_LABELS = new Set(['diff', 'patch']);

/** What a fence draws with when its label names no grammar above, a missing
 *  label included. The kit has no plain-text language, and given none it
 *  assumes `tsx`. None of its grammars draws text plain: every one of them shares
 *  one string rule, where `'`, `"` and a backtick each open a string that runs
 *  across lines to the next of the same mark, so the apostrophes in "don't" and
 *  a later "it's" paint everything between them. JSON adds the least on top of
 *  that: three keywords and no comments. Shell also paints `set` and `export`
 *  in a sentence, CSS paints `none` and `auto`, and TypeScript paints `if` and
 *  `for` and dims a URL from its `//` to the end of the line. */
export const UNKNOWN_LANG: CodeLang = 'json';

export type ReadmeFence = { lang: CodeLang; variant: CodeVariant };

/** How the kit draws a fence, from the `language-<label>` class remark puts on
 *  its `code` element. A Map and a Set rather than object literals, so a fence
 *  labelled `constructor` cannot reach a prototype key. */
export function readmeFence(className: unknown): ReadmeFence {
  const classes = Array.isArray(className) ? className : typeof className === 'string' ? className.split(' ') : [];
  const found = classes.find((c): c is string => typeof c === 'string' && c.startsWith('language-'));
  const label = found?.slice('language-'.length).toLowerCase();
  if (label && DIFF_LABELS.has(label)) return { lang: UNKNOWN_LANG, variant: 'diff' };
  return { lang: (label && KIT_LANG.get(label)) || UNKNOWN_LANG, variant: 'default' };
}

function textOf(node: HastChild): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

/** A `pre` from markdown holds one `code` element, whose text ends in the
 *  newline that closed the fence; left on, the kit draws it as an empty last
 *  line. Long lines scroll inside the block rather than wrap, because a readme's
 *  code is mostly commands and config, where a wrapped line reads as two. */
function ReadmePre({ node, children }: ComponentProps<'pre'> & ExtraProps) {
  const code = node?.children.find((c): c is HastElement => c.type === 'element' && c.tagName === 'code');
  if (!code) return <pre>{children}</pre>;
  const { lang, variant } = readmeFence(code.properties.className);
  return (
    <div className="md-code">
      <CodeBlock code={textOf(code).replace(/\n$/, '')} lang={lang} variant={variant} scroll copy />
    </div>
  );
}

export const README_COMPONENTS: Components = { pre: ReadmePre };

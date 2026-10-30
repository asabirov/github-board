/**
 * Github issue/user references in markdown (#468).
 *
 * `#123`, `owner/repo#123`, `GH-123` and `@login` are links on Github, but they
 * are Github's own server-side preprocessing — not GFM — so react-markdown +
 * remark-gfm leave them as dead grey text. This is that preprocessing, as a
 * small remark plugin: it walks the parsed tree and splits `text` nodes into
 * text + `link` nodes, so the references come out as ordinary markdown links
 * and inherit the body's own anchor styling (`.pj-md a`).
 *
 * Working on the tree rather than on the raw markdown is what keeps code safe:
 * a fenced block is a `code` node and a code span an `inlineCode` node, neither
 * of which holds `text` children, so they are skipped by construction rather
 * than by a guard we could get wrong. Link and image subtrees are skipped
 * explicitly, so a URL fragment (`…/docs#123`) and the text of an existing link
 * are both left intact.
 *
 * Deliberately NOT linked: bare commit SHAs. A 7-40 char hex run is
 * indistinguishable from an id, a colour or a hash from some other repository,
 * so linking it produces confident 404s; the Definition of Done doesn't ask for
 * it. `GH-123` is in, being unambiguous and one alternative wide.
 */

import type { Options } from 'react-markdown';

/** The plugin list type ReactMarkdown accepts — re-exported so callers (and the
 *  spec) can name it without reaching into unified's types. */
export type RemarkPlugins = NonNullable<Options['remarkPlugins']>;

/** The repository a reference is relative to: a bare `#123` means an issue in
 *  THIS repo, so the page must pass the issue's own owner/repo. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** The mdast subset this plugin touches. Declared structurally so we don't take
 *  on `@types/mdast` as a dependency for four fields. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
  data?: { hProperties?: Record<string, string> };
}

/** Subtrees whose text is not prose: a link's label (nesting an `<a>` inside an
 *  `<a>` is invalid), a link/image URL, and raw HTML. `code` and `inlineCode`
 *  are here for the reader's benefit — they carry no `text` children, so they
 *  are already unreachable. */
const OPAQUE = new Set([
  'link', 'linkReference', 'image', 'imageReference', 'definition', 'html', 'code', 'inlineCode',
]);

// One pass over a text node's value. Alternatives, in order: a cross-repo
// `owner/repo#123`, a bare `#123`, `GH-123`, then `@login`. Boundaries are
// checked in code rather than with lookbehind, which not every browser we may
// meet parses — a SyntaxError in a regex literal would take the whole page down.
const REF = /([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)#(\d+)|#(\d+)|GH-(\d+)|@([A-Za-z0-9][A-Za-z0-9-]{0,38})/g;

/** What may sit directly before a `#123` / `GH-123`: not a word character (that
 *  is `build#42`, not a reference), not `/` or `#` or `&` (that is a URL path,
 *  a fragment or an entity), not `-`. */
const NOT_BEFORE_NUMBER = /[\w#&/-]/;
/** What may sit directly before `owner/repo#123` — as above, plus `.` so a
 *  hostname (`github.com/owner/repo#1`) can't be read as the owner. */
const NOT_BEFORE_SLUG = /[\w#&./-]/;
/** What may sit directly before an `@login`: the tail of an email's local part,
 *  which is what makes `octocat@example.com` not a mention. */
const NOT_BEFORE_LOGIN = /[\w.+@-]/;
/** What may not sit directly after any reference — it would mean we cut a
 *  longer word in half (`#12abc`, a 40-character login). */
const NOT_AFTER = /[\w-]/;

const text = (value: string): MdNode => ({ type: 'text', value });

/** A reference link. `hProperties` rides through remark-rehype onto the anchor:
 *  every other Github link on the issue page opens in a new tab, and a body
 *  reference that navigated the board away would lose the reader's place. */
function link(url: string, label: string): MdNode {
  return {
    type: 'link',
    url,
    title: null,
    children: [text(label)],
    data: { hProperties: { target: '_blank', rel: 'noopener noreferrer' } },
  };
}

const issueUrl = (owner: string, repo: string, number: string) =>
  `https://github.com/${owner}/${repo}/issues/${number}`;

/**
 * Split one text value into text and link nodes. Returns null when the value
 * holds no reference, so the original node (and its position) is kept as is.
 */
function splitRefs(value: string, here: RepoRef): MdNode[] | null {
  REF.lastIndex = 0;
  let out: MdNode[] | null = null;
  let cut = 0;
  let m: RegExpExecArray | null;

  while ((m = REF.exec(value)) !== null) {
    const [whole, slugOwner, slugRepo, slugNumber, number, ghNumber, login] = m;
    const before = m.index === 0 ? '' : value[m.index - 1];
    const after = value[m.index + whole.length] ?? '';

    let node: MdNode | null = null;
    if (slugNumber !== undefined) {
      if (!NOT_BEFORE_SLUG.test(before) && !NOT_AFTER.test(after)) {
        node = link(issueUrl(slugOwner, slugRepo, slugNumber), whole);
      }
    } else if (number !== undefined) {
      if (!NOT_BEFORE_NUMBER.test(before) && !NOT_AFTER.test(after)) {
        node = link(issueUrl(here.owner, here.repo, number), whole);
      }
    } else if (ghNumber !== undefined) {
      if (!NOT_BEFORE_NUMBER.test(before) && !NOT_AFTER.test(after)) {
        node = link(issueUrl(here.owner, here.repo, ghNumber), whole);
      }
    } else if (login !== undefined) {
      // A login never ends in a hyphen, so `@baz-` mentions baz.
      const trimmed = login.replace(/-+$/, '');
      const tail = value[m.index + 1 + trimmed.length] ?? '';
      if (!NOT_BEFORE_LOGIN.test(before) && trimmed && !/\w/.test(tail)) {
        node = link(`https://github.com/${trimmed}`, `@${trimmed}`);
        // Re-scan from the end of the login we actually took, not the match.
        REF.lastIndex = m.index + 1 + trimmed.length;
      }
    }

    if (!node) continue;
    out ??= [];
    const end = REF.lastIndex;
    if (m.index > cut) out.push(text(value.slice(cut, m.index)));
    out.push(node);
    cut = end;
  }

  if (!out) return null;
  if (cut < value.length) out.push(text(value.slice(cut)));
  return out;
}

/** Replace references in every prose text node under `node`, in place. */
function linkify(node: MdNode, here: RepoRef): void {
  const kids = node.children;
  if (!kids) return;
  let out: MdNode[] | null = null;

  for (let i = 0; i < kids.length; i += 1) {
    const child = kids[i];
    if (child.type === 'text' && typeof child.value === 'string') {
      const parts = splitRefs(child.value, here);
      if (parts) {
        out ??= kids.slice(0, i);
        out.push(...parts);
        continue;
      }
    } else if (!OPAQUE.has(child.type)) {
      linkify(child, here);
    }
    out?.push(child);
  }

  if (out) node.children = out;
}

/**
 * The remark plugin. Used as `[githubRefs, { owner, repo }]` in `remarkPlugins`,
 * where owner/repo are the rendered issue's own — never a hardcoded repository.
 */
export function githubRefs(here: RepoRef) {
  return (tree: MdNode): void => linkify(tree, here);
}

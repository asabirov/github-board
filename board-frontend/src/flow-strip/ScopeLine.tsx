/**
 * The one line under the flow strip saying which scope each tile counted (#666).
 *
 * THE RELEASES SENTENCE CAME OFF WITH THE RELEASES TILE (#816). "Releases are
 * the whole of acme." was the original reason this line exists: three
 * captions stated three facts and only that one was the odd tile, so the scope
 * was named once here rather than on it. The third tile is the oldest open issue
 * now, which names its own repo on itself, so the sentence explained a tile
 * nobody could see and the `releaseScope` prop was a value two pages carried
 * here for nothing.
 *
 * `OrgScopeNotice`'s idiom: 12.5px tertiary, no box, no border, and no margin of
 * its own — the call site owns the gap to the numbers above.
 *
 * #714 adds the third and fourth sentences, and this was the right place for
 * both rather than a new element: once an address can narrow the shell to one
 * org, Issues and Throughput go on counting every org — `/api/issues/*` takes
 * no `org`, checked against the controllers — and this line already exists to
 * say which scope a tile counted. The fourth is what the board says about the
 * selected org itself, and it comes from `scope-copy.ts` so that every narrowed
 * surface says it in one voice. A banner at the top of the page was rejected for
 * `OrgScopeNotice`'s reason and the reason holds here: the reader is looking at
 * a count.
 */
import { unnarrowedSentence } from '../org-scope/scope-copy';
import { ScopeNote } from '../org-scope/ScopeNote';
import type { ScopeState } from '../org-scope/use-scope-state';

/**
 * `scope` is the page's, already read by its owner — this line never reaches
 * for it.
 *
 * Renders nothing when there is nothing to say, which is the ordinary case on
 * both pages: the address narrows nothing and nothing has narrowed under the
 * tiles. A selected person is not said here (#1450): the page header already
 * names them, so the sentence said it twice, behind an icon nobody could read.
 */
export function ScopeLine({ scope = null, className = '', narrowed = false }: {
  narrowed?: boolean;
  /** #714: the org the address narrowed to and what the board has to say about
   *  it, or null for the union — where every sentence below is dropped and this
   *  line is exactly what it was. */
  scope?: ScopeState | null;
  className?: string;
}) {
  const org = scope?.org ?? null;
  // What the board says about the selected org itself — that it could not read
  // it, or that it does not cover it at all. One sentence, `scope-copy.ts`'s,
  // whichever it is.
  const notice = scope?.notice ?? null;
  // NOT SAID AT ALL beside a notice (#714 review). "Issues and Throughput
  // count every org, not just gtm." says gtm is one of the orgs counted; "This
  // board does not cover gtm." says it has never heard of it. `/gtm` drew both,
  // one after the other, in one line.
  const unnarrowed = notice !== null || narrowed
    ? null
    : unnarrowedSentence(org, 'Issues and Throughput');
  // `ScopeNote` draws it — the same element the Overview tiles' own line is
  // drawn in, so the two are one idiom rather than two copies of a class string.
  // It renders nothing when nothing is left.
  return (
    <ScopeNote
      tooltip={notice === null}
      said={[unnarrowed, notice?.notice ?? null]}
      reason={notice?.reason ?? null}
      className={className}
    />
  );
}

/**
 * The board-mode dispatch power (#394), ported verbatim from the retired
 * `IssueQueue` and kept PURE so the two behaviours that used to hide in a
 * component — the per-column Copy-for-agent markdown and the per-card
 * context-menu guard — are unit-tested exactly as they render.
 *
 * `stackMarkdown` reproduces IssueQueue's format byte-for-byte (an em dash before
 * the ref, a space before `#`, a `(blocked)` marker, the URL on its own indented
 * line). `issueReference` / `canCloseIssue` / `closeTargetOf` carry the card
 * menu's copy-reference string and its close-issue guard (only a real Github
 * issue URL, and only while still open).
 */
import { issueRefFromUrl } from '../route';
import type { CloseTarget } from '../ui/CloseIssueAlert';
import type { ActionableIssue } from '../ui/issue-actions';
import type { ViewerIssue } from './viewer-issue';

/** One stack's issues as markdown a coding agent can act on directly — the exact
 *  shape the retired IssueQueue's Copy-for-agent produced. */
export function stackMarkdown(label: string, items: ViewerIssue[]): string {
  const lines = [`## Open issues — ${label}`, ''];
  for (const it of items) {
    lines.push(`- ${it.title} — ${it.repo} #${it.number}${it.blocked ? ' (blocked)' : ''}`);
    lines.push(`  ${it.htmlUrl}`);
  }
  return lines.join('\n');
}

/** The row's copyable `repo#number` reference (Copy reference). */
export function issueReference(i: ActionableIssue): string {
  return `${i.repo}#${i.number}`;
}

/**
 * The same reference, split where a narrow card has to break it (#662/#674). The
 * board card names its repo in 210px-wide columns, where the longest repo in the
 * org doesn't fit; the repo half truncates and the `#number` half never does, so
 * the identifier stays usable at any width.
 *
 * It splits `issueReference`'s output rather than re-reading `repo` and `number`,
 * so the card's meta and the menu's Copy reference are the same string by
 * construction and cannot drift.
 */
export function issueReferenceParts(i: ActionableIssue): { repo: string; number: string } {
  const ref = issueReference(i);
  const hash = ref.lastIndexOf('#');
  return { repo: ref.slice(0, hash), number: ref.slice(hash) };
}

/** Close-issue is offered only for a real Github issue URL and only while the row
 *  is still open — the same guard the queue card used before the close write. */
export function canCloseIssue(i: ActionableIssue, closed: boolean): boolean {
  return !closed && issueRefFromUrl(i.htmlUrl) != null;
}

/** The owner/repo/number/title the close write needs, resolved from the issue's
 *  html URL (the row carries only a short repo key). Null when the URL isn't a
 *  Github issue URL. */
export function closeTargetOf(i: ActionableIssue): CloseTarget | null {
  const ref = issueRefFromUrl(i.htmlUrl);
  return ref ? { owner: ref.owner, repo: ref.repo, number: i.number, title: i.title } : null;
}

/** What a shortened name is cut with — one character, so the budget arithmetic
 *  in `middleElide` stays in characters the caller can count. */
export const ELLIPSIS = '…';

/**
 * Shorten `text` to fit, cutting from the MIDDLE (#662 review).
 *
 * Every repository in this org is named `acme-…`, so a tail truncation throws
 * away the half that discriminates: `acme-deployment-extension-v2` and
 * `acme-deployment-api` both read `acme-deploym…`. Keeping both ends keeps
 * the name identifying at every column width.
 *
 * The caller injects `fits`, so the algorithm is pure and the measurement is
 * somebody else's problem — the card measures glyphs with a canvas, the spec
 * counts characters, and both drive this same code. `fits` is assumed monotone
 * (a longer candidate is never narrower), which is what lets this binary-search
 * the answer in ~5 measurements instead of one per character.
 *
 * Snapping the cuts to a `-` boundary was considered and rejected on a rendering,
 * not on taste: at the 210px floor the budget only stretches to one segment either
 * side, so `acme-deployment-extension-v2` comes out `acme-…-v2` — every repo in
 * the org would render the same string, which is the failure this function exists to
 * prevent. A mid-word tail is the price of a tail that still identifies.
 *
 * The odd character goes to the TAIL for the same reason the cut is in the
 * middle: the tail is where these names differ.
 */
export function middleElide(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  const chars = Array.from(text);
  const cutTo = (keep: number) => {
    const tail = Math.ceil(keep / 2);
    const head = keep - tail;
    return chars.slice(0, head).join('') + ELLIPSIS + chars.slice(chars.length - tail).join('');
  };
  // `keep` tops out two characters short of the whole, so the result is always
  // strictly shorter than the input it replaced.
  let lo = 0;
  let hi = chars.length - 2;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(cutTo(mid))) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Nothing fits, not even the cut mark: show the cut mark anyway. A card that
  // says nothing is worse than a card that says "there is a name here".
  return best < 0 ? ELLIPSIS : cutTo(best);
}

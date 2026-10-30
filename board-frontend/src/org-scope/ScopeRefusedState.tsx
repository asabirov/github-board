/**
 * What a page draws instead of its content when the address named an org this
 * board refused (#714 review).
 *
 * Two things it fixes, and the second is the one that mattered. A refused Repos
 * page returned a bare `<div className="state">` holding one grey line, which
 * replaced the whole page body — no heading, no search, no filters — and read as
 * a render that had failed. And a refused Your work drew a COMPLETE board:
 * Issues 10, Throughput 1, the day grid, and a Projects rail reporting real
 * boards at 40% and 45% as "0% — nothing opened or closed this week", because the projects read
 * degraded to `[]` on the 404 while the contributions still carried their names.
 * A grey line under that is not enough, because the board itself is the lie.
 *
 * So: the page keeps its heading, and everything that draws a number comes off
 * and this goes where the content was. `EmptyState` is the board's one empty
 * state (#452) and it is the right shape here — a title, the sentence, and the
 * action that fills the gap.
 *
 * The action is the whole reason this is a panel rather than a line. `App`'s
 * `tabRoute` carries the org onto every sidebar link, so from `/gtm` all four
 * tabs stay inside gtm and the only way out was retyping the address. This is
 * the way back, to the same tab on the union.
 *
 * It writes no sentence of its own: the notice comes from `scope-copy.ts`, the
 * one voice every narrowed surface speaks in.
 */
import { Button } from '../ui/kit';
import { EmptyState } from '../ui/EmptyState';
import { useRoute } from '../route-ctx';
import { gotoPath, routePath } from '../route';
import { UNION_LABEL } from './org-scope';
import type { ScopeNotice } from './scope-copy';

export function ScopeRefusedState({ org, notice, className = 'mt-[18px]' }: {
  /** The org the address named — the panel's subject, and the bare name rather
   *  than a sentence about it: the sentence is `notice`, and a second one here
   *  would be this file writing copy `scope-copy.ts` owns. */
  org: string;
  /** What the board has to say about that org, from `scope-copy.ts`. */
  notice: ScopeNotice;
  className?: string;
}) {
  const route = useRoute();
  // The SAME tab, on the union: somebody who asked for gtm's Repos wants Repos.
  const union = routePath({ tab: route.tab });
  return (
    <EmptyState
      className={className}
      title={org}
      description={
        <>
          {notice.notice}
          {notice.reason !== null && <span className="mt-1 block">{notice.reason}</span>}
        </>
      }
      action={
        <Button variant="outline" size="sm" onClick={() => gotoPath(union)}>
          {UNION_LABEL}
        </Button>
      }
    />
  );
}

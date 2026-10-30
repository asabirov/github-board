import { ROLLUP_ITEM_NODES } from './github-projects.source';

type GraphqlAnswer = (query: string, vars: Record<string, unknown>) => unknown;

/**
 * Github as the Projects rollup meets it since #1007, for a spec whose fake was
 * written for the read before it.
 *
 * The rollup used to be one document: the board list, each board carrying its
 * first hundred items. Now it is the board list, then each surfaced board's
 * first page asked for by number. `answer` goes on answering the list the old
 * way, boards and items together, and this serves each board's first page back
 * out of the last list answer that named it, keyed on org and number so two
 * orgs' board 7 stay apart. A board no list named gets the `projectV2: null`
 * Github answers for a board that is not there.
 *
 * Those first pages never reach `answer`, so a spec counting `answer`'s calls
 * counts what it always did: board-list documents and later pages. The #1007
 * cases in `github-projects.source.spec.ts` count every document.
 */
export function asRollupGithub(answer: GraphqlAnswer): (query: string, vars: Record<string, unknown>) => Promise<unknown> {
  const firstPages = new Map<string, unknown>();
  const slot = (owner: unknown, number: unknown) => `${String(owner)}#${String(number)}`;
  return async (query, vars) => {
    if (query.includes(ROLLUP_ITEM_NODES) && /projectV2\(number/.test(query) && vars.after == null) {
      const key = slot(vars.owner, vars.number);
      return { organization: { projectV2: firstPages.has(key) ? { items: firstPages.get(key) } : null } };
    }
    const out = await answer(query, vars);
    const nodes = (out as { organization?: { projectsV2?: { nodes?: ({ number?: unknown; items?: unknown } | null)[] } } } | null)
      ?.organization?.projectsV2?.nodes ?? [];
    for (const node of nodes) if (node) firstPages.set(slot(vars.owner, node.number), node.items);
    return out;
  };
}

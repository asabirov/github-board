/**
 * The org the shell is narrowed to, for the whole tree (#714).
 *
 * It holds nothing. The scope lives in the address — `/acme/repos` is that
 * org's Repos and `/repos` is every org's — so this reads the active `Route` and
 * derives the two facts a page wants from it. Selecting an org is therefore
 * navigating, and there is no state here to fall out of step with the URL: the
 * prototype's module variable, its `select` and its refresh-nonce bump are all
 * gone with it.
 *
 * It is still a provider rather than a hook per page so the derivation happens
 * once for the tree, and so `useOrgScope` keeps the shape `use-scope-state.ts`
 * already reads. It must sit INSIDE `RouteProvider`.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useRoute } from '../route-ctx';
import { UNION, scopeOfRoute, scopedOrg, type OrgScope } from './org-scope';

interface OrgScopeCtx {
  scope: OrgScope;
  /** The org a request carries, or null for the union. The one thing most
   *  readers want, so they do not each re-narrow the union case. */
  org: string | null;
}

const Ctx = createContext<OrgScopeCtx>({ scope: UNION, org: null });

export function OrgScopeProvider({ children }: { children: ReactNode }) {
  const route = useRoute();
  const value = useMemo(() => {
    const scope = scopeOfRoute(route);
    return { scope, org: scopedOrg(scope) };
  }, [route]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOrgScope(): OrgScopeCtx {
  return useContext(Ctx);
}

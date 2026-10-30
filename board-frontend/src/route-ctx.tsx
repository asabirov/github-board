/**
 * The active Route, shared so any page can render its own breadcrumb without
 * threading `route` through props. App owns the state and provides it here.
 */
import { createContext, useContext, ReactNode } from 'react';
import { Route } from './route';

const RouteContext = createContext<Route>({ tab: 'dashboard' });

export function RouteProvider({ route, children }: { route: Route; children: ReactNode }) {
  return <RouteContext.Provider value={route}>{children}</RouteContext.Provider>;
}

export function useRoute(): Route {
  return useContext(RouteContext);
}

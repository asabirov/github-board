/**
 * How anything inside or beside the panel reaches App's panel state (#712).
 *
 * `open` has two callers that hold no state of their own: the account menu at
 * the foot of the sidebar, and the API-reference link inside Access & agents —
 * which is INSIDE an open panel and must replace it rather than stack a second
 * one on it. One opener for both is what keeps "exactly one panel, one X" true.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { Panel } from './panel';

interface PanelActions {
  open: (panel: Panel) => void;
}

const Ctx = createContext<PanelActions>({ open: () => {} });

export function PanelActionsProvider({ value, children }: { value: PanelActions; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOpenPanel(): (panel: Panel) => void {
  return useContext(Ctx).open;
}

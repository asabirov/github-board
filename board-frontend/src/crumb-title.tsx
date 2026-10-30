/**
 * The current page's async detail label, surfaced to the breadcrumb (#288, #382).
 * PageCrumb knows the route synchronously, but a page's human name — an issue's
 * title, a project board's name — arrives async after a fetch. The page reports
 * it here via `useReportCrumbTitle`; PageCrumb reads it via `useCrumbTitle` and
 * uses it for the current-page segment, falling back to a route-derived label
 * until it lands. Cleared on navigate-away so one page's label never lingers on
 * the next. (Generalized from the issue-only title reporting of #288.)
 */
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

const CrumbTitleCtx = createContext<{
  title: string | null;
  report: (t: string | null) => void;
}>({ title: null, report: () => {} });

export function CrumbTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  return (
    <CrumbTitleCtx.Provider value={{ title, report: setTitle }}>
      {children}
    </CrumbTitleCtx.Provider>
  );
}

/** The current page's async detail label for the breadcrumb, or null before it loads. */
export function useCrumbTitle(): string | null {
  return useContext(CrumbTitleCtx).title;
}

/** Report the current page's loaded detail label (null while loading, and on
 *  unmount so it doesn't linger on the next route). Safe to call every render. */
export function useReportCrumbTitle(title: string | null): void {
  const { report } = useContext(CrumbTitleCtx);
  useEffect(() => {
    report(title);
    return () => report(null);
  }, [title, report]);
}

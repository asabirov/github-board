import { Component, type ReactNode } from 'react';

/**
 * What a PAGE shows when its render threw (#824 follow-up).
 *
 * The boundary defaults to `null`, which is right for the chrome it was written
 * for — a top bar that failed is a top bar that is not there — and wrong for a
 * page, where it is a shell with a nav and an empty body and no way to tell a
 * broken render from a board with nothing on it. The route that made that
 * reachable without anybody doing anything wrong was a stored payload of the
 * wrong shape, which `payload-cache.ts` now refuses and deletes; this is the
 * other half, for every render throw that is not a cache read.
 *
 * A sentence and not a retry button: nothing here can re-run a render that
 * threw, and a control that does nothing is worse than the sentence that says
 * what to do.
 */
export const PAGE_FALLBACK: ReactNode = (
  <div className="state">This page couldn’t be displayed. Reload to try again.</div>
);

/**
 * Minimal render-error boundary. Used to isolate always-mounted chrome (the
 * #108 top bar) so a throw in it degrades to its fallback instead of white-
 * screening the whole authed app. Fetch failures are handled inline by the
 * children; this only catches render throws (e.g. a malformed record).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('ErrorBoundary caught a render error:', error);
  }

  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

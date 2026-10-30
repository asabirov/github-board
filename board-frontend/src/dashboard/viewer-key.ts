/**
 * The storage key Your work hands the IssuesViewer so its queue reopens the way
 * you left it (#463). The `projects/viewer-key.ts` of this page — the Project
 * page's key is per board and derived, and this one is a constant, but both are
 * a host's key held next to the host rather than in `issues-viewer`, which owns
 * the mechanism and not any page's vocabulary.
 *
 * FLAT, with no org in it. `/api/issues/mine` takes no org, so this queue is the
 * same issues whatever `?org=` the address carries — an org in the key would
 * split one arrangement into several the reader cannot tell apart. That is the
 * exact opposite of the Project page's case, and it is why the two keys are
 * shaped differently on purpose.
 *
 * Named rather than typed twice, because since #750's review TWO things read it:
 * the queue, which stores and restores under it, and a Contributions ring press,
 * which has to carry what it holds into the URL it writes (`withArrangement` in
 * `project-filter.ts`). A second spelling is how the ring would come to read a
 * memory the queue never wrote.
 */
export const DASHBOARD_VIEWER_KEY = 'dashboard';

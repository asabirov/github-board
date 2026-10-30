/**
 * What the area panel is open on (#712).
 *
 * Admin Hub, the Account pages and the API reference were tabs of `route.ts`
 * until #712, so entering one replaced the sidebar's whole primary nav and the
 * only way back was the `board.` wordmark — which reads as a wordmark. They are
 * areas of ONE panel over the board now: the board keeps its nav, the panel
 * carries the area's own rail, and an X closes it.
 *
 * State rather than address, deliberately (Artur's call, #712): the URL never
 * says a panel is open, so an old `/admin` bookmark lands on Your work —
 * `route.ts`'s RETIRED_PATHS is the other half of that.
 *
 * The two section unions live here, above both the rails and the views, so a
 * section list and the panel cannot disagree about what a section is.
 */

/** Admin Hub sub-sections (#322-follow-up). `access` is the one it opens on. */
export type AdminSection = 'access' | 'audit';

/** Account sections (#345) — three separate tabs until #712. */
export type AccountSection = 'account' | 'github' | 'preferences';

export type Panel =
  | { area: 'admin'; section: AdminSection }
  | { area: 'account'; section: AccountSection }
  // The reference is one page; its rail scrolls within it rather than switching.
  | { area: 'docs' }
  | { area: 'organisation'; section: 'goals' };

export type Area = Panel['area'];

/** What the panel's rail and its close control call the area. Sentence case, the
 *  way "API reference" beside it has always been: "Admin Hub" was the one
 *  title-cased name the shell drew, and #979 brought it into line. */
export const AREA_LABEL: Record<Area, string> = {
  admin: 'Admin hub',
  account: 'Account',
  docs: 'API reference',
  organisation: 'Organisation settings',
};

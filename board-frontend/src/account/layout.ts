/**
 * The Account section's outer column (#450). Access & agents, Feedback and
 * Preferences each used to centre their own width at their own inset — 840px,
 * 560px, 840px, at 30px and 24px — so the breadcrumb and H1 moved every time you
 * pressed a different Account item in the sidebar. Feedback went with #1450.
 *
 * The remaining pages hang off the one app rail (PAGE_RAIL) with the same vertical
 * rhythm, and narrow their own content inside it — settings rows and the token
 * list at PAGE_READING, so a
 * page has one right edge and the section has one width. Those inner columns are
 * left-aligned, so the page identity keeps the rail's left edge.
 */
import { PAGE_RAIL } from '../ui/PageHeading';

export const ACCOUNT_RAIL = `${PAGE_RAIL} pb-20 pt-[26px] max-[900px]:pt-4 max-[900px]:pb-12`;

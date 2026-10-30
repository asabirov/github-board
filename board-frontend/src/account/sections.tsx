/**
 * Account area sections, shared by the area panel's rail and the views (#345).
 * Mirrors admin/sections.tsx: opening an Account section draws this list as the
 * panel's left rail, and the X closes the panel.
 *
 * Each was a top-level tab (/account, /preferences) until #712 took those
 * addresses away, which is why the key is `id` and no longer `tab`.
 */
import { KeyRoundIcon, ShieldIcon, SlidersIcon } from '../icons';
import type { AccountSection } from '../area-panel/panel';

/** The section's own name — its rail row AND its H1, so the two cannot drift. */
export const ACCOUNT_LABEL: Record<AccountSection, string> = {
  account: 'Access & agents',
  github: 'GitHub',
  preferences: 'Preferences',
};

export const ACCOUNT_SECTIONS: { id: AccountSection; label: string; Icon: typeof ShieldIcon }[] = [
  { id: 'account', label: ACCOUNT_LABEL.account, Icon: ShieldIcon },
  { id: 'github', label: ACCOUNT_LABEL.github, Icon: KeyRoundIcon },
  { id: 'preferences', label: ACCOUNT_LABEL.preferences, Icon: SlidersIcon },
];

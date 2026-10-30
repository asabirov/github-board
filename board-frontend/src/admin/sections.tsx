/**
 * Admin Hub sections, shared by the area panel's rail and the content pane
 * (AdminHub). The rail lives inside the panel now (#712) rather than replacing
 * the board's primary nav — so both still need the same ordered list of section
 * id + label + icon.
 */
import { ShieldIcon, SlidersIcon } from '../icons';
import type { AdminSection } from '../area-panel/panel';

export const ADMIN_SECTIONS: { id: AdminSection; label: string; Icon: typeof ShieldIcon }[] = [
  { id: 'access', label: 'Access', Icon: ShieldIcon },
  { id: 'audit', label: 'Audit log', Icon: SlidersIcon },
];

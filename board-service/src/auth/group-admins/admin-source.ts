/**
 * A source of the board's admin emails (#143, #332). In db mode these are the
 * people with a board-assigned `admin` role (StoredRoleAdminSource); in dev/test
 * a fixture list (BOARD_FIXTURE_ADMINS). Decoupled from Google-group ownership —
 * the group is used only for membership.
 */
export interface IAdminSource {
  /** Lowercased emails granted admin by the board. Throws on a cold failure. */
  listAdminEmails(): Promise<string[]>;
}

export const ADMIN_SOURCE = Symbol('ADMIN_SOURCE');

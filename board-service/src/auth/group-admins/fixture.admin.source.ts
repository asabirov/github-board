import type { IAdminSource } from './admin-source';

/**
 * Dev/local admin source — an explicit BOARD_FIXTURE_ADMINS list of GitHub
 * logins standing in for the stored board roles (which need a database).
 */
export class FixtureAdminSource implements IAdminSource {
  private readonly emails: string[];

  constructor(adminEmails: string[]) {
    this.emails = adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  }

  async listAdminEmails(): Promise<string[]> {
    return this.emails;
  }
}

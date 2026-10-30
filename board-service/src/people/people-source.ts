/** A source of current-team member emails (the Google team group, or a fixture). */
export interface IPeopleSource {
  /** Lowercased member emails. Throws on a cold failure (caller may cache last-good). */
  listMemberEmails(): Promise<string[]>;
}

export const PEOPLE_SOURCE = Symbol('PEOPLE_SOURCE');

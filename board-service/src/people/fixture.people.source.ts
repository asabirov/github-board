import { Injectable } from '@nestjs/common';
import type { IPeopleSource } from './people-source';

/**
 * Dev/local people source — the plain-login portion of `BOARD_ALLOWED_GITHUB`.
 * The organisation entries cannot be enumerated without a GitHub call, so they
 * contribute nothing to the roster; the roster is the same list the sign-in
 * gate admits by name.
 */
@Injectable()
export class FixturePeopleSource implements IPeopleSource {
  private readonly logins: string[];

  constructor(logins: string[]) {
    this.logins = logins.map((e) => e.trim().toLowerCase()).filter(Boolean);
  }

  async listMemberEmails(): Promise<string[]> {
    return this.logins;
  }
}

import { Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';
import { PEOPLE_ALIASES } from '../people/people-aliases';
import { IdentityData, IdentityRecord, IdentityRepository } from './identity.repository';
import { isMemberRole } from './role';

const norm = (s: string) => s.trim().toLowerCase();
const normEmails = (emails: string[]) => [...new Set(emails.map(norm).filter(Boolean))];

/**
 * Postgres-backed identity store (Prisma). On the first read of a fresh DB it
 * seeds itself from PEOPLE_ALIASES — so the file stays the origin of the live
 * roster's identities, and a new environment comes up populated rather than
 * blank. The seed only runs when the table is empty, so admin edits are never
 * overwritten.
 */
export class PrismaIdentityRepository implements IdentityRepository {
  private readonly logger = new Logger(PrismaIdentityRepository.name);
  private seeded = false;
  // Single-flight guard: concurrent first-boot reads must share ONE seed, or
  // both pass the count===0 check and each createMany → duplicate rows. With
  // duplicates, findFirst (used by identityForEmail AND upsert) becomes
  // non-deterministic — an admin edit could update one row while every reader
  // sees the other. Memoizing the in-flight promise serializes them.
  private seeding: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<IdentityRecord[]> {
    await this.seedIfEmpty();
    const rows = await this.prisma.identity.findMany({ orderBy: { displayName: 'asc' } });
    return rows.map(toRecord);
  }

  async identityForEmail(email: string): Promise<IdentityRecord | null> {
    await this.seedIfEmpty();
    // Deterministic order: if two rows ever share an email (an admin fat-fingers
    // one person's address into another's `emails`), the lookup must resolve to
    // ONE row every time, not whatever Postgres yields first. Most recently
    // edited wins — that matches admin intent. Without this, an admin edit could
    // target one row while readers see the other (the emails column has no
    // DB-enforceable uniqueness).
    const row = await this.prisma.identity.findFirst({
      where: { emails: { has: norm(email) } },
      orderBy: { updatedAt: 'desc' },
    });
    return row ? toRecord(row) : null;
  }

  async upsert(keyEmail: string, data: IdentityData): Promise<IdentityRecord> {
    await this.seedIfEmpty();
    const key = norm(keyEmail);
    // Always keep the key email in the set so the identity stays matchable to
    // the roster even if the admin edits the other addresses.
    const emails = normEmails([key, ...data.emails]);
    const fields = {
      displayName: data.displayName.trim(),
      emails,
      githubLogin: data.githubLogin?.trim() || null,
      clickupUserId: data.clickupUserId?.trim() || null,
      clickupNames: (data.clickupNames ?? []).map((s) => s.trim()).filter(Boolean),
      // Board-assigned role (#332): null clears the override; undefined (role key
      // absent) is omitted so Prisma leaves the stored role unchanged on update.
      role: data.role,
    };
    // Same deterministic order as identityForEmail: an edit must target the same
    // row readers resolve, or an admin fix could update a shadow duplicate.
    const existing = await this.prisma.identity.findFirst({
      where: { emails: { has: key } },
      orderBy: { updatedAt: 'desc' },
    });
    const row = existing
      ? await this.prisma.identity.update({ where: { id: existing.id }, data: fields })
      : await this.prisma.identity.create({ data: fields });
    return toRecord(row);
  }

  private async seedIfEmpty(): Promise<void> {
    if (this.seeded) return;
    // Reuse the in-flight seed if one is already running (single-flight); only
    // the first caller kicks it off. On failure, clear the promise so a later
    // request can retry rather than being wedged on a rejected seed forever.
    if (!this.seeding) {
      this.seeding = this.runSeed().catch((err) => {
        this.seeding = null;
        throw err;
      });
    }
    await this.seeding;
  }

  private async runSeed(): Promise<void> {
    const count = await this.prisma.identity.count();
    if (count === 0) {
      await this.prisma.identity.createMany({
        data: PEOPLE_ALIASES.map((a) => ({
          displayName: a.displayName,
          emails: normEmails(a.emails),
          githubLogin: a.githubLogin,
          clickupUserId: a.clickupUserId ?? null,
          clickupNames: a.clickupNames,
        })),
      });
      this.logger.log(`seeded ${PEOPLE_ALIASES.length} identities from PEOPLE_ALIASES`);
    }
    this.seeded = true;
  }
}

function toRecord(row: {
  id: string;
  displayName: string;
  emails: string[];
  githubLogin: string | null;
  clickupUserId: string | null;
  clickupNames: string[];
  role: string | null;
}): IdentityRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    emails: row.emails,
    githubLogin: row.githubLogin,
    clickupUserId: row.clickupUserId,
    clickupNames: row.clickupNames,
    // Guard against a stray value that predates validation — unknown ⇒ no override.
    role: isMemberRole(row.role) ? row.role : null,
  };
}

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * Storage for user-minted personal access tokens (#210). Only the SHA-256 hash
 * of a secret is ever persisted; the secret is shown once at mint and discarded.
 * The `db` backend is Postgres via Prisma (the same table lives beside Identity);
 * the `disabled` backend stands in when no database is configured (fixture/dev),
 * so the service can report the feature unavailable instead of crashing at boot.
 */

export const PERSONAL_TOKEN_REPOSITORY = 'PERSONAL_TOKEN_REPOSITORY';

/** One stored token row (never leaves the server with `tokenHash`). */
export interface PersonalTokenRow {
  id: string;
  ownerEmail: string;
  /** Google `sub` of the minting session, or null on a row minted before #892.
   *  See the schema comment — this is the stable half of "who owns this token". */
  ownerSub: string | null;
  name: string;
  scopes: string[];
  tokenHash: string;
  prefix: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreateTokenInput {
  ownerEmail: string;
  ownerSub: string | null;
  name: string;
  scopes: string[];
  tokenHash: string;
  prefix: string;
  expiresAt: Date | null;
}

export interface PersonalTokenRepository {
  /** False when no DB is configured — the controller then answers 503. */
  readonly enabled: boolean;
  create(input: CreateTokenInput): Promise<PersonalTokenRow>;
  listByOwner(ownerEmail: string): Promise<PersonalTokenRow[]>;
  findByHash(tokenHash: string): Promise<PersonalTokenRow | null>;
  /** Revoke one of the owner's own tokens; true iff a live row was revoked. */
  revoke(id: string, ownerEmail: string): Promise<boolean>;
  /** All active (non-revoked, non-expired) tokens across every owner — the
   *  admin agent roster (#211). Disabled repo returns [] (viewing ≠ a mutation). */
  listAllActive(): Promise<PersonalTokenRow[]>;
  /** Admin revoke — any owner's token, no owner check (#211); true iff a live
   *  row was revoked (double-revoke / unknown id → false). */
  revokeAny(id: string): Promise<boolean>;
  touchLastUsed(id: string): Promise<void>;
}

/** Postgres-backed store (Prisma). */
export class PrismaPersonalTokenRepository implements PersonalTokenRepository {
  readonly enabled = true;
  private readonly logger = new Logger(PrismaPersonalTokenRepository.name);
  constructor(private readonly prisma: PrismaClient) {}

  create(input: CreateTokenInput): Promise<PersonalTokenRow> {
    return this.prisma.personalToken.create({ data: input });
  }

  listByOwner(ownerEmail: string): Promise<PersonalTokenRow[]> {
    return this.prisma.personalToken.findMany({
      where: { ownerEmail },
      orderBy: { createdAt: 'desc' },
    });
  }

  findByHash(tokenHash: string): Promise<PersonalTokenRow | null> {
    return this.prisma.personalToken.findUnique({ where: { tokenHash } });
  }

  async revoke(id: string, ownerEmail: string): Promise<boolean> {
    // Scoped to the owner + un-revoked, so a user can only revoke their own live
    // tokens and a double-revoke is a no-op (count 0), never a 500.
    const res = await this.prisma.personalToken.updateMany({
      where: { id, ownerEmail, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count > 0;
  }

  listAllActive(): Promise<PersonalTokenRow[]> {
    const now = new Date();
    return this.prisma.personalToken.findMany({
      where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      // Most-recently-active first; never-used tokens (null lastUsedAt) trail,
      // then newest-minted. Prisma sorts nulls last on desc.
      orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async revokeAny(id: string): Promise<boolean> {
    // Admin kill-switch: no ownerEmail scope. Un-revoked guard keeps a
    // double-revoke a no-op (count 0), never a 500.
    const res = await this.prisma.personalToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count > 0;
  }

  async touchLastUsed(id: string): Promise<void> {
    // Best-effort: a failed last-used bump must never fail the guarded request.
    await this.prisma.personalToken
      .update({ where: { id }, data: { lastUsedAt: new Date() } })
      .catch((err) => this.logger.warn(`lastUsed bump failed: ${(err as Error).message}`));
  }
}

/** No-DB stand-in: verification finds nothing; management calls report 503. */
export class DisabledPersonalTokenRepository implements PersonalTokenRepository {
  readonly enabled = false;
  private unavailable(): never {
    // NOT shown in the Tokens sheet, which is what #1056 assumed and the #1080
    // review disproved. This repository exists only where no database is
    // configured, and in that state `AccountController.list` answers
    // `{ enabled: false }` and the page replaces its whole body with a sentence
    // of its own — no New token button, so `create` is unreachable; `revoke`
    // swallows its error; `revokeAny` is the admin route, whose caller throws
    // its own text. So the only reader is a caller holding a personal token,
    // and for that reader the setting is the useful half: #1056 had taken it
    // out on the strength of a screen nobody was looking at. "right now" went
    // with it — this is fixed at boot and no waiting changes it.
    throw new ServiceUnavailableException(
      'Personal tokens need a database, and this board has none configured (IDENTITY_SOURCE=db).',
    );
  }
  create(): Promise<PersonalTokenRow> {
    return this.unavailable();
  }
  listByOwner(): Promise<PersonalTokenRow[]> {
    return this.unavailable();
  }
  async findByHash(): Promise<PersonalTokenRow | null> {
    return null; // a board_pat_ bearer simply doesn't resolve → 401
  }
  revoke(): Promise<boolean> {
    return this.unavailable();
  }
  async listAllActive(): Promise<PersonalTokenRow[]> {
    return []; // no DB → an empty roster, not a 503 (the admin page still renders)
  }
  revokeAny(): Promise<boolean> {
    return this.unavailable();
  }
  async touchLastUsed(): Promise<void> {
    /* no-op */
  }
}

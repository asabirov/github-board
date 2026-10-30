import { Logger } from '@nestjs/common';
import type { PrismaClient } from '../../generated/prisma/client';
import type { IAdminSource } from './admin-source';

/**
 * The board's admins from board-assigned roles (#332): every identity whose
 * stored `role` is `admin`. This is the durable admin path — an admin assigns
 * the Admin role in the person editor and it grants real access, decoupled from
 * Google-group ownership. Reads Prisma directly (its own client, mirroring the
 * identity/audit/account modules) rather than the IdentityRepository, so the
 * @Global AdminAuthorityModule needs no dependency on IdentityModule — which
 * would be circular, since IdentityController is admin-guarded.
 *
 * Throws on a DB error so the AdminEmailCache keeps its last-good snapshot; the
 * BOARD_ADMIN_EMAILS break-glass in AdminAuthority still covers admin resolution.
 */
export class StoredRoleAdminSource implements IAdminSource {
  private readonly logger = new Logger(StoredRoleAdminSource.name);

  constructor(private readonly prisma: PrismaClient) {}

  async listAdminEmails(): Promise<string[]> {
    const rows = await this.prisma.identity.findMany({
      where: { role: 'admin' },
      select: { emails: true },
    });
    const emails = rows.flatMap((r) => r.emails).map((e) => e.trim().toLowerCase()).filter(Boolean);
    return [...new Set(emails)];
  }
}

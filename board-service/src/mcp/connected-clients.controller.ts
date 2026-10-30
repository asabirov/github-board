import {
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { Writes } from '../capability/writes.decorator';
import {
  MCP_GRANT_REPOSITORY,
  type GrantRow,
  type McpGrantRepository,
} from './mcp-grant.repository';
import { MCP_CLIENTS_STORE, type McpClientsStore } from './oauth-store';

/**
 * Account › the clients holding an OAuth grant on your account (#456), and the
 * one place a person cuts one off. Global prefix 'api' → /api/account/clients.
 *
 * `HumanOnlyGuard` beside the global chain, exactly as `account.controller.ts`
 * does for personal tokens: a credential must never enumerate or revoke its
 * owner's other credentials. Everything is keyed to the caller's own `sub`, so
 * an admin cannot reach a colleague's grants from here either — cutting off a
 * client is the account holder's own act, and only theirs.
 */

interface AuthedRequest {
  user: { sub: string; email: string };
}

/** One grant, as the account page reads it. No token value, and no hash of one. */
export interface ConnectedClientView {
  /** The grant's id — what DELETE takes. */
  id: string;
  clientId: string;
  /** The client's self-chosen name, or null when it registered without one. */
  clientName: string | null;
  scopes: string[];
  createdAt: string;
  /**
   * When this grant last exchanged a refresh token, or null if it never has.
   *
   * Last *refreshed*, never "last used": only the refresh path writes it. The
   * guard's read of an access-token row is the hot path on every `/mcp` call,
   * and putting a write there to earn the wider word would cost more than the
   * word is worth.
   */
  lastRefreshedAt: string | null;
}

export interface ConnectedClientsResponse {
  /** False when no database is configured — the UI shows an unavailable note. */
  enabled: boolean;
  clients: ConnectedClientView[];
}

@Controller('account/clients')
@UseGuards(HumanOnlyGuard)
export class ConnectedClientsController {
  constructor(
    @Inject(MCP_GRANT_REPOSITORY) private readonly grants: McpGrantRepository,
    @Inject(MCP_CLIENTS_STORE) private readonly clients: McpClientsStore,
    @Inject(SessionRevocationService) private readonly revocation: SessionRevocationService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /**
   * The repository carries no `enabled` flag by design — the only correct answer
   * to a missing row there is to reject, and a boolean inviting `if
   * (!repo.enabled) return true` is the vacuous guard this repository has
   * shipped before. So the flag is answered here, from the same config the
   * module reads when it picks an implementation.
   */
  private get enabled(): boolean {
    return this.config.get<string>('IDENTITY_SOURCE') === 'db';
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest): Promise<ConnectedClientsResponse> {
    if (!this.enabled) return { enabled: false, clients: [] };
    const rows = await this.grants.listGrantsForSubject(req.user.sub);
    const clients = await Promise.all(rows.map((row) => this.viewOf(row)));
    return { enabled: true, clients };
  }

  // Revokes a board grant — no Github write.
  @Writes()
  @Delete(':id')
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ revoked: true }> {
    // `null` and `[]` are two different answers and the difference is the whole
    // point of this call. `null` is "no live grant with that id belongs to you";
    // `[]` is "it does, it is revoked now, and it had no live access token left".
    // Reading every empty result as 404 would tell a person their revoke failed
    // at the exact moment it worked.
    const live = await this.grants.revokeGrantForOwner(id, req.user.sub, new Date());
    if (live === null) throw new NotFoundException('No such connected client.');

    for (const token of live) this.revocation.revoke(token.jti, token.expiresAtMs);

    // The receipt is `McpGrant.revokedAt`, already written above by a call whose
    // failure fails this request. The audit entry is best-effort on top of it.
    await this.audit.record({
      actorEmail: req.user.email,
      action: 'oauth.revoke',
      summary: `Revoked own OAuth grant ${id}`,
      targetType: 'mcp-grant',
      targetId: id,
    });
    return { revoked: true };
  }

  /**
   * The client's registered name, or null. A registration that has been swept
   * (or a store that cannot answer) leaves the row naming its `clientId` alone
   * rather than dropping the row — a grant board cannot label is still a grant
   * the person has to be able to see and cut off.
   */
  private async nameOf(clientId: string): Promise<string | null> {
    try {
      const registration = await this.clients.getClient(clientId);
      return registration?.client_name ?? null;
    } catch {
      return null;
    }
  }

  private async viewOf(row: GrantRow): Promise<ConnectedClientView> {
    return {
      id: row.id,
      clientId: row.clientId,
      clientName: await this.nameOf(row.clientId),
      scopes: row.scopes,
      createdAt: row.createdAt.toISOString(),
      lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
    };
  }
}

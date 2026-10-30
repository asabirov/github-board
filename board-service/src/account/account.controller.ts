import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthority } from '../auth/admin-authority';
import { AuditService } from '../audit/audit.service';
import { HumanOnlyGuard } from './human-only.guard';
import { Writes } from '../capability/writes.decorator';
import {
  MintRequest,
  PersonalTokenService,
  PersonalTokenView,
} from './personal-token.service';

/**
 * A user's own access & agents surface (#210): mint / list / revoke personal
 * access tokens for their local agents. Global prefix 'api' → /api/account/*.
 * Runs under the global chain (JwtAuthGuard → TeamAccessGuard → RequiredScopes)
 * plus HumanOnlyGuard, so only a signed-in human — never a token — manages
 * tokens. Everything is keyed to the caller's own email; there is no cross-user
 * access here (org-wide governance lives in the admin hub).
 */
interface AuthedRequest {
  /** `sub` is the minting session's stable Google subject, recorded on the token
   *  so a later lookup can tell one person from the next holder of one address
   *  (#892). Optional only because the eight controllers each declare their own
   *  shape; `JwtAuthGuard` sets it in every branch. */
  user: { email: string; boardSub?: string };
}

export interface AccountTokensResponse {
  /** False when no database is configured — the UI shows an unavailable state. */
  enabled: boolean;
  /** Scopes this caller may grant, capped by their own authority. */
  grantableScopes: string[];
  tokens: PersonalTokenView[];
}

@Controller('account/tokens')
@UseGuards(HumanOnlyGuard)
export class AccountController {
  constructor(
    @Inject(PersonalTokenService) private readonly tokens: PersonalTokenService,
    @Inject(AdminAuthority) private readonly admin: AdminAuthority,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest): Promise<AccountTokensResponse> {
    const email = req.user.email;
    if (!this.tokens.enabled) {
      return { enabled: false, grantableScopes: [], tokens: [] };
    }
    return {
      enabled: true,
      grantableScopes: this.tokens.grantableScopes(this.admin.isAdmin(email)),
      tokens: await this.tokens.list(email),
    };
  }

  // Mints a board token — no Github write.
  @Writes()
  @Post()
  @Header('Cache-Control', 'no-store')
  async mint(
    @Req() req: AuthedRequest,
    @Body() body: MintRequest,
  ): Promise<{ token: string; record: PersonalTokenView }> {
    const email = req.user.email;
    // `boardSub`, the one field that means "stable Board identity" everywhere
    // (#892). `sub` carries the address on the PAT branch of `JwtAuthGuard`, so
    // reading it here would record an address as a subject. `HumanOnlyGuard` on
    // this controller admits browser sessions only, where the two are equal —
    // this is the field that stays right if that ever changes.
    const minted = await this.tokens.mint(email, req.user.boardSub ?? null, this.admin.isAdmin(email), body);
    await this.audit.record({
      actorEmail: email,
      action: 'token.mint',
      summary: `Minted token '${minted.record.name}' (${minted.record.scopes.join(', ')})`,
      targetType: 'token',
      targetId: minted.record.id,
    });
    return minted;
  }

  // Revokes a board token — no Github write.
  @Writes()
  @Delete(':id')
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ revoked: true }> {
    const ok = await this.tokens.revoke(id, req.user.email);
    if (!ok) throw new NotFoundException('Token not found.');
    await this.audit.record({
      actorEmail: req.user.email,
      action: 'token.revoke',
      summary: `Revoked own token ${id}`,
      targetType: 'token',
      targetId: id,
    });
    return { revoked: true };
  }
}

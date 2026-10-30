import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PERSONAL_TOKEN_REPOSITORY,
  PersonalTokenRepository,
} from '../account/personal-token.repository';
import { AgentsModel, buildAgentsModel, toOrgAgent } from './agents';

/**
 * Serves the admin hub's Agents model (#183, #211): the live org agent roster
 * (every active `board_pat_` token, aggregated across owners) plus the static
 * access reference (scopes, presets, tool→scope map, connect URL). The roster
 * comes from the same token store the personal Access page uses; when no DB is
 * configured it is simply empty (the page still renders the reference).
 */
@Injectable()
export class AgentsService {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(PERSONAL_TOKEN_REPOSITORY) private readonly tokens: PersonalTokenRepository,
  ) {}

  async getModel(): Promise<AgentsModel> {
    const reference = buildAgentsModel({
      baseUrl: this.config.get<string>('BOARD_BASE_URL', 'http://localhost:5173'),
      mcpEnabled: this.config.get<boolean>('BOARD_MCP_ENABLED', false),
    });
    const rows = await this.tokens.listAllActive();
    return { ...reference, agents: rows.map(toOrgAgent) };
  }

  /** Admin kill-switch: revoke any owner's token (#211). False = nothing live matched. */
  revokeAgent(id: string): Promise<boolean> {
    return this.tokens.revokeAny(id);
  }
}

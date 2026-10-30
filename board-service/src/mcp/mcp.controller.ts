import { All, Controller, Inject, NotFoundException, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildOverviewMcpServer } from './overview-tools';
import { RequiredScopes } from '../auth/required-scopes.decorator';
import { Writes } from '../capability/writes.decorator';
import { BOARD_READ } from '../auth/scopes';
import { isStaticAgent, type AuthenticatedActor } from '../auth/static-agent';
import { githubContext } from '../auth/github-principal';
import { GithubLoginResolver } from '../identity/github-login.resolver';

/**
 * Streamable HTTP MCP endpoint, stateless mode: a fresh server + transport per
 * request, tools closed over the authenticated actor. Path is excluded from
 * the `api` global prefix; the global guard chain (JWT → team → required-scopes)
 * runs before this handler. The @All handler is decorated
 * @RequiredScopes(board:read) so scoped MCP tokens reach it; per-tool write
 * gating lives in the MCP layer (overview-tools.ts).
 */
@Controller('mcp')
export class McpController {
  constructor(
    // Explicit tokens on both — tsx/esbuild emit no design:paramtypes metadata,
    // so an undecorated param boots in dev and crash-loops compiled.
    @Inject(ConfigService) private readonly config: ConfigService,
    // Typed structurally: another lane owns identity/, and this way a signature
    // change there surfaces here at one compile site instead of spreading.
    @Inject(GithubLoginResolver)
    private readonly githubLogins: Pick<GithubLoginResolver, 'forEmail' | 'typedLoginFor'>,
  ) {}

  // The @All() handler covers POST/DELETE too, which would otherwise fall
  // into RequiredScopesGuard's fail-closed write default (#56). Per-tool
  // gating happens inside the MCP layer itself; at the HTTP layer any scoped
  // actor holding board:read (every static agent token does) may reach /mcp.
  // The MCP surface registers no write tool, so this handler writes no Github.
  // `writes-declared.spec.ts` holds that claim against MCP_BACKED_WRITES.
  @Writes()
  @RequiredScopes(BOARD_READ)
  @All()
  async handle(
    @Req() req: Request & { user?: AuthenticatedActor & { sub?: string; scopes?: string[] } },
    @Res() res: Response,
  ) {
    if (!this.config.get<boolean>('BOARD_MCP_ENABLED')) throw new NotFoundException();
    const actor = {
      sub: req.user?.sub ?? '',
      email: req.user?.email ?? '',
      agent: req.user?.agent === true,
      // The one definition of the fact (#525) — never re-derived from the
      // shape of the address.
      staticAgent: isStaticAgent(req.user),
    };
    // The scope list is REPORTED by board_whoami, never used to decide what is
    // registered. `actor.agent` above is the only input to that.
    // Read once, here, while the request's context is unambiguous. `null` means
    // no person context exists at all (the AUTH_DISABLED fixture lane); an
    // unconnected person resolves to a principal whose `login` is null, which is
    // a different answer and the one `board_whoami` must report (#892).
    const principal = githubContext.getStore()?.principal ?? null;
    const server = buildOverviewMcpServer(actor, req.user?.scopes ?? [], {
      githubLogins: this.githubLogins,
      connectedGithub: () => (principal ? { login: principal.login } : null),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}

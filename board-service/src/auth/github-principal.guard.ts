import { resolveRequestTarget } from './github-target';
import { ConfigService } from '@nestjs/config';
import { CanActivate, ExecutionContext, Inject, Injectable, ForbiddenException } from '@nestjs/common';
import { githubContext } from './github-principal';
import { GithubUserService, MIN_READ_HEADROOM_MS } from './github-user.service';
import { isStaticAgent } from './static-agent';

/**
 * The connection-management routes, which must stay reachable while Github
 * discovery is unavailable — connecting is how you fix that. Anchored at the
 * start of the path and matched on a whole segment: the unanchored test this
 * replaced would have exempted any route that merely CONTAINED the words, and a
 * route is not exempt because of what is in the middle of its address.
 */
const AUTH_ROUTE = /^\/(?:api\/)?auth\/github(?:\/|$)/;

/**
 * The Github-backed surfaces, refused outright when nobody is connected.
 *
 * Not the enforcement: `tokenFor` throws the same refusal the moment any of
 * these builds a client, and no route can skip it. What the list adds is the
 * surfaces whose answer would otherwise be EMPTY rather than refused — an
 * unconnected person resolves to no owners, and `/api/repos` reads no owners as
 * a map with nothing on it, which draws a clean board over an absent
 * credential. Anchored on whole first segments.
 */
const GITHUB_SURFACE =
  /^\/(?:api\/)?(?:issues|projects|repos|delivery|sync)(?:\/|$)/;

@Injectable()
export class GithubPrincipalGuard implements CanActivate {
  constructor(
    @Inject(GithubUserService) private readonly github: GithubUserService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.get<boolean>('AUTH_DISABLED', false)) return true;
    const scope = githubContext.getStore();
    if (!scope) throw new Error('Missing Github request context');
    const req = context.switchToHttp().getRequest();
    const path: string = req.path ?? '';

    // Public OAuth routes read no person-backed data, and connection management
    // must work while discovery does not.
    if (!req.user || AUTH_ROUTE.test(path)) {
      scope.principal = {
        key: 'auth',
        email: req.user?.email ?? '',
        login: null,
        token: null,
        owners: [],
        repositories: [],
        cache: new WeakMap(),
      };
      return true;
    }

    scope.boardSub = req.user.boardSub;
    // A read of a Github-backed surface is admitted with headroom (#892 review,
    // C3). The cold ones here run tens of seconds against a sixty-second check,
    // and a permission-sensitive answer landing past that check is refused — so
    // a read is not STARTED against a check with almost nothing left. Asked of
    // the reads only: a write is one request and finishes in it. The session
    // probe also needs headroom so the browser can renew real responses before
    // their old deadlines; it cannot do that by re-reading a nearly spent check.
    const progressStart = req.method === 'POST' && /^\/(?:api\/)?sync\/operations\/?$/.test(path);
    const headroom = progressStart || (req.method === 'GET' && (GITHUB_SURFACE.test(path) || /^\/(?:api\/)?auth\/me$/.test(path))) ? MIN_READ_HEADROOM_MS : 0;
    scope.principal = await this.github.principal(
      req.user.email,
      // The stable Board identity, never the address (#892 review). A static
      // agent carries none and is refused a credential anyway; a personal token
      // minted before that field existed carries none either, and lands on the
      // same unconnected principal as somebody who has never connected.
      req.user.boardSub,
      isStaticAgent(req.user),
      headroom,
    );
    if (!scope.principal.token && GITHUB_SURFACE.test(path)) {
      // A scoped caller with no stable subject is a token minted before #892:
      // its owner may be connected, but nothing on the token says which person's
      // grant it would reach for. Say what to do about it rather than telling
      // somebody already connected to connect.
      throw new ForbiddenException(
        req.user.scopes && !req.user.boardSub
          ? 'This token predates per-person GitHub access. Create a new token in Account › Tokens to use GitHub surfaces.'
          : 'Sign in with GitHub to use this surface',
      );
    }
    resolveRequestTarget(req, scope.principal);
    return true;
  }
}

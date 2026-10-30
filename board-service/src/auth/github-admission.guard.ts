import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './jwt-auth.guard';
import { GithubAdmissionService } from './github-admission.service';
import { GithubUserService } from './github-user.service';
import { isStaticAgent } from './static-agent';

/**
 * Authorization gate: the GitHub sign-in allow list (#1450). Runs AFTER
 * JwtAuthGuard supplies the session claims. An empty `BOARD_ALLOWED_GITHUB`
 * admits every GitHub user; otherwise only the named numeric ids, the logins
 * that resolve to those ids and members of the named organisations pass. The
 * caller's stable GitHub user id is the identity compared, never the mutable
 * login. Fails closed when no rule admits the caller.
 *
 * Agent actors (authenticated via BOARD_AGENT_TOKENS) skip the check — their
 * authorization is the token itself, scoped by RequiredScopesGuard.
 */
@Injectable()
export class GithubAdmissionGuard implements CanActivate {
  private readonly logger = new Logger(GithubAdmissionGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(GithubAdmissionService) private readonly admission: GithubAdmissionService,
    @Inject(GithubUserService) private readonly github: GithubUserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    if (isStaticAgent(req.user)) return true;

    const githubUserId: string | undefined = req.user?.boardSub;
    if (!githubUserId) {
      throw new ForbiddenException('No GitHub identity on token; cannot verify access');
    }
    if (this.admission.empty()) return true;

    // Organisation membership is read through the person's own credential, keyed
    // on the stable GitHub user id. A caller with no credential — a token minted
    // before that identity existed — cannot prove membership and is refused.
    let token: string | undefined;
    let credentialVersion: string | undefined;
    if (this.admission.orgsConfigured()) {
      const credential = await this.github.credential(githubUserId);
      token = credential?.token;
      credentialVersion = credential?.row.version;
    }
    if (await this.admission.admits(githubUserId, req.user?.email, { token, credentialVersion })) {
      return true;
    }
    const login = req.user?.email ?? githubUserId;
    this.logger.warn(`Denied ${login}: not in the GitHub sign-in allow list`);
    throw new ForbiddenException('Your GitHub account is not allowed on this board.');
  }
}

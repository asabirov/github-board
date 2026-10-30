import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor, ServiceUnavailableException } from '@nestjs/common';
import { from, switchMap } from 'rxjs';
import { githubContext } from './github-principal';
import { GithubUserService } from './github-user.service';

/** What the interceptor tells the browser about the answer it is sending: set
 *  when the request read permission-sensitive state, absent otherwise. */
export const SENSITIVE_HEADER = 'X-Board-Sensitive';

/**
 * A GET answer may only be released while the access that authorized it holds
 * (#892).
 *
 * A read can outlive the check that authorized it — a cold repository map is
 * tens of seconds against a sixty-second check — so something has to decide
 * what to do with an answer that lands late. Two different things, because the
 * two kinds of answer are not equally recoverable:
 *
 * - A **permission-sensitive** answer is refused, full stop. Private Projects,
 *   security alerts, billing and capability verdicts turn on grants the
 *   visibility fingerprint does not observe, so "the fingerprint is unchanged"
 *   does not reauthorize them. Re-checking would release data on a test that
 *   cannot see the loss it is meant to catch. Two states behind such answers,
 *   Projects and the repository map, are kept across a check that found
 *   nothing changed, up to their own TTLs (#1007, see `PrincipalState`). That
 *   decides how long a cache may be reused; the refusal of a late answer here is
 *   unchanged by it.
 * - A **repository-only** answer is released once a FRESH check finds the same
 *   visibility. That check is a real one: `principal()` re-discovers because the
 *   window this read started in has expired by definition. If the key moved —
 *   access narrowed, widened, credential rotated or revoked — the answer is
 *   refused like any other.
 *
 * Which kind a request is comes from whether it read a permission-sensitive
 * `PrincipalState`, recorded as it happens rather than declared per route.
 *
 * The same reading is put on the answer as `X-Board-Sensitive`, because the
 * browser has the same problem one step later: it holds this answer on the disk
 * and on the screen after the check behind it has expired, and re-checking the
 * visibility fingerprint does not reauthorize it there either. Saying it here
 * means the browser does not carry a second list of which surfaces are
 * sensitive — a list that would drift from this one, which is the defect this
 * class exists to prevent (#892 review, C2).
 */
@Injectable()
export class GithubExpiryInterceptor implements NestInterceptor {
  constructor(@Inject(GithubUserService) private readonly github: GithubUserService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const store = githubContext.getStore();
    const principal = store?.principal;
    const req = context.switchToHttp().getRequest();
    const read = req.method === 'GET';
    const res = context.switchToHttp().getResponse();
    return next.handle().pipe(
      switchMap((value) => {
        // Set before any return below, so a released answer carries it too —
        // it is what the answer IS, not what happened to it.
        if (store?.sensitive) {
          res.setHeader?.(SENSITIVE_HEADER, '1');
          if (principal?.expiresAt) {
            const visibilityKey = this.github.clientVisibilityKey(principal.key);
            if (visibilityKey) {
              res.setHeader?.('X-Board-Access-Expires-At', String(principal.expiresAt));
              res.setHeader?.('X-Board-Visibility', visibilityKey);
            }
          }
        }
        if (!read || !principal?.expiresAt || Date.now() < principal.expiresAt) return from([value]);
        if (store?.sensitive) {
          throw new ServiceUnavailableException(
            'GitHub access needs rechecking before this view can be shown; retry',
          );
        }
        return from(
          this.github
            .principal(principal.email, store?.boardSub, false)
            .then((fresh) => {
              if (fresh.key !== principal.key) {
                throw new ServiceUnavailableException('GitHub access changed during this read; retry');
              }
              return value;
            }),
        );
      }),
    );
  }
}

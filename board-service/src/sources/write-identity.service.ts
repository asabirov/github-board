import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { asMsg } from '../capability/github-refusal';
import { githubContext } from '../auth/github-principal';
import { tokenFor } from './github-client';

/**
 * Who this board writes Github as (#756).
 *
 * A DEPLOYMENT diagnostic, and only that (#892). It names the credential the
 * board holds for its own no-person work — the boot alert, the boot warms, the
 * detached login derivation. It is NOT the account a person's writes land
 * under: since #892 every read and write made on somebody's behalf goes out
 * under their own Github credential, and Github's timeline names them. See
 * `resolve()` for what keeps this answer person-free.
 *
 * Two states, not four. `resolved` means Github answered and `login` is the
 * account the board's OWN mutations land under; `unknown` means it did
 * not, and `reason` says which of the several honest reasons applies — no
 * credential configured, a Github App installation (which is a bot account and
 * not a user, so `GET /user` has no answer for it), a refused credential, or
 * Github being unreachable. The nuance travels in the sentence rather than in a
 * state a caller would have to switch on, because every non-`resolved` outcome
 * has the same consequence for the operator: the board cannot name the account,
 * and going and looking is the fallback.
 *
 * `unknown` is never an error. This is a read about a deployment, consulted from
 * an admin page and logged once at boot; a Github outage must cost the board an
 * unanswered question and nothing else.
 */
export type WriteIdentityState = 'resolved' | 'unknown';

export interface WriteIdentity {
  state: WriteIdentityState;
  /** The Github account login, when Github named one. Null on `unknown`. */
  login: string | null;
  /** Why it is `unknown`, in a sentence an operator can act on. Null on `resolved`. */
  reason: string | null;
  /** When the answer below was taken, ISO-8601. */
  checkedAt: string;
  /** Whether writes are on at all (`GITHUB_WRITE_ENABLED`). Reported beside the
   *  login because "which account" and "does it write" are one question to the
   *  operator who has just changed the credential, and answering only the first
   *  invites the reading that a board with writes off is writing as this account.
   *  It gates person-credential writes too, so this flag is wider than the
   *  login beside it. */
  writesEnabled: boolean;
  /** True when `GITHUB_WRITE_TOKEN` is set, so writes and reads hold different
   *  credentials (#625). False means the login above is the READ credential too. */
  separateWriteToken: boolean;
}

/** How long a failed answer is held before the next caller may ask again. A
 *  successful one is held for the life of the process: the credential comes from
 *  the environment, so changing it is a restart. A failure is transient far more
 *  often than it is permanent, and an admin page that refreshes must not turn a
 *  five-second Github blip into an `unknown` that outlives it — nor may it
 *  hammer Github while an outage lasts. */
const FAILURE_TTL_MS = 60_000;

/** DI tokens for the two seams below. Nothing provides them in production —
 *  they exist so the parameters carry an `@Inject`, without which `tsc`'s
 *  `design:paramtypes` hands Nest a `Function` token it cannot resolve. A spec
 *  that wants the seams still passes them positionally to `new`. */
export const WRITE_IDENTITY_ASK = Symbol('WRITE_IDENTITY_ASK');
export const WRITE_IDENTITY_NOW = Symbol('WRITE_IDENTITY_NOW');

/** How long `GET /user` may take before it is a failure. Matches
 *  `identity/github-derived-logins.source.ts`, and for the same reason: a socket
 *  that hangs rather than fails would otherwise sit in `inFlight` forever, and
 *  every later admin read would be handed that same pending promise. Undici's
 *  own headers timeout is 300 s, which is not a bound this can live with. */
const REQUEST_TIMEOUT_MS = 20_000;

@Injectable()
export class WriteIdentityService {
  private readonly logger = new Logger(WriteIdentityService.name);

  /** The last answer, and when it was taken. A `resolved` one is never retaken. */
  private held: WriteIdentity | null = null;

  /** The request in flight, shared by every caller that arrives during it — so
   *  three admins opening the page at once cost Github one call, not three. */
  private inFlight: Promise<WriteIdentity> | null = null;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    /** Seam for the specs: the real one is `GET /user` under the write token.
     *  It takes the TOKEN and not the ConfigService, so a spec can see which of
     *  the two credentials this asked about; `take()` below is the only caller
     *  and resolves it through `tokenFor(config, 'write')`.
     *
     *  `@Optional() @Inject(TOKEN)` and not a bare default. This class is an
     *  `@Injectable` in `admin.module.ts`'s `providers`, and `tsc` — which is
     *  what `pnpm build` and the production image run — emits
     *  `design:paramtypes` for it under `emitDecoratorMetadata`. A parameter
     *  typed as a function emits `Function`, which Nest then tries to resolve as
     *  a provider token and cannot, so the container throws inside
     *  `NestFactory.create` and the process never listens. The constructor
     *  default still supplies the real implementation: Nest passes `undefined`
     *  for an unprovided optional dependency, which is exactly what triggers it. */
    @Optional() @Inject(WRITE_IDENTITY_ASK) private readonly ask: (token: string) => Promise<string> = defaultAsk,
    @Optional() @Inject(WRITE_IDENTITY_NOW) private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The current answer, resolving it if there is none worth reusing.
   *
   * Never rejects and never throws — every failure becomes an `unknown` with a
   * reason. A caller may hold this for as long as it likes; it is a fact about
   * the deployment, not about the request.
   *
   * DETACHED from the acting person, first line (#892). `held` and `inFlight`
   * are process-wide and a `resolved` answer is never retaken, so whichever
   * credential `take()` reads becomes the answer every later caller is given —
   * which must never be one person's. The exit also keeps the promise above:
   * inside a request `tokenFor` throws for an unconnected person.
   */
  async resolve(): Promise<WriteIdentity> {
    if (githubContext.getStore()) return githubContext.exit(() => this.resolve());
    const held = this.held;
    if (held) {
      if (held.state === 'resolved') return held;
      if (this.now() - Date.parse(held.checkedAt) < FAILURE_TTL_MS) return held;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.take().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** The one call, and the one place a failure becomes a sentence. */
  private async take(): Promise<WriteIdentity> {
    const token = tokenFor(this.config, 'write');
    const base = {
      checkedAt: new Date(this.now()).toISOString(),
      writesEnabled: this.config.get<boolean>('GITHUB_WRITE_ENABLED', false),
      separateWriteToken: Boolean(this.config.get<string>('GITHUB_WRITE_TOKEN', '')),
    };

    if (!token) {
      // No token means `buildOctokitClient` falls back to a Github App
      // installation — or to nothing at all. An installation token authenticates
      // as an app, not a user, so `GET /user` answers 403 for it however healthy
      // the deployment is. Asking anyway would spend a call to learn what the
      // configuration already says, and would report a working App deployment as
      // if something were wrong with it.
      const app = this.config.get<string>('GITHUB_APP_ID', '');
      const unknown: WriteIdentity = {
        ...base,
        state: 'unknown',
        login: null,
        reason: app
          ? 'This deployment authenticates as a Github App installation. Its writes land under the ' +
            "App's own bot account, which `GET /user` cannot name — read the App's slug from its " +
            'settings page on Github.'
          : 'No Github credential is configured (GITHUB_TOKEN and GITHUB_WRITE_TOKEN are both empty, ' +
            'and no App is set). This board makes no Github writes.',
      };
      this.held = unknown;
      return unknown;
    }

    try {
      const login = await this.ask(token);
      const resolved: WriteIdentity = { ...base, state: 'resolved', login, reason: null };
      this.held = resolved;
      return resolved;
    } catch (err) {
      const unknown: WriteIdentity = {
        ...base,
        state: 'unknown',
        login: null,
        // `redact` and not trust: Github's own 401 message is "Bad credentials"
        // and carries nothing, but this string is served to an admin page and
        // written to the log, and a credential must not reach either even if
        // some future error type decides to quote the request it made.
        reason: `Github did not answer which account this credential belongs to: ${redact(asMsg(err), token)}`,
      };
      this.held = unknown;
      return unknown;
    }
  }

  /**
   * The boot line (#756). Fired and not awaited: resolving a login is a network
   * call, and a board must boot without Github.
   *
   * It logs the account, or the reason there is none. Never the credential.
   */
  announce(): void {
    void this.resolve().then((identity) => {
      if (identity.state === 'resolved') {
        this.logger.log(
          `The board’s own Github work goes out as @${identity.login} ` +
            `(GITHUB_WRITE_ENABLED=${identity.writesEnabled}, ` +
            `${identity.separateWriteToken ? 'GITHUB_WRITE_TOKEN' : 'GITHUB_TOKEN'}). ` +
            'That is the boot alert and the other no-person jobs. A write made for a person ' +
            'goes out under their own connected credential, and Github names them (#892).',
        );
        return;
      }
      // WARN only when it matters. A board with writes off writing as nobody is
      // not a problem, and a local dev boot on fixtures hits this every time —
      // a warning nobody can act on is a warning people learn to skip, which is
      // the failure `docs/ops/production-alerting.md` was written about.
      const say = identity.writesEnabled ? this.logger.warn : this.logger.log;
      say.call(
        this.logger,
        `Github write identity unknown: ${identity.reason}` +
          (identity.writesEnabled
            ? ' Writes are ON, so the board’s own no-person writes go out under an account it cannot name.'
            : ''),
      );
    });
  }
}

/** `GET /user` under the WRITE token — the credential the mutations actually
 *  carry since #625, not the read one beside it. Built here rather than through
 *  `buildOctokitClient` because `take()` has already returned for the App
 *  fallback that function exists to provide, so the token is never empty by the
 *  time this runs. A GET, so `capability/github-write-census.contract.ts`
 *  classifies it a read and the census of 14 mutations is unchanged. */
export async function defaultAsk(token: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<string> {
  const client: Octokit = new Octokit({ auth: token });
  const res = await client.request('GET /user', {
    // Without this the promise below can never settle, and `inFlight` hands
    // every later reader the same pending promise (#756 review).
    request: { signal: AbortSignal.timeout(timeoutMs) },
  });
  const login = (res.data as { login?: string }).login;
  if (!login) throw new Error('Github answered GET /user with no login');
  return login;
}

/** Remove the credential from a string, whatever put it there. */
function redact(text: string, token: string): string {
  return token ? text.split(token).join('[redacted]') : text;
}

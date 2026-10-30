import type { McpActor } from './overview-tools';

/** What `board_whoami` answers: three facts about the calling session. */
export interface WhoAmI {
  /** The address this session acts as. `agent:<name>` for a static token. */
  email: string;
  /** The Github account this session's work actually goes out under, or null
   *  when there is none — nobody connected, or a static agent token (#892).
   *
   *  Not a roster handle: naming an account a session cannot act as invites an
   *  agent to plan work every Github call then refuses. */
  githubLogin: string | null;
  /** The limits on this session. Empty means unlimited, not empty-handed. */
  scopes: string[];
}

/**
 * Declared structurally so the real `GithubLoginResolver` and a two-line stub
 * both satisfy it, and so a change inside `identity/` surfaces at one site.
 */
export interface IdentityDeps {
  githubLogins: {
    forEmail(email: string): Promise<string | null>;
    typedLoginFor(email: string): Promise<string | null>;
  };
  /**
   * This request's resolved Github principal, or null when none was resolved at
   * all (`AUTH_DISABLED` fixtures, where there is no person context to read).
   *
   * A seam and not a direct `githubPrincipal()` call, for the reason every other
   * dependency here is one: the tool stays a pure function of what it is handed,
   * and the controller is the one place that knows about the request.
   */
  connectedGithub(): { login: string | null } | null;
}

/**
 * The `board_whoami` answer (#536).
 *
 * Takes no caller-supplied arguments, by design. An `email` parameter would let
 * any holder of `board:read` resolve an arbitrary address to a Github handle,
 * turning a self-description into a roster lookup. It reads `actor`, which
 * `JwtAuthGuard` builds field by field in every branch, and makes at most one
 * resolver call keyed on the actor's own address.
 *
 * `scopes` is a REPORTING argument. Nothing here branches on it, and it must
 * never be fed to `deriveAgentFlag` — that returns true for `[]`, which is the
 * unscoped signed-in person, whose `actor.agent` is false.
 *
 * No try/catch: `GithubLoginResolver` already swallows store failures and falls
 * back to the checked-in table, so a second layer would only hide a real defect.
 */
export async function whoAmI(
  actor: McpActor,
  scopes: string[],
  deps: IdentityDeps,
): Promise<WhoAmI> {
  // No person is behind a BOARD_AGENT_TOKENS token, so there is no handle to
  // find and no lookup worth making. Short-circuit rather than trust the
  // resolver to answer null for `agent:<name>`.
  if (actor.staticAgent) return { email: actor.email, githubLogin: null, scopes };

  // The CONNECTED principal outranks the roster (#892). When this request
  // resolved one, it is the whole answer — including when its login is null,
  // which is what an unconnected person looks like and must be reported as.
  // Falling through to the roster there would name a handle this session cannot
  // act as, which is the one wrong answer this tool can give.
  const connected = deps.connectedGithub();
  if (connected) return { email: actor.email, githubLogin: connected.login, scopes };

  // No principal at all — the fixture lane. typedLoginFor, NOT forEmail: the MCP
  // surface is never told an identity the board inferred from commit authorship
  // (#535). `/api/auth/me` and "Your work" do use that tier; this is the one
  // surface that deliberately does not, and #892 does not change that tier's
  // meaning anywhere else.
  const githubLogin = await deps.githubLogins.typedLoginFor(actor.email);
  return { email: actor.email, githubLogin, scopes };
}

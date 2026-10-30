/** The authenticated caller, as the guards leave it on `req.user` — as much of
 *  it as any visibility decision is allowed to see. */
export interface AuthenticatedActor {
  /**
   * The STABLE Board identity behind `email` — the GitHub user id of the
   * session, of the MCP grant, or of the session that minted a personal token.
   *
   * An address is not an identity: a company can hand `alice@` to a second Alice,
   * and every roster read would then agree the new person is the old one. A
   * Github credential is a reversible secret belonging to whoever consented to
   * it, so it is looked up on THIS and never on the address beside it.
   *
   * Absent means no stable identity was established for this caller: a static
   * agent token, or a personal token minted before this field existed. Absent is
   * never a wildcard — `GithubUserService.principal` resolves it to unconnected.
   */
  boardSub?: string;
  /**
   * Set ONLY where `JwtAuthGuard` builds a `BOARD_AGENT_TOKENS` actor, and the
   * only thing `isStaticAgent` reads.
   */
  staticAgent?: boolean;
  /**
   * The scoped-actor flag: a static token, a personal access token and an MCP
   * agent-scoped session all carry it. It says the caller is scoped, never that
   * it is nobody, so it does not tell a static token from a person on its own.
   */
  agent?: boolean;
  email?: string;
}

/**
 * The single definition of "is this request a static agent token?" (#482).
 *
 * A `BOARD_AGENT_TOKENS` actor authenticates as `agent:<name>` — no person is
 * behind it, nobody is accountable for what it reads, and revoking it means
 * editing an environment variable rather than removing an identity, which is why
 * the routes carrying other people's addresses treat it differently from every
 * other caller.
 *
 * Every other scoped actor carries a real address: a personal access token is
 * its owner's (`#210`), and an MCP agent-scoped session is a GitHub identity
 * that passed the allow list. Both stay on the human path — they read what
 * their owner already reads in the board.
 *
 * ## Why a flag and not the address (#525)
 *
 * This used to read the address: agent flag set AND no `@` in the email. The
 * address is built as `agent:${name}` from a name out of `BOARD_AGENT_TOKENS`,
 * so a token named `claude@ci` produced `agent:claude@ci`, which passed the `@`
 * test and made the token read as an ordinary person. Every rule keyed on this
 * predicate inverted at once — from one character in an environment variable.
 *
 * `parseAgentTokens` now refuses such a name and `config.schema.ts` already did,
 * so no such token can be configured. Both of those are gates on a STRING. This
 * is the part that does not depend on one: what a caller is comes from a flag
 * set where the actor is built, so a future bug in name handling cannot re-open
 * the hole.
 *
 * The flag is written in exactly one place — the `BOARD_AGENT_TOKENS` branch of
 * `jwt-auth.guard` — and it cannot be forged. No branch of that guard spreads a
 * token's claims into `req.user`; each builds the object field by field, so
 * nothing a caller puts in a JWT, a cookie or a header lands here.
 *
 * `TeamAccessGuard` has keyed its group-check bypass on this predicate since
 * #56; it calls this function rather than restating it, so the bypass and the
 * withholding rules cannot drift apart.
 *
 * ## Why the flag is read as an OWN property
 *
 * A plain `user.staticAgent` read walks the prototype chain, so the answer would
 * depend on nothing having put a `staticAgent` property on `Object.prototype`.
 * Nothing can today — `parseCookies` assigns only strings onto a fresh object
 * literal, `main.ts` configures the urlencoded parser with `extended: false` so
 * a query string cannot build a nested key, and no dependency deep-merges — so
 * `Object.hasOwn` closes no live hole. It writes down a constraint three gates
 * were relying on silently, and it is worth writing down because they would not
 * fail alike: a stray inherited `true` makes `AdminAuthority.isAdminActor`
 * refuse everyone, which is closed and harmless, while `TeamAccessGuard` returns
 * early on the same answer and would skip the admission check for every
 * caller. This holds the stricter of the two, and holds it here rather than at
 * each of the three, so a fourth consumer inherits it by calling this.
 */
export const isStaticAgent = (user?: AuthenticatedActor): boolean =>
  !!user && Object.hasOwn(user, 'staticAgent') && user.staticAgent === true;

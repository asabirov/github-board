// TODO(overview-rename stage 2): cookie names keep the atlas_ prefix —
// renaming them invalidates live browser sessions.
export const SESSION_COOKIE = 'atlas_session';
export const STATE_COOKIE = 'atlas_oauth_state';
export const VERIFIER_COOKIE = 'atlas_oauth_verifier';
/** Post-login continuation for the MCP OAuth flow (whitelisted in the callback). */
export const NEXT_COOKIE = 'atlas_next';

/**
 * How long a browser sign-in lasts, in seconds: the signer, the cookie maxAge and
 * the denylist clamp all read it, so they cannot drift apart (#677). Seven days,
 * up from eight hours, which signed people out mid-week — the ceiling on a
 * captured cookie and, likelier, on a machine left signed in, since the cookie is
 * persistent and there is no idle timeout.
 *
 * Sign-out ends three things: the session presented, by its jti; every other
 * session that person holds, by the per-person epoch; and their MCP grants. The
 * denylist and the epoch are Postgres rows since #679, so a redeploy no longer
 * hands a captured cookie the rest of the week back. SessionRevocationService
 * holds that account.
 *
 * A personal access token is not among the three, and this lifetime does not
 * describe one. A `board_pat_` is a separate credential with its own expiry,
 * resolved in the guard before any session is verified (jwt-auth.guard.ts), so
 * neither gate above is even consulted for it. Signing out of a browser leaves
 * every PAT its owner minted working; they are listed and revoked one by one in
 * Account, which is where a key deliberately created belongs.
 */
export const SESSION_TTL_S = 7 * 24 * 3600;

/** The same lifetime in ms, for the logout revocation clamp (#112). */
export const SESSION_TTL_MS = SESSION_TTL_S * 1000;

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

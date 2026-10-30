import type { GithubOwner } from './github-principal';

/**
 * Every Github destination the account page offers, built here and nowhere else
 * (#892).
 *
 * A signed-in browser follows these into Github's consent screens, so none is
 * forwarded from a provider payload — not the `html_url` on each installation
 * either, which would be a redirect target chosen by whatever the API said that
 * minute. Each is CONSTRUCTED from a numeric id and a login checked against the
 * character set a Github login may use: no `/`, `.`, `%`, `?`, `#`, `:` or
 * whitespace, so a value that passes cannot climb out of its path segment and
 * one that fails yields `null` rather than a guess. Validated here even where a
 * caller already validated, this being the last stop before an href.
 */

/** An allowlist, so a character nobody thought of is refused by default. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** An App slug is the same shape, lowercased on the way out. */
const SLUG = LOGIN;

/** Where a person reviews and revokes every OAuth/App authorization they hold.
 *  Fixed, public, and the same for every Github user. */
export const GITHUB_AUTHORIZATIONS_URL = 'https://github.com/settings/apps/authorizations';

export function isGithubLogin(value: unknown): value is string {
  return typeof value === 'string' && LOGIN.test(value);
}

export function isGithubAppSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value);
}

/**
 * Where this person manages ONE installation of the board's App.
 *
 * Two pages, because Github keeps them apart: an org's installation is
 * administered under the org's settings and a personal one under the person's
 * own, so the account type decides rather than a default. `null` when the id or
 * the login does not validate, and a caller that gets `null` must drop the
 * entry rather than substitute a link.
 */
export function installationManageUrl(id: number, account: GithubOwner): string | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (!isGithubLogin(account.login)) return null;
  return account.type === 'Organization'
    ? `https://github.com/organizations/${account.login}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

/**
 * Where a person installs the board's App on an account that has none yet.
 *
 * The slug is the App's, and the board knows it only if told —
 * `GITHUB_USER_APP_SLUG`, or the `app_slug` Github reports on an installation
 * this person already holds. Never guessed from the display name or the client
 * id: a wrong slug links to somebody else's App install screen, which is worse
 * than no link.
 */
export function appInstallUrl(slug: string | null | undefined): string | null {
  if (!isGithubAppSlug(slug)) return null;
  return `https://github.com/apps/${slug.toLowerCase()}/installations/new`;
}

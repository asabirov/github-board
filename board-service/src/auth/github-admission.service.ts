import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';

/**
 * Who may sign in to the board (#1450). `BOARD_ALLOWED_GITHUB` is one optional
 * comma-separated list. Empty admits every GitHub user. Otherwise each entry is
 * one of three kinds:
 *
 * - a numeric GitHub user id, compared against the caller's stable id;
 * - a plain login, resolved to its numeric id through the GitHub API once per
 *   process and then compared against the caller's id — so a person who renamed
 *   their login is still admitted, and a login reused by a different account is
 *   not;
 * - an `org:`-prefixed organisation login, admitting a person when GitHub
 *   reports their membership in it as `active`, checked with the person's own
 *   token.
 *
 * Organisation membership is cached briefly, keyed on the GitHub user id and the
 * credential version — so a token refresh (which rotates the version) re-checks
 * membership rather than trusting a cached answer. A failed GitHub read denies:
 * the board fails closed.
 */
export const ADMISSION_CACHE_TTL_MS = 60_000;

export interface GithubAllowList {
  /** Numeric GitHub user ids, as strings. */
  ids: string[];
  /** Lowercased logins, resolved to ids on first admission check. */
  logins: string[];
  /** Lowercased organisation logins. */
  orgs: string[];
}

export function parseGithubAllowList(raw: string | undefined): GithubAllowList {
  const ids: string[] = [];
  const logins: string[] = [];
  const orgs: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    if (lower.startsWith('org:')) {
      const org = lower.slice('org:'.length).trim();
      if (org) orgs.push(org);
    } else if (/^[0-9]+$/.test(value)) {
      ids.push(value);
    } else {
      logins.push(lower);
    }
  }
  return { ids, logins, orgs };
}

@Injectable()
export class GithubAdmissionService {
  private readonly logger = new Logger(GithubAdmissionService.name);
  private readonly membership = new Map<string, { until: number; admitted: boolean }>();
  private readonly loginIds = new Map<string, string>();

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private get allowList(): GithubAllowList {
    return parseGithubAllowList(this.config.get<string>('BOARD_ALLOWED_GITHUB', ''));
  }

  /** Is no allow list set? Then every GitHub user is admitted. */
  empty(): boolean {
    const list = this.allowList;
    return list.ids.length === 0 && list.logins.length === 0 && list.orgs.length === 0;
  }

  /** Does the allow list name any organisation, so membership needs a token? */
  orgsConfigured(): boolean {
    return this.allowList.orgs.length > 0;
  }

  /**
   * May this GitHub identity sign in? `githubUserId` is the caller's stable
   * numeric GitHub id and `githubLogin` their current login. `opts.token` is the
   * caller's own user token, needed only to check organisation membership.
   */
  async admits(
    githubUserId: string | undefined,
    githubLogin: string | undefined,
    opts: { token?: string; credentialVersion?: string } = {},
  ): Promise<boolean> {
    const list = this.allowList;
    if (list.ids.length === 0 && list.logins.length === 0 && list.orgs.length === 0) return true;
    const id = (githubUserId ?? '').trim();
    if (!id) return false;
    if (list.ids.includes(id)) return true;
    for (const login of list.logins) {
      if ((await this.loginId(login)) === id) return true;
    }
    if (list.orgs.length === 0 || !opts.token) return false;
    for (const org of list.orgs) {
      if (await this.memberOf(org, id, opts.credentialVersion ?? '', opts.token)) {
        return true;
      }
    }
    return false;
  }

  /**
   * The numeric id behind a named login, resolved through the GitHub API with
   * the board's machine token and cached for the process. Ids are stable across
   * renames, so one resolution is enough. A failed read returns `undefined` and
   * denies rather than guessing.
   */
  private async loginId(login: string): Promise<string | undefined> {
    const cached = this.loginIds.get(login);
    if (cached) return cached;
    const token = this.config.get<string>('GITHUB_TOKEN', '');
    if (!token) {
      this.logger.warn(`cannot resolve allow-list login ${login}: no GITHUB_TOKEN`);
      return undefined;
    }
    try {
      const { data } = await new Octokit({ auth: token }).rest.users.getByUsername({ username: login });
      if (!data.id) throw new Error('no id');
      const id = String(data.id);
      this.loginIds.set(login, id);
      return id;
    } catch (err) {
      this.logger.warn(`GitHub login resolution for ${login} failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async memberOf(org: string, githubUserId: string, version: string, token: string): Promise<boolean> {
    const key = `${githubUserId}\u0000${version}\u0000${org}`;
    const hit = this.membership.get(key);
    if (hit && hit.until > Date.now()) return hit.admitted;
    let admitted = false;
    try {
      const { data } = await new Octokit({ auth: token }).rest.orgs.getMembershipForAuthenticatedUser({ org });
      admitted = data.state === 'active';
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (status === 404 || status === 403) {
        admitted = false;
      } else {
        this.logger.warn(`GitHub membership check for ${org} failed: ${(err as Error).message}`);
        admitted = false; // fail closed
      }
    }
    this.membership.set(key, { until: Date.now() + ADMISSION_CACHE_TTL_MS, admitted });
    return admitted;
  }
}

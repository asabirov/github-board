import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Octokit } from '@octokit/rest';
import { githubOrgs } from '../config/github-orgs';
import { buildOctokitClient } from '../sources/github-client';
import type { DerivedLoginsResult, DerivedLoginsSource } from './derived-logins.source';

/**
 * A Github handle derived from commit authorship (#535).
 *
 * The issue proposed reading `GET /users/{login}`'s public email. Measured
 * against this org that places one member in three, and the one it places is
 * already in the roster — so it would derive nothing new and still miss the two
 * accounts the feature exists for. Commit metadata places all three, because an
 * address somebody never published on a profile is nonetheless stamped on every
 * commit they authored.
 *
 * Read from BOTH ends of a member's history, never the top. Github rewrites a
 * commit address to `<id>+<login>@users.noreply.github.com` when the account
 * hides its email, and that is usually switched on partway through — so the
 * newest page is the one most likely to carry no usable address at all. One
 * member here has 213 noreply commits in his newest 300 and his work address
 * only underneath them.
 *
 * Paced per REQUEST. Each member costs two searches, so a gap taken once per
 * member emits two requests per gap and doubles the true rate. `/search/commits`
 * is the service's only search-API consumer and that bucket is 30 a minute, not
 * core's 5000 an hour — nothing else absorbs an overrun. It can afford the wait:
 * the only caller is a background timer, so a slow run costs nobody a page view.
 */

/** `<id>+<login>@users.noreply.github.com` — Github's stand-in, not an address anybody signs in with. */
export function isNoReplyAddress(email: string): boolean {
  return email.toLowerCase().endsWith('@users.noreply.github.com');
}

/** `dependabot[bot]`, `github-actions[bot]` — no person behind them. */
export function isBotLogin(login: string): boolean {
  return login.toLowerCase().endsWith('[bot]');
}

const SEARCH_PAGE = 100;
const REQUEST_TIMEOUT_MS = 20_000;


export class GithubDerivedLoginsSource implements DerivedLoginsSource {
  private readonly logger = new Logger(GithubDerivedLoginsSource.name);
  private readonly maxMembers: number;
  private readonly minGapMs: number;

  constructor(
    private readonly config: ConfigService,
    // Injected so the spec drives this without a network. Defaults to the shared
    // factory every other Github source uses.
    private readonly clientFactory: (c: ConfigService) => Octokit = buildOctokitClient,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    // Injected for the same reason, and because a list with one member cannot
    // tell a producer that walks it from one that pins `orgs[0]` (#647).
    //
    // THE OWNER SCOPE, from the one function that answers it (#647, #1209). This
    // source exists to attribute the people behind the work the issue ingest
    // reads, so an org the ingest covers and this does not is a person-shaped
    // surface under-attributing that org with nothing said about it — and an org
    // this covers and the ingest does not is search quota spent on work nobody
    // will see. One resolver for both is what keeps them equal; a pinned
    // `ISSUES_METRICS_ORG` used to split them, and it is retired (#1209 part 4).
    //
    // This source is DETACHED work — a boot run and a twelve-hour timer, with no
    // person acting — so the scope it reads is `GITHUB_ORGS`.
    //
    // It THROWS on a `GITHUB_ORGS` that names no org, and the throw reaches
    // `identity.module.ts`'s factory, which aborts the boot. Joi refuses the
    // same value first, so where this fires it is the second door — for the
    // specs across the tree that build a ConfigService from a plain object and
    // never see the schema. With the pins gone there is no config that reaches
    // this line without the list being parsed.
    //
    // An empty `orgs` is still a legal thing to INJECT, and `derive` answers it
    // with an empty map rather than querying `org:`.
    private readonly orgs: string[] = githubOrgs(config),
  ) {
    this.maxMembers = config.get<number>('GITHUB_LOGIN_DERIVATION_MAX_MEMBERS', 200);
    const rpm = Math.max(1, config.get<number>('GITHUB_LOGIN_DERIVATION_RPM', 20));
    this.minGapMs = Math.ceil(60_000 / rpm);
  }

  async derive(): Promise<DerivedLoginsResult> {
    if (this.orgs.length === 0) return { map: new Map(), complete: true };

    const octokit = this.clientFactory(this.config);
    // NOT caught. Failing to list members means the run saw nothing at all, and
    // the service must tell that from a run that saw everything and found
    // nobody. Every other failure below degrades to `complete: false`.
    const members = await this.members(octokit);

    let complete = true;
    const byLogin = new Map<string, Set<string>>();
    for (const login of members) {
      // Every org, not the org the member was first seen in: a person can author
      // under one address in one org and another in the next, and the map is
      // keyed on the address (#647).
      const addresses = new Set<string>();
      for (const org of this.orgs) {
        const found = await this.addressesFor(octokit, login, org);
        if (!found.ok) complete = false;
        for (const email of found.addresses) addresses.add(email);
      }
      byLogin.set(login, addresses);
    }

    // Invert, dropping any address two logins both claim. Two people sharing a
    // commit address is rare and always ambiguous; guessing between them would
    // attribute one person's work to the other, which is worse than answering
    // nothing and letting an admin type it.
    const claimants = new Map<string, Set<string>>();
    for (const [login, addresses] of byLogin) {
      for (const email of addresses) {
        const set = claimants.get(email) ?? new Set<string>();
        set.add(login);
        claimants.set(email, set);
      }
    }

    const map = new Map<string, string>();
    for (const [email, logins] of claimants) {
      if (logins.size === 1) map.set(email, [...logins][0]);
      else this.logger.warn(`derived login ambiguous for ${email}: ${[...logins].join(' ')}`);
    }
    return { map, complete };
  }

  /**
   * Members of EVERY configured org, de-duplicated and bounded.
   *
   * De-duplicated because somebody in both orgs is one person: enumerated twice
   * they would be two claimants of every address they author under, and the
   * ambiguity rule below would drop the lot — the opposite of what reading a
   * second org is for.
   *
   * The cap applies to the union, so it still bounds the work the run does.
   * What it drops is logged — a silent truncation reads as "everybody was
   * considered" when they were not.
   */
  private async members(octokit: Octokit): Promise<string[]> {
    const seen = new Set<string>();
    for (const org of this.orgs) {
      const all = (await octokit.paginate(octokit.rest.orgs.listMembers, {
        org,
        per_page: 100,
      })) as Array<{ login: string }>;
      for (const m of all) if (!isBotLogin(m.login)) seen.add(m.login);
    }
    const logins = [...seen];
    if (logins.length > this.maxMembers) {
      this.logger.warn(
        `the configured orgs have ${logins.length} members between them; deriving for the first ` +
          `${this.maxMembers}. Raise GITHUB_LOGIN_DERIVATION_MAX_MEMBERS to cover the rest.`,
      );
    }
    return logins.slice(0, this.maxMembers);
  }

  /**
   * Every usable address this login has authored under IN ONE ORG, from the
   * oldest and newest ends of their history there. `ok` is false if either end
   * failed, so the run can report itself incomplete rather than presenting a
   * short map as whole.
   */
  private async addressesFor(
    octokit: Octokit,
    login: string,
    org: string,
  ): Promise<{ addresses: Set<string>; ok: boolean }> {
    const addresses = new Set<string>();
    let ok = true;
    for (const order of ['asc', 'desc'] as const) {
      // Before EVERY request, which is the unit the limit counts.
      await this.sleep(this.minGapMs);
      try {
        const res = await octokit.request('GET /search/commits', {
          q: `author:${login} org:${org}`,
          sort: 'author-date',
          order,
          per_page: SEARCH_PAGE,
          // A hung request would otherwise wedge this run and, through
          // single-flight, every refresh behind it.
          request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        });
        const items =
          (res.data as { items?: Array<{ commit?: { author?: { email?: string } } }> }).items ?? [];
        for (const item of items) {
          const email = item.commit?.author?.email?.trim().toLowerCase();
          if (email && !isNoReplyAddress(email)) addresses.add(email);
        }
      } catch (err) {
        ok = false;
        this.logger.warn(
          `derived login lookup failed for ${login} in ${org} (${order}): ${(err as Error).message}`,
        );
      }
    }
    return { addresses, ok };
  }
}

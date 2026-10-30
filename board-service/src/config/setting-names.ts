/**
 * Which settings name a Github ORGANISATION or REPOSITORY, said once, for every
 * key the schema declares (#1183 review).
 *
 * The boot probe used to decide that by a regex over key names —
 * `/_(ORGS?|OWNER|REPOS?)$/` — which is the mechanism #1183 was filed to
 * replace. A check that enumerates spellings is always one spelling behind, and
 * this one was: `CUSTOMER_STREAM_REPOSITORY` would have been invisible to it,
 * and so would a `FEEDBACK_REPO` renamed to `FEEDBACK_REPOSITORY`, which leaves
 * the same count of keys behind and so slips under a floor on how many were
 * found.
 *
 * What replaces it is not a longer pattern but a TOTAL one — total over the keys
 * the schema DECLARES. Every key in the schema appears here exactly once, and
 * `check-naming-settings.mjs` refuses to run when the two disagree in either
 * direction: a key the schema declares and nobody classified, or a
 * classification for a key the schema no longer has. So a new setting cannot
 * arrive uncovered under a new SPELLING — it arrives as a failing boot check
 * that names it and asks which of the two it is.
 *
 * Say the qualifier, because without it the claim is false. A key nobody
 * declared is in neither set, so neither direction fires and nothing here has
 * an opinion about it — which is how `BOOT_ALERT_REPO`, the key that decides
 * where this board writes under its shared token, stayed invisible to every
 * check that reads the schema until #1175 (#1183 review). `github-orgs.spec.ts`
 * closes that from the other side: every key `src/` reads off `ConfigService`
 * must be declared, so a read cannot outrun this file. A key read straight off
 * `process.env` still can, and `docs/testing/naming-settings.md` holds that.
 *
 * Being one spelling behind is no longer possible; being one DECISION behind
 * is, and the decision is written down in a diff where a reviewer sees it.
 *
 * `null` is a claim, not a blank: it says this setting names no ORGANISATION and
 * no REPOSITORY, which is the ground #1183 covers. A port, a TTL, a secret, a
 * Google group, a source switch — none of them is an owner a stranger can
 * register the moment it is freed
 * (`docs/traps.md#a-renamed-organisation-is-indistinguishable-from-a-missing-one-by-org-lookup`).
 *
 * TWO of these nulls are still claims about a github.com namespace, and both are
 * said out loud below rather than left to the reader (#1244 review). A person's
 * login is the clearest: `BOOT_ALERT_ASSIGNEE` names one, and a person's login
 * is re-registrable on the same terms an organisation's is.
 * `GITHUB_USER_APP_SLUG` is the other — it is the `SLUG` in
 * `https://github.com/apps/SLUG`, freed by a rename on those same terms, and
 * `auth/github-app-links.ts` says what that costs: a wrong slug links to
 * somebody else's App install screen. Neither names an organisation or a
 * repository, which is what every check downstream acts on, so both stay `null`
 * and the risk is named where it lives.
 *
 * The four kinds are what a check needs in order to exercise a key: whether it
 * holds one org login, a list of them, one `owner/name`, or a list of
 * repositories that may legitimately resolve empty. The values fed to each kind
 * belong to `scripts/check-naming-settings.mjs`, not here.
 */

/** What a naming setting holds. `repos` named a LIST of repositories, and the
 *  one key that held one — `ISSUES_METRICS_REPOS` — is retired (#1209 part 4).
 *  The kind stays declared so a list-valued repository setting added later has
 *  a classification to take, and `check-naming-settings.mjs` refuses a key it
 *  cannot exercise. */
export type NamingKind = 'org' | 'orgs' | 'repo' | 'repos';

/**
 * Every schema key, and what it names. Keep it in the schema's own order so the
 * two files read side by side.
 */
export const SETTING_NAMES: Readonly<Record<string, NamingKind | null>> = {
  // Process and HTTP.
  NODE_ENV: null,
  APP_VERSION: null,
  PORT: null,
  CORS_ORIGIN: null,
  BOARD_BASE_URL: null,

  // Who may sign in, and how the board is told.
  AUTH_DISABLED: null,
  DEV_USER_EMAIL: null,
  // Names GitHub logins and organisations, but it is an admission list rather
  // than a data scope, so it names nothing this check exercises.
  BOARD_ALLOWED_GITHUB: null,
  BOARD_FIXTURE_ADMINS: null,
  BOARD_ADMIN_EMAILS: null,
  ADMIN_CACHE_TTL_MS: null,
  BOARD_SESSION_SECRET: null,
  BOARD_AGENT_TOKENS: null,
  BOARD_MCP_ENABLED: null,
  BOARD_CREDENTIAL_KEY: null,

  // Github credentials and the app a person connects through. A client id and a
  // private key address an installation, not an org's contents.
  GITHUB_TOKEN: null,
  GITHUB_WRITE_TOKEN: null,
  GITHUB_APP_ID: null,
  GITHUB_PRIVATE_KEY: null,
  GITHUB_INSTALLATION_ID: null,
  GITHUB_WEBHOOK_SECRET: null,
  GITHUB_USER_APP_CLIENT_ID: null,
  GITHUB_USER_APP_CLIENT_SECRET: null,
  // The `SLUG` in `https://github.com/apps/SLUG`. Not an organisation and not a
  // repository, so `null` — but a github.com namespace entry all the same, and
  // freed by a rename like any other. Only an operator can set it and it carries
  // no default, so there is no baked-in value here for a rename to take.
  GITHUB_USER_APP_SLUG: null,

  // The orgs this board serves where no person is acting. The four surface pins
  // that used to narrow it are retired and no longer declared (#1209 part 4) —
  // `config/retired-settings.ts` holds them, and a retired key names nothing
  // here because nothing reads it.
  GITHUB_ORGS: 'orgs',

  // The repositories the board writes into. `ISSUES_METRICS_REPOS` pinned the
  // ones it READ and is retired (#1209 part 4).
  FEEDBACK_REPO_ID: null,
  BOOT_ALERT_REPO_ID: null,
  FEEDBACK_REPO: 'repo',
  BOOT_ALERT_REPO: 'repo',

  // The label and the assignee a boot error is filed under. A label names
  // nothing on Github; an assignee names a PERSON, and a person's login is
  // re-registrable on the same terms an organisation's is. That risk is real and
  // is not this classification's: `null` here says NO ORGANISATION OR
  // REPOSITORY, which is what #1183 is about and what every check downstream
  // acts on. The assignee has no default; startup requires an explicit choice
  // when alerting is enabled (#1247).
  BOOT_ALERT_LABEL: null,
  BOOT_ALERT_ASSIGNEE: null,

  // Which source each surface is wired to, and what it is allowed to do.
  ISSUES_SOURCE: null,
  PROJECTS_SOURCE: null,
  DELIVERY_SOURCE: null,
  IDENTITY_SOURCE: null,
  GITHUB_WRITE_ENABLED: null,
  GITHUB_CAPABILITIES_DENY: null,
  CAPABILITY_GUARD_ENFORCING: null,

  // Labels, ceilings and cache lifetimes.
  LONG_LIVED_LABELS: null,
  FEEDBACK_LABELS: null,
  ISSUE_COMMENTS_MAX: null,
  ISSUES_STORE_MAX_AGE_MS: null,
  ISSUES_METRICS_CACHE_TTL_MS: null,
  ISSUE_BUCKETS_CACHE_TTL_MS: null,
  ISSUE_DETAIL_CACHE_TTL_MS: null,
  PROJECTS_CACHE_TTL_MS: null,
  PROJECTS_LAST_GOOD_MAX_MS: null,
  REPOS_CACHE_TTL_MS: null,
  DELIVERY_CACHE_TTL_MS: null,
  GITHUB_LOGIN_DERIVATION_INTERVAL_MS: null,
  GITHUB_LOGIN_DERIVATION_RPM: null,
  GITHUB_LOGIN_DERIVATION_MAX_MEMBERS: null,

  // Databases.
  DATABASE_URL: null,
  GITHUB_STORE_DATABASE_URL: null,
};

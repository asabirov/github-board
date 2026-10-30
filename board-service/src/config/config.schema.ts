import * as Joi from 'joi';
import { isCapability } from '../capability/capability';
import {
  BOOT_ALERT_REPO_UNSET,
  FEEDBACK_REPO_UNSET,
  GITHUB_ORGS_UNSET,
  parseGithubOrgs,
} from './github-orgs';

/**
 * The capability deny list (#584), in the two shapes the guard's own setting
 * puts it in. One function rather than two branches of copied parsing, so the
 * name check and the mismatch check read the same list.
 */
const denyList = (enforcing: boolean) =>
  Joi.string()
    .allow('')
    .custom((value: string, helpers) => {
      const named = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // `{{#label}}` is what makes the message name the key — `"PORT" must be a
      // number` is the shape every other bad value on this board fails in, and
      // naming the key is the whole reason this lives in Joi rather than in the
      // provider factory. Without it the boot dies on a bare `names no such
      // capability: …` and an operator has to guess which setting said it.
      const bogus = named.filter((s) => !isCapability(s));
      if (bogus.length) {
        return helpers.message({
          custom: `{{#label}} names no such capability: ${bogus.join(', ')}`,
        });
      }
      if (!enforcing && named.length) {
        return helpers.message({
          custom:
            `{{#label}} denies ${named.join(', ')} while CAPABILITY_GUARD_ENFORCING is false, ` +
            'so the board would report the refusal and make the write anyway — ' +
            'set CAPABILITY_GUARD_ENFORCING=true, or clear {{#label}}',
        });
      }
      return value;
    }, 'capability names');

// Rename complete (#142 stage 5): BOARD_* is the sole, canonical env prefix.
// The transitional OVERVIEW_* → BOARD_* alias shim was removed; BOARD_* keys are
// set directly as platform service variables.
export const configValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  // Baked into the image at build time (`--build-arg APP_VERSION=<tag>`) so a
  // deploy can assert the correct image is live. Absent in local and dev builds,
  // and both readers answer `null` for that, so it carries no default here.
  // `.allow('')` because an undeclared key reached its readers empty and they
  // answered `null` for that too; declaring it must not start refusing a boot
  // over a value that already had an answer (#1244 review).
  APP_VERSION: Joi.string().allow('').optional(),
  PORT: Joi.number().default(3000),

  // Dev-only: skip token validation so the board can be browsed without an OAuth flow.
  // Refused outright once MCP is on (#456): JwtAuthGuard short-circuits to a stub
  // user and returns true before anything else runs — including the grant check —
  // so the pair would publish an MCP endpoint with no authentication at all. That
  // gap predates #456; the lock lands here because its twin below is one line away.
  //
  // Refused again once Github writes are on (#774), and for a reason the MCP rule
  // does not cover. `IDENTITY_SOURCE=db` buys a trail that RECORDS; this buys a
  // trail that records the RIGHT NAME. With auth off the guard stamps every
  // request `DEV_USER_EMAIL` (`jwt-auth.guard.ts`), so `PrismaAuditRepository`
  // writes a full log in which every write on the shared Github credential
  // belongs to the `DEV_USER_EMAIL` stub — one fake person. That is worse than the empty
  // log #774 was filed on: an empty log is ambiguous and invites the question, a
  // full one naming a person is believed.
  //
  // Both `.when()`s chained, not merged: joi concatenates the matched branches,
  // and with both keys on it reports the LAST match — so the operator reads the
  // write message. Same order and same reasoning as IDENTITY_SOURCE below, and
  // the remedy is identical either way (`AUTH_DISABLED=false`). Checked against
  // joi 17 with each key on alone and with both (2026-09-01).
  AUTH_DISABLED: Joi.boolean()
    .default(false)
    .when('BOARD_MCP_ENABLED', {
      is: true,
      then: Joi.boolean().valid(false).messages({
        'any.only': 'AUTH_DISABLED must be false when BOARD_MCP_ENABLED=true',
      }),
    })
    .when('GITHUB_WRITE_ENABLED', {
      is: true,
      then: Joi.boolean().valid(false).messages({
        'any.only': 'AUTH_DISABLED must be false when GITHUB_WRITE_ENABLED=true',
      }),
    }),
  // Identity assigned to the stub user when AUTH_DISABLED (drives the local gate).
  DEV_USER_EMAIL: Joi.string().email().default('dev@example.com'),
  CORS_ORIGIN: Joi.string().default('*'),

  // GitHub-only sign-in gate (#1450). Empty admits every GitHub user. Otherwise
  // each comma-separated entry is a numeric GitHub user id, a plain login, or an
  // `org:`-prefixed organisation login. A numeric id admits that account; a
  // login is resolved to its id once and admits the account that owns it, so a
  // rename does not change the answer; an org admits its `active` members.
  BOARD_ALLOWED_GITHUB: Joi.string()
    .allow('')
    .default('')
    .custom((value: string, helpers) => {
      const bad: string[] = [];
      for (const entry of value.split(',')) {
        const item = entry.trim();
        if (!item) continue;
        const isOrg = item.toLowerCase().startsWith('org:');
        const name = isOrg ? item.slice(4).trim() : item;
        // Numeric ids, and GitHub logins (letters, digits and single hyphens).
        if (!/^[0-9]+$/.test(name) && !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name)) bad.push(item);
      }
      if (bad.length) {
        return helpers.message({
          custom: `{{#label}} names invalid GitHub ids, logins or organisations: ${bad.join(', ')}`,
        });
      }
      return value;
    }, 'github allow list'),
  // Board admins in fixture mode (#143): a comma-separated list of GitHub logins
  // standing in for the stored board roles used when IDENTITY_SOURCE=db.
  BOARD_FIXTURE_ADMINS: Joi.string().allow('').default(''),
  ADMIN_CACHE_TTL_MS: Joi.number().default(300000),

  BOARD_BASE_URL: Joi.string().uri().default('http://localhost:5173'),
  // Signs UI sessions AND MCP access tokens — a forgeable secret means
  // forgeable full-authority tokens, so require a real one once MCP is on.
  BOARD_SESSION_SECRET: Joi.string()
    .allow('')
    .default('dev-insecure-session-secret-change-me')
    .when('BOARD_MCP_ENABLED', {
      is: true,
      then: Joi.string()
        .min(16)
        .disallow('')
        .invalid('dev-insecure-session-secret-change-me')
        .required()
        .messages({
          'any.invalid': 'BOARD_SESSION_SECRET must not be the default when BOARD_MCP_ENABLED=true',
          'any.required': 'BOARD_SESSION_SECRET must be set when BOARD_MCP_ENABLED=true',
        }),
    }),
  // Agent bearer tokens: comma-separated `name:secret`, secret = 64 hex chars
  // (openssl rand -hex 32). Empty ⇒ no agent access. Malformed ⇒ boot fails.
  BOARD_AGENT_TOKENS: Joi.string()
    .pattern(/^\s*$|^\s*[A-Za-z0-9_-]+\s*:\s*[0-9a-fA-F]{64}\s*(,\s*[A-Za-z0-9_-]+\s*:\s*[0-9a-fA-F]{64}\s*)*$/)
    // The message is not decoration and MUST NOT interpolate the value (#584,
    // PR #609 security re-review). Joi's default `string.pattern.base` reads
    // `"X" with value "…" fails to match the required pattern: /…/`, and the
    // value here is the WHOLE list: an operator who fats one colon adding a
    // second agent token would get a boot failure printing every OTHER agent's
    // well-formed 64-hex bearer secret to stderr, which is what the platform
    // deploy log keeps. `string.pattern.base` is one of only four Joi defaults
    // that echo the value, and all four come from `.pattern()` — which is why
    // the rule is "a pattern on a secret carries its own message", not "check
    // every rule".
    .message(
      'BOARD_AGENT_TOKENS must be a comma-separated list of `name:secret`, ' +
        'each secret 64 hex characters (openssl rand -hex 32). The value is not ' +
        'echoed here: a list that failed to parse still holds every other agent’s secret.',
    )
    .allow('')
    .default(''),
  // Remote MCP endpoint + OAuth AS. Off by default; enable per environment.
  BOARD_MCP_ENABLED: Joi.boolean().default(false),

  // GitHub (required only for live source). A fine-grained PAT is the simplest
  // option; the GitHub App fields are an alternative.
  //
  // The org(s) this board serves, comma-separated (#647). It is MACHINE scope
  // and nothing else (#1209 part 4): the paths where no person is acting read it
  // — the boot warms, the capability probe, derived logins on their timer, the
  // boot alert and the write-identity announce. A personal request never reads
  // it; a person's owners come from their own Github App grants.
  //
  // Four per-surface keys used to narrow it — `ISSUES_METRICS_ORG`,
  // `ISSUE_BUCKETS_ORG`, `PROJECTS_OWNER` and `DELIVERY_OWNER`. All four are
  // retired and none is declared here any more. On a personal request they
  // intersected the person's own grants, so an operator could narrow what a
  // person saw of access that was already theirs, and the approved design
  // removes that ceiling. `config/retired-settings.ts` names them and reports a
  // deployment that still sets one; `allowUnknown` leaves the value alone, so
  // the boot does not die on a key it no longer needs.
  //
  // Validated by RUNNING the parser every reader uses, so the rule and the
  // reading cannot drift: a `.pattern()` that accepted a string `parseGithubOrgs`
  // read differently would be the copies problem again, one layer up. The value
  // is a public org login, so echoing it in a failure is fine — the no-echo rule
  // above is scoped to secrets.
  //
  // That parser also folds REPEATS, case-insensitively: Github logins are
  // case-insensitive, so `acme,Acme` names ONE org and is read once
  // (#718). The spelling that survives is the FIRST one written here, since that
  // is what every surface displays and what `?org=` answers in. Unfolded, a
  // surface reading per org and summing the answers counted that org twice —
  // on Repos every alert count and every Actions dollar doubled — and nothing
  // said the list had repeated itself.
  //
  // REQUIRED, with no default (#1175). It carried one org login and then another,
  // and the rename between them was invisible for a day because Github redirects
  // a repository path and only an ORGANISATION lookup fails. A board that names
  // no organisation now refuses to boot and says which setting to add, which is
  // what `parseGithubOrgs` has done since #647 for a value that parses to no
  // org. The deployment that never set the key was in the same position and was
  // the one being handed a guess.
  GITHUB_ORGS: Joi.string()
    .custom((value: string) => {
      parseGithubOrgs(value);
      return value;
    })
    .required()
    .messages({ 'any.required': GITHUB_ORGS_UNSET }),
  GITHUB_TOKEN: Joi.string().allow('').default(''),
  // #584 — the separate write credential. UNSET everywhere today, and unset
  // means "use GITHUB_TOKEN", so leaving it alone is what every deployment does
  // and nothing about it has changed.
  //
  // What setting it moves, since #625: EVERY Github mutation this board makes.
  // The nine issue-detail writes — `setState` and the `close` that shares its
  // call, assignees, labels, milestone, the task toggle and the four Projects
  // v2 mutations — go out through that source's `'write'` client; `repo.dri`
  // and the boot alert build their own. The reads keep
  // GITHUB_TOKEN, including the reads a write method makes first.
  // `issue-detail/write-credential.spec.ts` measures which credential each call
  // carries, on the wire.
  //
  // So this credential needs write permission on everything the board writes,
  // and setting it no longer costs the board its probed refusals: the boot probe
  // (`capability.registry.ts`, `probe()`) reads THIS token's scopes and seeds
  // credential-wide verdicts that are now true of the writes, because the writes
  // ride it. Before #625 it declined to seed anything at all once the two
  // differed.
  //
  // No shape is asserted beyond a string: Github issues five kinds of
  // credential and this board is not the place that decides which are legal.
  GITHUB_WRITE_TOKEN: Joi.string().allow('').default(''),
  GITHUB_APP_ID: Joi.string().allow('').default(''),
  GITHUB_PRIVATE_KEY: Joi.string().allow('').default(''),
  GITHUB_INSTALLATION_ID: Joi.string().allow('').default(''),

  // Break-glass admin recovery (#143, #332, #371). Admins are board-assigned
  // roles — people whose stored role is `admin`, edited in Admin › Access. The
  // Google group decides membership only, never who administers.
  //
  // This comma-separated list is NOT unioned on top of those. It is DORMANT: it
  // grants admin only while no assigned admin can SIGN IN, and goes inert the
  // moment one can. So it recovers an admin set nobody can use — a fresh
  // database, every admin demoted, or the last one leaving the team group (#591)
  // — and is inert the rest of the time. To leave that state, assign the Admin
  // role to yourself in Admin › Access, then unset this.
  //
  // "Can sign in" is judged against the same team roster the sign-in gate uses,
  // so an assigned admin who has left the group no longer holds this dormant. A
  // roster read that failed, or an admin roster that has never been read, leaves
  // it dormant too (#588), so an outage cannot hand the board to whoever is
  // named here.
  //
  // Setting it is not sufficient on its own: production runs
  // BOARD_GROUP_SOURCE=directory, so an address outside the team group is still
  // refused at sign-in. The Access panel flags anyone admin only via this list.
  BOARD_ADMIN_EMAILS: Joi.string().allow('').default(''),

  // Issue-flow metrics (#120). `github` ingests issues via the GitHub creds
  // above; `fixture` runs local. The raw list is cached for
  // ISSUES_METRICS_CACHE_TTL_MS (issue lists are heavy).
  ISSUES_SOURCE: Joi.string().valid('github', 'fixture').default('github'),
  // Scope of the ingest. `github` enumerates every non-archived, non-fork repo
  // with issues in every owner the scope covers (#257 — the team's
  // throughput/aging/load are org-wide, matching the already-org-wide Issues
  // buckets, since members work across many repos, not just board + the product repo).
  // That scope is the acting person's own Github App grants, or GITHUB_ORGS when
  // no person is acting. `ISSUES_METRICS_ORG` used to narrow it, and
  // `ISSUES_METRICS_REPOS` used to replace it with a fixed repository list; both
  // are retired (#1209 part 4), and neither is declared here. The Repos map
  // shares the scope and reads all of it too, one read per owner, an owner that
  // fails costing its own rows rather than the page (#718) — see
  // `github-repos.source.ts`.

  // Deriving a member's Github handle from commit authorship (#535). The map is
  // warmed in the background, never on a request — INTERVAL is how stale it may
  // get, and RPM paces the searches against Github's 30-a-minute search bucket
  // (unrelated to core's 5000/hour, and this is its only consumer).
  GITHUB_LOGIN_DERIVATION_INTERVAL_MS: Joi.number().default(43_200_000),
  GITHUB_LOGIN_DERIVATION_RPM: Joi.number().default(20),
  GITHUB_LOGIN_DERIVATION_MAX_MEMBERS: Joi.number().default(200),
  ISSUES_METRICS_CACHE_TTL_MS: Joi.number().default(600000),
  // The Github webhook store (#1007, V5). Unset, which is the default, the
  // webhook endpoint answers 404 and no read touches the store: every issue list
  // is read from Github as before. Set, it is the App's webhook secret, twenty
  // characters at least because it is the only key to a public endpoint, and
  // none of them whitespace, so a run of spaces cannot satisfy the length and
  // pass for a secret (#1070). Setting it also makes GITHUB_STORE_DATABASE_URL
  // required rather than defaulted to DATABASE_URL, so forgetting the URL fails
  // the boot instead of quietly putting Github data in the identity database.
  GITHUB_WEBHOOK_SECRET: Joi.string()
    .allow('')
    .pattern(/^(|\S{20,})$/)
    .default('')
    .messages({ 'string.pattern.base': 'GITHUB_WEBHOOK_SECRET must be at least 20 characters with no whitespace' }),
  GITHUB_STORE_DATABASE_URL: Joi.string()
    .allow('')
    .default('')
    .when('GITHUB_WEBHOOK_SECRET', {
      is: Joi.string().min(1),
      then: Joi.string().disallow('').required().messages({
        'any.invalid': 'GITHUB_STORE_DATABASE_URL must be set when GITHUB_WEBHOOK_SECRET is set',
        'any.required': 'GITHUB_STORE_DATABASE_URL must be set when GITHUB_WEBHOOK_SECRET is set',
      }),
    }),
  // How long one full Github read of a repository may answer from the store
  // before the next read goes to Github again. It is the bound on how stale a
  // missed delivery can leave an issue, since Github never redelivers a failed
  // delivery by itself. Capped at a day, so nobody can raise it into "never"
  // without changing this line.
  ISSUES_STORE_MAX_AGE_MS: Joi.number().integer().min(60_000).max(86_400_000).default(3_600_000),
  // Labels marking issues that are long-lived BY DESIGN. The metrics keep these
  // out of the flow "problem" views (aging, load, the open headline) and track
  // them as their own category instead.
  LONG_LIVED_LABELS: Joi.string().default('discovery'),

  // Dashboard Issues block (#185). Org-wide open/bugs/feedback/unassigned counts
  // via cheap GitHub search totals (reuses ISSUES_SOURCE: `fixture` runs local).
  // Cached for ISSUE_BUCKETS_CACHE_TTL_MS — short, since the block advertises a
  // near-live "Synced" stamp.
  // The block counts every owner in scope in one search query — the acting
  // person's Github App grants, or GITHUB_ORGS with no person acting.
  // `ISSUE_BUCKETS_ORG` used to narrow it and is retired (#1209 part 4).
  // `bucketScope` still refuses an empty scope, which is now a person whose
  // grants cover nothing rather than a pinned key.
  ISSUE_BUCKETS_CACHE_TTL_MS: Joi.number().default(60000),

  // In-board issue page (#235): one issue + its thread, fetched on demand
  // (reuses ISSUES_SOURCE: `fixture` runs local). The thread is capped and each
  // issue cached for a short TTL like the buckets.
  ISSUE_COMMENTS_MAX: Joi.number().default(100),
  ISSUE_DETAIL_CACHE_TTL_MS: Joi.number().default(60000),

  // The old in-product feedback form (#213, removed by #1450) filed submissions
  // into FEEDBACK_REPO under FEEDBACK_LABELS. Those issues stay on Github, and
  // these two settings keep them hidden from static agent tokens.
  // REQUIRED, with no default, and with no flag in front of it (#1175).
  // `feedbackScopeFrom` builds the submission-visibility rule in five service
  // constructors on every boot. An absent value could not mean "no feedback
  // repository". It would mean the visibility rule matches no issue, and a
  // person's own first line becomes an ordinary title on the queues.
  // Optional overrides; otherwise destinations are resolved and persisted in the background.
  FEEDBACK_REPO_ID: Joi.number().integer().positive().max(Number.MAX_SAFE_INTEGER),
  BOOT_ALERT_REPO_ID: Joi.number().integer().positive().max(Number.MAX_SAFE_INTEGER),
  FEEDBACK_REPO: Joi.string().required().messages({ 'any.required': FEEDBACK_REPO_UNSET }),
  // Comma-separated, and it must name at least one label. These two settings are
  // also what tells a READ which issues are somebody else's words (#497), so a
  // value that parses to nothing — `'   '`, `','`, `',,'` all used to validate —
  // would switch that off for the old submissions. The pattern
  // demands one character that is neither a comma nor whitespace;
  // `feedbackScopeFrom` refuses the same values again at boot, because a value
  // reaching the service from anywhere but this schema must fail the same way.
  FEEDBACK_LABELS: Joi.string()
    .pattern(/[^\s,]/)
    .message('FEEDBACK_LABELS must name at least one label, e.g. `feedback`')
    .default('feedback'),

  // Where a boot that found something wrong files its report (#592), DECLARED
  // here since #1175 — it was the one of the three repo settings the schema
  // never knew about, so its only default lived in the notifier and nothing at
  // boot could see it. Required when the board can write and absent otherwise:
  // `reportBootErrors` returns before anything else unless GITHUB_WRITE_ENABLED
  // is on and a credential exists, so a board that cannot write has nothing to
  // name. There is no BOOT_ALERT_ENABLED; the write flag is the whole switch.
  BOOT_ALERT_REPO: Joi.string()
    .when('GITHUB_WRITE_ENABLED', { is: true, then: Joi.required(), otherwise: Joi.optional() })
    .messages({ 'any.required': BOOT_ALERT_REPO_UNSET }),
  // An empty label disables alerts; an explicitly empty assignee files unassigned.
  // An absent assignee must fail startup rather than silently select a person.
  BOOT_ALERT_LABEL: Joi.string().allow('').default('boot-error'),
  BOOT_ALERT_ASSIGNEE: Joi.string().allow('')
    .when('GITHUB_WRITE_ENABLED', {
      is: true,
      then: Joi.when('BOOT_ALERT_LABEL', {
        is: Joi.string().pattern(/\S/).required(),
        then: Joi.required(),
      }),
    })
    .messages({
      'any.required': 'BOOT_ALERT_ASSIGNEE is not set; cannot assign boot alerts. ' +
        'Set BOOT_ALERT_ASSIGNEE to the Github login responsible for boot alerts, ' +
        'or set BOOT_ALERT_LABEL to an empty string to disable boot alerts.',
    }),

  // Cross-system identity store (#11). `db` = Postgres via Prisma (editable in
  // the Access panel, seeded from people-aliases.ts); `fixture` = the read-only
  // file (dev/test without a DB). Prisma reads DATABASE_URL directly (not via
  // ConfigService); it is declared here only so boot validation flags a `db`
  // deployment that forgot to set it.
  // Turning MCP on forces `db` (#456): board's OAuth server keeps its grants,
  // access tokens and refresh tokens in Postgres, and on the in-memory seam every
  // restart would silently invalidate every token it had minted. `.invalid(...)`
  // rather than `.valid('db')`, because Joi merges valid-value sets as a UNION —
  // `.valid('db')` lets `fixture` survive from the base, which is the whole case
  // this rule exists to block. Same reason the BOARD_SESSION_SECRET rule above
  // subtracts its bad value. Under the { abortEarly: false } app.module.ts boots
  // with, a `fixture` value reports `any.only` and `any.invalid` together, so all
  // three keys carry the same text and the operator reads one line.
  IDENTITY_SOURCE: Joi.string()
    .valid('db', 'fixture')
    .default('fixture')
    .when('BOARD_MCP_ENABLED', {
      is: true,
      then: Joi.string().invalid('fixture').required().messages({
        'any.only': 'IDENTITY_SOURCE must be db when BOARD_MCP_ENABLED=true',
        'any.invalid': 'IDENTITY_SOURCE must be db when BOARD_MCP_ENABLED=true',
        'any.required': 'IDENTITY_SOURCE must be db when BOARD_MCP_ENABLED=true',
      }),
    })
    // Turning Github writes on forces `db` too (#774), for the same reason and by
    // the same construction as the MCP rule above. Board writes Github under ONE
    // shared credential, so the audit trail is the only thing that turns a write
    // back into the person who asked for it, and that trail follows this key and
    // nothing else — `audit.module.spec.ts` pins which store each value gets.
    // Refusing to boot rather than warning, because the Admin log is where an
    // operator looks and an empty one there is indistinguishable from a board
    // nobody has used yet. `AUTH_DISABLED` above carries the other half.
    //
    // Message order with both flags on: `config.schema.spec.ts` asserts it.
    .when('GITHUB_WRITE_ENABLED', {
      is: true,
      then: Joi.string().invalid('fixture').required().messages({
        'any.only': 'IDENTITY_SOURCE must be db when GITHUB_WRITE_ENABLED=true',
        'any.invalid': 'IDENTITY_SOURCE must be db when GITHUB_WRITE_ENABLED=true',
        'any.required': 'IDENTITY_SOURCE must be db when GITHUB_WRITE_ENABLED=true',
      }),
    }),
  // Required when IDENTITY_SOURCE=db: PrismaClient reads it at construction and
  // throws without it, which would take the WHOLE service down (not just the
  // identity feature) — so fail fast at boot with a clear message instead.
  DATABASE_URL: Joi.string()
    .allow('')
    .default('')
    .when('IDENTITY_SOURCE', {
      is: 'db',
      then: Joi.string().disallow('').required().messages({
        'any.invalid': 'DATABASE_URL must be set when IDENTITY_SOURCE=db',
        'any.required': 'DATABASE_URL must be set when IDENTITY_SOURCE=db',
      }),
    }),

  // Projects surface: a read-only mirror of the org's GitHub Projects (v2) boards.
  // `github` reads them over GraphQL from the owners in scope (needs project read scope
  // on the token/App); `fixture` runs local. Rollup cached for the TTL.
  PROJECTS_SOURCE: Joi.string().valid('github', 'fixture').default('fixture'),
  // Which owners' Projects (v2) boards are surfaced: the acting person's Github
  // App grants, or GITHUB_ORGS with no person acting. The surface reads each and
  // unions the boards, and `?org=` narrows a read to one of them.
  // `PROJECTS_OWNER` used to narrow it and is retired (#1209 part 4).
  // `ProjectsService.mustHaveScope` still refuses an empty scope, which is now a
  // person whose grants cover nothing rather than a pinned key.
  // A FLOOR, because this key stopped being only a cache window (#713).
  // `ProjectsService` measures the retiree ceiling as `RETIREE_MAX_TTLS` of it —
  // the fallback that serves the boards from before a write when the read after
  // it meets a Github outage — so `PROJECTS_CACHE_TTL_MS=0` made that ceiling
  // `3 * 0`, refusing every retiree the millisecond it existed. That is the
  // #713 fallback switched off, at boot, with nothing in the log saying so.
  //
  // ONE MINUTE, which is where two arguments already in the tree meet. It is the
  // shortest TTL at which the three-TTL ceiling still covers the failure the
  // retiree exists for — `RETIREE_MAX_TTLS` prices a secondary rate limit at
  // under a minute — and it is roughly where the ordinary refresh stops fitting
  // the budget: a board-list walk is 63 Projects-v2 points against 5,000/hour
  // (`stale-on-write.ts`), so one org alone spends ~3,780 of them at this floor
  // and would be over the whole budget at half of it.
  PROJECTS_CACHE_TTL_MS: Joi.number().integer().min(60000).default(300000),
  // How long a last-good Projects answer may stand in for a failing read. Two
  // hours, chosen off a Github GraphQL point budget that resets hourly, so a
  // ceiling under an hour would expire inside the outage it covers. Declared
  // rather than only read, so the value reaches the reader as a number.
  PROJECTS_LAST_GOOD_MAX_MS: Joi.number().default(7200000),

  // Repos map (#472): every repo the issue ingest reads, with its queue trend
  // and its CODEOWNERS owner. The counts are a rollup of that same ingest, so
  // there is no source toggle of its own — it follows ISSUES_SOURCE, and its
  // scope follows the owner scope above. Only the repo
  // list and the CODEOWNERS reads cost a call, and both are cached: the map on
  // the short TTL, CODEOWNERS on a much longer one, since owners change roughly
  // never and re-reading three paths across ~70 repos is the expensive part.
  // "Sync now" (#301) drops both regardless of TTL.
  REPOS_CACHE_TTL_MS: Joi.number().default(600000),

  // Delivery stream (#173 Phase 2): the dashboard's cross-repo "what shipped"
  // feed + the org-wide unassigned-PR counter. `github` reads the owners in scope over
  // GraphQL (recent merged PRs + latest release tags + unassigned-PR count in one
  // round-trip); `fixture` runs local. Rollup cached stale-while-revalidate.
  DELIVERY_SOURCE: Joi.string().valid('github', 'fixture').default('github'),
  // The feed reads every owner in scope and unions them, one owner's failure
  // costing that owner rather than the feed: the acting person's Github App
  // grants, or GITHUB_ORGS with no person acting. `DELIVERY_OWNER` used to
  // narrow it and is retired (#1209 part 4). `DeliveryService.rollups` still
  // refuses an empty scope, which is now a person whose grants cover nothing
  // rather than a pinned key.
  DELIVERY_CACHE_TTL_MS: Joi.number().default(600000),

  // Master gate for GitHub write-back; surfaced as a diagnostic in the Access
  // panel so operators can see when board writes are globally disabled.
  // Turning it on REQUIRES IDENTITY_SOURCE=db AND AUTH_DISABLED=false (#774) —
  // both rules live on those keys above, next to the MCP ones they copy, so both
  // readings of "what forces a database" and "what forces real logins" are each
  // in one place.
  //
  // The `boolean.base` message is overridden because this key is the one #774
  // makes an operator touch, and joi's default (`"GITHUB_WRITE_ENABLED" must be
  // a boolean`) says nothing about what it is coupled to. `1`, `yes`, `on` and
  // an empty value all land here — `1` being the common container idiom — and
  // they are REFUSED rather than accepted: widening the truthy set is a
  // schema-wide decision, and doing it for this key alone would boot on
  // `GITHUB_WRITE_ENABLED=1` while still refusing `BOARD_MCP_ENABLED=1` beside
  // it. Widening it schema-wide would turn `AUTH_DISABLED=1` from a refused boot
  // into a board with no authentication, which is exactly the failure the rule
  // above exists to stop. So the value stays strict and the message carries the
  // coupling.
  GITHUB_WRITE_ENABLED: Joi.boolean().default(false).messages({
    'boolean.base':
      'GITHUB_WRITE_ENABLED must be `true` or `false` — not `1`, `yes`, `on` or an empty value. ' +
      'Setting it to `true` also requires IDENTITY_SOURCE=db and AUTH_DISABLED=false (#774): ' +
      'board writes Github under one shared credential, and the audit trail is the only record ' +
      'of which person a write belongs to.',
  }),

  // Operator kill-switch and the declared capability source (#584). A DENY list
  // only: an allow list would widen the board's reach by configuration, and a
  // deny list can only narrow it, so the worst a bad entry can do is refuse a
  // write. Comma-separated capability names. GITHUB_WRITE_ENABLED=false still
  // means deny-all.
  //
  // Validated HERE rather than in the provider factory. Both places abort the
  // boot on a bad value — a schema failure and a factory throw both happen
  // inside NestFactory.create, before main.ts reaches `listen`, so neither is
  // reported through the #592 boot-alert path. What Joi buys is the failure
  // MESSAGE: a schema error names the env key and the offending value, the same
  // way every other bad config value on this board fails, where a factory throw
  // is a DI stack trace. A kill-switch that quietly switches off nothing is
  // worse than no kill-switch, so a typo must not be allowed to boot either way.
  //
  // A deny list is also refused while CAPABILITY_GUARD_ENFORCING is false. That
  // pair is the kill-switch that is not one: the registry reports the capability
  // `refused`, /api/auth/me carries that to the browser and the control
  // disappears, and the write still lands, because the guard logs and returns
  // true. An operator would be shown a switch that switched nothing off.
  // Refusing to boot is the smallest and loudest answer to that.
  GITHUB_CAPABILITIES_DENY: Joi.string()
    .allow('')
    .default('')
    .when('CAPABILITY_GUARD_ENFORCING', {
      // A ref, so Joi orders the two keys and this reads the CONVERTED value —
      // `process.env` carries the string 'true', never the boolean.
      is: Joi.boolean().valid(true).required(),
      then: denyList(true),
      otherwise: denyList(false),
    }),

  // Whether CapabilityGuard refuses or only reports (#584). It was false for the
  // two tasks between the guard being registered and being switched on; task 8
  // flipped this default and nothing else. Setting it to false puts the board
  // back into reporting mode — every refusal is logged and every write still
  // lands, which is a diagnostic state and not a safe one to leave a deployment
  // in.
  //
  // Two ways that rollback takes the service DOWN instead, both measured against
  // `node dist/main.js`. Write the word: `true` and `false` in any case are the
  // only values this accepts, and `0`, `off`, `no` and an empty string each die
  // on a Config validation error naming CAPABILITY_GUARD_ENFORCING and saying
  // it must be a boolean, thrown out of ConfigModule.forRoot before an app can
  // start. And clear GITHUB_CAPABILITIES_DENY in the same change — the rule
  // above refuses a non-empty deny list while this is false, so a rollback that
  // touches only this key does not boot either.
  CAPABILITY_GUARD_ENFORCING: Joi.boolean().default(true),
  GITHUB_USER_APP_CLIENT_ID: Joi.string().empty(''),
  GITHUB_USER_APP_CLIENT_SECRET: Joi.string().empty(''),
  // Public App slug for the first installation link. Optional: an existing
  // installation can supply it; when neither is known, the link is unavailable.
  GITHUB_USER_APP_SLUG: Joi.string().empty('').custom((value: string, helpers) => {
    if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) return value;
    return helpers.message({
      custom:
        '{{#label}} must be a Github App slug — letters, digits and hyphens, as it appears in ' +
        'https://github.com/apps/SLUG — not a URL and not the App display name',
    });
  }),
  BOARD_CREDENTIAL_KEY: Joi.string().empty('').custom((value, helpers) => {
    const key = Buffer.from(value, 'base64');
    return key.length === 32 && key.toString('base64') === value ? value : helpers.message({ custom: 'BOARD_CREDENTIAL_KEY must encode exactly 32 bytes in canonical base64' });
  }),
}).and('GITHUB_USER_APP_CLIENT_ID', 'GITHUB_USER_APP_CLIENT_SECRET', 'BOARD_CREDENTIAL_KEY').custom((value, helpers) => {
  if (value.GITHUB_USER_APP_CLIENT_ID && (value.AUTH_DISABLED || value.IDENTITY_SOURCE !== 'db' || !value.DATABASE_URL)) {
    return helpers.message({ custom: 'Github user access requires AUTH_DISABLED=false, IDENTITY_SOURCE=db and DATABASE_URL' });
  }
  return value;
});

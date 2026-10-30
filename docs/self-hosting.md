# Self-hosting

This page tells you how to run the board for your own GitHub organisations. `board-service/.env.example` lists every setting with its reason. `board-service/src/config/config.schema.ts` checks them at start. A bad value stops the start and names the setting.

## 1. Make a GitHub App for sign-in

People sign in with a GitHub App. The board then reads GitHub with each person's own token.

1. In GitHub, open **Settings > Developer settings > GitHub Apps > New GitHub App**.
2. Set **Callback URL** to `<BOARD_BASE_URL>/api/auth/github/callback`.
3. Give the App read access to the data that the board shows: issues, pull requests, metadata and organisation projects.
4. Make a client secret.
5. Install the App on each organisation that the board reads.

Then set these values:

| Setting | Value |
| --- | --- |
| `BOARD_BASE_URL` | The public address of the board, for example `https://board.example.com` |
| `GITHUB_USER_APP_CLIENT_ID` | The App's client id |
| `GITHUB_USER_APP_CLIENT_SECRET` | The App's client secret |
| `BOARD_CREDENTIAL_KEY` | 32 random bytes in base64: `openssl rand -base64 32`. The service encrypts the stored tokens with it. |
| `GITHUB_USER_APP_SLUG` | Optional. The App's slug, for the "install on another organisation" link. |
| `AUTH_DISABLED` | `false` |
| `GITHUB_ORGS` | The organisation logins that the board reads when no person acts, comma-separated |
| `FEEDBACK_REPO` | The repository, as `owner/name`, whose old feedback submissions stay hidden from agent tokens. The service does not start without it. |

Set each `*_SOURCE` setting to `github` to read real data.

## 2. Decide who can sign in

`BOARD_ALLOWED_GITHUB` controls sign-in. An empty value lets every GitHub user sign in. Each person still sees only what GitHub lets them see.

Otherwise, give a comma-separated list. Each entry is one of:

| Entry | Who it lets in |
| --- | --- |
| `12345` | The GitHub account with that numeric user id |
| `octocat` | The account that owns that login now. The service keeps its id, so a later rename stays allowed. |
| `org:acme` | Every active member of the organisation `acme` |

Example: `BOARD_ALLOWED_GITHUB=octocat,12345,org:acme`.

The service checks the list at sign-in and again on later requests. It keeps an organisation membership answer for 60 seconds, so a removed member can keep access for up to 60 seconds.

## 3. Private boards

The board has no private flag of its own. GitHub decides:

- **A private board.** Make the GitHub Project or repository private. The board shows it only to people whose own GitHub token can read it. Nobody can make a board more open than GitHub makes it.
- **A private instance.** Set `BOARD_ALLOWED_GITHUB` (step 2). Only the listed people and organisation members can sign in.

The board has no public read-only link, and no roles of its own such as viewer or editor. GitHub roles cover this.

## 4. Databases

| Setting | Use | Needed when |
| --- | --- | --- |
| `DATABASE_URL` | People, board roles, the audit trail and the encrypted GitHub tokens | `IDENTITY_SOURCE=db`. Sign-in for more than one person needs this. |
| `GITHUB_STORE_DATABASE_URL` | The webhook store, and a cache of the resolved repository IDs | You turn on the webhook store |

The two URLs must name different databases. The service refuses to start when they name the same one. `docker-compose.yml` starts both for local use, on ports 5432 and 5433.

## 5. Webhooks (optional)

Without the webhook store, every issue list reads GitHub directly, and the service keeps a short cache.

To turn the store on:

1. Set `GITHUB_STORE_DATABASE_URL`.
2. Set `GITHUB_WEBHOOK_SECRET` to at least 20 characters with no whitespace.
3. In the GitHub App, set **Webhook URL** to `<BOARD_BASE_URL>/api/github/webhook` and use the same secret.

`ISSUES_STORE_MAX_AGE_MS` (default one hour) sets how long one full read of a repository can answer before the next read checks GitHub again.

If the webhook deliveries stop, the board can show old data with no time limit. The service logs a warning after three cache periods. Check the App's **Advanced > Recent deliveries** page when data looks old.

## 6. Writes to GitHub (optional)

Writes are off by default. To turn them on, set all of these:

- `GITHUB_WRITE_ENABLED=true`
- `IDENTITY_SOURCE=db` and `AUTH_DISABLED=false`. The service refuses to start without them.
- `GITHUB_WRITE_TOKEN`: the token of a machine user. GitHub shows this account as the author of every write. The board's audit trail records which person pressed the button.
- `BOOT_ALERT_REPO` and `BOOT_ALERT_ASSIGNEE`, where a failed start files its report.

To check the write account without a write, read the start log line, or `GET /api/admin/write-identity`.

## 7. Run it

The root `Dockerfile` builds the frontend image. It serves the app with Caddy and sends `/api`, `/mcp`, `/authorize` and `/token` to the service at `BOARD_API_UPSTREAM` (`deploy/Caddyfile.platform`). `deploy/board-api/Dockerfile` builds the service image. The service image applies the pending database migrations at each start.

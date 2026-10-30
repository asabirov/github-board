# Contributing

## Layout

`board-service/` and `board-frontend/` are two separate packages with their own lockfiles. There is no workspace root. Run `pnpm install` and every command inside the package that you change.

## Backend, in `board-service/`

```
pnpm test        # vitest; generates the Prisma client first
pnpm typecheck   # tsc --noEmit over src and the specs
pnpm build       # tsc -p tsconfig.build.json
pnpm start:dev   # tsx watch
```

`pnpm build` does not typecheck the spec files. If you change a `.spec.ts`, run `pnpm typecheck` before you push.

`pnpm test` does not run `src/**/*.db-spec.ts`. These specs need Postgres. They cover the Prisma stores, the migrations and two specs that start the whole app. Run them before you push a change to a route, a query or a migration:

```
docker compose up -d postgres    # from the repo root
pnpm run test:db                 # here, with DATABASE_URL exported
```

`test:db` does not read `.env`, so export `DATABASE_URL`. The value in `.env.example` points at the compose container. Each run migrates into its own schema and drops it after. If port 5432 is in use, set `POSTGRES_HOST_PORT` (and `STORE_POSTGRES_HOST_PORT` for `board-store-pg`) to a free port.

`start:dev` needs a `.env`. If you copy `board-service/.env.example` unchanged, the service runs on fixtures: no GitHub token and no database. To read real data, set one `*_SOURCE` to `github`. `.env.example` names the credentials that each source then needs.

## Frontend, in `board-frontend/`

```
pnpm build       # tsc -b && vite build
pnpm test        # vitest
pnpm dev         # vite
```

Only `pnpm build` typechecks the app, because vitest does not check types. Build before you push.

Put each API call in `src/api/<adapter>.ts`, in the adapter for its screen. The adapters share `src/api/core.ts`.

Most frontend tests run without a DOM. A green run does not prove that a screen works. For a change to a screen, open it in the browser and attach before and after screenshots to the pull request.

## Container images

Both images build from the repo root:

```
docker build -f deploy/board-api/Dockerfile -t board-api .   # the NestJS service
docker build -t board-web .                                  # the frontend behind Caddy
```

`board-api` runs `prisma migrate deploy` before it serves, so it needs Postgres and `DATABASE_URL`. The image has no `.env`, so it does not start on fixtures. Pass the fixture settings yourself:

```
-e ISSUES_SOURCE=fixture -e DELIVERY_SOURCE=fixture \
  -e GITHUB_ORGS=acme -e FEEDBACK_REPO=acme/board
```

The fixture data belongs to the organisation `acme`. With another `GITHUB_ORGS`, the Projects and delivery pages are empty. `--build-arg APP_VERSION=<tag>` sets the version that `GET /api/health` reports.

## Pull requests

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/), such as `feat(config): add Joi schema`.
- **Merges:** squash-merge. Do not force-push to a shared branch.
- **Tests:** add a test for a changed behaviour or a fixed bug. The test must fail without the change.
- **Screenshots:** attach them to the pull request. Do not commit them.
- **Docs:** `docs/` holds documents that describe the board as it works now. Keep plans and review records in the issue or the pull request.

There is no linter. `tsc` and the tests are the checks.

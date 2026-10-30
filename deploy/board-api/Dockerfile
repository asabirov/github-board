# board-api: the NestJS service image. The Docker context is the REPO ROOT.
#
# The Acme platform builds git services from the repo root and uses the
# service `path` only to locate the Dockerfile; `board-api` points at
# `deploy/board-api`. Every COPY below is therefore root-relative, and a local
# build names this file from the root:
#
#   docker build -f deploy/board-api/Dockerfile -t board-api .
#
# There was a second, subdir-relative copy under board-service/ until #691,
# kept in step by hand. Its comments had already drifted from this file's. Do
# not add one back: root context is the only context.

FROM node:22-slim AS build
WORKDIR /app
# Prisma's query/schema engines are dynamically linked against libssl.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY board-service/package.json board-service/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY board-service/tsconfig.json board-service/tsconfig.build.json ./
COPY board-service/prisma ./prisma
COPY board-service/prisma.config.ts ./prisma.config.ts
COPY board-service/src ./src
# Generate TypeScript into src/generated/prisma so tsc carries it into dist.
RUN pnpm exec prisma generate
RUN pnpm build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Baked release identity — the build may pass --build-arg APP_VERSION=<tag>.
# Surfaced at /api/health so a deploy can assert the correct image is live.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
# Prisma's CLI phones checkpoint.prisma.io on every invocation, including the
# entrypoint's `migrate deploy`. It forks and does not block boot, but it is a
# process and a DNS lookup this container has no use for.
ENV CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
# openssl for Prisma's migration engine (migrate deploy at boot). No corepack
# here: the entrypoint calls ./node_modules/.bin/prisma directly, so the boot
# path fetches nothing from the registry.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY board-service/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]

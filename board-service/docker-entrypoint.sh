#!/bin/sh
# Container entrypoint: bring the schema up to date before serving, then start.
# migrate deploy is idempotent (applies only pending migrations) and safe to run
# on every boot. The one persisted table is the cross-system identity store (#11);
# with IDENTITY_SOURCE=db it seeds from people-aliases.ts on first boot.
#
# Prisma runs from the local binary in node_modules, not through pnpm: corepack
# bakes no pnpm into the image, so `pnpm prisma ...` fetched the pnpm tarball
# from registry.npmjs.org on every boot. Each step is bracketed by a UTC
# timestamp so a pod log names the step a stuck boot is sitting in.
set -e

# A TERM landing mid-migration would otherwise wedge the schema: PID 1 gets no
# default disposition, the kernel drops the signal, and the SIGKILL that follows
# leaves `_prisma_migrations.finished_at` NULL, which fails every later boot on
# P3009 until somebody runs `prisma migrate resolve`. The trap alone does not do
# it — a POSIX shell defers a trap until the current FOREGROUND command returns,
# so the migrate call below runs in the background and this shell waits on it.
# Measured both ways in #689; `wait` still carries the child's status to `set -e`.
trap 'exit 143' TERM INT

log() {
  echo "[entrypoint] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

log "started"
log "migrations: applying..."
./node_modules/.bin/prisma migrate deploy &
wait $!
log "migrations: done"
# The second Postgres GITHUB_STORE_DATABASE_URL names (#1007, V5), brought up to
# the same schema whenever that URL is set. It carries every table and writes
# only its Github ones; docs/ops/github-webhook-store.md says why it is
# separate.
#
# The URL alone, and not the webhook secret with it. Two features share this
# database and different variables switch them on: the webhook receiver wants
# GITHUB_WEBHOOK_SECRET as well, while the destination bootstrap
# (github-destination-bootstrap.ts) wants only the URL. A store with a missing
# table fails at its first use, and nothing refuses that configuration at boot
# (#1158 review, B1). A migration this condition skips is one nothing else runs.
#
# A store that cannot be migrated does not stop the boot: board starts, finds
# the store unreadable, and reads every issue list from Github, as it does with
# the store off.
if [ -n "${GITHUB_STORE_DATABASE_URL:-}" ]; then
  log "store migrations: applying..."
  DATABASE_URL="$GITHUB_STORE_DATABASE_URL" ./node_modules/.bin/prisma migrate deploy &
  if wait $!; then
    log "store migrations: done"
  else
    log "store migrations: FAILED, starting anyway; issue lists are read from Github. A migration that failed part-way blocks every later one (P3009) until 'prisma migrate resolve' is run against the store; docs/ops/github-webhook-store.md"
  fi
fi
log "starting board-service on :${PORT:-3000}..."
exec node dist/main.js

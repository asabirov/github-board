# Platform (Acme) build for the board web front — a self-contained image.
#
# Builds the SPA and bakes it into a Caddy image that serves the SPA and
# reverse-proxies the API / MCP / OAuth paths to the board-api service. Build
# context is the repo root so it can reach both board-frontend/ (SPA source) and
# deploy/ (Caddyfile.platform).
#
# TLS is terminated by the platform ingress, so Caddy serves plain HTTP on :8080
# (see deploy/Caddyfile.platform). The board-api upstream is injected at runtime
# via BOARD_API_UPSTREAM.

# --- Stage 1: build the SPA ---
FROM node:22-slim AS spa
RUN corepack enable
WORKDIR /app
COPY board-frontend/package.json board-frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY board-frontend/ ./
RUN pnpm run build

# --- Stage 2: Caddy serving the SPA + proxying to board-api ---
FROM caddy:2
COPY deploy/Caddyfile.platform /etc/caddy/Caddyfile
COPY deploy/content-security-policy.caddy /etc/caddy/content-security-policy.caddy
COPY deploy/caddy-entrypoint.sh /usr/bin/board-caddy-entrypoint
ENTRYPOINT ["/bin/sh", "/usr/bin/board-caddy-entrypoint"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
COPY --from=spa /app/dist /srv/spa
EXPOSE 8080

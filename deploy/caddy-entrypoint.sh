#!/bin/sh
set -eu
# An origin is configuration, never a free-form CSP source list.
if [ -n "${BOARD_CSP_SCRIPT_ORIGIN:-}" ]; then
  if [ "${#BOARD_CSP_SCRIPT_ORIGIN}" -gt 261 ]; then
    echo 'BOARD_CSP_SCRIPT_ORIGIN must be one HTTPS origin with a valid hostname' >&2
    exit 1
  fi
  case "$BOARD_CSP_SCRIPT_ORIGIN" in
    *[!a-zA-Z0-9:/.-]*)
      echo 'BOARD_CSP_SCRIPT_ORIGIN must be one HTTPS origin without a path or port' >&2
      exit 1 ;;
  esac
  if ! printf '%s\n' "$BOARD_CSP_SCRIPT_ORIGIN" | LC_ALL=C grep -Eq '^https://[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$'; then
    echo 'BOARD_CSP_SCRIPT_ORIGIN must be one HTTPS origin without a path or port' >&2
    exit 1
  fi
fi
exec caddy "$@"

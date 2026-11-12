#!/usr/bin/env bash
# Nightly encrypted logical backup of the Supabase Postgres database to Cloudflare R2.
# Why: the Supabase FREE plan has no automatic backups (daily backups need Pro). This is the safeguard.
#
# Secrets live OUTSIDE the repo, in ~/.config/hex-expan/ (never printed, never committed):
#   backup.env          PG_URL (session-pooler URI of the database), R2_ACCOUNT_ID,
#                       R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
#   backup-passphrase   symmetric GPG passphrase (AES256). Losing it makes every backup unreadable.
set -euo pipefail

CONF_DIR="${HOME}/.config/hex-expan"
ENV_FILE="${CONF_DIR}/backup.env"
PASS_FILE="${CONF_DIR}/backup-passphrase"
LOG_DIR="${HOME}/.local/state/hex-expan"
LOG_FILE="${LOG_DIR}/nightly-db-backup.log"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
PROJECT_LABEL="${BACKUP_PROJECT_LABEL:-hex-expan-press}"

mkdir -p "$LOG_DIR"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"; }
fail() { log "FAILED: $*"; exit 1; }

[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ -f "$PASS_FILE" ] || fail "missing $PASS_FILE"
# pg_dump must be >= the server major (Supabase runs Postgres 17). Use the PGDG 17 client, not the distro 16 one.
PG_DUMP="${PG_DUMP:-/usr/lib/postgresql/17/bin/pg_dump}"
[ -x "$PG_DUMP" ] || fail "pg_dump 17 not installed at $PG_DUMP"
command -v rclone >/dev/null || fail "rclone not installed"
command -v gpg >/dev/null || fail "gpg not installed"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${PG_URL:?PG_URL not set in backup.env}" "${R2_ACCOUNT_ID:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_BUCKET:?}"

# rclone reads its remote from environment variables, so no rclone.conf with secrets is written to disk.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_ACL=private

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="${WORK}/${PROJECT_LABEL}-${STAMP}.dump.gpg"

# custom format = compressed, restorable with pg_restore; --no-owner/--no-acl keeps the restore portable.
timeout 900 "$PG_DUMP" --format=custom --no-owner --no-acl --compress=6 "$PG_URL" \
  | gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASS_FILE" \
        --symmetric --cipher-algo AES256 -o "$OUT" \
  || fail "dump or encrypt step failed"

BYTES="$(stat -c %s "$OUT")"
[ "$BYTES" -gt 1024 ] || fail "dump is suspiciously small (${BYTES} bytes)"

rclone copyto "$OUT" "r2:${R2_BUCKET}/${PROJECT_LABEL}/$(basename "$OUT")" --s3-no-check-bucket \
  || fail "upload to R2 failed"

# Retention: delete encrypted dumps older than RETENTION_DAYS. Only this project's prefix.
rclone delete "r2:${R2_BUCKET}/${PROJECT_LABEL}/" --min-age "${RETENTION_DAYS}d" || log "WARN: retention prune failed"

log "OK ${PROJECT_LABEL} ${STAMP} bytes=${BYTES}"

#!/usr/bin/env bash
# Nightly encrypted logical backup of the Supabase Postgres database to Cloudflare R2.
# Why: the Supabase FREE plan has no automatic backups (daily backups need Pro). This is the safeguard.
# Settings shared with the restore check live in backup-common.sh. Secrets live OUTSIDE the repo, in
# ~/.config/hex-expan/ (never printed, never committed): backup.env (PG_URL, R2_*) and backup-passphrase.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

LOG_DIR="${HOME}/.local/state/hex-expan"
LOG_FILE="${LOG_DIR}/nightly-db-backup.log"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$LOG_DIR"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"; }
fail() { log "FAILED: $*"; exit 1; }

# A retention of 0 would let the prune delete the dump this run just uploaded. Require at least the floor.
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -ge "$RETENTION_FLOOR_DAYS" ] \
  || fail "BACKUP_RETENTION_DAYS must be an integer >= ${RETENTION_FLOOR_DAYS}"
[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ -f "$PASS_FILE" ] || fail "missing $PASS_FILE"
[ -x "$PG_DUMP" ] || fail "pg_dump 17 not installed at $PG_DUMP"
command -v rclone >/dev/null || fail "rclone not installed"
command -v gpg >/dev/null || fail "gpg not installed"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${PG_URL:?PG_URL not set in backup env file}"
load_pg_env
resolve_remote
log "destination ${REMOTE}/${PROJECT_LABEL}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="${WORK}/${PROJECT_LABEL}-${STAMP}.dump.gpg"

# custom format = compressed, restorable with pg_restore; --no-owner/--no-acl keeps the restore portable.
# Scope and what is NOT dumped (Supabase-managed schemas; storage object bytes) are documented in backup-common.sh.
timeout "$DUMP_TIMEOUT_SECONDS" "$PG_DUMP" --format=custom --no-owner --no-acl --compress=6 "${SCHEMA_FLAGS[@]}" \
  | gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASS_FILE" \
        --symmetric --cipher-algo "$CIPHER_ALGO" -o "$OUT" \
  || fail "dump or encrypt step failed"

BYTES="$(stat -c %s "$OUT")"
[ "$BYTES" -gt "$MIN_DUMP_BYTES" ] || fail "dump is suspiciously small (${BYTES} bytes)"

# Integrity sidecar: the SHA-256 of the encrypted file, checked by verify-db-backup.sh after download.
SHA_FILE="${OUT}.sha256"
(cd "$WORK" && sha256sum "$(basename "$OUT")") > "$SHA_FILE"

for f in "$OUT" "$SHA_FILE"; do
  rclone copyto "$f" "${REMOTE}/${PROJECT_LABEL}/$(basename "$f")" --s3-no-check-bucket \
    || fail "upload of $(basename "$f") failed"
done

# Retention: delete encrypted dumps older than RETENTION_DAYS. Only this project's prefix.
rclone delete "${REMOTE}/${PROJECT_LABEL}/" --min-age "${RETENTION_DAYS}d" || log "WARN: retention prune failed"

log "OK ${PROJECT_LABEL} ${STAMP} bytes=${BYTES}"

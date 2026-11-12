# Shared settings for scripts/ops/nightly-db-backup.sh and scripts/ops/verify-db-backup.sh. SOURCED, never run.
# Holds no secrets and imports no app code. Importing app config loads .env, which is the leak fixed in 5ee9f4c,
# so cron must never load it. Values here are the single source for both scripts: change them once.

CONF_DIR="${HOME}/.config/hex-expan"
ENV_FILE="${BACKUP_ENV_FILE:-${CONF_DIR}/backup.env}"            # BACKUP_ENV_FILE: test runs only
PASS_FILE="${CONF_DIR}/backup-passphrase"
PROJECT_LABEL_DEFAULT="hex-expan-press"
PROJECT_LABEL="${BACKUP_PROJECT_LABEL:-$PROJECT_LABEL_DEFAULT}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/17/bin}"                    # pg_dump must be >= the server major (17)
PG_DUMP="${PG_DUMP:-${PG_BIN}/pg_dump}"

# Scope, one place only. public: app data. auth: accounts (its triggers call private.*). private: app helpers.
BACKUP_SCHEMAS=(public auth private)
SCHEMA_FLAGS=()
SCHEMA_SQL_IN=""
for s in "${BACKUP_SCHEMAS[@]}"; do
  SCHEMA_FLAGS+=("--schema=${s}")
  SCHEMA_SQL_IN+="'${s}',"
done
SCHEMA_SQL_IN="${SCHEMA_SQL_IN%,}"

CIPHER_ALGO=AES256
MIN_DUMP_BYTES=1024
DUMP_TIMEOUT_SECONDS=900
RETENTION_FLOOR_DAYS=1

# Connection details go into libpq environment variables, never onto a command line: argv is visible to every local
# user through `ps`, which would expose the database password. Call AFTER PG_URL is loaded.
load_pg_env() {
  local rest="${PG_URL#postgresql://}"
  local userpass="${rest%%@*}" hostdb="${rest#*@}"
  local hostport="${hostdb%%/*}" dbq="${hostdb#*/}"
  PGUSER="${userpass%%:*}"
  PGPASSWORD="${userpass#*:}"
  PGHOST="${hostport%%:*}"
  PGPORT="${hostport#*:}"
  PGDATABASE="${dbq%%\?*}"
  PGSSLMODE=require
  PGCONNECT_TIMEOUT=30
  PGOPTIONS="-c statement_timeout=600000"
  export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE PGSSLMODE PGCONNECT_TIMEOUT PGOPTIONS
}

# Call AFTER the env file is loaded. Sets REMOTE and, for R2, exports rclone's remote from env so no rclone.conf
# with secrets is written to disk. BACKUP_REMOTE sends the run somewhere else; it is refused unless BACKUP_TEST_MODE=1,
# so a production run can never be redirected by a stray variable.
resolve_remote() {
  if [ -n "${BACKUP_REMOTE:-}" ] && [ "${BACKUP_TEST_MODE:-}" != "1" ]; then
    echo "FAIL: BACKUP_REMOTE is set but BACKUP_TEST_MODE is not 1; refusing to redirect the backup" >&2
    exit 1
  fi
  REMOTE="${BACKUP_REMOTE:-r2:${R2_BUCKET:?R2_BUCKET not set}}"
  case "$REMOTE" in
    r2:*)
      : "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID not set}" "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID not set}" "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY not set}"
      export RCLONE_CONFIG_R2_TYPE=s3
      export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
      export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
      export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
      export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
      export RCLONE_CONFIG_R2_ACL=private
      ;;
  esac
}

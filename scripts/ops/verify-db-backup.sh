#!/usr/bin/env bash
# Restore check for the nightly backup. Downloads the newest encrypted dump, verifies its SHA-256 sidecar, decrypts it,
# restores it into a scratch PostgreSQL 17 server (unix socket only), then compares against the source:
#   1. schema: pg_dump --schema-only hash of source and restored (comments and restrict lines removed)
#   2. every table in the backup scope: row count AND an order-independent content hash (md5 over sorted row text)
# Exit 0 only if every check matches. Settings come from backup-common.sh, the same file the backup uses.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

WORK="$(mktemp -d)"
DATA="${WORK}/pgdata"
cleanup() {
  "${PG_BIN}/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ -f "$PASS_FILE" ] || fail "missing $PASS_FILE"
[ -x "$PG_DUMP" ] || fail "pg_dump 17 not installed at $PG_DUMP"
command -v rclone >/dev/null || fail "rclone not installed"
command -v gpg >/dev/null || fail "gpg not installed"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${PG_URL:?PG_URL not set}"
load_pg_env
resolve_remote

# 1. Fetch the newest dump and its checksum sidecar; verify the checksum before decrypting anything.
LATEST="$(rclone lsf "${REMOTE}/${PROJECT_LABEL}/" --include '*.dump.gpg' | sort | tail -n 1)"
[ -n "$LATEST" ] || fail "no dump under ${PROJECT_LABEL}/"
rclone copyto "${REMOTE}/${PROJECT_LABEL}/${LATEST}" "${WORK}/${LATEST}" --s3-no-check-bucket || fail "download failed"
rclone copyto "${REMOTE}/${PROJECT_LABEL}/${LATEST}.sha256" "${WORK}/${LATEST}.sha256" --s3-no-check-bucket || fail "checksum download failed"
(cd "$WORK" && sha256sum -c "${LATEST}.sha256" >/dev/null) || fail "SHA-256 of downloaded dump does not match the uploaded checksum"
echo "ok: downloaded ${LATEST}, checksum matches"

# 2. Decrypt.
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASS_FILE" -d -o "${WORK}/restore.dump" "${WORK}/${LATEST}" \
  || fail "decryption failed (wrong passphrase file?)"
echo "ok: decrypted"

# 3. Scratch server: unix socket only, nothing listens on the network.
"${PG_BIN}/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
"${PG_BIN}/pg_ctl" -D "$DATA" -o "-k ${WORK} -c listen_addresses=''" -l "${WORK}/pg.log" -w start >/dev/null
SCRATCH=(-h "$WORK" -U postgres)

# Supabase roles referenced by policies must exist before restore; they are NOLOGIN and hold no data.
psql "${SCRATCH[@]}" -d postgres -q -v ON_ERROR_STOP=1 -c "
  do \$\$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end \$\$;"
createdb "${SCRATCH[@]}" restored

# 4. Restore. Any error is a failure: a backup that restores with errors is not a verified backup.
# --clean --if-exists drops the empty default public schema that a fresh database always has, then recreates it from the dump.
if ! "${PG_BIN}/pg_restore" "${SCRATCH[@]}" -d restored --clean --if-exists --no-owner --no-acl --exit-on-error "${WORK}/restore.dump" 2>"${WORK}/restore.err"; then
  head -n 10 "${WORK}/restore.err" >&2
  fail "pg_restore reported errors"
fi
echo "ok: restored into scratch server with no errors"

# 5. Schema hash, source vs restored. Same scope flags as the backup.
schema_hash() { rg -v '^(--|\\(un)?restrict)' | sha256sum | cut -d' ' -f1; }
dump_schema() { "$PG_DUMP" --schema-only --no-owner --no-acl "${SCHEMA_FLAGS[@]}" "$@"; }
SRC_SCHEMA="$(dump_schema | schema_hash)"
DST_SCHEMA="$(dump_schema "${SCRATCH[@]}" restored | schema_hash)"
[ "$SRC_SCHEMA" = "$DST_SCHEMA" ] || fail "schema hash differs (source ${SRC_SCHEMA:0:12} vs restored ${DST_SCHEMA:0:12})"
echo "ok: schema hash matches (${SRC_SCHEMA:0:12})"

# 6. Table-by-table: row count and content hash. Rows are hashed as text and ordered, so row order cannot matter.
TABLES_SQL="select table_schema||'.'||table_name from information_schema.tables
            where table_schema in (${SCHEMA_SQL_IN}) and table_type='BASE TABLE' order by 1"
# timestamptz text depends on the session TimeZone. The source session is UTC, the scratch server takes the machine's
# zone, so the same instant would hash differently. Pin both sides to UTC so only the data is compared.
ROW_SQL_PREFIX="set timezone to 'UTC'; select count(*)::text || ' ' || coalesce(md5(string_agg(t::text, E'\n' order by t::text)), 'empty') from"

list_tables() { psql "$@" -tAq -c "$TABLES_SQL"; }
row_hash() { psql "$@" -tAq -c "${ROW_SQL_PREFIX} ${tbl} t"; }
src_tables="$(list_tables)"
dst_tables="$(list_tables "${SCRATCH[@]}" -d restored)"
[ "$src_tables" = "$dst_tables" ] || fail "table lists differ"

: > "${WORK}/src.rows"; : > "${WORK}/dst.rows"
while IFS= read -r tbl; do
  [ -n "$tbl" ] || continue
  src_line="$(row_hash)"
  dst_line="$(row_hash "${SCRATCH[@]}" -d restored)"
  echo "${tbl} ${src_line}" >> "${WORK}/src.rows"
  echo "${tbl} ${dst_line}" >> "${WORK}/dst.rows"
done <<< "$src_tables"

if ! diff -u "${WORK}/src.rows" "${WORK}/dst.rows" > "${WORK}/rows.diff"; then
  head -n 40 "${WORK}/rows.diff" >&2
  fail "row counts or content hashes differ"
fi
TABLE_COUNT="$(wc -l < "${WORK}/src.rows" | tr -d ' ')"
TOTAL_ROWS="$(awk '{s+=$2} END {print s+0}' "${WORK}/src.rows")"
echo "ok: ${TABLE_COUNT} tables match (rows and content hash), ${TOTAL_ROWS} rows total"
echo "PASS: ${LATEST} restores to an identical copy of the source"

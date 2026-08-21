#!/usr/bin/env bash
set -euo pipefail

umask 077

PROJECT_DIR="${SDBR_BACKUP_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
EXPORT_DIR="${SDBR_BACKUP_EXPORT_DIR:-$PROJECT_DIR/data/exports}"
DB_PATH="${SDBR_DB_PATH:-$PROJECT_DIR/data/sdbr-research.db}"
NODE_BIN="${SDBR_BACKUP_NODE_BIN:-$(command -v node || true)}"
COSCLI_BIN="${SDBR_BACKUP_COSCLI_BIN:-$(command -v coscli || true)}"
BUCKET="${SDBR_BACKUP_COS_BUCKET:-${FLOW_BACKUP_COS_BUCKET:-}}"
REGION="${SDBR_BACKUP_COS_REGION:-${FLOW_BACKUP_COS_REGION:-}}"
ENDPOINT="${SDBR_BACKUP_COS_ENDPOINT:-${FLOW_BACKUP_COS_ENDPOINT:-}}"
SECRET_ID="${SDBR_BACKUP_COS_SECRET_ID:-${FLOW_BACKUP_COS_SECRET_ID:-}}"
SECRET_KEY="${SDBR_BACKUP_COS_SECRET_KEY:-${FLOW_BACKUP_COS_SECRET_KEY:-}}"
PREFIX="${SDBR_BACKUP_COS_PREFIX:-post-dump-recovery/daily}"
THREADS="${SDBR_BACKUP_COS_THREADS:-4}"
RETENTION_DAYS="${SDBR_BACKUP_LOCAL_RETENTION_DAYS:-2}"
UPLOAD_TIMEOUT="${SDBR_BACKUP_UPLOAD_TIMEOUT:-30m}"
VERIFY_TIMEOUT="${SDBR_BACKUP_VERIFY_TIMEOUT:-5m}"

if [[ "$DB_PATH" != /* ]]; then DB_PATH="$PROJECT_DIR/$DB_PATH"; fi
for required in flock tar gzip sha256sum mktemp date find sort xargs sed timeout cut sleep; do
  command -v "$required" >/dev/null 2>&1 || { echo "Missing required command: $required" >&2; exit 1; }
done
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Node.js executable not found" >&2; exit 1; }
[[ -n "$COSCLI_BIN" && -x "$COSCLI_BIN" ]] || { echo "coscli executable not found" >&2; exit 1; }
[[ -s "$DB_PATH" ]] || { echo "Research database not found: $DB_PATH" >&2; exit 1; }
[[ -n "$SECRET_ID" && -n "$SECRET_KEY" ]] || { echo "COS credentials are incomplete" >&2; exit 1; }
[[ -n "$BUCKET" && -n "$REGION" && -n "$ENDPOINT" ]] || { echo "COS destination is incomplete" >&2; exit 1; }
case "$SECRET_ID$SECRET_KEY" in
  *$'\n'*|*$'\r'*) echo "COS credentials must not contain newlines" >&2; exit 1 ;;
esac

mkdir -p "$EXPORT_DIR"
EXPORT_DIR="$(cd "$EXPORT_DIR" && pwd)"
case "$EXPORT_DIR" in
  "$PROJECT_DIR"/data/exports|"$PROJECT_DIR"/data/exports/*) ;;
  *) echo "Refusing unsafe export directory: $EXPORT_DIR" >&2; exit 1 ;;
esac

exec 9>"$EXPORT_DIR/.daily-export.lock"
if ! flock -n 9; then
  echo "Another daily export is already running; exiting without overlap."
  exit 0
fi

STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M-CST)"
DATE_PATH="$(TZ=Asia/Shanghai date +%Y/%m/%d)"
BASE_NAME="post-dump-recovery-last24h-$STAMP.tar.gz"
ARCHIVE="$EXPORT_DIR/$BASE_NAME"
SHA_FILE="$ARCHIVE.sha256"
STATE_FILE="$EXPORT_DIR/last-run.env"
STAGE="$(mktemp -d "$EXPORT_DIR/.stage-XXXXXXXX")"
COS_CONFIG="$(mktemp --suffix=.yaml)"
SUCCESS=0

write_state() {
  local state="$1"
  local detail="${2:-}"
  local temporary="$STATE_FILE.tmp"
  {
    printf 'STATE=%q\n' "$state"
    printf 'UPDATED_AT=%q\n' "$(TZ=Asia/Shanghai date --iso-8601=seconds)"
    printf 'ARCHIVE=%q\n' "$ARCHIVE"
    printf 'REMOTE=%q\n' "${REMOTE_OBJECT:-}"
    printf 'DETAIL=%q\n' "$detail"
  } > "$temporary"
  mv -f -- "$temporary" "$STATE_FILE"
}

cleanup() {
  local exit_code=$?
  rm -f -- "$COS_CONFIG"
  case "$STAGE" in "$EXPORT_DIR"/.stage-*) rm -rf -- "$STAGE" ;; esac
  if [[ "$SUCCESS" != "1" ]]; then write_state FAILED "exit=$exit_code"; fi
}
trap cleanup EXIT

DB_EXPORT="$STAGE/post-dump-recovery-last24h.db"
MANIFEST="$STAGE/manifest.json"
SCHEMA="$STAGE/schema.sql"

write_state EXPORTING
"$NODE_BIN" "$PROJECT_DIR/scripts/export-research-window.js" \
  "--db=$DB_PATH" "--out=$DB_EXPORT" "--hours=24" \
  "--manifest=$MANIFEST" "--schema=$SCHEMA"
{
  echo "git_commit=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "exported_at=$(TZ=Asia/Shanghai date --iso-8601=seconds)"
  echo "schedule=07:00 Asia/Shanghai"
} > "$STAGE/version.txt"
(cd "$STAGE" && find . -type f ! -name sha256sums.txt -print0 | sort -z | xargs -0 sha256sum > sha256sums.txt)
tar -C "$STAGE" -cf - . | gzip -1 > "$ARCHIVE.tmp"
mv -f -- "$ARCHIVE.tmp" "$ARCHIVE"
sha256sum "$ARCHIVE" > "$SHA_FILE"
tar -tzf "$ARCHIVE" >/dev/null

yaml_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
cat > "$COS_CONFIG" <<EOF
cos:
  base:
    secretid: "$(yaml_escape "$SECRET_ID")"
    secretkey: "$(yaml_escape "$SECRET_KEY")"
    sessiontoken: ""
    protocol: https
    disableencryption: true
  buckets:
  - name: "$BUCKET"
    alias: sdbrbackup
    region: "$REGION"
    endpoint: "$ENDPOINT"
    ofs: false
EOF
chmod 600 "$COS_CONFIG"

REMOTE_DIR="cos://sdbrbackup/${PREFIX#/}/$DATE_PATH"
REMOTE_OBJECT="$REMOTE_DIR/$BASE_NAME"
retry() {
  local attempt=1
  until "$@"; do
    if (( attempt >= 3 )); then return 1; fi
    sleep "$((attempt * 10))"
    attempt=$((attempt + 1))
  done
}
write_state UPLOADING
retry timeout --foreground "$UPLOAD_TIMEOUT" "$COSCLI_BIN" -c "$COS_CONFIG" cp \
  "$ARCHIVE" "$REMOTE_OBJECT" --thread-num "$THREADS" --part-size 64 --fail-output=false
retry timeout --foreground "$VERIFY_TIMEOUT" "$COSCLI_BIN" -c "$COS_CONFIG" cp \
  "$SHA_FILE" "$REMOTE_OBJECT.sha256" --thread-num 1 --fail-output=false
write_state VERIFYING
retry timeout --foreground "$VERIFY_TIMEOUT" "$COSCLI_BIN" -c "$COS_CONFIG" ls "$REMOTE_OBJECT" >/dev/null

find "$EXPORT_DIR" -maxdepth 1 -type f \
  \( -name 'post-dump-recovery-last24h-*.tar.gz' -o -name 'post-dump-recovery-last24h-*.tar.gz.sha256' \) \
  -mtime "+$RETENTION_DAYS" -delete

SUCCESS=1
write_state DONE "sha256=$(cut -d' ' -f1 "$SHA_FILE")"
echo "Daily COS export complete: $REMOTE_OBJECT"

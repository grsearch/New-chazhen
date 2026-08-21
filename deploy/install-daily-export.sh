#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${1:-/home/ubuntu/New-chazhen}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
SERVICE_GROUP="${SERVICE_GROUP:-$(id -gn "$SERVICE_USER" 2>/dev/null || true)}"
BACKUP_ENV_FILE="/etc/new-chazhen/backup-cos.env"
LEGACY_ENV_FILE="/etc/flow-acceleration/backup-cos.env"
PROJECT_ENV_FILE="$INSTALL_DIR/.env"
SERVICE_NAME="post-dump-recovery-backup.service"
TIMER_NAME="post-dump-recovery-backup.timer"
LEGACY_TIMER="flow-acceleration-backup.timer"
LEGACY_SERVICE="flow-acceleration-backup.service"

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo."
  exit 1
fi
[[ -d "$INSTALL_DIR" ]] || { echo "Install directory not found: $INSTALL_DIR" >&2; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "Service user not found: $SERVICE_USER" >&2; exit 1; }

NODE_BIN="${NODE_BIN:-$(sudo -H -u "$SERVICE_USER" bash -lc 'command -v node' 2>/dev/null || true)}"
COSCLI_BIN="${COSCLI_BIN:-$(command -v coscli 2>/dev/null || true)}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Node.js was not found for $SERVICE_USER" >&2; exit 1; }
[[ -n "$COSCLI_BIN" && -x "$COSCLI_BIN" ]] || { echo "coscli is required" >&2; exit 1; }
for required in systemctl systemd-analyze install sed tail; do
  command -v "$required" >/dev/null 2>&1 || { echo "Missing required command: $required" >&2; exit 1; }
done

mkdir -p /etc/new-chazhen "$INSTALL_DIR/data/exports/.coscli-home"
if [[ ! -f "$BACKUP_ENV_FILE" ]]; then
  install -m 600 -o "$SERVICE_USER" -g "$SERVICE_GROUP" \
    "$INSTALL_DIR/deploy/backup-cos.env.example" "$BACKUP_ENV_FILE"
  echo "Created $BACKUP_ENV_FILE; fill it when no compatible legacy configuration exists."
fi
chown "$SERVICE_USER:$SERVICE_GROUP" "$BACKUP_ENV_FILE"
chmod 600 "$BACKUP_ENV_FILE"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/data/exports"
chmod 700 "$INSTALL_DIR/data/exports" "$INSTALL_DIR/data/exports/.coscli-home"
chmod 700 "$INSTALL_DIR/scripts/export-last24h-cos.sh"

env_value() {
  local file="$1" key="$2" result
  [[ -f "$file" ]] || return 1
  result="$(sed -n "s/^[[:space:]]*${key}=//p" "$file" | tail -n 1)"
  result="${result%$'\r'}"
  result="${result%\"}"; result="${result#\"}"
  result="${result%\'}"; result="${result#\'}"
  printf '%s' "$result"
}

has_complete_keyset() {
  local file="$1" prefix="$2" key current
  for key in COS_SECRET_ID COS_SECRET_KEY COS_BUCKET COS_REGION COS_ENDPOINT; do
    key="${prefix}_${key}"
    current="$(env_value "$file" "$key" || true)"
    [[ -n "$current" ]] || return 1
    case "$current" in your-*|cos.your-*) return 1 ;; esac
  done
}

has_complete_config() {
  has_complete_keyset "$1" SDBR_BACKUP || has_complete_keyset "$1" FLOW_BACKUP
}

BACKUP_ENV_LINE="# COS settings are loaded from $PROJECT_ENV_FILE"
CONFIG_SOURCE=""
if has_complete_config "$BACKUP_ENV_FILE"; then
  BACKUP_ENV_LINE="EnvironmentFile=$BACKUP_ENV_FILE"
  CONFIG_SOURCE="$BACKUP_ENV_FILE"
elif has_complete_config "$PROJECT_ENV_FILE"; then
  CONFIG_SOURCE="$PROJECT_ENV_FILE"
elif has_complete_config "$LEGACY_ENV_FILE"; then
  BACKUP_ENV_LINE="EnvironmentFile=$LEGACY_ENV_FILE"
  CONFIG_SOURCE="$LEGACY_ENV_FILE"
fi

render_unit() {
  local source="$1" destination="$2"
  sed \
    -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
    -e "s|@SERVICE_USER@|$SERVICE_USER|g" \
    -e "s|@SERVICE_GROUP@|$SERVICE_GROUP|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@COSCLI_BIN@|$COSCLI_BIN|g" \
    -e "s|@BACKUP_ENV_LINE@|$BACKUP_ENV_LINE|g" \
    "$source" > "$destination"
}

render_unit "$INSTALL_DIR/deploy/$SERVICE_NAME" "/etc/systemd/system/$SERVICE_NAME"
render_unit "$INSTALL_DIR/deploy/$TIMER_NAME" "/etc/systemd/system/$TIMER_NAME"
systemctl daemon-reload
systemd-analyze verify "/etc/systemd/system/$SERVICE_NAME" "/etc/systemd/system/$TIMER_NAME"

if [[ -z "$CONFIG_SOURCE" ]]; then
  systemctl disable --now "$TIMER_NAME" >/dev/null 2>&1 || true
  echo "Units installed but timer not enabled: COS configuration is incomplete."
  exit 0
fi

systemctl enable --now "$TIMER_NAME"
systemctl restart "$TIMER_NAME"

# Disable the old 08:00 scheduler only after the new 07:00 timer is valid.
if systemctl cat "$LEGACY_TIMER" >/dev/null 2>&1; then
  systemctl disable --now "$LEGACY_TIMER" || true
  if systemctl is-active --quiet "$LEGACY_SERVICE"; then
    echo "$LEGACY_SERVICE is currently running and will be allowed to finish."
  fi
fi

echo "Daily COS export installed: 07:00 Asia/Shanghai"
echo "Configuration source: $CONFIG_SOURCE"
echo "Test once: systemctl start $SERVICE_NAME"
echo "Inspect: systemctl list-timers $TIMER_NAME --all"

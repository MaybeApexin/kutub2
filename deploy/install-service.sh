#!/usr/bin/env bash
# Installs kutub2-bot.service as a systemd service, so the Discord bot stays
# running in the background, restarts on crash, and comes back up on reboot.
#
# Run this ON THE VPS, from inside the project directory, as the user that
# should own the running bot process (the same one you ran `bun install` as):
#
#   bash deploy/install-service.sh
#
# It fills in the current user, the current directory, and the bun binary on
# PATH, installs the unit to /etc/systemd/system/, and enables + starts it.
# Needs sudo for the systemd-related steps; everything else runs as you.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="kutub2-bot"
UNIT_SRC="$PROJECT_DIR/deploy/$SERVICE_NAME.service"
UNIT_DEST="/etc/systemd/system/$SERVICE_NAME.service"

BUN_PATH="$(command -v bun || true)"
if [ -z "$BUN_PATH" ]; then
  echo "error: bun not found on PATH for this user. Install it first (see README) and re-run this script as the same user." >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "warning: no .env found at $PROJECT_DIR/.env — the bot will fail to start until one exists (cp .env.example .env, then fill it in)." >&2
fi

echo "Installing $SERVICE_NAME.service:"
echo "  User:             $(whoami)"
echo "  WorkingDirectory: $PROJECT_DIR"
echo "  bun:              $BUN_PATH"
echo

sed \
  -e "s#REPLACE_WITH_YOUR_USERNAME#$(whoami)#" \
  -e "s#REPLACE_WITH_PROJECT_PATH#$PROJECT_DIR#" \
  -e "s#REPLACE_WITH_BUN_PATH#$BUN_PATH#" \
  "$UNIT_SRC" | sudo tee "$UNIT_DEST" > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"

echo
echo "Done. Useful commands:"
echo "  sudo systemctl status $SERVICE_NAME     # is it running?"
echo "  journalctl -u $SERVICE_NAME -f          # follow logs live"
echo "  sudo systemctl restart $SERVICE_NAME    # restart after a code/env change"
echo "  sudo systemctl stop $SERVICE_NAME       # stop it"

#!/usr/bin/env bash
# Print the Claude Control Mobile login link and a QR code for your phone.
#
# SECURITY: the link holds your personal token. This script prints it only to
# this local terminal. Do not paste it into chats, tickets or logs, and do not
# run this script where the output is recorded or shared.
#
#   scripts/login-link.sh            link for https://<magicdns>/
#   scripts/login-link.sh --local    link for http://127.0.0.1:7810/ (this Mac only)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DECK_DATA_DIR:-$REPO/data}"
PORT="${DECK_PORT:-7810}"
TOKEN_FILE="$DATA_DIR/token"

LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -s "$TOKEN_FILE" ]; then
  echo "No token yet at $TOKEN_FILE. Start the server once (scripts/install.sh) so it creates one." >&2
  exit 1
fi

if [ "$LOCAL" = 1 ]; then
  BASE="http://127.0.0.1:$PORT"
else
  HOST=""
  [ -s "$DATA_DIR/allowed-hosts" ] && HOST="$(head -1 "$DATA_DIR/allowed-hosts" | tr -d '[:space:]')"
  if [ -z "$HOST" ]; then
    echo "No MagicDNS name in $DATA_DIR/allowed-hosts. Run scripts/tailscale-up.sh first, or use --local." >&2
    exit 1
  fi
  BASE="https://$HOST"
fi

# Token is base64url, so it is safe in a URL without more encoding.
URL="$BASE/login?token=$(tr -d '[:space:]' < "$TOKEN_FILE")"

if [ ! -t 1 ]; then
  echo "Refusing to print the login link: output is not a terminal." >&2
  exit 1
fi

echo "Login link (keep it private):"
echo "  $URL"
if command -v qrencode >/dev/null 2>&1; then
  echo
  qrencode -t ANSIUTF8 "$URL"
else
  echo "(install qrencode for a QR code: brew install qrencode)"
fi

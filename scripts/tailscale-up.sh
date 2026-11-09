#!/usr/bin/env bash
# Publish Claude Control Mobile on your tailnet only (HTTPS on 443, via tailscale serve).
# This uses serve, not funnel: nothing is opened to the internet.
#
#   scripts/tailscale-up.sh            serve http://127.0.0.1:7810 at https://<magicdns>/
#   scripts/tailscale-up.sh --down     remove that serve config
#   scripts/tailscale-up.sh --dry-run  print every step, change nothing
#
# It also writes the MagicDNS name to data/allowed-hosts, which
# scripts/install.sh reads for DECK_ALLOWED_HOSTS. Re-run install.sh after it.
set -euo pipefail

PORT="${DECK_PORT:-7810}"
TARGET="http://127.0.0.1:$PORT"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DECK_DATA_DIR:-$REPO/data}"

DRY_RUN=0
MODE=up
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --down) MODE=down ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { echo "==> $*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

TS="$(command -v tailscale 2>/dev/null || true)"
if [ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
if [ -z "$TS" ]; then
  echo "Tailscale CLI not found. Install the Tailscale app from tailscale.com/download." >&2
  exit 1
fi
say "tailscale CLI: $TS ($("$TS" version 2>/dev/null | head -1))"

if [ "$MODE" = down ]; then
  say "removing the HTTPS 443 serve handler"
  run "$TS" serve --https=443 off
  say "done. Check with: $TS serve status"
  exit 0
fi

# Read this machine's MagicDNS name (read only, changes nothing).
magicdns() {
  local node
  node="$(command -v node 2>/dev/null || true)"
  [ -n "$node" ] || node=/opt/homebrew/bin/node
  "$TS" status --json 2>/dev/null \
    | "$node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const n=(j.Self&&j.Self.DNSName||"").replace(/\.$/,"");if(!n)process.exit(1);console.log(n)})'
}

if ! DNS="$(magicdns)"; then
  if [ "$DRY_RUN" = 1 ]; then
    DNS="<machine>.<tailnet>.ts.net"
    say "Tailscale is not running or not logged in. Using placeholder: $DNS"
  else
    echo "Tailscale is not running or not logged in. Open the Tailscale app and log in first." >&2
    echo "MagicDNS and HTTPS certificates must be on in the admin console (DNS page)." >&2
    exit 1
  fi
fi
say "MagicDNS name: $DNS"

say "serving $TARGET on https://$DNS/ (tailnet only)"
run "$TS" serve --bg --https=443 "$TARGET"

say "writing $DATA_DIR/allowed-hosts"
run mkdir -p "$DATA_DIR"
if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] echo $DNS > $DATA_DIR/allowed-hosts"
else
  echo "$DNS" > "$DATA_DIR/allowed-hosts"
fi

cat <<EOF

DECK_ALLOWED_HOSTS hint:
  DECK_ALLOWED_HOSTS=$DNS,127.0.0.1:$PORT,localhost:$PORT
Next:
  scripts/install.sh       (re-run so launchd gets the new host list)
  scripts/login-link.sh    (login link and QR for the phone)
EOF

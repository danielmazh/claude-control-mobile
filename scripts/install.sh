#!/usr/bin/env bash
# Install Claude Control Mobile as a launchd agent for the current user.
#
#   scripts/install.sh              install or update (safe to run again)
#   scripts/install.sh --dry-run    print every step, change nothing
#   scripts/install.sh --uninstall  stop the agent and remove the plist (keeps data/)
#
# Env overrides:
#   DECK_NODE           node binary to use (must be >= 22.6)
#   DECK_DATA_DIR       data folder (default: <repo>/data)
#   DECK_ALLOWED_HOSTS  comma list of allowed Host values
#                       (default: data/allowed-hosts written by tailscale-up.sh,
#                       plus 127.0.0.1:7810 and localhost:7810)
set -euo pipefail

LABEL="io.github.danielmazh.claude-control-mobile"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO/launchd/$LABEL.plist.template"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_FILE="$HOME/Library/Logs/claude-control-mobile.log"
DATA_DIR="${DECK_DATA_DIR:-$REPO/data}"
DOMAIN="gui/$(id -u)"

DRY_RUN=0
MODE=install
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { echo "==> $*"; }

# Run a command, or only print it in dry-run mode.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

is_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

stop_agent() {
  if is_loaded; then
    say "stopping $LABEL"
    run launchctl bootout "$DOMAIN/$LABEL" || true
    # bootout returns before launchd lets go of the label; bootstrap right
    # after it fails with "5: Input/output error". Wait up to 10s.
    if [ "$DRY_RUN" != 1 ]; then
      for _ in 1 2 3 4 5 6 7 8 9 10; do is_loaded || break; sleep 1; done
    fi
  fi
}

if [ "$MODE" = uninstall ]; then
  stop_agent
  if [ -f "$PLIST" ]; then
    say "removing $PLIST"
    run rm -f "$PLIST"
  fi
  say "done. Data kept in $DATA_DIR (token, push keys, state). Remove it by hand if you want."
  say "Tailscale serve is not touched. Run scripts/tailscale-up.sh --down to remove it."
  exit 0
fi

# Node >= 22.6 is needed for --experimental-strip-types.
node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)' >/dev/null 2>&1
}

find_node() {
  local c
  if [ -n "${DECK_NODE:-}" ]; then
    node_ok "$DECK_NODE" && { echo "$DECK_NODE"; return 0; }
    echo "DECK_NODE=$DECK_NODE is not node >= 22.6" >&2; return 1
  fi
  c="$(command -v node 2>/dev/null || true)"
  if [ -n "$c" ] && node_ok "$c"; then echo "$c"; return 0; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -rV); do
    if [ -x "$c" ] && node_ok "$c"; then echo "$c"; return 0; fi
  done
  echo "no node >= 22.6 found. Set DECK_NODE=/path/to/node" >&2
  return 1
}

NODE="$(find_node)"
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm)"
say "node: $NODE ($("$NODE" --version))"

# Allowed hosts.
if [ -z "${DECK_ALLOWED_HOSTS:-}" ]; then
  HOSTS="127.0.0.1:7810,localhost:7810"
  if [ -s "$DATA_DIR/allowed-hosts" ]; then
    HOSTS="$(tr -d '[:space:]' < "$DATA_DIR/allowed-hosts"),$HOSTS"
  else
    say "note: no $DATA_DIR/allowed-hosts yet. Run scripts/tailscale-up.sh first for phone access."
  fi
  DECK_ALLOWED_HOSTS="$HOSTS"
fi
say "allowed hosts: $DECK_ALLOWED_HOSTS"

say "installing dependencies"
run "$NPM" ci --prefix "$REPO"

say "building web UI"
run "$NPM" run --prefix "$REPO" web:build

# Escape a value for the sed replacement side (|, &, and \).
esc() { printf '%s' "$1" | sed -e 's/[|&\\]/\\&/g'; }

render() {
  sed \
    -e "s|__NODE_PATH__|$(esc "$NODE")|g" \
    -e "s|__WORKING_DIR__|$(esc "$REPO")|g" \
    -e "s|__DATA_DIR__|$(esc "$DATA_DIR")|g" \
    -e "s|__ALLOWED_HOSTS__|$(esc "$DECK_ALLOWED_HOSTS")|g" \
    -e "s|__LOG_FILE__|$(esc "$LOG_FILE")|g" \
    "$TEMPLATE"
}

TMP="$(mktemp -t claude-control-mobile-plist)"
trap 'rm -f "$TMP"' EXIT
render > "$TMP"
if grep -q '__[A-Z_]*__' "$TMP"; then
  echo "template still has placeholders:" >&2
  grep -n '__[A-Z_]*__' "$TMP" >&2
  exit 1
fi
plutil -lint "$TMP" >/dev/null

if [ "$DRY_RUN" = 1 ]; then
  say "rendered plist (would be written to $PLIST):"
  cat "$TMP"
fi

run mkdir -p "$PLIST_DIR" "$(dirname "$LOG_FILE")" "$DATA_DIR"
run chmod 700 "$DATA_DIR"
run install -m 0644 "$TMP" "$PLIST"

# Reload so a new plist or new code takes effect.
stop_agent
say "starting $LABEL"
run launchctl bootstrap "$DOMAIN" "$PLIST"

say "done. Log: $LOG_FILE"
say "next: scripts/login-link.sh to open the deck on your phone."

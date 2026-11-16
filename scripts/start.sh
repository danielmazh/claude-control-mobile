#!/bin/bash
# launchd entry point. Runs the server with the node that install.sh found (DECK_NODE).
# If that node is gone (for example an nvm version was removed), it falls back to any
# other node >= 22.6, so the service still comes up after an update or a reboot.
cd "$(dirname "$0")/.." || exit 1

node_ok() {
  [ -x "$1" ] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)' >/dev/null 2>&1
}

for c in "${DECK_NODE:-}" /opt/homebrew/bin/node /usr/local/bin/node $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -rV); do
  if [ -n "$c" ] && node_ok "$c"; then
    [ "$c" = "${DECK_NODE:-}" ] || echo "start.sh: DECK_NODE not usable, using fallback $c" >&2
    exec "$c" --experimental-strip-types server/main.ts
  fi
done
echo "start.sh: no node >= 22.6 found" >&2
exit 1

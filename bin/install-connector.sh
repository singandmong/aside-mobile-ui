#!/bin/zsh
# Pairs this Mac with an Aside Mobile hub and keeps the connector running at login.
# Usage: ./bin/install-connector.sh --hub https://<hub-address> --code XXXX-XXXX [--label "Mac mini"]
#        ./bin/install-connector.sh            (re-install using the existing pairing)
set -euo pipefail
ROOT_DIR="${0:A:h:h}"
LABEL=com.aside-mobile.connector
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="$HOME/.config/aside-mobile"

BUN="$(command -v bun)" || { print -u2 "Bun is required: https://bun.sh"; exit 1; }
ASIDE="$(command -v aside)" || { print -u2 "Aside CLI is required (Aside › Settings › Developers › Install CLI)"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p -m 700 "$STATE_DIR"

cd "$ROOT_DIR"
if [[ $# -gt 0 ]]; then
  ASIDE_BIN="$ASIDE" "$BUN" run src/connector.ts pair "$@"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>run</string><string>$ROOT_DIR/src/connector.ts</string><string>run</string></array>
  <key>WorkingDirectory</key><string>$ROOT_DIR</string>
  <key>EnvironmentVariables</key><dict><key>ASIDE_BIN</key><string>$ASIDE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/connector.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/connector.error.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
print "Connector running ($LABEL). Logs: $STATE_DIR/connector.log"

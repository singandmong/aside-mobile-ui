#!/bin/zsh
# Installs the Aside Mobile server as a login item on this Mac.
# Usage: ./bin/install-launchd.sh [--relay]
#   --relay  also act as a hub that other computers can connect to (see README "Multiple computers").
set -euo pipefail
ROOT_DIR="${0:A:h:h}"
LABEL=com.aside-mobile.pwa
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_DIR="$HOME/.config/aside-mobile"
ENV_FILE="$ENV_DIR/env"

BUN="$(command -v bun)" || { print -u2 "Bun is required: https://bun.sh"; exit 1; }
ASIDE="$(command -v aside || true)"
[[ -n "$ASIDE" ]] || print -u2 "warning: Aside CLI not found on PATH; set ASIDE_BIN in $ENV_FILE"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p -m 700 "$ENV_DIR"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

set_default() { grep -q "^$1=" "$ENV_FILE" || print -r -- "$1=$2" >> "$ENV_FILE"; }
set_value() {
  { grep -v "^$1=" "$ENV_FILE" || true; print -r -- "$1=$2"; } > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

set_default ASIDE_MOBILE_TOKEN "$(openssl rand -hex 24)"
set_default TRUST_TAILSCALE_IDENTITY 1
set_default HOST 127.0.0.1
set_default PORT 8787
set_value BUN_BIN "$BUN"
[[ -n "$ASIDE" ]] && set_value ASIDE_BIN "$ASIDE"
[[ "${1:-}" == "--relay" ]] && set_value ASIDE_MOBILE_RELAY 1

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$ROOT_DIR/bin/aside-mobile-start.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ENV_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$ENV_DIR/server.error.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
print "Installed $LABEL (settings: $ENV_FILE)"
print "Expose it to your tailnet with: tailscale serve --bg --https=443 http://127.0.0.1:\$(grep ^PORT= $ENV_FILE | cut -d= -f2)"

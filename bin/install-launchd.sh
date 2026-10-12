#!/bin/zsh
set -euo pipefail
ROOT_DIR="${0:A:h:h}"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/com.aside-mobile.pwa.plist"
ENV_DIR="$HOME/.config/aside-mobile"
mkdir -p "$PLIST_DIR" "$ENV_DIR"
if [[ ! -e "$ENV_DIR/env" ]]; then
  cat > "$ENV_DIR/env" <<EOF
ASIDE_MOBILE_TOKEN=$(openssl rand -hex 24)
HOST=127.0.0.1
PORT=8787
EOF
  chmod 600 "$ENV_DIR/env"
fi
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aside-mobile.pwa</string>
  <key>EnvironmentVariables</key><dict><key>TRUST_TAILSCALE_IDENTITY</key><string>1</string></dict>
  <key>ProgramArguments</key><array><string>$ROOT_DIR/bin/aside-mobile-start.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ENV_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$ENV_DIR/server.error.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.aside-mobile.pwa" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.aside-mobile.pwa"
print "Installed $PLIST"
print "Token file: $ENV_DIR/env"

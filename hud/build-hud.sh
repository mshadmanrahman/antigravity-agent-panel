#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Elemental HUD.app"
OUT_APP="${1:-$HOME/Applications/$APP_NAME}"
CONTENTS="$OUT_APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"

mkdir -p "$MACOS_DIR" "$RES_DIR"

if [[ -f "$ROOT_DIR/hud/AppIcon.icns" ]]; then
  cp "$ROOT_DIR/hud/AppIcon.icns" "$RES_DIR/AppIcon.icns"
fi

swiftc \
  -O \
  -framework AppKit \
  -framework WebKit \
  -framework CoreGraphics \
  "$ROOT_DIR/hud/ElementalHUD.swift" \
  -o "$MACOS_DIR/ElementalHUD"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>ElementalHUD</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.shadman.elemental-hud</string>
  <key>CFBundleName</key>
  <string>Elemental HUD</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

echo "Built $OUT_APP"

#!/usr/bin/env bash
#
# bootstrap-ios.sh — stand up the Waves customer iOS app (Capacitor shell).
#
# Prereqs (macOS):
#   - Xcode (full app, not just CLT)            xcodebuild -version
#   - CocoaPods                                 brew install cocoapods   (or: sudo gem install cocoapods)
#   - An Apple Developer account + Team ID (signing)
#
# What it does:
#   1. installs/updates the Capacitor deps in client/
#   2. builds the web app into client/dist (the webDir Capacitor copies)
#   3. generates the native Xcode project at client/ios/App (idempotent)
#   4. syncs web assets + native plugins into the iOS project
#   5. opens Xcode so you can set the signing team and run on a device
#
# Run from the repo root:  bash scripts/mobile/bootstrap-ios.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/client"

echo "==> 1/5  Installing Capacitor deps (pinning to latest majors)…"
npm install \
  @capacitor/core@latest @capacitor/cli@latest @capacitor/ios@latest \
  @capacitor/push-notifications@latest @capacitor/app@latest \
  @capacitor/status-bar@latest @capacitor/splash-screen@latest

echo "==> 2/5  Building web bundle (dist/)…"
npm run build

if [ ! -d "ios/App" ]; then
  echo "==> 3/5  Generating native iOS project (client/ios/App)…"
  npx cap add ios
else
  echo "==> 3/5  Native iOS project already exists — skipping cap add."
fi

echo "==> 4/5  Syncing web + plugins into the iOS project…"
npx cap sync ios

echo
echo "==> 5/5  Manual steps in Xcode (opening now):"
cat <<'NOTES'
   • Signing & Capabilities → select your Team (bundle id: com.wavespestcontrol.portal)
   • + Capability → Push Notifications
   • + Capability → Background Modes → check "Remote notifications"
   • App Store Connect → Users and Access → Integrations → APNs Auth Key:
       create a .p8 key, note the Key ID + Team ID → these feed the backend
       APNs env vars (see docs/mobile/apns-backend-pr-plan.md).
   • Run on a real device (push does not work in the simulator).
NOTES
npx cap open ios

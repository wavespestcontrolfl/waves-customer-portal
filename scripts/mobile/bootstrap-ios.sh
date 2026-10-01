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
#   1. installs the exact lockfile-pinned Capacitor deps
#   2. builds the web app into client/dist (the webDir Capacitor copies)
#   3. generates the native Xcode project at client/ios/App (idempotent)
#   4. syncs web assets + native plugins into the iOS project
#   5. opens Xcode so you can set the signing team and run on a device
#
# Run from the repo root:  bash scripts/mobile/bootstrap-ios.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/client"

install_brand_assets() {
  local asset_catalog="${WAVES_IOS_ASSET_ROOT:-ios/App/App/Assets.xcassets}"
  local icon_src="resources/icon.png"
  local icon_set="$asset_catalog/AppIcon.appiconset"
  local icon_dest="$icon_set/AppIcon-512@2x.png"
  if [ -f "$icon_src" ] && [ -d "$icon_set" ]; then
    cp "$icon_src" "$icon_dest"
    cat > "$icon_set/Contents.json" <<'JSON'
{
  "images" : [
    {
      "filename" : "AppIcon-512@2x.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
JSON
    echo "==> Waves app icon installed into AppIcon.appiconset ✓"
  else
    echo "==> ERROR: icon source or app-icon set missing — refusing to ship the Capacitor default." >&2
    return 1
  fi

  # Replace the stock Capacitor launch screen (white background + Capacitor
  # logo) with the tracked Waves splash. The generated storyboard renders the
  # Splash imageset full-bleed (aspectFill), so overwriting its PNGs is enough.
  local splash_src="resources/splash-2732x2732.png"
  local splash_set="$asset_catalog/Splash.imageset"
  if [ -f "$splash_src" ] && [ -d "$splash_set" ]; then
    for f in "$splash_set"/splash-*.png; do
      [ -e "$f" ] && cp "$splash_src" "$f"
    done
    echo "==> Waves splash installed into Splash.imageset ✓"
  else
    echo "==> WARNING: splash source or imageset missing — launch screen keeps the Capacitor default."
  fi
}

# Reinstall the tracked branding into an existing/generated catalog without
# running npm, Capacitor, CocoaPods, or Xcode. This is also safe for isolated
# fixture verification because WAVES_IOS_ASSET_ROOT can name a scratch catalog.
if [ "${1:-}" = "--assets-only" ]; then
  install_brand_assets
  exit 0
fi

echo "==> 1/5  Installing lockfile-pinned native dependencies…"
# Run from client/ intentionally: npm resolves the workspace root lockfile.
# `npm ci` refuses drift instead of silently moving Capacitor/plugin versions
# between release builds.
npm ci

echo "==> 2/5  Building web bundle (dist/)…"
npm run build

# Capacitor 8 defaults new iOS projects to Swift Package Manager, but
# @aparajita/capacitor-biometric-auth ships no Package.swift — under SPM it is
# silently EXCLUDED from the build, and biometric.js fails open when the plugin
# is missing, so a fresh SPM project produces an app with no Face ID lock at all.
# Pin to CocoaPods until every plugin is SPM-compatible.
if [ -d "ios/App/CapApp-SPM" ]; then
  echo "==> 3/5  Existing project is SPM-based (drops the Face ID plugin) — moving it to client/ios-spm-backup and regenerating with CocoaPods…"
  rm -rf ios-spm-backup
  mv ios ios-spm-backup
fi
if [ ! -d "ios/App" ]; then
  echo "==> 3/5  Generating native iOS project (client/ios/App)…"
  npx cap add ios --packagemanager Cocoapods
else
  echo "==> 3/5  Native iOS project already exists — skipping cap add."
fi

echo "==> 4/5  Syncing web + plugins into the iOS project…"
npx cap sync ios

# Reapply the tracked app icon and splash after every add/sync. Capacitor's
# native project is generated and ignored, so this is the durable source of
# both assets for clean projects and repeat bootstraps of existing projects.
install_brand_assets

# Capacitor's iOS push plugin only fires the JS 'registration' event if
# AppDelegate forwards the UIKit APNs callbacks to Capacitor's NotificationCenter
# names. The default Capacitor template includes these, but a regenerated/older
# template may not — verify and inject if missing (idempotent).
APPDELEGATE="ios/App/App/AppDelegate.swift"
if [ -f "$APPDELEGATE" ]; then
  if grep -q "capacitorDidRegisterForRemoteNotifications" "$APPDELEGATE"; then
    echo "==> AppDelegate APNs forwarding present ✓"
  else
    echo "==> Injecting APNs registration forwarding into AppDelegate.swift…"
    perl -0pi -e 's/\n\}\s*$/\n\n    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {\n        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)\n    }\n\n    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {\n        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)\n    }\n}\n/' "$APPDELEGATE"
  fi
fi

# Native capability usage strings, required by App review (Face ID app-lock +
# camera/photo capture). Idempotent: Add fails if the key exists, then Set.
PLIST="ios/App/App/Info.plist"
if [ -f "$PLIST" ]; then
  set_plist() {
    /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST"
  }
  set_plist NSFaceIDUsageDescription "Unlock the Waves app with Face ID."
  set_plist NSCameraUsageDescription "Take photos of pests or lawn issues to share with your technician."
  set_plist NSPhotoLibraryUsageDescription "Attach photos from your library to share with your technician."
  # Required too: Capacitor Camera's getPhoto can reject up front if any usage
  # key it expects is missing (incl. the photo-library ADD key), which camera.js
  # would otherwise see as a cancel — so set all of them.
  set_plist NSPhotoLibraryAddUsageDescription "Save photos you attach for your technician."
  echo "==> Info.plist usage strings set (Face ID, camera, photo library R/W) ✓"
fi

# @capacitor/filesystem touches file-timestamp APIs — Apple requires the app
# to declare NSPrivacyAccessedAPICategoryFileTimestamp (reason C617.1) in a
# privacy manifest or App Review rejects the binary (Capacitor 7 docs).
# Idempotent: written once; on the FIRST bootstrap after this was introduced
# the file must also be added to the App target in Xcode (manual step below).
PRIVACY="ios/App/App/PrivacyInfo.xcprivacy"
if [ ! -f "$PRIVACY" ]; then
  cat > "$PRIVACY" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array>
        <string>C617.1</string>
      </array>
    </dict>
  </array>
  <key>NSPrivacyCollectedDataTypes</key>
  <array/>
  <key>NSPrivacyTracking</key>
  <false/>
</dict>
</plist>
PLIST
  echo "==> PrivacyInfo.xcprivacy written (Filesystem file-timestamp declaration) ✓"
else
  echo "==> PrivacyInfo.xcprivacy already present ✓"
fi

# Universal links: portal.wavespestcontrol.com URLs open the installed app
# directly. Needs (a) this Associated Domains entitlement in the binary and
# (b) the server serving /.well-known/apple-app-site-association
# (GATE_UNIVERSAL_LINKS — see docs/mobile/universal-links.md). Idempotent:
# creates the entitlements file if missing, appends the applinks entry if the
# file exists without it. The APNs setup below connects the signing file.
ENTITLEMENTS="ios/App/App/App.entitlements"
APPLINK_DOMAIN="applinks:portal.wavespestcontrol.com"
if [ ! -f "$ENTITLEMENTS" ]; then
  cat > "$ENTITLEMENTS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.developer.associated-domains</key>
  <array>
    <string>${APPLINK_DOMAIN}</string>
  </array>
</dict>
</plist>
PLIST
  echo "==> App.entitlements written (Associated Domains: ${APPLINK_DOMAIN}) ✓"
elif /usr/libexec/PlistBuddy -c "Print :com.apple.developer.associated-domains" "$ENTITLEMENTS" 2>/dev/null | grep -q "$APPLINK_DOMAIN"; then
  echo "==> App.entitlements already lists ${APPLINK_DOMAIN} ✓"
else
  /usr/libexec/PlistBuddy -c "Add :com.apple.developer.associated-domains array" "$ENTITLEMENTS" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :com.apple.developer.associated-domains:0 string ${APPLINK_DOMAIN}" "$ENTITLEMENTS"
  echo "==> ${APPLINK_DOMAIN} appended to App.entitlements ✓"
fi

# Notification permission can be granted even when the signed app is missing
# aps-environment. Configure every App target build configuration so a fresh
# native project cannot silently depend on a manual Push Notifications step.
python3 "$ROOT/scripts/mobile/ios_push.py" configure "$ROOT/client/ios/App" --badge

echo
echo "==> 5/5  Manual steps in Xcode (opening now):"
cat <<'NOTES'
   • If PrivacyInfo.xcprivacy is new this run: File → Add Files to "App"…
     → select App/PrivacyInfo.xcprivacy → check "App" target membership
     (required for the Filesystem plugin's file-timestamp declaration).
   • Signing & Capabilities → select your Team (bundle id: com.wavespestcontrol.portal)
   • Push Notifications is configured by this script. Automatic signing must
     use a profile with Push Notifications enabled for this App ID.
   • + Capability → Background Modes → check "Remote notifications"
   • + Capability → Associated Domains → confirm applinks:portal.wavespestcontrol.com
     is listed. Automatic signing then enables Associated Domains on the
     App ID for you. Server side, links only start opening in-app once
     GATE_UNIVERSAL_LINKS=true is set on Railway — see docs/mobile/universal-links.md.
   • App Store Connect → Users and Access → Integrations → APNs Auth Key:
       create a .p8 key, note the Key ID + Team ID → these feed the backend
       APNs env vars (see docs/mobile/apns-backend-pr-plan.md).
   • Run on a real device (push does not work in the simulator).
   • Before uploading the exported App Store / TestFlight IPA, run from the repo root:
       python3 scripts/mobile/ios_push.py verify /path/to/Waves.ipa
     The exported app must have aps-environment=production. A web deployment
     cannot add this entitlement to an already-installed iOS build.
NOTES
if [ "${CI:-}" = "true" ]; then
  echo "==> CI mode: native project synced; skipping Xcode launch."
else
  npx cap open ios
fi

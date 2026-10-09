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
#
# client/ios/App/ci_scripts is the one tracked folder inside the generated
# project (Xcode Cloud reads it from beside the workspace), so client/ios
# exists in a clean clone and `cap add ios` refuses an existing ios folder.
# Move the folder aside for the add and put it back on every exit. The move is
# a rename on the same volume, so a ci_post_clone.sh that is running this
# script keeps its open file.
CI_SCRIPTS_HOLD="$PWD/.ios-ci-scripts-hold"
restore_ci_scripts() {
  if [ -d "$CI_SCRIPTS_HOLD/ci_scripts" ]; then
    mkdir -p ios/App
    if [ ! -e ios/App/ci_scripts ]; then mv "$CI_SCRIPTS_HOLD/ci_scripts" ios/App/ci_scripts; fi
  fi
  rmdir "$CI_SCRIPTS_HOLD" 2>/dev/null || true
}
trap restore_ci_scripts EXIT
restore_ci_scripts
hold_ci_scripts() {
  if [ -d ios/App/ci_scripts ]; then
    mkdir -p "$CI_SCRIPTS_HOLD"
    mv ios/App/ci_scripts "$CI_SCRIPTS_HOLD/ci_scripts"
  fi
}
if [ -d "ios/App/CapApp-SPM" ]; then
  echo "==> 3/5  Existing project is SPM-based (drops the Face ID plugin) — moving it to client/ios-spm-backup and regenerating with CocoaPods…"
  hold_ci_scripts
  rm -rf ios-spm-backup
  mv ios ios-spm-backup
fi
if [ ! -d "ios/App/App.xcodeproj" ]; then
  echo "==> 3/5  Generating native iOS project (client/ios/App)…"
  hold_ci_scripts
  # Only empty folders are removed: anything else in client/ios stops the add.
  rmdir ios/App ios 2>/dev/null || true
  npx cap add ios --packagemanager Cocoapods
  restore_ci_scripts
else
  echo "==> 3/5  Native iOS project already exists — skipping cap add."
fi

# Xcode 27 builds only for iOS 15 and later; the Capacitor 7 template says
# 14.0, and every target (App + Pods) then fails to build. Raise the floor in
# the Podfile (Pods targets) and the App project before sync runs pod install.
IOS_MIN="15.0"
# Only a floor below 15 is raised; a higher one is kept.
sed -i '' -E "s/^platform :ios, '([0-9]|1[0-4])(\.[0-9]+)*'/platform :ios, '${IOS_MIN}'/" ios/App/Podfile
sed -i '' -E "s/IPHONEOS_DEPLOYMENT_TARGET = 1[0-4]\.[0-9]+;/IPHONEOS_DEPLOYMENT_TARGET = ${IOS_MIN};/g" ios/App/App.xcodeproj/project.pbxproj
# Each generated Pods target takes its floor from its podspec (Capacitor's
# says 14.0), not from the Podfile platform, and the template's
# assertDeploymentTarget only lifts targets below 14.0. Raise every Pods
# build configuration in post_install too (inserted once, marked).
if ! grep -q 'waves: iOS floor' ios/App/Podfile; then
  IOS_MIN="$IOS_MIN" ruby -e '
    path = "ios/App/Podfile"
    src = File.read(path)
    floor = ENV.fetch("IOS_MIN")
    hook = "  # waves: iOS floor (scripts/mobile/bootstrap-ios.sh): Xcode 27 builds only for iOS #{floor}+.\n" \
           "  installer.pods_project.targets.each do |t|\n" \
           "    t.build_configurations.each do |c|\n" \
           "      c.build_settings[\"IPHONEOS_DEPLOYMENT_TARGET\"] = \"#{floor}\" if c.build_settings[\"IPHONEOS_DEPLOYMENT_TARGET\"].to_f < #{floor}\n" \
           "    end\n" \
           "  end\n"
    out = src.sub(/^(post_install do \|installer\|\n(?:.*assertDeploymentTarget.*\n)?)/) { $1 + hook }
    # An older or customized Podfile with no post_install: add a whole one.
    out = src.rstrip + "\n\npost_install do |installer|\n" + hook + "end\n" if out == src
    File.write(path, out)
  '
fi
echo "==> iOS deployment target set to ${IOS_MIN} (Xcode 27 minimum) ✓"
# The template turns on Xcode's user-script sandbox, which blocks CocoaPods'
# "Embed Pods Frameworks" script from reading its own file list
# (Pods-App-frameworks.sh: "Sandbox: bash deny file-read-data"), so archive
# fails. CocoaPods does not support that sandbox; turn it off for the App.
sed -i '' 's/ENABLE_USER_SCRIPT_SANDBOXING = YES;/ENABLE_USER_SCRIPT_SANDBOXING = NO;/g' ios/App/App.xcodeproj/project.pbxproj

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

  # Export compliance. The app uses only the encryption iOS itself provides
  # (HTTPS, the Keychain behind Face ID unlock), which Apple treats as exempt.
  # Without this key App Store Connect holds every upload at "Missing
  # Compliance" until someone answers the question by hand, and TestFlight
  # does not show the build. Change it if the app ever ships its own
  # encryption code.
  /usr/libexec/PlistBuddy -c "Delete :ITSAppUsesNonExemptEncryption" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$PLIST"
  echo "==> Info.plist ITSAppUsesNonExemptEncryption = false ✓"

  # App-bound domains. WKWebView exposes service workers only to the domains
  # listed in WKAppBoundDomains, so without this the portal's offline copy
  # (client/public/sw.js) never installs inside the app and the app opens to
  # a blank screen with no signal. capacitor.config.json sets
  # ios.limitsNavigationsToAppBoundDomains, which Capacitor needs to keep its
  # plugin bridge working once the list exists. The domain comes from
  # server.url, so the two cannot drift. Rewritten on every bootstrap.
  APP_BOUND_HOST="$(node -p "const c=require('./capacitor.config.json'); c.server && c.server.url ? new URL(c.server.url).hostname : ''")"
  if [ -z "$APP_BOUND_HOST" ]; then
    echo "ERROR: capacitor.config.json has no server.url; set WKAppBoundDomains for bundled mode by hand." >&2
    exit 1
  fi
  /usr/libexec/PlistBuddy -c "Delete :WKAppBoundDomains" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :WKAppBoundDomains array" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :WKAppBoundDomains:0 string $APP_BOUND_HOST" "$PLIST"
  echo "==> Info.plist WKAppBoundDomains = $APP_BOUND_HOST ✓"
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

# The privacy manifest only counts when it is in the App target's resources;
# App Review rejects a build without it. Attach it with the xcodeproj gem that
# CocoaPods ships (idempotent). Without that gem, say so and leave the manual
# Xcode step below.
# Run Ruby with the xcodeproj gem, through the same Ruby CocoaPods runs on.
# Homebrew's `pod` is a wrapper that sets GEM_HOME and execs libexec/bin/pod,
# whose shebang names Homebrew's Ruby; a `gem install cocoapods` pod is itself
# a Ruby script. `realpath` (not `readlink -f`, missing on older macOS)
# resolves the symlink. Every probe tolerates no match: under pipefail a
# failed grep would end the bootstrap.
POD_BIN="$(command -v pod || true)"
POD_REAL="$POD_BIN"
if [ -n "$POD_BIN" ]; then
  POD_REAL="$(realpath "$POD_BIN" 2>/dev/null || readlink -f "$POD_BIN" 2>/dev/null || echo "$POD_BIN")"
fi
POD_GEM_HOME="$( { [ -n "$POD_REAL" ] && grep -o 'GEM_HOME="[^"]*"' "$POD_REAL" 2>/dev/null | head -1 | cut -d'"' -f2; } || true)"
POD_SCRIPT="$POD_REAL"
if [ -n "$POD_GEM_HOME" ] && [ -f "$POD_GEM_HOME/bin/pod" ]; then POD_SCRIPT="$POD_GEM_HOME/bin/pod"; fi
POD_RUBY="ruby"
POD_SHEBANG="$( { [ -n "$POD_SCRIPT" ] && head -1 "$POD_SCRIPT" 2>/dev/null | sed -n 's/^#![[:space:]]*//p' | cut -d' ' -f1; } || true)"
if [ -n "$POD_SHEBANG" ] && [ -x "$POD_SHEBANG" ] && [ "$(basename "$POD_SHEBANG")" != "env" ]; then POD_RUBY="$POD_SHEBANG"; fi
xcodeproj_ruby() {
  if [ -n "$POD_GEM_HOME" ]; then GEM_HOME="$POD_GEM_HOME" "$POD_RUBY" "$@"; else "$POD_RUBY" "$@"; fi
}
if (cd ios/App && xcodeproj_ruby -e '
  require "xcodeproj"
  project = Xcodeproj::Project.open("App.xcodeproj")
  target = project.targets.find { |t| t.name == "App" } or abort("no App target")
  group = project.main_group.find_subpath("App", false) or abort("no App group")
  # Reuse a reference an earlier manual Add Files left (maybe without target
  # membership); membership is checked on its own.
  ref = group.files.find { |f| f.path == "PrivacyInfo.xcprivacy" } || group.new_reference("PrivacyInfo.xcprivacy")
  phase = target.resources_build_phase
  phase.add_file_reference(ref, true) unless phase.files_references.include?(ref)
  project.save
'); then
  PRIVACY_ATTACHED=1
  echo "==> PrivacyInfo.xcprivacy is in the App target ✓"
else
  echo "==> WARN: could not attach PrivacyInfo.xcprivacy automatically — add it to the App target in Xcode (step below)."
fi

# UIScene life cycle. Apps built with the iOS 27 SDK (Xcode 27) quit at
# launch without it: "UIScene life cycle is required for apps built with this
# SDK" (found 2026-10-05 in the simulator; 1.7 build 2026100501 has this
# bug). The Capacitor 7 template has no scene. Add a SceneDelegate that only
# forwards links to Capacitor (UIKit now delivers them to the scene, not the
# AppDelegate) and a scene manifest that keeps the Main storyboard. The
# manifest is written only after the delegate is in the App target, so a
# build never names a class it does not contain.
SCENE_SWIFT="ios/App/App/SceneDelegate.swift"
if [ ! -f "$SCENE_SWIFT" ]; then
  cat > "$SCENE_SWIFT" <<'SWIFT'
import UIKit
import UserNotifications
import Capacitor

// Written by scripts/mobile/bootstrap-ios.sh. Apps built with the iOS 27 SDK
// must use the UIScene life cycle or they quit at launch. The Main storyboard
// (UISceneStoryboardFile in Info.plist) still creates the window and
// Capacitor's bridge view controller; this delegate only forwards links to
// Capacitor, which UIKit now delivers to the scene instead of the AppDelegate.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        if let context = connectionOptions.urlContexts.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: [:])
        }
        if let activity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
        }
        // A push tapped while the app was closed. With scenes, Capacitor's
        // NotificationRouter becomes the notification-center delegate only
        // when its bridge loads, after launch, so UIKit hands this tap only to
        // the scene. Pass it on once the push plugin's handler exists; the
        // plugin retains pushNotificationActionPerformed until JS listens.
        if let response = connectionOptions.notificationResponse {
            pendingNotificationResponse = response
            deliverPendingNotificationResponse(delay: 0.1)
        }
    }

    // Kept until Capacitor's push handler exists, however long the bridge
    // takes to load; dropped only if the scene goes away.
    private var pendingNotificationResponse: UNNotificationResponse?

    private func deliverPendingNotificationResponse(delay: TimeInterval) {
        guard let response = pendingNotificationResponse else { return }
        let center = UNUserNotificationCenter.current()
        if let router = center.delegate as? NotificationRouter, router.pushNotificationHandler != nil {
            pendingNotificationResponse = nil
            router.userNotificationCenter(center, didReceive: response, withCompletionHandler: {})
            return
        }
        // Check often at first, then once a second.
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.deliverPendingNotificationResponse(delay: min(delay * 2, 1.0))
        }
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        pendingNotificationResponse = nil
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: [:])
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
}
SWIFT
fi
if (cd ios/App && xcodeproj_ruby -e '
  require "xcodeproj"
  project = Xcodeproj::Project.open("App.xcodeproj")
  target = project.targets.find { |t| t.name == "App" } or abort("no App target")
  group = project.main_group.find_subpath("App", false) or abort("no App group")
  ref = group.files.find { |f| f.path == "SceneDelegate.swift" } || group.new_reference("SceneDelegate.swift")
  phase = target.source_build_phase
  phase.add_file_reference(ref, true) unless phase.files_references.include?(ref)
  project.save
'); then
  SCENE_KEY=":UIApplicationSceneManifest"
  SCENE_CFG="$SCENE_KEY:UISceneConfigurations:UIWindowSceneSessionRoleApplication:0"
  /usr/libexec/PlistBuddy -c "Delete $SCENE_KEY" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy \
    -c "Add $SCENE_KEY dict" \
    -c "Add $SCENE_KEY:UIApplicationSupportsMultipleScenes bool false" \
    -c "Add $SCENE_KEY:UISceneConfigurations dict" \
    -c "Add $SCENE_KEY:UISceneConfigurations:UIWindowSceneSessionRoleApplication array" \
    -c "Add $SCENE_CFG dict" \
    -c "Add $SCENE_CFG:UISceneConfigurationName string Default Configuration" \
    -c "Add $SCENE_CFG:UISceneDelegateClassName string \$(PRODUCT_MODULE_NAME).SceneDelegate" \
    -c "Add $SCENE_CFG:UISceneStoryboardFile string Main" \
    "$PLIST"
  echo "==> UIScene life cycle: SceneDelegate in the App target, scene manifest in Info.plist ✓"
else
  echo "ERROR: could not add SceneDelegate.swift to the App target; an iOS 27 SDK build would quit at launch." >&2
  exit 1
fi

# Shared scheme, release version and signing team. Xcode Cloud builds only a
# shared scheme and cannot take build settings on a command line, and the
# generated project has neither a shared scheme nor a team. The version and
# the team are written only when the caller names them
# (client/ios/App/ci_scripts/ci_post_clone.sh does); a local bootstrap keeps
# the template values and Xcode's own team choice.
if (cd ios/App && WAVES_IOS_MARKETING_VERSION="${WAVES_IOS_MARKETING_VERSION:-}" WAVES_IOS_TEAM_ID="${WAVES_IOS_TEAM_ID:-}" xcodeproj_ruby -e '
  require "xcodeproj"
  project = Xcodeproj::Project.open("App.xcodeproj")
  target = project.targets.find { |t| t.name == "App" } or abort("no App target")
  version = ENV["WAVES_IOS_MARKETING_VERSION"].to_s
  team = ENV["WAVES_IOS_TEAM_ID"].to_s
  abort("WAVES_IOS_MARKETING_VERSION must look like 1.7 or 1.7.1") unless version.empty? || version.match?(/\A\d+(\.\d+){1,2}\z/)
  abort("WAVES_IOS_TEAM_ID must be a 10-character team id") unless team.empty? || team.match?(/\A[A-Z0-9]{10}\z/)
  target.build_configurations.each do |c|
    c.build_settings["MARKETING_VERSION"] = version unless version.empty?
    c.build_settings["DEVELOPMENT_TEAM"] = team unless team.empty?
  end
  project.save
  scheme_file = Xcodeproj::XCScheme.shared_data_dir(project.path) + "App.xcscheme"
  unless scheme_file.exist?
    scheme = Xcodeproj::XCScheme.new
    scheme.configure_with_targets(target, nil, launch_target: true)
    scheme.save_as(project.path, "App", true)
  end
'); then
  echo "==> Shared App scheme present; version ${WAVES_IOS_MARKETING_VERSION:-(template)}, team ${WAVES_IOS_TEAM_ID:-(not set)} ✓"
else
  echo "ERROR: could not write the shared App scheme, version or team into App.xcodeproj." >&2
  exit 1
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
if [ "${PRIVACY_ATTACHED:-0}" != "1" ]; then
  cat <<'NOTES'
   • PrivacyInfo.xcprivacy is not in the App target yet: File → Add Files to "App"…
     → select App/PrivacyInfo.xcprivacy → check "App" target membership
     (required for the Filesystem plugin's file-timestamp declaration).
NOTES
fi
cat <<'NOTES'
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

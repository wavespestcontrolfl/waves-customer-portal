#!/usr/bin/env bash
#
# bootstrap-android.sh — stand up the Waves customer Android app (Capacitor shell).
#
# Mirrors bootstrap-ios.sh. Prereqs (any OS with a JDK):
#   - Android Studio (or the Android SDK + platform-tools)   sdkmanager --version
#   - JDK 17+                                                 java -version
#   - A Google Play Console account (register as the ORG / LLC — see notes)
#   - A Firebase project for FCM push (provides google-services.json)
#
# What it does:
#   1. installs the exact lockfile-pinned Capacitor deps (incl. Android)
#   2. verifies the slim native fallback shell (client/native-shell/index.html)
#      — the native app loads https://portal.wavespestcontrol.com remotely, so
#      bundling client/dist would copy ~95 MB of unused marketing/admin files
#      into the .aab
#   3. generates the native Android project at client/android (idempotent)
#   4. syncs the slim shell + native plugins, Waves launcher/adaptive icons,
#      splash screen, monochrome notification icon, SDK 36 pin, and App Links
#   5. prints the manual steps (Firebase, signing, Play) and opens Android Studio
#
# Run from the repo root:  bash scripts/mobile/bootstrap-android.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/client"

install_brand_assets() {
  local res_root="${WAVES_ANDROID_RES_ROOT:-android/app/src/main/res}"
  local icon_src="resources/icon.png"
  local splash_src="resources/splash-2732x2732.png"

  if [ ! -f "$icon_src" ] || [ ! -d "$res_root" ]; then
    echo "==> ERROR: icon source or Android res directory missing — refusing to ship the Capacitor default." >&2
    return 1
  fi

  # Generate/copy launcher & adaptive foreground icons across all density buckets.
  # Uses sharp (installed at workspace root) for crisp downscaling when available,
  # falling back to copying the 1024px source so asset installation stays reliable.
  WAVES_ICON_SRC="$icon_src" WAVES_RES_ROOT="$res_root" node -e '
    const fs = require("fs");
    const path = require("path");
    const src = process.env.WAVES_ICON_SRC;
    const res = process.env.WAVES_RES_ROOT;
    let sharp = null;
    try { sharp = require("sharp"); } catch { /* fallback to raw copy */ }
    const buckets = [
      ["mipmap-mdpi", 48, 108],
      ["mipmap-hdpi", 72, 162],
      ["mipmap-xhdpi", 96, 216],
      ["mipmap-xxhdpi", 144, 324],
      ["mipmap-xxxhdpi", 192, 432],
    ];
    (async () => {
      for (const [dir, legacySize, fgSize] of buckets) {
        const outDir = path.join(res, dir);
        fs.mkdirSync(outDir, { recursive: true });
        for (const name of ["ic_launcher.png", "ic_launcher_round.png"]) {
          const dest = path.join(outDir, name);
          if (sharp) await sharp(src).resize(legacySize, legacySize).png().toFile(dest);
          else fs.copyFileSync(src, dest);
        }
        const fgDest = path.join(outDir, "ic_launcher_foreground.png");
        if (sharp) {
          // Adaptive icons mask the outer ~18% bleed; keep the artwork safely centered inside the 66% safe zone.
          const inset = Math.round(fgSize * 0.70);
          const pad = Math.floor((fgSize - inset) / 2);
          const padRight = fgSize - inset - pad;
          await sharp(src)
            .resize(inset, inset)
            .extend({ top: pad, bottom: padRight, left: pad, right: padRight, background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toFile(fgDest);
        } else {
          fs.copyFileSync(src, fgDest);
        }
      }
    })().catch((err) => { console.error(err); process.exit(1); });
  '

  mkdir -p "$res_root/mipmap-anydpi-v26" "$res_root/values" "$res_root/drawable"
  cat > "$res_root/values/ic_launcher_background.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#1299DE</color>
</resources>
XML

  for name in ic_launcher.xml ic_launcher_round.xml; do
    cat > "$res_root/mipmap-anydpi-v26/$name" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
XML
  done
  echo "==> Waves launcher & adaptive icons installed into $res_root ✓"

  # Monochrome status-bar notification icon (Android renders non-monochrome
  # launcher icons as solid white squares in the status bar).
  cat > "$res_root/drawable/ic_stat_waves.xml" <<'XML'
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M2,13.5C4.5,11 6.5,11 9,13.5C11.5,16 13.5,16 16,13.5C18.5,11 20.5,11 22,12.5V16.5C20.5,15 18.5,15 16,17.5C13.5,20 11.5,20 9,17.5C6.5,15 4.5,15 2,17.5V13.5ZM2,7.5C4.5,5 6.5,5 9,7.5C11.5,10 13.5,10 16,7.5C18.5,5 20.5,5 22,6.5V10.5C20.5,9 18.5,9 16,11.5C13.5,14 11.5,14 9,11.5C6.5,9 4.5,9 2,11.5V7.5Z" />
</vector>
XML

  cat > "$res_root/values/waves_colors.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="waves_notification_color">#04395E</color>
</resources>
XML
  echo "==> Android monochrome notification icon & accent color installed ✓"

  if [ -f "$splash_src" ]; then
    cp "$splash_src" "$res_root/drawable/splash.png"
    for dir in "$res_root"/drawable-port-* "$res_root"/drawable-land-*; do
      [ -d "$dir" ] && cp "$splash_src" "$dir/splash.png"
    done
    echo "==> Waves splash installed into $res_root/drawable*/splash.png ✓"
  else
    echo "==> WARNING: splash source missing — keeping Capacitor default splash."
  fi
}

inject_fcm_manifest_metadata() {
  local manifest="${1:-${WAVES_ANDROID_MANIFEST:-android/app/src/main/AndroidManifest.xml}}"
  [ -f "$manifest" ] || return 0
  local ind="        "
  local nl=$'\n'
  local fcm_meta="${ind}<meta-data android:name=\"com.google.firebase.messaging.default_notification_icon\" android:resource=\"@drawable/ic_stat_waves\" />${nl}"
  fcm_meta="${fcm_meta}${ind}<meta-data android:name=\"com.google.firebase.messaging.default_notification_color\" android:resource=\"@color/waves_notification_color\" />${nl}"
  fcm_meta="${fcm_meta}${ind}<meta-data android:name=\"com.google.firebase.messaging.default_notification_channel_id\" android:value=\"waves_service_updates\" />"
  FCM_META="$fcm_meta" perl -0pi -e '
    s{\n?[ \t]*<meta-data\b[^>]*android:name="com\.google\.firebase\.messaging\.default_notification_(?:icon|color|channel_id)"[^>]*/>}{}gs;
    s{(\n\s*</application>)}{\n$ENV{FCM_META}$1};
  ' "$manifest"
  echo "==> FCM default notification icon, color, and channel injected into $manifest ✓"
}

# Reinstall tracked Waves Android icons/splash/notification drawables without
# running npm, Capacitor, or Android Studio. Safe for hermetic fixture tests.
if [ "${1:-}" = "--assets-only" ]; then
  install_brand_assets
  if [ -n "${WAVES_ANDROID_MANIFEST:-}" ]; then
    inject_fcm_manifest_metadata "$WAVES_ANDROID_MANIFEST"
  fi
  exit 0
fi

echo "==> 1/5  Installing lockfile-pinned native dependencies…"
# Run from client/ intentionally: npm resolves the workspace root lockfile.
# `npm ci` refuses drift instead of silently moving Capacitor/plugin versions
# between release builds.
npm ci

echo "==> 2/5  Verifying slim native shell (native-shell/)…"
# capacitor.config.json sets server.url = https://portal.wavespestcontrol.com
# and webDir = native-shell, keeping the .aab slim instead of bundling ~95 MB
# of unreachable marketing media and admin bundles from dist/.
test -f native-shell/index.html || { echo "ERROR: client/native-shell/index.html missing." >&2; exit 1; }

if [ ! -d "android" ]; then
  echo "==> 3/5  Generating native Android project (client/android)…"
  npx cap add android
else
  echo "==> 3/5  Native Android project already exists — skipping cap add."
fi

echo "==> 4/5  Syncing web + plugins into the Android project…"
npx cap sync android

# Reapply tracked Waves launcher icons, adaptive icons, monochrome notification
# icon, and splash screen after every add/sync so a fresh checkout never ships
# the stock Capacitor branding.
install_brand_assets

# Push (FCM) needs google-services.json from your Firebase project. If it's present
# at the repo path below, copy it into the Android app module so the build picks it up.
GS_SRC="$ROOT/client/google-services.json"
GS_DEST="android/app/google-services.json"
if [ -f "$GS_SRC" ]; then
  cp "$GS_SRC" "$GS_DEST"
  echo "==> Copied google-services.json into android/app/ ✓"
else
  echo "==> NOTE: google-services.json not found at client/google-services.json —"
  echo "    Android push (FCM) will be inert until you add it (see step 5)."
fi

# Google Play policies:
# - Play automatic protection requires minSdkVersion >= 24 (the Capacitor 7
#   template defaults to 23 and Play Console refuses the bundle at upload).
# - Releases must target Android 16 (API 36) by Aug 31, 2026 (template is 35).
# compileSdk 36 needs AGP >= 8.9.1 (the template's 8.7.x tops out at 35);
# client/android persists across bootstraps, so pin all SDK levels here.
ANDROID_MIN_SDK=24
ANDROID_TARGET_SDK=36
ANDROID_AGP_VERSION=8.9.2
perl -pi -e "s/^(\s*minSdkVersion = )\d+/\${1}$ANDROID_MIN_SDK/" android/variables.gradle
perl -pi -e "s/^(\s*(?:compileSdkVersion|targetSdkVersion) = )\d+/\${1}$ANDROID_TARGET_SDK/" android/variables.gradle
perl -pi -e "s/(com\.android\.tools\.build:gradle:)[0-9.]+/\${1}$ANDROID_AGP_VERSION/" android/build.gradle
if grep -q "minSdkVersion = $ANDROID_MIN_SDK" android/variables.gradle \
   && grep -q "compileSdkVersion = $ANDROID_TARGET_SDK" android/variables.gradle \
   && grep -q "targetSdkVersion = $ANDROID_TARGET_SDK" android/variables.gradle \
   && grep -q "gradle:$ANDROID_AGP_VERSION" android/build.gradle; then
  echo "==> Pinned min SDK $ANDROID_MIN_SDK + compile/target SDK $ANDROID_TARGET_SDK + AGP $ANDROID_AGP_VERSION ✓"
else
  echo "==> ERROR: could not pin SDK $ANDROID_MIN_SDK/$ANDROID_TARGET_SDK / AGP $ANDROID_AGP_VERSION —"
  echo "    check android/variables.gradle and android/build.gradle by hand."
  exit 1
fi

# Targeting API 36 flips android:enableOnBackInvokedCallback to default-TRUE,
# which stops delivering onBackPressed/KEYCODE_BACK — Capacitor 7's bridge (and
# the @capacitor/app backButton listener) depend on those, so the system back
# gesture would exit the app instead of navigating the webview back. Pin the
# legacy behavior explicitly until Capacitor ships predictive-back support.
MANIFEST="android/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ] && ! grep -q 'enableOnBackInvokedCallback' "$MANIFEST"; then
  perl -0pi -e 's{(<application\b)}{$1\n        android:enableOnBackInvokedCallback="false"}' "$MANIFEST"
fi
if grep -q 'android:enableOnBackInvokedCallback="false"' "$MANIFEST"; then
  echo "==> Pinned enableOnBackInvokedCallback=false (Capacitor back handling) ✓"
else
  echo "==> ERROR: could not pin enableOnBackInvokedCallback=false in $MANIFEST."
  exit 1
fi

# Android App Links: verified https://portal.wavespestcontrol.com URLs open the
# installed app directly. Needs (a) this autoVerify intent-filter on MainActivity
# and (b) the server serving /.well-known/assetlinks.json with the Play signing
# cert fingerprints (GATE_UNIVERSAL_LINKS — see docs/mobile/universal-links.md).
#
# Android intent-filters have no exclude syntax, so unlike the iOS AASA this is
# an ALLOWLIST of customer link surfaces — claiming the whole host would grab
# /api/... links too (direct PDF/report URLs in SMS/email would open a raw API
# response in the webview instead of the browser download flow — codex P1 on
# #2496). A path not listed here simply keeps opening in the browser; when a
# new customer link surface ships, add its prefix here, in
# server/services/messaging/email-link-policy.js APP_LINK_PATH_PREFIXES (the
# same list: emailed links to these paths skip SendGrid's click rewrite so
# they reach the app), AND rebuild. server/tests/mobile-bootstrap-pinning.test.js
# fails when the two lists differ or a customer route in client/src/App.jsx is
# in neither the list nor its documented browser-only set.
# NOTE: pathPrefix is a plain string prefix — '/l/' and '/r/' need the trailing
# slash or they'd swallow /login, /report, /reschedule, etc.
#
# Idempotent by REPLACEMENT, not by skipping: client/android persists across
# bootstraps (gitignored, generated once), so a filter injected by an earlier
# script revision — or an outdated allowlist — must not survive a re-run.
# Every run strips ALL autoVerify intent-filters and re-injects the current
# one; this script is the source of truth for the block. MainActivity is the
# only activity in the Capacitor template, so the first </activity> is safe
# to target.
MANIFEST="android/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ]; then
  # /r/ (referral links) is deliberately ABSENT: referral-links.js 302s those
  # to the marketing site, which would strand the app's webview off-portal —
  # they belong in the browser (iOS AASA excludes them too).
  APP_LINK_PREFIXES="/l/ /track /pay /billing /receipt /report /pest-report /rate /prep /reschedule /estimate /contract /recap /review /book /login /quote /lawn-report /service-outlines /appointment /secure /visit /reservice /inspection /price-change /moving"
  IND="            "
  NL=$'\n'
  FILTER="${IND}<intent-filter android:autoVerify=\"true\">${NL}"
  FILTER="${FILTER}${IND}    <action android:name=\"android.intent.action.VIEW\" />${NL}"
  FILTER="${FILTER}${IND}    <category android:name=\"android.intent.category.DEFAULT\" />${NL}"
  FILTER="${FILTER}${IND}    <category android:name=\"android.intent.category.BROWSABLE\" />${NL}"
  # http as well as https: texted links carry no scheme (the SMS link policy
  # strips https://) and the phone opens them as http://, which an https-only
  # filter never matched, so every texted link opened Chrome. Verification
  # still runs over https; the web handler upgrades http to https
  # (client/src/native/nativeLinks.js upgradeOwnHostHttp).
  FILTER="${FILTER}${IND}    <data android:scheme=\"http\" />${NL}"
  FILTER="${FILTER}${IND}    <data android:scheme=\"https\" android:host=\"portal.wavespestcontrol.com\" />${NL}"
  FILTER="${FILTER}${IND}    <data android:path=\"/\" />${NL}"
  for p in $APP_LINK_PREFIXES; do
    FILTER="${FILTER}${IND}    <data android:pathPrefix=\"$p\" />${NL}"
  done
  FILTER="${FILTER}${IND}</intent-filter>"
  export FILTER
  # Strip any previous autoVerify filter(s), then inject the current one.
  perl -0pi -e 's{\n[ \t]*<intent-filter android:autoVerify="true">.*?</intent-filter>}{}gs' "$MANIFEST"
  perl -0pi -e 's{(\n\s*</activity>)}{\n$ENV{FILTER}$1}' "$MANIFEST"
  if grep -q 'android:autoVerify="true"' "$MANIFEST"; then
    echo "==> App Links intent-filter (re)injected into AndroidManifest.xml (customer-path allowlist) ✓"
  else
    echo "==> WARNING: could not inject the App Links intent-filter — add it to"
    echo "    MainActivity in $MANIFEST manually (see docs/mobile/universal-links.md)."
  fi

  # FCM defaults: monochrome status-bar icon, Waves navy accent color, and
  # default high-priority service-updates channel (matches server/services/fcm.js).
  inject_fcm_manifest_metadata "$MANIFEST"
fi

# Optional release versioning for reproducible Play Console builds (mirrors
# WAVES_IOS_MARKETING_VERSION in bootstrap-ios.sh).
APP_GRADLE="android/app/build.gradle"
if [ -f "$APP_GRADLE" ]; then
  if [ -n "${WAVES_ANDROID_VERSION_NAME:-}" ]; then
    [[ "$WAVES_ANDROID_VERSION_NAME" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]] || {
      echo "ERROR: WAVES_ANDROID_VERSION_NAME must look like 1.9 or 1.9.1" >&2; exit 1;
    }
    perl -pi -e "s/^(\s*versionName\s+)\"[^\"]+\"/\${1}\"$WAVES_ANDROID_VERSION_NAME\"/" "$APP_GRADLE"
    echo "==> Android versionName set to $WAVES_ANDROID_VERSION_NAME ✓"
  fi
  if [ -n "${WAVES_ANDROID_VERSION_CODE:-}" ]; then
    [[ "$WAVES_ANDROID_VERSION_CODE" =~ ^[0-9]+$ ]] || {
      echo "ERROR: WAVES_ANDROID_VERSION_CODE must be a positive integer" >&2; exit 1;
    }
    perl -pi -e "s/^(\s*versionCode\s+)[0-9]+/\${1}$WAVES_ANDROID_VERSION_CODE/" "$APP_GRADLE"
    echo "==> Android versionCode set to $WAVES_ANDROID_VERSION_CODE ✓"
  fi
fi

echo
echo "==> 5/5  Manual steps:"
cat <<'NOTES'
   FIREBASE (push):
     • Create a Firebase project, add an Android app with package id
       com.wavespestcontrol.portal, download google-services.json, and place it at
       client/google-services.json (this script copies it into android/app/).
     • In the Firebase console → Project settings → Service accounts → generate a
       private key. Put that JSON (whole file, as one string) in the Railway env
       var FCM_SERVICE_ACCOUNT so the backend (server/services/fcm.js) can send.
     • Confirm @capacitor/push-notifications' Android setup is applied (Google
       Services Gradle plugin) after `cap sync`.

   SIGNING:
     • Generate an upload keystore:
         keytool -genkey -v -keystore waves-upload.keystore -alias waves \
           -keyalg RSA -keysize 2048 -validity 10000
     • Configure it in android/app/build.gradle (signingConfigs) or
       android/keystore.properties (keep the keystore OUT of git).

   APP LINKS (universal links):
     • Play re-signs releases, so /.well-known/assetlinks.json must carry the
       Play "App signing key certificate" SHA-256 (Play Console → Setup →
       App signing) — include the upload cert too so local builds verify.
       Set both, comma-separated, in the Railway env var
       ANDROID_ASSETLINKS_SHA256, then GATE_UNIVERSAL_LINKS=true.
     • Verify on-device after install:
         adb shell pm get-app-links com.wavespestcontrol.portal
       (portal.wavespestcontrol.com should show "verified".)

   GOOGLE PLAY:
     • Register the Play Console account as the ORGANIZATION (Waves Pest Control,
       LLC). This (a) shows "Waves Pest Control" as the developer name and
       (b) exempts you from the new-personal-account closed-testing requirement
       (~20 testers for 14 days).
     • Build a release bundle:  cd android && ./gradlew bundleRelease   (→ .aab)
     • Upload the .aab in Play Console; fill Data Safety, content rating, and
       point the listing's website link at the hub (https://www.wavespestcontrol.com).

   Then run on a device/emulator from Android Studio:
NOTES
if [ "${CI:-}" = "true" ]; then
  echo "==> CI mode: native project synced; skipping Android Studio launch."
else
  npx cap open android
fi

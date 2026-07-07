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
#   1. installs/updates the Capacitor deps in client/ (incl. @capacitor/android)
#   2. builds the web app into client/dist (the webDir Capacitor copies)
#   3. generates the native Android project at client/android (idempotent)
#   4. syncs web assets + native plugins into the Android project
#   5. prints the manual steps (Firebase, signing, Play) and opens Android Studio
#
# Run from the repo root:  bash scripts/mobile/bootstrap-android.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/client"

echo "==> 1/5  Installing Capacitor deps (pinning to latest majors)…"
npm install \
  @capacitor/core@latest @capacitor/cli@latest @capacitor/android@latest \
  @capacitor/push-notifications@latest @capacitor/app@latest \
  @capacitor/status-bar@latest @capacitor/splash-screen@latest \
  @capacitor/filesystem@latest @capacitor/share@latest

echo "==> 2/5  Building web bundle (dist/)…"
npm run build

if [ ! -d "android" ]; then
  echo "==> 3/5  Generating native Android project (client/android)…"
  npx cap add android
else
  echo "==> 3/5  Native Android project already exists — skipping cap add."
fi

echo "==> 4/5  Syncing web + plugins into the Android project…"
npx cap sync android

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
npx cap open android

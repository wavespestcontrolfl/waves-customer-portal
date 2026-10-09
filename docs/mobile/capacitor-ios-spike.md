# Waves customer iOS app — Capacitor spike

Wraps the existing customer PWA (`portal.wavespestcontrol.com`) in a native iOS
shell so it can ship on the App Store and use APNs push. **No rewrite** — the
same React/Vite app runs inside a `WKWebView`; we add a native push bridge on top.

## Why this is small

The portal is already a full PWA: `manifest.json` (standalone), `sw.js`
(offline + push handlers), and web-push (VAPID) end-to-end. The only thing the
web can't do well on iOS is push outside an installed PWA — so the native shell
exists mainly to (a) get an App Store listing and (b) swap web-push → APNs.

## What's in this spike

| File | Purpose |
|---|---|
| `client/capacitor.config.json` | App id `com.wavespestcontrol.portal`, name "Waves", load mode (remote vs bundled), push/splash plugin config. JSON (not `.ts`) because the client is a pure-JS project — a `.ts` config would force a TypeScript dependency. |
| `client/src/native/nativePush.js` | APNs registration — `@capacitor/core` `isNativePlatform()` guard + dynamic import of `@capacitor/push-notifications`; caches the token pre-login and flushes it after auth. **No-op on web** |
| `client/src/main.jsx` | Calls `initNativePush()` after mount (guarded) |
| `client/package.json` | Capacitor deps + `cap:*` scripts |
| `scripts/mobile/bootstrap-ios.sh` | One command: install → build → `cap add ios` → sync → open Xcode |
| `docs/mobile/apns-backend-pr-plan.md` | The backend follow-up (DB + APNs sender + subscribe route) |

The generated Xcode project (`client/ios/`) is gitignored — regenerate it with
the bootstrap script. The one tracked folder inside it is
`client/ios/App/ci_scripts` (see Xcode Cloud below).

## Run the spike (macOS)

Prereqs: Xcode (full app), CocoaPods (`brew install cocoapods`), an Apple
Developer account.

```bash
bash scripts/mobile/bootstrap-ios.sh
```

The script configures **Push Notifications** and connects the entitlement file
to every App build configuration. Then in Xcode: pick your signing Team, add
**Background Modes → Remote notifications**, and run on a **real
device** (push doesn't work in the simulator).

## Check the signed release before upload

Allowing notification permission does not prove that the installed binary has
the APNs entitlement. The signed customer app must contain `aps-environment`;
App Store and TestFlight exports must use `production`.

After exporting the IPA, run:

```bash
python3 scripts/mobile/ios_push.py verify /path/to/Waves.ipa
```

The check also accepts a signed `.app` directory. It inspects the actual code
signature and rejects missing push entitlements, a development environment,
or the wrong bundle identifier. For a development-signed device build, pass
`--environment development`. This checks push entitlement configuration;
delivery still needs a physical-device registration and notification test.

If it fails, enable Push Notifications for the App ID, refresh its signing
profile in Xcode, rebuild, and export again. A portal web deployment cannot
change an entitlement in an installed iOS binary. See Apple's
[APS entitlement documentation](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment).

## Xcode Cloud

Xcode Cloud clones the repository, and the clone has no Xcode project. It runs
`client/ios/App/ci_scripts/ci_post_clone.sh` first, which installs Node (the
`.nvmrc` major, from nodejs.org) and CocoaPods and then runs
`bootstrap-ios.sh` with `CI=true`. The bootstrap also writes what a cloud build
needs and a command line cannot supply there: a shared `App` scheme, the
release version and the signing team.

Workflow settings in App Store Connect → Xcode Cloud:

- **Start condition:** branch `main`. A branch without this script fails in
  under a minute with "Workspace App.xcworkspace does not exist".
- **Version:** `ci_post_clone.sh` holds the default (`DEFAULT_MARKETING_VERSION`).
  Raise it in a PR when App Review approves that version, or set the workflow
  environment variable `WAVES_IOS_MARKETING_VERSION` for one build.
- **Build number:** Xcode Cloud counts from 1. Local uploads use a date number
  (`2026100503`), so set Settings → Build Number → next build number above the
  last upload of the same version, or App Store Connect refuses the build.
- Run the push check in the section above on the cloud build's IPA
  (Artifacts) before a first submission from Xcode Cloud.

To run the same steps on a Mac: `bash client/ios/App/ci_scripts/ci_post_clone.sh`.

## Load modes (set in `capacitor.config.json`)

- **MODE A — remote (spike default):** `server.url` points at the live portal.
  Fastest path; web deploys ship without resubmitting the app; the Bearer-JWT
  session (localStorage) + socket.io work unchanged (same-origin). Best for
  proving the wrapper + push.
- **MODE B — bundled (hardening):** remove the `server` block; the app loads the
  static `dist/` build locally. Needs the client to call the API at an absolute
  base + CORS for those calls. Auth is a Bearer JWT in localStorage, so there's
  no cookie/SameSite work. Works offline and reads as a "real" native app to
  Apple review.

## Offline opening (app-bound domains)

In MODE A the app loads the live portal each time. iOS exposes service workers
inside a `WKWebView` only to domains listed in the app's `WKAppBoundDomains`,
so without that list the portal's offline copy (`client/public/sw.js`) never
installs and the app shows a blank screen with no signal.

- `bootstrap-ios.sh` writes `WKAppBoundDomains` into `Info.plist` from the
  host of `server.url` (`portal.wavespestcontrol.com`) on every run.
- `capacitor.config.json` sets `ios.limitsNavigationsToAppBoundDomains: true`;
  Capacitor needs it to keep its plugin bridge working once the list exists.
- Result: after one online open, the app opens offline from the saved copy
  (including the tech Today page's last saved route). The first open after an
  install still needs signal, and iOS may evict the copy when storage is low.
- Switching to MODE B (no `server.url`) makes the bootstrap stop with an error:
  set the bundled-mode domain list by hand then.

Test on TestFlight before each submission that ships this setting. The list
limits the app to the listed domain, so check every part that loads another
company's page:

1. Stripe card form (`client/src/lib/stripeLoader.js`). If it fails, add
   Stripe's domain to the list (iOS allows up to 10 entries).
2. Google address suggestions in the estimate and customer forms.
3. Cloudflare Turnstile on public forms.
4. Google Maps in the tech treatment-zone screen.
5. Links to other sites open in Safari.
6. Push, Face ID unlock, camera photos, universal links.
7. Open once online, turn on Airplane Mode, force-quit, reopen: the app opens.
8. Merge a small portal change: the app shows it on the next open.

Rollback: remove the setting from `capacitor.config.json` and the plist step,
rebuild and resubmit.

## Known follow-ups before submission

1. **Backend APNs** — **Shipped.** See `apns-backend-pr-plan.md`; the
   `/api/push/native-subscribe` endpoint (`server/routes/push.js`) exists and
   `nativePush.js` already posts to it.
2. **App Store Guideline 4.2 ("minimum functionality").** A thin web wrapper can
   be rejected. Lean on native capabilities to justify the app: APNs push (this
   spike), Face ID unlock, camera upload for service photos, native share. MODE B
   (offline) also helps.
3. **Customer-scoped shell.** The portal serves admin/tech/customer behind one
   `/login`. For the App Store *customer* app, scope the shell to the customer
   experience (land on the customer home post-login; don't expose `/admin`,
   `/tech`) so review sees a focused consumer app.
4. **Icons & splash.** Provide 1024px App Store icon + launch assets.
5. **Android** comes nearly free later: `npx cap add android` + a Play listing.

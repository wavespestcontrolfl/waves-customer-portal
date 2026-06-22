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
| `client/capacitor.config.ts` | App id `com.wavespestcontrol.portal`, name "Waves", load mode (remote vs bundled), push/splash plugin config |
| `client/src/native/nativePush.js` | Guarded APNs registration via the injected `window.Capacitor` bridge — **no-op on web** |
| `client/src/main.jsx` | Calls `initNativePush()` after mount (guarded) |
| `client/package.json` | Capacitor deps + `cap:*` scripts |
| `scripts/mobile/bootstrap-ios.sh` | One command: install → build → `cap add ios` → sync → open Xcode |
| `docs/mobile/apns-backend-pr-plan.md` | The backend follow-up (DB + APNs sender + subscribe route) |

The generated Xcode project (`client/ios/`) is gitignored — regenerate it with
the bootstrap script.

## Run the spike (macOS)

Prereqs: Xcode (full app), CocoaPods (`brew install cocoapods`), an Apple
Developer account.

```bash
bash scripts/mobile/bootstrap-ios.sh
```

Then in Xcode: pick your signing Team, add the **Push Notifications** and
**Background Modes → Remote notifications** capabilities, and run on a **real
device** (push doesn't work in the simulator).

## Load modes (set in `capacitor.config.ts`)

- **MODE A — remote (spike default):** `server.url` points at the live portal.
  Fastest path; web deploys ship without resubmitting the app; the Bearer-JWT
  session (localStorage) + socket.io work unchanged (same-origin). Best for
  proving the wrapper + push.
- **MODE B — bundled (hardening):** remove the `server` block; the app loads the
  static `dist/` build locally. Needs the client to call the API at an absolute
  base + CORS for those calls. Auth is a Bearer JWT in localStorage, so there's
  no cookie/SameSite work. Works offline and reads as a "real" native app to
  Apple review.

## Known follow-ups before submission

1. **Backend APNs** — see `apns-backend-pr-plan.md` (the `/api/push/native-subscribe`
   endpoint that `nativePush.js` posts to does not exist yet).
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

# Universal links / Android App Links

Goal: every existing `portal.wavespestcontrol.com` link — tracking links,
invoices, reports, reschedules, and every `/l/:code` short link in an SMS —
opens **inside the installed Waves app** instead of Safari/Chrome, with zero
template changes. Customers without the app see no difference. Transactional
links therefore stay portal URLs forever; the app claims them at the OS level.

## How it works

1. The server serves two association files (routes/well-known.js, dark behind
   `GATE_UNIVERSAL_LINKS`):
   - `/.well-known/apple-app-site-association` — team ID from `APPLE_TEAM_ID`
     (falls back to `APNS_TEAM_ID`, the same team that signs push). Excludes
     `/admin/*`, `/tech/*`, `/api/*`.
   - `/.well-known/assetlinks.json` — fingerprints from
     `ANDROID_ASSETLINKS_SHA256` (comma-separated). 404s until that's set.
2. The binaries carry the claim:
   - iOS: Associated Domains entitlement `applinks:portal.wavespestcontrol.com`
     (bootstrap-ios.sh writes `App/App.entitlements`; Xcode manual check in its
     step-5 notes).
   - Android: `autoVerify` intent-filter on MainActivity (bootstrap-android.sh
     injects it after `cap sync` — client/android is gitignored, so the script
     is the source of truth). Android has no path-exclude syntax, so the
     filter is an ALLOWLIST of customer link prefixes (`/l/`, `/r/`, `/track`,
     `/pay`, `/report`, …) — `/api`, `/admin`, `/tech` are never claimed, and
     a path not on the list keeps opening in the browser. New customer link
     surface ⇒ add its prefix in bootstrap-android.sh AND rebuild.
3. In the app, Capacitor fires `appUrlOpen` / `getLaunchUrl` with the tapped
   URL; `client/src/native/nativeLinks.js` navigates the webview to the same
   path (same-origin only). The shell loads the remote portal, so short-link
   302s, auth guards, and staff-path redirects behave exactly as on the web.

## Rollout order (any order is safe, nothing happens until ALL are true)

1. Merge + deploy this PR (routes 404 → no behavior change).
2. Rebuild binaries via the bootstrap scripts + `npx cap sync` (rides the same
   rebuild as #2490's Filesystem/Share plugins and the new store screenshots).
3. Set Railway env:
   - `ANDROID_ASSETLINKS_SHA256` = Play Console → Setup → App signing →
     **App signing key certificate** SHA-256, plus the **Upload key
     certificate** SHA-256, comma-separated. (Play re-signs installs — the
     app-signing cert is the one that matters on customer phones.)
   - `APPLE_TEAM_ID` only if it should differ from `APNS_TEAM_ID` (it
     shouldn't — same developer account).
4. Flip `GATE_UNIVERSAL_LINKS=true` (Adam).
5. Ship the rebuilt binaries through the stores (Apple new-version submission,
   Play update; Samsung/Microsoft ride the same binaries).

Kill switch: unset `GATE_UNIVERSAL_LINKS`. Both files 404; iOS (Apple's CDN
re-fetches periodically) and Android (re-verification) fall back to opening
links in the browser. No client update needed.

## Verification

- `curl -si https://portal.wavespestcontrol.com/.well-known/apple-app-site-association`
  → 200, `Content-Type: application/json`, appID `<TEAM>.com.wavespestcontrol.portal`.
- Apple CDN view (what devices actually consume, ~can lag hours):
  `curl -s https://app-site-association.cdn-apple.com/a/v1/portal.wavespestcontrol.com`
- Android statement check:
  `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://portal.wavespestcontrol.com&relation=delegate_permission/common.handle_all_urls`
- On-device: `adb shell pm get-app-links com.wavespestcontrol.portal` →
  `verified`; iOS: long-press a portal link in Notes → "Open in Waves" appears.
- End-to-end: text yourself any `/l/...` short link → tap → opens in the app
  on the target page; uninstall the app → same link opens in the browser.

## Gotchas

- iOS caches the AASA per-install (refreshes on app install/update and on its
  own cadence) — a stale 404 from before the gate flip fixes itself after a
  reinstall or an OS re-fetch; don't debug the entitlement first.
- Tapping a link **inside** the app's own webview never bounces through the
  OS — universal links only apply from other apps (Messages, Mail, browser).
- The client handler also refuses /admin, /tech, /api and any URL whose
  pathname starts with `//` (protocol-relative smuggling) — keep that guard;
  it backstops the association files.

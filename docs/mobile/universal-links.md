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
     filter is an ALLOWLIST of customer link prefixes (`/l/`, `/track`,
     `/pay`, `/billing`, `/report`, …) — `/api`, `/admin`, `/tech` are never
     claimed, and a path not on the list keeps opening in the browser. `/r/`
     referral links are excluded on BOTH platforms: they 302 to the marketing
     site, which would strand the app's webview off-portal. New customer link
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

## Diagnosing an app that opens on home

The web handler reports native link stages through the existing
`POST /api/client-errors` receiver. In Sentry, filter
`client_context:native-links` and `native_platform:ios` (or `android`).
`link_source` distinguishes boot, the launch lookup, and a live `appUrlOpen`
event. `link_route` is the current document's route family; `link_target` is
the destination family. These labels never contain the link, estimate token,
query string, customer information or a device identifier.

| Outcome | Meaning |
| --- | --- |
| `started` / `listener-ready` | Native detection passed / the native listener registered. |
| `plugin-error` / `listener-error` | The JS import failed / the native listener failed to register. An installed JS package does not prove the plugin was compiled into the binary. |
| `empty` | The launch lookup returned no URL; this also happens on ordinary icon opens. |
| `lookup-error` / `lookup-timeout` | The launch lookup rejected / remained unresolved for five seconds. A timeout does not cancel a later result. |
| `received` / `rejected` | The handler received a permitted URL / refused the URL before consumption or navigation. |
| `replay-skipped` | The launch URL matches the existing storage marker. `link_route:home` is worth checking during a link-open reproduction; it is not proof of a cold start. |
| `superseded` | A live event was handled during startup, so the launch lookup did not overwrite it. |
| `navigation-requested` / `navigation-failed` | Navigation was attempted / the navigation call failed synchronously. A request is not proof the destination rendered. |
| `already-current` | The destination is already the current URL. |
| `storage-unavailable` | The replay marker could not be read or written; navigation remains best-effort, and redirect-loop protection cannot be guaranteed. |

Normal stages are informational and have a budget of 10/min per IP and 20/min
globally. Bridge, storage and navigation failures share the existing crash
report budgets of 30/min per IP and 60/min globally. The same limiters use
separate keys so routine native activity cannot hide error reports. Telemetry
is best-effort. Missing telemetry is not proof that the OS never delivered a
URL. No stable per-device identifier is collected, so aggregate events are
not a correlated per-customer navigation trace.

Keep the existing launch marker until a replacement has device evidence. It
prevents a short link from looping `assign -> 302 -> boot -> assign`. Explicit
events bypass the marker. On iOS, an event-delivered URL stamps it before
navigation so the next document does not replay that tap. Android's launch
lookup retains the original launch URL, so its events preserve that original
marker instead. When an Android event wins a startup race, the superseded
lookup is consumed without navigating so it cannot replay on the next boot.
A synchronous navigation failure restores the previous marker.
Unit tests with cleared storage do not establish how WKWebView behaves across
a native cold start.

For device verification, use an owner-created test estimate and record the app
version, iOS version and test time. Do not use a live customer's link.

1. From Messages or Notes, open a fresh short link after force-quitting the
   installed customer app. Confirm the estimate renders and stays stable.
2. Force-quit again and open that same link. Then try a different short link.
3. Repeat both links with the app in the background, including after viewing
   an estimate or another server-rendered page. Also test a direct estimate
   URL to separate redirect behavior from URL delivery.
4. Inspect the native `AppDelegate` universal-link forwarding and Capacitor
   App-plugin registration if the app opens but neither delivery path carries
   the link. A correct AASA only establishes the association.
5. Check the matching diagnostic time window and confirm there is no repeated
   short-link request loop. Use Safari's device inspector to confirm the
   destination loaded; `navigation-requested` alone does not establish that.

The generated customer shell is `client/ios/` (see the bootstrap procedure
above); the checked-in `ios/WavesPay` project is a different application.

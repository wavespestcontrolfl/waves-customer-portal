# Lock Screen visit card (iOS Live Activity)

Owner 2026-11-11: "do this first Visit day on the Lock Screen". On visit day an iPhone with the Waves app
shows one live card on its Lock Screen when the technician goes on the way. The card follows the visit:
on the way, arrived, service complete. Gate: `GATE_VISIT_LIVE_ACTIVITY` (dark by default).

This page is the contract between the iPhone app and the server. Both sides must change together.

## How it works

1. The app asks iOS for its ActivityKit **push-to-start token** and posts it to the server.
2. When a visit goes on the way, the server makes one Apple **broadcast channel** for the stop and sends a
   start push to each of the customer's registered iPhones. The start names the channel
   (`input-push-channel`), so the new card listens on it.
3. Each later step is one broadcast on that channel. The card updates with the app closed.
4. The last broadcast ends the card. The server then removes the channel.

Channel updates need iOS 18 or later. Apple's Broadcast Capability must be on for the app id
(developer.apple.com → Certificates, IDs & Profiles → Identifiers → the app id → Push Notifications).

## Registration: `POST /api/push/live-activity-token`

Customer session (the same bearer token as `/api/push/native-subscribe`). A contact session and a
cancelled account cannot reach it.

Request body:

| Field | Type | Meaning |
|---|---|---|
| `deviceToken` | string, required | The APNs device token this app posted to `/api/push/native-subscribe`. It names the phone's row. |
| `startToken` | string, optional | The push-to-start token as lowercase or uppercase hex (32 to 512 characters). Absent, null or empty clears the stored token. |
| `osVersion` | string, optional | The iOS version, for example `18.5.1`. The server keeps the major number. |
| `enabled` | boolean, optional | `false` when Live Activities are off for the app in iOS Settings. Clears the stored token. |

Response: `200 { "ok": true, "stored": true | false }`. `stored` is `true` only when a start token was saved
on this phone's row. It is `false` when the gate is off, when the token was cleared, or when no active
account-holder iPhone row matched the device token. `400` for a missing device token or a start token that
is not hex. The response is `Cache-Control: no-store`.

The app posts again whenever iOS hands it a new push-to-start token, and each time it comes to the front.

## The app side: where it lives and how it is built

Tracked sources, in `client/resources/visit-card/`:

| File | Built into | What it is |
|---|---|---|
| `WavesVisitAttributes.swift` | The app and the extension | The card's data type (next section). One file, compiled into both. |
| `WavesVisitCardPlugin.swift` | The app | Capacitor plugin `WavesVisitCard`. `status()` answers `{ supported, enabled, osVersion, startToken? }`. `endAll()` ends this app's cards. A `startToken` event fires when iOS hands the app a new token. |
| `WavesVisitCardWidget.swift`, `Info.plist` | The `WavesVisitCard` extension | The widget extension that draws the card on the Lock Screen and in the Dynamic Island. |

The native project is generated, not tracked. `scripts/mobile/bootstrap-ios.sh` puts the card in only when
`WAVES_IOS_VISIT_CARD=1` is set (it runs `scripts/mobile/ios_visit_card.rb`): the plugin goes into the App
target, the `WavesVisitCard` extension target (iOS 18 or later, bundle id
`com.wavespestcontrol.portal.VisitCard`) is embedded in the app, `NSSupportsLiveActivities` goes into the
app's Info.plist, and the plugin class goes into `packageClassList` so Capacitor registers it at launch.
Without the variable the project has no card.

- GitHub CI (`native-ios`) sets the variable, so the Swift compiles on every mobile change.
- A release build takes the card when the variable is set in its Xcode Cloud workflow (App Store Connect →
  Xcode Cloud → the workflow → Environment → Environment Variables). `ci_post_clone.sh` runs the bootstrap
  with the workflow's environment.
- The first release build with the card needs an App ID for the extension (automatic signing makes it) and
  Apple's Broadcast Capability on the app's own App ID.

An app build without the card is safe with the web code that talks to it: the web code asks Capacitor
whether the `WavesVisitCard` plugin exists and does nothing when it does not.

## The card's data

The Swift type is `WavesVisitAttributes` (`ATTRIBUTES_TYPE` in `server/services/apns-live-activity.js`).
Apple matches the name as text, so a rename needs both sides and a new app version.

Static attributes (set at start):

| Key | Type | Meaning |
|---|---|---|
| `visitRef` | string | An opaque id for this card. Not a customer or visit id. |

Content state (sent at start and in every update). Strings and one integer only; the app must use the
default JSON coding (Apple: no custom encoding strategies).

| Key | Type | Meaning |
|---|---|---|
| `phase` | string | `en_route`, `on_property` or `complete`. Drives the step marks. |
| `title` | string | The main line, for example "Sam is on the way". |
| `detail` | string | The second line: the service name. |
| `step` | integer | 1, 2 or 3. |

The server writes the words, so wording can change without a new app version. An unknown `phase` must still
show `title` and `detail`.

## Apple requests the server sends

All are in `server/services/apns-live-activity.js`, signed with the same provider token as other pushes.

| Request | Where | Notes |
|---|---|---|
| Start | `POST /3/device/<start token>` on the push host | `apns-push-type: liveactivity`, `apns-topic: <bundle id>.push-type.liveactivity`. Payload `event: start` with `attributes-type`, `attributes`, `content-state`, `input-push-channel`, `alert`. No sound. |
| Update / end | `POST /4/broadcasts/apps/<bundle id>` on the push host | `apns-channel-id` header. Payload `event: update` or `event: end` (with `dismissal-date`). |
| Make / remove a channel | `POST` / `DELETE /1/apps/<bundle id>/channels` on the manage host (port 2196 production, 2195 sandbox) | Storage policy 1: Apple keeps the newest message for a phone that was offline. |

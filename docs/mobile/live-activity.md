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
4. The last broadcast ends the card. The server removes the channel 9 hours later (Apple keeps a channel's
   newest message for a phone that was offline, so a late phone still hears the end).

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

## When the server starts, updates and ends a card

`server/services/visit-live-activity.js`. The card is a picture of the visit: each pass reads the visit as it
is and makes the card agree. A pass runs when the customer's in-app tracker is told to refresh, and every
2 minutes for every live card.

| Visit | Card |
|---|---|
| The technician goes on the way | Starts, step 1: "{technician} is on the way". |
| The technician arrives | Step 2: "{technician} has arrived". If no card started on the way, one starts here. |
| Service complete | Step 3: "Service complete". The card ends and stays on the Lock Screen 15 minutes. |
| Cancelled, no-show, moved to another day or technician, or rewound | Ends and leaves the Lock Screen at once. |
| On the way for 45 minutes with no arrival | `stale-date` passes: the app shows the stale look. At 90 minutes the server takes the card down. |
| On the property for 2 hours with no completion | Stale. At 3 hours the server takes the card down. |
| The gate goes off | Every live card is taken down within 2 minutes. |

A card starts only inside the first 20 minutes of its step, once per step, and only when all of these hold:
the gate is on, the customer is on the allowlist (when one is set), the customer's "technician on the way"
notice is on, appointment notices go to the account holder, their app notifications are on, and an active
account-holder iPhone on iOS 18 or later has a start token. One card per stop: the customer, the saved address, the ET day and the technician. Two
services at one address share one card and its second line names both.

What the app must do:

- Show `title` and `detail` as sent. Draw the step marks from `step` (1 to 3).
- Give the card a stale look when iOS reports it stale (`context.isStale`): the visit has had no news past
  its usual time. Do not show a time or an ETA; the server sends none.
- End its own cards on sign-out. A channel reaches every card that listens on it, so the server cannot
  stop one phone.
- Post the start token again after sign-in: the token is stored on the signed-in phone's own row.

The start push carries an alert (Apple requires one): title "Waves", body the title line. It has no sound;
the on-the-way notice already made one.

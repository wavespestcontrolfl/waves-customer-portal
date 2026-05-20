# Communications Callback, Voicemail, and Storage Setup

## Callback button

The Calls tab uses the existing outbound bridge endpoint:

- `POST /api/admin/communications/call`
- The server calls the admin phone first.
- The admin presses `1`.
- Twilio bridges to the customer and records the call.

Rows launched from call history are tagged in `call_log.source` as
`admin-callback` and include `metadata.relatedCallId` when the callback came
from an existing call row.

## Voicemail

The failure mode is direct cell forwarding. If Adam or Virginia's carrier
voicemail answers a forwarded inbound call, Twilio treats the call as answered
and the caller reaches the personal cell voicemail instead of Waves voicemail.

The app-owned inbound fallback now screens forwarded staff legs:

1. Caller hears the Waves disclosure greeting.
2. Twilio simul-rings the configured staff numbers.
3. The staff leg hears `Waves inbound call. Press 1 to accept.`
4. If nobody presses `1`, the call falls through to the Waves voicemail
   recorder in `/api/webhooks/twilio/call-complete`.

Required env:

- `WAVES_FALLBACK_FORWARD_NUMBERS=+19415993489,+17206334021`
- `WAVES_GREETING_URL=<approved disclosure greeting MP3>`
- `WAVES_VOICEMAIL_URL=<Waves voicemail greeting MP3>`
- `SERVER_DOMAIN=portal.wavespestcontrol.com`

If `WAVES_FALLBACK_FORWARD_NUMBERS` is not set, the app falls back to existing
staff phone env vars (`OWNER_PHONE`, `ADAM_PHONE`, `VIRGINIA_PHONE`,
`OFFICE_MANAGER_PHONE`, `WAVES_OFFICE_MANAGER_PHONE`) so deployed environments
do not silently stop ringing staff during rollout. Set
`WAVES_FALLBACK_FORWARD_NUMBERS` explicitly in production to control the exact
ring list.

Production note: inbound voice currently enters Twilio Studio before it reaches
this repo. To make the fix active for real calls, either point the production
Twilio numbers at `/api/webhooks/twilio/voice`, or update the Studio Flow so
its forward step uses a TwiML/Function leg with the same press-1 screening
behavior.

If Studio remains the production entrypoint, also change its voicemail
transcription callback from the legacy email Twimlet to:

`https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/transcription`

Keep the recording status callback pointed at:

`https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/recording-status`

## Storage Model

SMS is already stored in both:

- `sms_log` for legacy reporting and scheduled-message consumers
- `messages` for the unified AI-ready communications timeline

Voice calls and voicemail are stored in:

- `call_log` for call processing, extraction, disposition, and recordings
- `messages` for the unified AI-ready communications timeline

The database stores transcript text, Twilio SIDs, durations, statuses, and
recording metadata. Raw audio stays with Twilio; the portal serves playback
through the authenticated `/api/admin/call-recordings/audio/:id` proxy.

Future agent retrieval should prefer `messages` for chronology and join to
`call_log` only when it needs processing metadata such as `ai_extraction`,
`lead_synopsis`, or call disposition.

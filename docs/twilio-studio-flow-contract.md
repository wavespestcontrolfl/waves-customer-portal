---
title: Twilio Studio Flow Contract — Waves Inbound
status: active
date: 2026-04-29
owner: Adam (operator) + repo (verifier)
---

# Studio Flow Contract — "Waves Inbound — All Numbers"

## Why this doc exists

Production inbound voice does not hit any code in this repo. Every Waves
Twilio number's `voiceUrl` points at a Twilio Studio Flow
(`FW5fdc2e44700c6e786ed27de94e0cbace`, friendly name *"Waves Inbound —
All Numbers"*). The Flow plays the greeting, simul-rings field
contacts, records, and falls through to voicemail on no-answer. The
portal's `/voice` webhook is a fallback, not the production entry
point.

That means the most operationally-critical caller-facing behavior —
the recording disclosure, the dial-out targets, the recording-callback
URL — lives outside git. A careless Studio Console edit could silently
break compliance, routing, or recording ingestion, and nothing in the
repo would catch it.

This contract makes that invisible surface auditable without taking on
the operational burden of full Flow-as-code deploys (overkill for the
current change cadence — see the Studio-as-code-or-not analysis below).

## Architecture

```
Inbound call to any Waves Twilio number
  → Studio Flow FW5fdc2e44... (Trigger → say_play_2)
      • plays the ElevenLabs disclosure greeting
        (operative FL §934.03 consent surface)
  → forward_call (connect-call-to widget)
      • simul-rings Adam + Virginia, 30s, record=true
  → on call complete:
      → post_recording_to_portal (make-http-request)
        POSTs CallSid, RecordingSid, RecordingUrl, RecordingDuration,
        RecordingStatus to /api/webhooks/twilio/recording-status
      → say_play_1 (plays voicemail asset)
      → record_voicemail_3 (records + transcribes voicemail; emails
        transcript to contact@wavespestcontrol.com via twimlets)
```

The portal also receives a *standard* signed Twilio
`recordingStatusCallback` triggered by `record: true` on the
`forward_call` widget. That callback is the canonical source of
recording metadata; the Studio HTTP widget is treated as redundant
during the PR1 log-mode burn-in and may be removed once parity is
proven.

## Contract invariants

The verify script (`npm run twilio:flow:verify`) MUST fail if any of
these drift. Manual drift via the Twilio Console without a contract
update is a bug, not a feature.

### Identity
- `friendly_name === "Waves Inbound — All Numbers"`
- Flow SID matches `FW5fdc2e44700c6e786ed27de94e0cbace` OR an
  explicitly documented replacement SID in this file
- All production Twilio numbers (every entry in
  `server/config/twilio-numbers.js` location/domain/lawn lists, plus
  the toll-free chat number) point their `voiceUrl` at this Flow's
  webhook URL. Numbers in the `unassigned` block are exempt.

### Disclosure-first ordering
- The first caller-facing state on the `incomingCall` event is a
  `say-play` widget (currently `say_play_2`)
- That widget references the approved ElevenLabs disclosure asset:
  `https://jet-wolverine-3713.twil.io/assets/ElevenLabs_2025-09-20T05_54_14_Veda%20Sky%20-%20Customer%20Care%20Agent_pvc_sp114_s58_sb72_se89_b_m2.mp3`
- No state with type `connect-call-to`, `record-voicemail`, or any
  other recording-capable widget appears in the flow graph between
  Trigger and the disclosure widget. The disclosure plays before any
  recording starts.
- If the asset URL is rotated, the new asset MUST contain
  recording/transcription/AI-processing language in the spoken audio.
  Update §15 of `docs/call-triage-discovery.md` when this happens.

### Approved disclosure copy
The audio is the operative consent surface. The verbatim spoken text
of the approved asset (as confirmed 2026-04-29 by Adam):

> *Adam: confirm and paste the verbatim transcript of the ElevenLabs
> asset here so compliance does not depend on someone replaying audio
> from memory. Until that's done, this contract treats the asset URL
> itself as the canonical artifact.*

### Call routing
- A `connect-call-to` widget exists, currently named `forward_call`
- `noun === "number-multi"` (simul-ring, not single-target)
- `to` is a CSV of two NANP E.164 numbers, each matching `^\+1\d{10}$`
- `timeout === 30`
- `record === true`
- `caller_id === "{{contact.channel.address}}"` (preserves caller's
  original number into the simul-ring leg, so Adam/Virginia see who
  is calling)

**Strict forward-target verification.** The committed Flow snapshot
redacts the actual numbers to `<<FORWARD_NUMBERS>>` so personal cells
stay out of git history. To still get drift detection on the live
numbers, set `TWILIO_EXPECTED_FORWARD_NUMBERS` (CSV of E.164) in
Railway env and any local `.env` used by ops:

```
TWILIO_EXPECTED_FORWARD_NUMBERS=+19415993489,+17206334021
```

When set, `npm run twilio:flow:verify` asserts the live
`connect-call-to.to` list matches this CSV exactly (order-independent).
If unset, the verifier falls back to a suffix soft-check (warns when
known suffixes are missing) and emits a configuration warning.
**Recommendation:** set the env var so prod Railway always runs strict
verification.

When the routing pair changes intentionally, update
`TWILIO_EXPECTED_FORWARD_NUMBERS` in Railway env BEFORE editing the
Studio Console — that way the verifier catches the misalignment as a
single check rather than after several real calls.

### Recording callback
- `forward_call` automatically fires Twilio's standard signed
  `recordingStatusCallback` when `record: true`. The Flow's
  `make-http-request` widget (`post_recording_to_portal`) is
  considered redundant during log-mode burn-in.
- Any HTTP-request widget that POSTs to the portal must hit:
  `https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/recording-status`
- `content_type === "application/x-www-form-urlencoded;charset=utf-8"`
  (form-encoded body required for `validateRequest` to validate against
  `X-Twilio-Signature` correctly; switching to JSON would require a
  separate validation path on the portal side).
- `add_twilio_auth: false` is fine — see signature-validation note
  below.

### Voicemail
- A `record-voicemail` state exists (currently `record_voicemail_3`)
- `transcribe === true`
- `transcription_callback_url === "https://twimlets.com/voicemail?Email=contact@wavespestcontrol.com"`
  (current legacy email pipe — moves to portal in a future PR; track
  here when changed)
- `recording_status_callback_url === "https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/recording-status"`
- `max_length` is reasonable (≥120s, ≤3600s; current value: 3600)
- A `say-play` voicemail-prompt widget plays before the record state
  (currently `say_play_1` plays
  `https://voicemail-9557.twil.io/waves-voicemail.mp3`)

## Signature validation note

The `make-http-request` widget's `add_twilio_auth` field controls
**HTTP Basic auth** (Account SID + Auth Token), used for requests *to
Twilio APIs*. It is NOT a toggle for `X-Twilio-Signature`. Per Twilio
helper-library cluster tests, Studio `make-http-request` requests
*can* arrive at non-Twilio endpoints with a valid `X-Twilio-Signature`
header signed by the account auth token, even with
`add_twilio_auth: false`. PR1's signature middleware is the auth
boundary; this widget should validate cleanly during log-mode
observation. Proof or invalidation of that claim is a PR1 burn-in
deliverable.

If the Studio widget's request is found to NOT include
`X-Twilio-Signature`, the resolution is to **remove the widget** (the
standard `recordingStatusCallback` is canonical) or replace it with a
Twilio Function that signs the request — NOT to add a Basic Auth
exception to the portal's signature middleware.

## Manual change-management process

When you (Adam) edit the Studio Flow in the Twilio Console:

1. Before editing, capture current state:
   ```
   npm run twilio:flow:export
   ```
   This pulls the live Flow JSON and writes it to
   `ops/twilio/studio/waves-inbound-all-numbers.snapshot.json` (with
   personal cell numbers redacted). Compare to git to see if anyone
   else has touched the Flow since the last sync.

2. Make the change in the Studio Console. Publish the new revision.

3. Validate the change against this contract:
   ```
   npm run twilio:flow:verify
   ```
   Exits non-zero if any invariant above is broken.

4. Re-export and commit:
   ```
   npm run twilio:flow:export
   git add ops/twilio/ docs/twilio-studio-flow-contract.md
   git commit -m "docs(twilio): update Studio Flow snapshot to revision N"
   ```
   Include the reason in the commit body — *what changed and why*.

5. Push. Git history now shows the Studio change alongside the
   contract update.

If a change to the Flow requires a contract update (e.g., simul-ring
adds a third number), update both the contract and the snapshot in the
same commit.

## When to graduate to full Flow-as-code

Move to GitOps deploys (CI applies snapshot to staging Flow → publish
on merge to main) only if:

- Studio is edited monthly or more
- More than one person edits the Flow
- A staging/prod Flow split is needed
- A bad manual edit breaks production
- Compliance audit requires provable deployed-artifact control

Until then, the contract + drift-check pattern catches the failure
modes that matter (silent disclosure breakage, routing change,
callback URL change) without the cost of owning a deploy pipeline for
something that changes quarterly.

## Replacement SID log

When the Flow SID changes (e.g., a fresh Flow is created during a
larger redesign), document it here so the verify script's identity
check can be updated.

| Date | Old SID | New SID | Reason |
|---|---|---|---|
| (none) | — | `FW5fdc2e44700c6e786ed27de94e0cbace` | initial baseline |

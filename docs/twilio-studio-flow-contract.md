---
title: Twilio Studio Flow Contract - Waves Inbound Legacy Rollback
status: legacy-rollback
date: 2026-05-25
owner: Adam (operator) + repo (verifier)
---

# Studio Flow Contract - Legacy Rollback

## Current Production Routing

Production inbound voice is app-owned as of 2026-05-25. All 25 configured
Waves Twilio numbers in `server/config/twilio-numbers.js` point their voice URL
at:

```text
https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/voice
```

The production app route:

1. Plays the approved Waves disclosure greeting.
2. Simul-rings `WAVES_FALLBACK_FORWARD_NUMBERS`.
3. Requires the staff leg to press `1` before the caller is bridged.
4. Routes no-answer, busy, failed, or completed-without-press-1 legs to the
   Waves-owned voicemail recorder.
5. Writes `call_log` and unified conversation records through the portal.

Use `npm run twilio:inbound:audit -- --mode=app --expected-drift=0 --days=1`
to verify production routing. The expected production result is:

- 25 configured numbers matched in Twilio.
- `driftCount=0`.
- No configured Waves number points at the Studio Flow.

## Legacy Flow

The old Studio Flow still exists as rollback/forensics only:

- SID: `FW5fdc2e44700c6e786ed27de94e0cbace`
- Friendly name: `Waves Inbound — All Numbers`
- Last verified revision before cutover: 14

It is not the active production entrypoint for configured Waves numbers.

## Why It Was Retired

The Studio Flow played the disclosure greeting, then used a `connect-call-to`
widget to simul-ring staff cell phones:

```text
Trigger incomingCall
  -> say_play_2 disclosure greeting
  -> forward_call connect-call-to number-multi, timeout 30, record true
  -> post_recording_to_portal
  -> say_play_1 voicemail greeting
  -> record_voicemail_3
```

That design had an operational flaw: carrier voicemail on a forwarded staff
cell could answer the leg, causing Twilio to treat the call as answered before
the caller reached Waves voicemail. The app-owned route fixes that by requiring
`Press 1 to accept`.

## Rollback Procedure

Rollback should be temporary and targeted. Prefer rolling back one number first,
then auditing before moving more traffic.

Rollback one number to Studio:

```bash
npm run twilio:inbound:set-url -- --mode=studio --number=+19413187612 --apply
npm run twilio:inbound:audit -- --mode=app --expected-drift=1 --days=1
```

Rollback all configured numbers to Studio:

```bash
npm run twilio:inbound:set-url -- --mode=studio --apply
npm run twilio:inbound:audit -- --mode=studio --expected-drift=0 --days=1
```

After rollback, immediately verify:

- calls ring the expected staff numbers;
- recording callbacks still reach `/api/webhooks/twilio/recording-status`;
- voicemail transcription behavior is acceptable;
- `call_log` receives inbound rows.

## Legacy Flow Invariants

If the Studio Flow is used for rollback, these invariants still matter:

- `friendly_name === "Waves Inbound — All Numbers"`
- Flow SID matches `FW5fdc2e44700c6e786ed27de94e0cbace`.
- First caller-facing state on `incomingCall` is the approved disclosure
  `say-play` widget.
- `forward_call` uses `number-multi`, `timeout=30`, and `record=true`.
- `forward_call.to` matches `TWILIO_EXPECTED_FORWARD_NUMBERS`.
- Recording callbacks point at:
  `https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/recording-status`
- Voicemail recording exists and is transcribed.

`npm run twilio:flow:verify` remains available for rollback verification, but
it no longer represents active production routing.

## Change Management

Going forward, Twilio number voice URL changes should use:

```bash
npm run twilio:inbound:set-url -- --mode=app --apply
npm run twilio:inbound:audit -- --mode=app --expected-drift=0 --days=1
```

Do not edit the Studio Flow as if it were production primary. If Studio is
modified for rollback readiness, export a fresh snapshot and document why.

## Cutover Record

| Date | Change | Result |
|---|---|---|
| 2026-05-25 | Canary `+19412412459` moved to app webhook | Press-1 and voicemail paths verified |
| 2026-05-25 | `+17206334021` added back to app forward list | Two-person child legs verified |
| 2026-05-25 | Remaining configured Waves numbers moved to app webhook | Final app audit `driftCount=0` |
| 2026-05-25 | Audit corrected to exclude synthetic `outbound-api` test-call parent legs | Twilio true inbound total matched portal `call_log` total |

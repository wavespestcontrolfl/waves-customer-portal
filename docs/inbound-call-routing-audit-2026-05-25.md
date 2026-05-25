# Inbound Call Routing Audit - 2026-05-25

## Summary

Production inbound voice was controlled by Twilio Studio Flow
`FW5fdc2e44700c6e786ed27de94e0cbace` (`Waves Inbound - All Numbers`),
revision 14, updated 2026-05-01, before this cutover.

All 25 Waves Twilio numbers configured in `server/config/twilio-numbers.js`
now point their voice URL at the app route:

```text
https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/voice
```

Studio is no longer the production entrypoint for configured Waves numbers.

The Studio Flow still routes callers to two staff cell phones after the
greeting:

```text
Trigger incomingCall
  -> say_play_2 disclosure greeting
  -> forward_call connect-call-to number-multi, timeout 30, record true
  -> post_recording_to_portal
  -> say_play_1 voicemail greeting
  -> record_voicemail_3
```

The Flow does not use the app-owned `inbound-forward-screen` press-1 step. That
means a staff carrier voicemail can answer the forwarded leg and Twilio will
treat the call as answered before the caller reaches Waves voicemail. This is
why production was moved to the app route.

## Evidence

- `TWILIO_EXPECTED_FORWARD_NUMBERS` is set in Railway from the live Flow's
  current forward targets. `npm run twilio:flow:verify` passes with zero
  warnings.
- Twilio incoming-number audit found 25 expected portal numbers and 25 matched
  Twilio numbers. No configured Waves number was missing from the live Twilio
  account.
- Each matched number uses the Flow voice URL:
  `https://webhooks.twilio.com/v1/Accounts/.../Flows/FW5fdc2e44700c6e786ed27de94e0cbace`.
- Twilio call-record audit for the trailing 30 days found:
  - 297 inbound calls to configured Waves numbers.
  - 516 child call legs, all to the two staff forward targets.
  - Staff child-leg statuses: 231 completed, 285 no-answer.
  - The two staff targets were balanced evenly at 258 legs each.
- Portal DB audit for the same trailing 30-day window found:
  - 281 inbound `call_log` rows.
  - 205 rows with recording URLs.
  - 202 rows with transcriptions.
  - 15 rows marked voicemail.
  - Warning: portal `call_log` inbound total is 16 lower than Twilio's inbound
    parent-call total for the same window. Track this during rollout.
- Final post-cutover audit at 2026-05-25 03:19 ET:
  - `mode=app`, `expected-drift=0`
  - 25 expected numbers, 25 matched in Twilio
  - `driftCount=0`
  - Production health endpoint returned OK
- Follow-up audit at 2026-05-25 03:22 ET corrected the Twilio-side call count
  filter to exclude synthetic `outbound-api` parent legs from controlled test
  calls. Result: Twilio true inbound total `11`, portal `call_log` inbound
  total `11`, no warnings.

## Existing App Capability

`server/routes/twilio-voice-webhook.js` already has the safer fallback behavior:

1. Play the Waves disclosure greeting.
2. Simul-ring `WAVES_FALLBACK_FORWARD_NUMBERS`.
3. On each staff leg, require `Press 1 to accept`.
4. If nobody accepts, fall through to the Waves-owned voicemail recorder.

This is the behavior we want production callers to use.

Production env for this path:

- `GATE_TWILIO_VOICE=true`
- `GATE_WEBHOOKS=true`
- `WAVES_FALLBACK_FORWARD_NUMBERS` explicitly set to the two-person forward
  list.
- `TWILIO_EXPECTED_FORWARD_NUMBERS` explicitly set to the same list.
- `WAVES_GREETING_URL` explicitly set to the current Studio disclosure greeting.
- `WAVES_VOICEMAIL_URL` set to the Waves voicemail MP3.

## Repeatable Audit Commands

Local shell, using app Twilio vars plus the Postgres public URL:

```bash
APP_VARS=$(railway variables --kv --service waves-customer-portal)
PG_VARS=$(railway variables --kv --service Postgres)
TWILIO_ACCOUNT_SID=$(printf "%s\n" "$APP_VARS" | awk -F= '/^TWILIO_ACCOUNT_SID=/{sub(/^TWILIO_ACCOUNT_SID=/,"");print}')
TWILIO_AUTH_TOKEN=$(printf "%s\n" "$APP_VARS" | awk -F= '/^TWILIO_AUTH_TOKEN=/{sub(/^TWILIO_AUTH_TOKEN=/,"");print}')
DATABASE_URL=$(printf "%s\n" "$PG_VARS" | awk -F= '/^DATABASE_PUBLIC_URL=/{sub(/^DATABASE_PUBLIC_URL=/,"");print}')

TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
DATABASE_URL="$DATABASE_URL" \
NODE_ENV=production \
npm run twilio:inbound:audit -- --days=30
```

Dry-run a one-number move to the app webhook:

```bash
TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
npm run twilio:inbound:set-url -- --mode=app --number=+19413187612
```

Apply the one-number canary only after the app deploy is healthy:

```bash
TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
npm run twilio:inbound:set-url -- --mode=app --number=+19413187612 --apply
```

Rollback that number to Studio:

```bash
TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
npm run twilio:inbound:set-url -- --mode=studio --number=+19413187612 --apply
```

## Strategy

### Completed Path: Production Voice URLs Moved To The App Webhook

All production Twilio number voice URLs were changed from the Studio Flow to:

```text
https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/voice
```

Keep SMS URLs and call status callbacks unchanged.

Why this is the preferred path:

- The press-1 screening code already exists and is versioned in git.
- Future routing changes become normal app changes instead of manual Studio
  edits.
- The fallback route records calls, logs them, supports spam blocking, and
  routes no-answer callers to Waves voicemail.
- It removes the Studio Flow's legacy voicemail transcript email Twimlet from
  the primary path.

Rollout completed:

1. Confirmed production env includes:
   - `GATE_TWILIO_VOICE=true`
   - `GATE_WEBHOOKS=true`
   - `WAVES_FALLBACK_FORWARD_NUMBERS=<approved staff CSV>`
   - `WAVES_GREETING_URL=<approved disclosure MP3>`
   - `WAVES_VOICEMAIL_URL=<Waves voicemail MP3>`
2. Ran a single-number pilot on low-risk van tracking number `+19412412459`.
3. Tested calls:
   - Staff presses 1 and connects.
   - Staff ignores; caller reaches Waves voicemail.
   - Staff prompt leg completes without `Digits=1`; caller reaches Waves
     voicemail, not personal voicemail.
4. Reviewed Twilio call logs and portal call recording ingestion.
5. Updated the remaining 24 numbers in batches.
6. Ran final zero-drift app-mode audit.

Post-canary checks:

```bash
npm run twilio:inbound:audit -- --mode=app --expected-drift=24 --days=1
npm run twilio:inbound:audit -- --mode=studio --expected-drift=1 --days=1
```

After full cutover, app-mode audit should have `driftCount: 0`.

## Canary Status

As of 2026-05-25 02:26 ET, the low-volume van tracking number
`+19412412459` is pointed at the app-owned voice webhook:

```text
https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/voice
```

Rollback:

```bash
npm run twilio:inbound:set-url -- --mode=studio --number=+19412412459 --apply
```

Canary test result:

- 2026-05-25 02:40 ET: first controlled call proved the app route dialed only
  the 3489 staff leg, but also exposed a bug: Twilio marked the staff prompt leg
  `completed` even when no one pressed 1, so the caller did not fall through to
  Waves voicemail.
- Fix deployed from a clean `origin/main` worktree: completed staff legs only
  count as human when `/inbound-forward-accept` records a `Digits=1` acceptance.
  Completed-without-acceptance now routes to Waves voicemail.
- 2026-05-25 02:56 ET: second controlled call dialed only the 3489 staff leg,
  then fell through to Waves voicemail. Portal `call_log` row:
  `answered_by=voicemail`, `call_outcome=voicemail`, `recording_url=true`,
  `transcription_status=pending`.
- 2026-05-25 03:02 ET: accept-path controlled call dialed the 3489 staff leg,
  staff pressed 1, and portal `call_log` row was `answered_by=human`.
- 2026-05-25 03:08 ET: two-person route controlled call attempted both 3489
  and 4021 child legs after 4021 was added back to
  `WAVES_FALLBACK_FORWARD_NUMBERS`.
- 2026-05-25 03:19 ET: all 25 configured Waves numbers were on the app webhook
  with final audit `driftCount=0`.

### Alternate Path: Keep Studio But Add Screening

Keep numbers pointed at Studio, but replace `forward_call` with a Studio
Function/TwiML step that implements the same press-1 screening and then returns
to Studio voicemail on no-answer.

This keeps Studio as the operator-facing routing layer, but it is less clean:
the important call behavior remains split between Studio, a Function, and this
repo.

## Follow-Ups

- Update `docs/twilio-studio-flow-contract.md` so it stops describing Studio as
  the primary production entrypoint.
- Keep watching app-mode audits for `driftCount=0` and matching Twilio true
  inbound vs portal `call_log` totals. The earlier 1-day mismatch was caused by
  synthetic `outbound-api` parent legs from controlled test calls and is fixed
  in `scripts/twilio/audit-inbound-routing.js`.

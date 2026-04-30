#!/usr/bin/env node
/**
 * Verify the LIVE Studio Flow against the contract in
 * docs/twilio-studio-flow-contract.md. Exits non-zero on drift so the
 * runbook can fail loudly during manual change-mgmt.
 *
 * Usage:
 *   npm run twilio:flow:verify
 *
 * Per ChatGPT v3 review (see chat thread): we test STRUCTURAL
 * invariants — disclosure-first ordering, simul-ring shape, recording
 * callback URL, content type, voicemail flow — not literal byte-level
 * equality with the snapshot. The snapshot exists for git-diff
 * visibility; this verifier exists for compliance/correctness drift.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const twilio = require('twilio');

const FLOW_SID = 'FW5fdc2e44700c6e786ed27de94e0cbace';
const EXPECTED_FRIENDLY_NAME = 'Waves Inbound — All Numbers';
const EXPECTED_GREETING_URL =
  'https://jet-wolverine-3713.twil.io/assets/ElevenLabs_2025-09-20T05_54_14_Veda%20Sky%20-%20Customer%20Care%20Agent_pvc_sp114_s58_sb72_se89_b_m2.mp3';
const EXPECTED_CALLBACK_URL =
  'https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/recording-status';
const EXPECTED_VOICEMAIL_TRANSCRIPTION_URL =
  'https://twimlets.com/voicemail?Email=contact@wavespestcontrol.com';

const failures = [];
const warnings = [];

function fail(msg) { failures.push(msg); }
function warn(msg) { warnings.push(msg); }

function findStateByType(states, type) {
  return states.filter((s) => s.type === type);
}
function findStateByName(states, name) {
  return states.find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// 1. Identity
// ---------------------------------------------------------------------------
function verifyIdentity(flow) {
  if (flow.sid !== FLOW_SID) {
    fail(
      `Flow SID drift: live=${flow.sid} expected=${FLOW_SID} — if intentional, update FLOW_SID + log in docs/twilio-studio-flow-contract.md "Replacement SID log".`
    );
  }
  if (flow.friendlyName !== EXPECTED_FRIENDLY_NAME) {
    fail(`friendly_name drift: live="${flow.friendlyName}" expected="${EXPECTED_FRIENDLY_NAME}"`);
  }
  if (flow.status !== 'published') {
    warn(`Flow status is "${flow.status}"; expected "published". Draft flows should not handle production traffic.`);
  }
}

// ---------------------------------------------------------------------------
// 2. Disclosure-first ordering
// ---------------------------------------------------------------------------
function verifyDisclosureFirst(definition) {
  const trigger = findStateByName(definition.states, 'Trigger');
  if (!trigger) return fail('No Trigger state in Flow definition.');

  const incomingCallTransition = (trigger.transitions || []).find(
    (t) => t.event === 'incomingCall'
  );
  if (!incomingCallTransition || !incomingCallTransition.next) {
    return fail('Trigger has no incomingCall.next transition.');
  }

  const firstState = findStateByName(definition.states, incomingCallTransition.next);
  if (!firstState) return fail(`First state "${incomingCallTransition.next}" not found in Flow.`);

  if (firstState.type !== 'say-play') {
    fail(
      `First caller-facing state must be type "say-play" (disclosure greeting). Got "${firstState.type}" (state name "${firstState.name}"). ` +
        'Disclosure must precede any recording widget.'
    );
  }

  if (firstState.properties?.play !== EXPECTED_GREETING_URL) {
    fail(
      `Disclosure greeting MP3 URL drift on state "${firstState.name}".\n` +
        `  expected: ${EXPECTED_GREETING_URL}\n` +
        `  live:     ${firstState.properties?.play}\n` +
        `If the asset was rotated, the new asset MUST contain recording/transcription/AI disclosure language. Update docs/twilio-studio-flow-contract.md and docs/call-triage-discovery.md §15.`
    );
  }

  // No recording widget should appear in the graph reachable from
  // Trigger before the disclosure widget. Since we just confirmed the
  // immediate-next state IS the disclosure say-play, this invariant
  // holds structurally for the current shape. If the Flow grows more
  // states between Trigger and disclosure, this check needs to walk
  // the graph.
}

// ---------------------------------------------------------------------------
// 3. Call routing (simul-ring shape)
// ---------------------------------------------------------------------------
function verifyForwardCall(definition) {
  const forwards = findStateByType(definition.states, 'connect-call-to');
  if (forwards.length === 0) return fail('No connect-call-to widget found in Flow.');
  if (forwards.length > 1) warn(`Multiple connect-call-to widgets found (${forwards.length}). Contract assumes one.`);

  const fwd = forwards[0];
  const p = fwd.properties || {};

  if (p.noun !== 'number-multi') {
    fail(`connect-call-to.noun expected "number-multi" (simul-ring). Got "${p.noun}".`);
  }
  if (p.timeout !== 30) {
    fail(`connect-call-to.timeout expected 30. Got ${p.timeout}.`);
  }
  if (p.record !== true) {
    fail(`connect-call-to.record expected true. Got ${p.record}.`);
  }
  if (p.caller_id !== '{{contact.channel.address}}') {
    warn(`connect-call-to.caller_id expected "{{contact.channel.address}}" (preserves caller's number on the simul-ring leg). Got "${p.caller_id}".`);
  }

  const numbers = String(p.to || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (numbers.length !== 2) {
    fail(`connect-call-to.to expected exactly 2 numbers. Got ${numbers.length}: ${JSON.stringify(numbers)}`);
  }
  for (const n of numbers) {
    if (!/^\+1\d{10}$/.test(n)) {
      fail(`connect-call-to.to has malformed NANP number: "${n}". Expected format ^\\+1\\d{10}$.`);
    }
  }

  // Strict forward-target verification when the env var is set. Per
  // ChatGPT v3 pre-merge review: the snapshot redacts personal cells
  // for repo privacy, but the verifier still needs to confirm the LIVE
  // Flow rings the expected recipients. TWILIO_EXPECTED_FORWARD_NUMBERS
  // (CSV of E.164 numbers) holds the authoritative list out-of-band
  // (Railway env / .env / runbook), so verification runs against real
  // values without committing them to git.
  //
  // Order is not significant — both sides are sorted before comparing.
  const expectedCsv = process.env.TWILIO_EXPECTED_FORWARD_NUMBERS;
  if (expectedCsv) {
    const expected = expectedCsv
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .sort();
    const live = [...numbers].sort();
    if (live.length !== expected.length || live.some((n, i) => n !== expected[i])) {
      fail(
        `connect-call-to.to drift vs. TWILIO_EXPECTED_FORWARD_NUMBERS.\n` +
          `  expected: ${expected.join(', ')}\n` +
          `  live:     ${live.join(', ')}\n` +
          'If the routing pair was intentionally changed, update TWILIO_EXPECTED_FORWARD_NUMBERS in Railway env (and the local .env if used by ops). Numbers stay out of the snapshot/contract on purpose.'
      );
    }
  } else {
    // Fallback soft check when env not configured — at least confirm
    // the documented Adam/Virginia suffixes are present so a totally
    // unrelated pair would warn. Suffixes are not personal-data-leaking
    // (already present in earlier commits of the verifier).
    const suffixes = numbers.map((n) => n.slice(-7));
    if (!suffixes.some((s) => s.endsWith('993489'))) {
      warn(`connect-call-to.to: no number ending in 993489 (Adam). If the routing pair changed, update TWILIO_EXPECTED_FORWARD_NUMBERS.`);
    }
    if (!suffixes.some((s) => s.endsWith('334021'))) {
      warn(`connect-call-to.to: no number ending in 334021 (Virginia). If the routing pair changed, update TWILIO_EXPECTED_FORWARD_NUMBERS.`);
    }
    warn(`TWILIO_EXPECTED_FORWARD_NUMBERS not set; falling back to suffix soft-check. Set the env var (Railway + .env) for strict verification.`);
  }
}

// ---------------------------------------------------------------------------
// 4. Recording HTTP-request widget (if present) — check URL + content type
// ---------------------------------------------------------------------------
function verifyRecordingHttpWidget(definition) {
  const httpReqs = findStateByType(definition.states, 'make-http-request');
  if (httpReqs.length === 0) return; // legitimate — standard signed callback covers it

  for (const w of httpReqs) {
    const p = w.properties || {};
    if (p.url !== EXPECTED_CALLBACK_URL) {
      // Allow legitimately different URLs but warn so the contract
      // can be expanded if a new HTTP widget is added intentionally.
      warn(`make-http-request "${w.name}" URL=${p.url}; expected production recording-status URL ${EXPECTED_CALLBACK_URL}`);
    }
    if (p.content_type !== 'application/x-www-form-urlencoded;charset=utf-8') {
      fail(
        `make-http-request "${w.name}".content_type expected form-urlencoded. Got "${p.content_type}". ` +
          'JSON bodies require validateRequestWithBody on the portal side and the middleware is not configured for it.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Voicemail flow
// ---------------------------------------------------------------------------
function verifyVoicemail(definition) {
  const recs = findStateByType(definition.states, 'record-voicemail');
  if (recs.length === 0) return fail('No record-voicemail widget found in Flow.');

  const v = recs[0];
  const p = v.properties || {};
  if (p.transcribe !== true) fail(`record-voicemail.transcribe expected true. Got ${p.transcribe}.`);
  if (p.transcription_callback_url !== EXPECTED_VOICEMAIL_TRANSCRIPTION_URL) {
    warn(
      `record-voicemail.transcription_callback_url drift.\n` +
        `  expected: ${EXPECTED_VOICEMAIL_TRANSCRIPTION_URL}\n` +
        `  live:     ${p.transcription_callback_url}\n` +
        'When the email pipe is migrated to the portal in a future PR, update the contract.'
    );
  }
  if (p.recording_status_callback_url !== EXPECTED_CALLBACK_URL) {
    fail(
      `record-voicemail.recording_status_callback_url expected ${EXPECTED_CALLBACK_URL}. Got ${p.recording_status_callback_url}.`
    );
  }
  const len = parseInt(p.max_length, 10);
  if (!Number.isFinite(len) || len < 120 || len > 3600) {
    warn(`record-voicemail.max_length=${p.max_length}. Expected 120..3600s.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN.');
    console.error('Run via: railway run -s waves-customer-portal node scripts/twilio/verify-studio-flow-contract.js');
    process.exit(2);
  }

  const client = twilio(sid, token);
  const flow = await client.studio.v2.flows(FLOW_SID).fetch();

  verifyIdentity(flow);
  verifyDisclosureFirst(flow.definition);
  verifyForwardCall(flow.definition);
  verifyRecordingHttpWidget(flow.definition);
  verifyVoicemail(flow.definition);

  console.log(`Studio Flow verify — ${flow.friendlyName} (${flow.sid}, rev ${flow.revision})`);
  if (warnings.length) {
    console.log('\n⚠️  Warnings:');
    for (const w of warnings) console.log('  - ' + w);
  }
  if (failures.length) {
    console.log('\n❌ Contract violations:');
    for (const f of failures) console.log('  - ' + f);
    console.log(`\n${failures.length} violation(s). See docs/twilio-studio-flow-contract.md.`);
    process.exit(1);
  }
  console.log(`\n✅ Contract clean. ${warnings.length} warning(s).`);
}

main().catch((e) => {
  console.error('verify-studio-flow-contract failed:', e.message);
  process.exit(2);
});

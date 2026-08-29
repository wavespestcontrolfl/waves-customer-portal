/**
 * Unrecorded-call alert — the "Twilio has no recording either" step of the
 * existing missing-recording sweep (call-recording-processor
 * .recoverMissingRecentRecordings, every 5 min).
 *
 * Why this exists: on 2026-08-29 a 4:17 inbound call (answered by a human)
 * produced NO recording. The DB pool was exhausted by the :30 cron fan-out,
 * so /inbound-forward-accept and /call-complete hung past Twilio's webhook
 * timeout, Railway answered 502, and Twilio fell back to the number's static
 * voice-fallback TwiML — a plain <Dial> with no `record` attribute. call_log
 * kept the row (written at /voice) and /call-status wrote the duration, so
 * the call-ingest watchdog saw nothing wrong: the SID was "known". The
 * recovery sweep asked Twilio every 5 minutes and got `no_completed_recording`
 * forever — silently. No recording ⇒ no transcription ⇒ no extraction ⇒ no
 * customer/lead. The caller became a bare phone number in Communications.
 *
 * This module does NOT scan call_log itself: the sweep already selects the
 * inbound completed calls with no recording_url and asks Twilio for each
 * one, so it is the single source of truth for "missing" — the alert runs on
 * the sweep's own `no_completed_recording` results, AFTER the Twilio lookup,
 * so a recording recovered in the same pass can never race a bell.
 *
 * What rings: a call whose recording-callback grace has elapsed since the
 * call ENDED (created_at + duration_seconds + GRACE_MINUTES ≤ now), with a
 * real conversation length (≥ MIN_DURATION_SECONDS), and not one of the
 * paths that legitimately carries no dial-leg recording: voicemail (its
 * recording lands through <Record>, a different lane with its own missed-
 * call alerts) and the AI relay session. PAN-quarantined rows never reach
 * here — recoverRecordingForCall short-circuits them before the lookup.
 *
 * Alerting: one admin bell per call (explicit `bell: true` — the 'alert'
 * category is silenced under GATE_ADMIN_BELL_POLICY, and a bell is this
 * lane's only output), deduped forever through notifyAdmin's top-level
 * `dedupeKey` (its advisory-lock insert — the sweep is unlocked, so two
 * overlapping pods must not both ring; the sidAlreadyAlerted pre-read is
 * only a cheap filter). More than AGGREGATE_THRESHOLD fresh misses in one
 * pass = recording is broadly broken → ONE aggregate bell keyed on the SET
 * of fresh SIDs (same set on two pods → same key → one bell; a later pass
 * with new misses → new set → its own bell) that carries every SID.
 *
 * A caller call_log already matched to a customer gets a different
 * instruction — open the customer, don't mint a duplicate lead.
 *
 * Dark by default behind GATE_UNRECORDED_CALL_WATCHDOG. Reads notifications;
 * writes only admin notifications.
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');

// Below this a "conversation" is a wrong number / hang-up — not worth a bell.
const MIN_DURATION_SECONDS = 60;
// Twilio posts recording-status shortly after the call ENDS; measured from
// the end, not the start, so a long call isn't judged while still in flight.
const GRACE_MINUTES = 30;
// More fresh misses than this in one pass = recording itself is down.
const AGGREGATE_THRESHOLD = 3;
// answered_by values whose calls legitimately carry no dial-leg recording.
const EXEMPT_ANSWERED_BY = new Set(['voicemail', 'ai_agent']);

// Log-safe phone rendering — full numbers belong ONLY in the admin
// notification body (an authenticated surface); Railway logs are plaintext.
function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// Pure predicate, exported for tests: is this sweep row (Twilio already
// reported no completed recording for it) an answered call that is past
// its recording grace?
function isUnrecordedCall(row, { now = new Date() } = {}) {
  if (!row || !row.twilio_call_sid) return false;
  if (row.direction !== 'inbound') return false;
  const duration = Number(row.duration_seconds || 0);
  if (duration < MIN_DURATION_SECONDS) return false;
  if (row.recording_sid || row.recording_url) return false;
  if (EXEMPT_ANSWERED_BY.has(String(row.answered_by || ''))) return false;
  if (String(row.call_outcome || '') === 'voicemail') return false;
  const started = row.created_at ? new Date(row.created_at) : null;
  if (!started || Number.isNaN(started.getTime())) return false;
  const endedAt = started.getTime() + duration * 1000;
  return endedAt + GRACE_MINUTES * 60 * 1000 <= now.getTime();
}

function findUnrecordedCalls(rows, { now = new Date() } = {}) {
  return (rows || []).filter((r) => isUnrecordedCall(r, { now }));
}

// Has this exact call already rung the bell (individually OR inside a prior
// aggregate bell's unrecorded_call_sids)? Restart-safe, no new table.
async function sidAlreadyAlerted(sid) {
  const existing = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw(
      "(metadata->>'dedupeKey' = ? OR (metadata->'unrecorded_call_sids') @> ?::jsonb)",
      [`unrecorded-call:${sid}`, JSON.stringify([sid])],
    )
    .first('id')
    .catch(() => null);
  return !!existing;
}

/**
 * Ring the bells for a pass of the missing-recording sweep.
 * `rows` = the sweep's call_log rows for which recoverRecordingForCall
 * returned `no_completed_recording` in THIS pass (Twilio confirmed absent).
 */
async function alertUnrecordedCalls(rows, { now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('unrecordedCallWatchdog')) {
    return { skipped: true, reason: 'gated_off' };
  }
  const missed = findUnrecordedCalls(rows, { now });

  const fresh = [];
  for (const c of missed) {
    if (!(await sidAlreadyAlerted(c.twilio_call_sid))) fresh.push(c);
  }
  if (!fresh.length) {
    return { skipped: false, scanned: (rows || []).length, missed: missed.length, alerted: 0 };
  }

  const when = (c) => new Date(c.created_at).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const describe = (c) => `${c.from_phone || 'unknown caller'} → ${c.to_phone || '?'} at ${when(c)} ET (${c.duration_seconds}s)`;
  const describeMasked = (c) => `${maskPhone(c.from_phone)} → ${maskPhone(c.to_phone)} at ${when(c)} ET (${c.duration_seconds}s)`;
  const WHY = 'Twilio produced no recording (usually the number\'s voice fallback after a webhook timeout), so no transcript, extraction, or lead will follow.';
  // Deduped (bell already existed) is settled, not a failure and not a new
  // alert; a null/id-less return is a silenced or failed write — this
  // lane's ONLY output, so it must not be reported as "alerted" (the
  // pre-read would then never let it re-ring).
  const outcome = (written) => (!written || written.id == null ? 'failed' : written.deduped ? 'deduped' : 'written');

  if (fresh.length > AGGREGATE_THRESHOLD) {
    const sids = fresh.map((c) => c.twilio_call_sid).sort();
    const dedupeKey = `unrecorded-call-outage:${crypto.createHash('sha1').update(sids.join(',')).digest('hex').slice(0, 16)}`;
    const written = await NotificationService.notifyAdmin(
      'alert',
      `Call recording may be DOWN — ${fresh.length} answered calls have no recording`,
      `${fresh.length} answered inbound calls have no Twilio recording, so no transcript, extraction, or lead will follow. ` +
      `Newest: ${describe(fresh[0])}. ` +
      'Check for webhook 502s in the Twilio debugger (the number\'s voice fallback bridges without the portal) and recent deploys.',
      { link: '/admin/communications', bell: true, dedupeKey, metadata: { unrecorded_call_sids: sids } },
    );
    const result = outcome(written);
    if (result === 'failed') {
      logger.error(`[unrecorded-call] ${fresh.length} unrecorded answered calls — aggregate alert NOT written (${written && written.reason ? written.reason : 'insert failed'})`);
      return { skipped: false, scanned: rows.length, missed: missed.length, alerted: 0, aggregate: true, failed: fresh.length };
    }
    if (result === 'written') logger.error(`[unrecorded-call] ${fresh.length} unrecorded answered calls in one pass — aggregate alert fired`);
    return { skipped: false, scanned: rows.length, missed: missed.length, alerted: result === 'written' ? 1 : 0, aggregate: true };
  }

  let alerted = 0;
  let failed = 0;
  for (const c of fresh) {
    const dedupeKey = `unrecorded-call:${c.twilio_call_sid}`;
    const known = !!c.customer_id;
    const written = await NotificationService.notifyAdmin(
      'alert',
      known
        ? 'Answered call has no recording — log the customer\'s request by hand'
        : 'Answered call has no recording — lead must be entered by hand',
      known
        ? `${describe(c)} matches an existing customer. ${WHY} Ask whoever took the call and log the request on the customer's record — do not create a new lead.`
        : `${describe(c)} was answered but ${WHY} Ask whoever took the call and create the lead from the call row.`,
      {
        link: known ? `/admin/customers/${c.customer_id}` : '/admin/communications',
        bell: true,
        dedupeKey,
        metadata: { call_sid: c.twilio_call_sid, from_phone: c.from_phone, ...(known ? { customer_id: c.customer_id } : {}) },
      },
    );
    const result = outcome(written);
    if (result === 'failed') {
      failed += 1;
      logger.error(`[unrecorded-call] Unrecorded call ${c.twilio_call_sid} (${describeMasked(c)}) — alert NOT written (${written && written.reason ? written.reason : 'insert failed'})`);
      continue;
    }
    if (result === 'deduped') continue;
    alerted += 1;
    logger.warn(`[unrecorded-call] Unrecorded call ${c.twilio_call_sid} (${describeMasked(c)}) — alert fired`);
  }
  return { skipped: false, scanned: rows.length, missed: missed.length, alerted, ...(failed ? { failed } : {}) };
}

module.exports = {
  alertUnrecordedCalls,
  isUnrecordedCall,
  findUnrecordedCalls,
  MIN_DURATION_SECONDS,
  GRACE_MINUTES,
  AGGREGATE_THRESHOLD,
};

/**
 * Unrecorded-call watchdog.
 *
 * Why this exists: on 2026-08-29 a 4:17 inbound call (answered by a human)
 * produced NO recording. The DB pool was exhausted by the :30 cron fan-out,
 * so /inbound-forward-accept and /call-complete hung past Twilio's webhook
 * timeout, Railway answered 502, and Twilio fell back to the number's static
 * voice-fallback TwiML — a plain <Dial> with no `record` attribute. call_log
 * kept the row (written at /voice) and /call-status wrote the duration, so
 * the call-ingest watchdog saw nothing wrong: the SID was "known". But no
 * recording ⇒ no transcription ⇒ no extraction ⇒ no customer/lead. The
 * caller became a bare phone number in the Communications list.
 *
 * What counts as a miss: an INBOUND call_log row with a Twilio SID, a real
 * conversation length (duration_seconds ≥ MIN_DURATION_SECONDS), older than
 * the grace period (Twilio's recording callback can lag the call end), that
 * still has neither recording_sid nor recording_url — and is not one of the
 * paths that legitimately carries no dial-leg recording: voicemail (its
 * recording lands through <Record>, a different path with its own alerts),
 * the AI relay session, and PAN-quarantined rows (the recording is deleted
 * on purpose).
 *
 * Alerting: one admin bell per call, deduped forever via the notifications
 * metadata dedupeKey (same pattern as call-ingest-watchdog). More than
 * AGGREGATE_THRESHOLD fresh misses in one run = recording is broadly broken
 * (fallback TwiML in use, recording-status route down) → ONE aggregate bell.
 *
 * Dark by default behind GATE_UNRECORDED_CALL_WATCHDOG. Reads call_log and
 * notifications; writes nothing but admin notifications.
 */
const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');

// Below this a "conversation" is a wrong number / hang-up — not worth a bell.
const MIN_DURATION_SECONDS = 60;
// Twilio posts recording-status shortly after the call ends; a call younger
// than this may simply not have its recording yet.
const GRACE_MINUTES = 30;
// Overlaps the run cadence generously so a missed tick can't open a blind
// spot; dedupe makes re-scanning cheap.
const LOOKBACK_HOURS = 24;
// More fresh misses than this in one run = recording itself is down.
const AGGREGATE_THRESHOLD = 3;
// answered_by values whose calls legitimately carry no dial-leg recording.
const EXEMPT_ANSWERED_BY = new Set(['voicemail', 'ai_agent']);

// Log-safe phone rendering — full numbers belong ONLY in the admin
// notification body (an authenticated surface); Railway logs are plaintext.
function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

function parseMeta(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// Pure predicate, exported for tests: is this call_log row an answered
// inbound call that never got a recording?
function isUnrecordedCall(row, { now = new Date() } = {}) {
  if (!row || !row.twilio_call_sid) return false;
  if (row.direction !== 'inbound') return false;
  if (Number(row.duration_seconds || 0) < MIN_DURATION_SECONDS) return false;
  if (row.recording_sid || row.recording_url) return false;
  if (EXEMPT_ANSWERED_BY.has(String(row.answered_by || ''))) return false;
  if (String(row.call_outcome || '') === 'voicemail') return false;
  const meta = parseMeta(row.transcription_metadata);
  if (String(meta.pan_detected) === 'true') return false;
  const created = row.created_at ? new Date(row.created_at) : null;
  if (!created || Number.isNaN(created.getTime())) return false;
  const graceCutoff = new Date(now.getTime() - GRACE_MINUTES * 60 * 1000);
  return created <= graceCutoff;
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

async function alreadyAlerted(dedupeKey) {
  const existing = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first('id')
    .catch(() => null);
  return !!existing;
}

async function runUnrecordedCallWatchdog({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('unrecordedCallWatchdog')) {
    return { skipped: true, reason: 'gated_off' };
  }
  // sidAlreadyAlerted() is read-then-notify with no unique constraint; two
  // overlapping ticks (deploy overlap) would double-ring. Non-blocking — the
  // overlapping tick skips and the next tick picks the work back up.
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('unrecorded-call-watchdog', () => runUnrecordedCallWatchdogInner({ now }));
}

async function runUnrecordedCallWatchdogInner({ now = new Date() } = {}) {
  const windowStart = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  // Broad SQL window; the exported predicate does the classification so the
  // rule lives in ONE place (and is unit-tested).
  const rows = await db('call_log')
    .where('direction', 'inbound')
    .whereNotNull('twilio_call_sid')
    .where('created_at', '>=', windowStart)
    .where('duration_seconds', '>=', MIN_DURATION_SECONDS)
    .whereNull('recording_sid')
    .whereNull('recording_url')
    .select(
      'id', 'twilio_call_sid', 'direction', 'duration_seconds', 'recording_sid', 'recording_url',
      'answered_by', 'call_outcome', 'from_phone', 'to_phone', 'transcription_metadata', 'created_at',
    );
  const missed = findUnrecordedCalls(rows, { now });

  const fresh = [];
  for (const c of missed) {
    if (!(await sidAlreadyAlerted(c.twilio_call_sid))) fresh.push(c);
  }
  if (!fresh.length) {
    return { skipped: false, scanned: rows.length, missed: missed.length, alerted: 0 };
  }

  const when = (c) => new Date(c.created_at).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const describe = (c) => `${c.from_phone || 'unknown caller'} → ${c.to_phone || '?'} at ${when(c)} ET (${c.duration_seconds}s)`;
  const describeMasked = (c) => `${maskPhone(c.from_phone)} → ${maskPhone(c.to_phone)} at ${when(c)} ET (${c.duration_seconds}s)`;

  if (fresh.length > AGGREGATE_THRESHOLD) {
    const hourKey = now.toISOString().slice(0, 13);
    const dedupeKey = `unrecorded-call-outage:${hourKey}`;
    if (!(await alreadyAlerted(dedupeKey))) {
      await NotificationService.notifyAdmin(
        'alert',
        `Call recording may be DOWN — ${fresh.length} answered calls have no recording`,
        `${fresh.length} answered inbound calls in the last ${LOOKBACK_HOURS}h have no Twilio recording, so no ` +
        `transcript, extraction, or lead will follow. Newest: ${describe(fresh[0])}. ` +
        'Check for webhook 502s in the Twilio debugger (the number\'s voice fallback bridges without the portal) and recent deploys.',
        // Every fresh sid rides in metadata — that settles them for
        // sidAlreadyAlerted so a fixed outage doesn't re-ring next hour.
        { link: '/admin/communications', metadata: { dedupeKey, unrecorded_call_sids: fresh.map((c) => c.twilio_call_sid) } },
      );
    }
    logger.error(`[unrecorded-call-watchdog] ${fresh.length} unrecorded answered calls in window — aggregate alert fired`);
    return { skipped: false, scanned: rows.length, missed: missed.length, alerted: 1, aggregate: true };
  }

  let alerted = 0;
  for (const c of fresh) {
    const dedupeKey = `unrecorded-call:${c.twilio_call_sid}`;
    await NotificationService.notifyAdmin(
      'alert',
      'Answered call has no recording — lead must be entered by hand',
      `${describe(c)} was answered but Twilio produced no recording (usually the number's voice fallback after a ` +
      'webhook timeout). No transcript, extraction, or lead will follow. Ask whoever took the call and create the lead from the call row.',
      { link: '/admin/communications', metadata: { dedupeKey, call_sid: c.twilio_call_sid, from_phone: c.from_phone } },
    );
    alerted += 1;
    logger.warn(`[unrecorded-call-watchdog] Unrecorded call ${c.twilio_call_sid} (${describeMasked(c)}) — alert fired`);
  }
  return { skipped: false, scanned: rows.length, missed: missed.length, alerted };
}

module.exports = {
  runUnrecordedCallWatchdog,
  isUnrecordedCall,
  findUnrecordedCalls,
  MIN_DURATION_SECONDS,
  GRACE_MINUTES,
  LOOKBACK_HOURS,
  AGGREGATE_THRESHOLD,
};

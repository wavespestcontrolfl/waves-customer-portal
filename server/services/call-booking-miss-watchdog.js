/**
 * Call booking-miss watchdog.
 *
 * Why this exists: on 2026-07-28 an outbound callback confirmed "Saturday at
 * noon" with a property manager (Knorr/Riverwalk). The V2 extraction captured
 * scheduling.status=confirmed with a concrete confirmed_start_at — but every
 * auto-booking guard held it back (outbound_call skip, v2 needs_review
 * routing), so it parked as triage_items among 1,700+ open low-severity
 * flags and drowned. Nothing rang; nobody was scheduled for Saturday. The
 * triage queue is a park, not a pager — this watchdog is the pager for the
 * one class that directly costs a visit: the caller was TOLD a slot and the
 * schedule has nothing on it.
 *
 * What counts as a miss: a call in the lookback window, past the grace
 * period, whose stored V2 extraction (v2_extraction_status = 'valid') says
 * scheduling.status === 'confirmed' with a parseable confirmed_start_at —
 * and NO non-cancelled scheduled_services row exists for that customer on
 * that ET service date. A call with no linked customer_id cannot match a
 * booking by definition and is always a miss (doubly bad: unattributed AND
 * unbooked; see call-log-relink.js for the attribution side).
 *
 * Alerting mirrors call-ingest-watchdog: one bell per call, deduped forever
 * via the notifications metadata dedupeKey, with a per-run cap so the first
 * enable over a backlog can't flood the bell. Dark by default behind
 * GATE_CALL_BOOKING_MISS_WATCHDOG. Read-only against call_log and
 * scheduled_services; writes nothing but admin notifications.
 */

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { etDateString } = require('../utils/datetime-et');

// How far back each run looks. Two days: long enough that a weekend outage
// still surfaces Monday, short enough that the candidate set stays tiny.
const LOOKBACK_HOURS = 48;
// Calls younger than this are still legitimately in flight — transcription →
// extraction → booking can take a while, and the office may be booking it
// by hand right now.
const GRACE_MINUTES = 90;
// A first enable scans the whole window; cap the bells per run so a backlog
// rings loudly but not unreadably. Dedupe keys make the remainder ring on
// subsequent ticks.
const MAX_ALERTS_PER_RUN = 8;

// Log-safe phone rendering — full numbers belong ONLY in the admin
// notification body (an authenticated surface); Railway logs are plaintext.
function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// Parse the stored V2 extraction (jsonb object or stringified JSON — both
// exist across the column's history) into the confirmed-slot facts this
// watchdog needs. Returns null unless the call confirmed a concrete slot.
function extractConfirmedSlot(extractionRaw) {
  let extraction = extractionRaw;
  if (!extraction) return null;
  if (typeof extraction === 'string') {
    try {
      extraction = JSON.parse(extraction);
    } catch {
      return null;
    }
  }
  const scheduling = extraction.scheduling || {};
  if (scheduling.status !== 'confirmed' || !scheduling.confirmed_start_at) return null;
  const startAt = new Date(scheduling.confirmed_start_at);
  if (Number.isNaN(startAt.getTime())) return null;
  return {
    startAt,
    name: extraction.caller?.name_full || extraction.caller?.first_name || 'Unknown caller',
    service: extraction.service_request?.specific_service_name
      || extraction.service_request?.primary_service_category
      || null,
  };
}

// Pure diff, exported for tests: which calls confirmed a slot that has no
// matching booking? `calls` are call_log rows ({ id, customer_id, direction,
// created_at, from_phone, ai_extraction_enriched }); `bookedKeys` is a Set of
// `${customer_id}:${YYYY-MM-DD}` for every non-cancelled scheduled_services
// row in play (date rendered in SQL via to_char — never a JS Date round-trip,
// which shifts the day across the UTC/ET boundary).
function computeBookingMisses(calls, bookedKeys, { now = new Date() } = {}) {
  const graceCutoff = new Date(now.getTime() - GRACE_MINUTES * 60 * 1000);
  const misses = [];
  for (const call of calls) {
    const createdAt = call.created_at ? new Date(call.created_at) : null;
    if (!createdAt || createdAt > graceCutoff) continue;
    const slot = extractConfirmedSlot(call.ai_extraction_enriched);
    if (!slot) continue;
    const serviceDateET = etDateString(slot.startAt);
    if (call.customer_id && bookedKeys.has(`${call.customer_id}:${serviceDateET}`)) continue;
    misses.push({ call, slot, serviceDateET });
  }
  return misses;
}

// Has this exact miss already rung the bell (any time in the past)? Same
// notifications metadata dedupeKey pattern as call-ingest-watchdog —
// restart-safe, no new table.
async function alreadyAlerted(dedupeKey) {
  const existing = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first('id')
    .catch(() => null);
  return !!existing;
}

async function runCallBookingMissWatchdog({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callBookingMissWatchdog')) {
    return { skipped: true, reason: 'gated_off' };
  }
  // alreadyAlerted() is a read-then-notify with no unique constraint —
  // serialize ticks so deploy overlap can't double-ring.
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('call-booking-miss-watchdog', () => runInner({ now }));
}

async function runInner({ now = new Date() } = {}) {
  const windowStart = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  // Candidate filtering happens in JS, not SQL: ai_extraction_enriched has
  // been both json and stringified-text across its history, so a ->> filter
  // would silently drop the string-era rows. The 48h window keeps this cheap.
  const calls = await db('call_log')
    .where('created_at', '>=', windowStart)
    .where({ v2_extraction_status: 'valid' })
    .whereNotNull('ai_extraction_enriched')
    .select('id', 'customer_id', 'direction', 'created_at', 'from_phone', 'to_phone', 'ai_extraction_enriched');

  // One pass to find the confirmed slots, then one bulk booking lookup.
  const provisional = computeBookingMisses(calls, new Set(), { now });
  if (!provisional.length) {
    return { skipped: false, scanned: calls.length, misses: 0, alerted: 0 };
  }
  const customerIds = [...new Set(provisional.map((m) => m.call.customer_id).filter(Boolean))];
  const dates = [...new Set(provisional.map((m) => m.serviceDateET))];
  const bookedKeys = new Set();
  if (customerIds.length && dates.length) {
    const booked = await db('scheduled_services')
      .whereIn('customer_id', customerIds)
      .whereNot({ status: 'cancelled' })
      .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ANY(?)", [dates])
      .select('customer_id', db.raw("to_char(scheduled_date, 'YYYY-MM-DD') AS sched_date"));
    for (const b of booked) bookedKeys.add(`${b.customer_id}:${b.sched_date}`);
  }
  const misses = computeBookingMisses(calls, bookedKeys, { now });

  let alerted = 0;
  for (const m of misses) {
    if (alerted >= MAX_ALERTS_PER_RUN) {
      logger.warn(`[call-booking-miss] per-run alert cap hit (${MAX_ALERTS_PER_RUN}); ${misses.length - alerted} more will ring next tick`);
      break;
    }
    const dedupeKey = `call-booking-miss:${m.call.id}`;
    if (await alreadyAlerted(dedupeKey)) continue;
    const slotET = m.slot.startAt.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const callAtET = new Date(m.call.created_at).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const contactPhone = String(m.call.direction || '').startsWith('outbound') ? m.call.to_phone : m.call.from_phone;
    await NotificationService.notifyAdmin(
      'alert',
      `Confirmed appointment never booked — ${m.slot.name}, ${slotET}`,
      `${m.slot.name} (${contactPhone || 'no number'}) confirmed ${m.slot.service || 'a visit'} for ${slotET} ` +
      `on a ${m.call.direction || 'unknown-direction'} call at ${callAtET} ET, but the schedule has no appointment ` +
      `for that date${m.call.customer_id ? '' : ' — and the call is not linked to any customer'}. ` +
      'Book it in dispatch or call back to reset expectations.',
      {
        link: '/admin/dispatch',
        metadata: {
          dedupeKey,
          call_log_id: m.call.id,
          customer_id: m.call.customer_id || null,
          confirmed_start_at: m.slot.startAt.toISOString(),
        },
      },
    );
    alerted += 1;
    logger.warn(`[call-booking-miss] Unbooked confirmed slot on call ${m.call.id} (${maskPhone(contactPhone)}, ${m.serviceDateET}) — alert fired`);
  }
  return { skipped: false, scanned: calls.length, misses: misses.length, alerted };
}

module.exports = {
  runCallBookingMissWatchdog,
  computeBookingMisses,
  extractConfirmedSlot,
  LOOKBACK_HOURS,
  GRACE_MINUTES,
  MAX_ALERTS_PER_RUN,
};

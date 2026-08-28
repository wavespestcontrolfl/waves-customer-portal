/**
 * "Customer called and we missed it" bell (owner ruling 2026-08-28: the
 * bell/push/badge are for customer communication — a missed call is one).
 *
 * Runs from the same 2-minute post-call hook as recording recovery, so a
 * voicemail has had time to land: a call WITH a recording is the voicemail
 * lane's (customer_voicemail_callback) and never rings here. Rings at most
 * once per call, only for an inbound call from a customer on file that no
 * human or AI agent answered. Delivery state lives in call_log.metadata:
 *   missed_call_notified_at — a LEASE (fence token; reclaimable once stale,
 *                             so a crash mid-delivery never loses the alert)
 *   missed_call_settled_at  — terminal: delivered (or superseded)
 */
const db = require('../models/db');
const logger = require('./logger');

const UNANSWERED = new Set(['missed', 'voicemail', 'unknown']);
// A row with NO answered_by (the Studio-flow status_callback fallback in
// twilio-voice-webhook.js inserts terminal calls without an outcome) counts
// as missed only when Twilio's own status says nobody picked up. A
// `completed` call with no outcome may have been handled by the flow — it
// never rings (codex r4).
const UNANSWERED_STATUSES = new Set(['no-answer', 'busy', 'canceled']);
// Lease length: covers customer lookup + delivery with margin; a stale lease
// is reclaimed by the 2-minute sweep.
const LEASE_MS = 10 * 60 * 1000;

function outcomeUnanswered(row) {
  if (row.answered_by) return UNANSWERED.has(row.answered_by);
  return UNANSWERED_STATUSES.has(row.status);
}

/** Pure eligibility — exported for tests. */
function missedCallEligible(row, now = Date.now()) {
  if (!row || row.direction !== 'inbound' || !row.customer_id) return false;
  if (row.recording_sid || row.recording_url) return false;          // voicemail lane owns it
  if (row.voicemail_callback_alerted_at) return false;                // voicemail lane already rang
  if (row.call_outcome === 'ai_handled') return false;
  if (!outcomeUnanswered(row)) return false;                          // human / ai_agent / unknown-outcome
  const meta = parseMeta(row.metadata);
  if (meta.missed_call_settled_at) return false;                      // delivered / superseded
  if (meta.missed_call_notified_at && !leaseStale(meta.missed_call_notified_at, now)) return false; // live lease
  return true;
}

function parseMeta(meta) {
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  return meta && typeof meta === 'object' ? meta : {};
}

function leaseStale(token, now = Date.now()) {
  const t = new Date(token).getTime();
  return !Number.isFinite(t) || now - t > LEASE_MS;
}

async function ringMissedCallIfUnanswered(callSid) {
  if (!callSid) return false;
  try {
    const row = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!missedCallEligible(row)) return false;
    // Atomic claim: first writer wins across retries / pods. The mutable
    // eligibility predicates are re-checked IN the claim so a voicemail
    // recording or an answered outcome that landed between the read above
    // and this write loses the race (codex r4).
    const token = new Date().toISOString();
    const reclaimed = Boolean(parseMeta(row.metadata).missed_call_notified_at);
    const claimed = await db('call_log')
      .where({ id: row.id })
      .whereRaw("COALESCE(metadata->>'missed_call_settled_at','') = ''")
      .whereRaw("(COALESCE(metadata->>'missed_call_notified_at','') = '' OR (metadata->>'missed_call_notified_at')::timestamptz < ?)", [new Date(Date.now() - LEASE_MS)])
      .whereNull('recording_sid')
      .whereNull('recording_url')
      .whereNull('voicemail_callback_alerted_at')
      .whereRaw("COALESCE(call_outcome,'') <> 'ai_handled'")
      .whereRaw('(answered_by IN (?, ?, ?) OR (answered_by IS NULL AND status IN (?, ?, ?)))', [...UNANSWERED, ...UNANSWERED_STATUSES])
      .update({ metadata: db.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('missed_call_notified_at', ?::text)", [token]) });
    if (!claimed) return false;
    // Every later write is fenced on the token: a stale owner waking up
    // late can't settle or release a lease someone else now holds.
    const fenced = () => db('call_log').where({ id: row.id }).whereRaw("metadata->>'missed_call_notified_at' = ?", [token]);
    const settle = () => fenced().update({ metadata: db.raw("metadata || jsonb_build_object('missed_call_settled_at', ?::text)", [new Date().toISOString()]) });
    // Reclaimed a stale lease: the previous owner may have died after the
    // bell was written. A bell row for this call means it delivered.
    if (reclaimed) {
      const prior = await db('notifications').where({ recipient_type: 'admin', category: 'missed_call' })
        .whereRaw("metadata->'payload'->>'callLogId' = ?", [String(row.id)]).first('id');
      if (prior) { await settle(); return false; }
    }
    const customer = await db('customers').where('id', row.customer_id).first('first_name', 'last_name', 'phone');
    const { triggerNotification } = require('./notification-triggers');
    // Is this call still the missed-call lane's? False once a recording
    // persisted or the voicemail lane claimed it.
    const stillMissed = async () => {
      const cur = await db('call_log').where({ id: row.id }).first('recording_sid', 'recording_url', 'voicemail_callback_alerted_at');
      return Boolean(cur) && !cur.recording_sid && !cur.recording_url && !cur.voicemail_callback_alerted_at;
    };
    let stats = null;
    try {
      stats = await triggerNotification('customer_missed_call', {
        customerId: row.customer_id,
        name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer',
        phone: row.from_phone,
        callLogId: row.id,
        at: row.created_at,
      }, {
        // Re-read right before the push (same supersession pattern as the
        // SMS bell): a recording that landed while the badge was computing
        // must not produce a contradictory missed-call push (hook P1).
        beforePush: stillMissed,
      });
    } finally {
      const delivered = Boolean(stats && !stats.error
        && (stats.bellWritten || Number(stats.push?.sent || 0) > 0 || stats.suppressed || stats.policySilenced));
      if (delivered) {
        await settle().catch(() => {});
      } else {
        await fenced().update({ metadata: db.raw("metadata - 'missed_call_notified_at'") }).catch(() => {});
      }
    }
    // Post-check (hook P1): a recording that persisted between the claim
    // and here makes this call the voicemail lane's — retire the bell just
    // written. The voicemail path runs the same supersede when IT claims, so
    // both orderings converge on one alert per call.
    if (!(await stillMissed().catch(() => true))) {
      const NotificationService = require('./notification-service');
      await NotificationService.supersedeMissedCallAdmin({ callLogId: row.id }).catch(() => {});
    }
    return true;
  } catch (err) {
    logger.warn(`[missed-call-bell] failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return false;
  }
}

const TERMINAL_STATUSES = ['completed', 'no-answer', 'busy', 'canceled', 'failed'];

/**
 * Durable retry (runs on the 2-minute scheduler): re-offer unanswered,
 * unsettled (unclaimed or stale-leased) customer calls from the last 24h that ended ≥3 minutes ago (so
 * the voicemail recording has had its chance to land). Idempotent — the
 * atomic claim inside ringMissedCallIfUnanswered makes a re-offer a no-op.
 */
async function sweepMissedCalls({ limit = 50 } = {}) {
  const rows = await db('call_log')
    .where({ direction: 'inbound' })
    .whereNotNull('customer_id')
    .whereIn('status', TERMINAL_STATUSES)
    .whereNull('recording_sid')
    .whereRaw('(answered_by IN (?, ?, ?) OR (answered_by IS NULL AND status IN (?, ?, ?)))', [...UNANSWERED, ...UNANSWERED_STATUSES])
    .whereRaw("COALESCE(metadata->>'missed_call_settled_at','') = ''")
    // Unclaimed, or a lease that went stale (crash mid-delivery) — hook P1.
    .whereRaw("(COALESCE(metadata->>'missed_call_notified_at','') = '' OR (metadata->>'missed_call_notified_at')::timestamptz < ?)", [new Date(Date.now() - LEASE_MS)])
    .where('created_at', '>', new Date(Date.now() - 24 * 60 * 60 * 1000))
    .where('created_at', '<', new Date(Date.now() - 3 * 60 * 1000))
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('twilio_call_sid');
  let rung = 0;
  for (const r of rows) {
    if (await ringMissedCallIfUnanswered(r.twilio_call_sid)) rung += 1;
  }
  return rung;
}

module.exports = { missedCallEligible, ringMissedCallIfUnanswered, sweepMissedCalls };

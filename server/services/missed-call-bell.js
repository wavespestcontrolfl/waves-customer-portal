/**
 * "Customer called and we missed it" bell (owner ruling 2026-08-28: the
 * bell/push/badge are for customer communication — a missed call is one).
 *
 * Runs from the same 2-minute post-call hook as recording recovery, so a
 * voicemail has had time to land: a call WITH a recording is the voicemail
 * lane's (customer_voicemail_callback) and never rings here. Rings at most
 * once per call — an atomic claim on call_log.metadata.missed_call_notified_at
 * — and only for an inbound call from a customer on file that no human or
 * AI agent answered.
 */
const db = require('../models/db');
const logger = require('./logger');

const UNANSWERED = new Set(['missed', 'voicemail', 'unknown']);

/** Pure eligibility — exported for tests. */
function missedCallEligible(row) {
  if (!row || row.direction !== 'inbound' || !row.customer_id) return false;
  if (row.recording_sid || row.recording_url) return false;          // voicemail lane owns it
  if (row.call_outcome === 'ai_handled') return false;
  if (row.answered_by && !UNANSWERED.has(row.answered_by)) return false; // human / ai_agent answered
  let meta = row.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  if (meta && meta.missed_call_notified_at) return false;
  return true;
}

async function ringMissedCallIfUnanswered(callSid) {
  if (!callSid) return false;
  try {
    const row = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!missedCallEligible(row)) return false;
    // Atomic claim: first writer wins across retries / pods.
    const claimed = await db('call_log')
      .where({ id: row.id })
      .whereRaw("COALESCE(metadata->>'missed_call_notified_at','') = ''")
      .update({ metadata: db.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('missed_call_notified_at', ?::text)", [new Date().toISOString()]) });
    if (!claimed) return false;
    const customer = await db('customers').where('id', row.customer_id).first('first_name', 'last_name', 'phone');
    const { triggerNotification } = require('./notification-triggers');
    let stats = null;
    try {
      stats = await triggerNotification('customer_missed_call', {
        customerId: row.customer_id,
        name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer',
        phone: row.from_phone,
        callLogId: row.id,
        at: row.created_at,
      });
    } finally {
      const delivered = Boolean(stats && !stats.error
        && (stats.bellWritten || Number(stats.push?.sent || 0) > 0 || stats.suppressed || stats.policySilenced));
      if (!delivered) {
        await db('call_log').where({ id: row.id })
          .update({ metadata: db.raw("metadata - 'missed_call_notified_at'") }).catch(() => {});
      }
    }
    return true;
  } catch (err) {
    logger.warn(`[missed-call-bell] failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return false;
  }
}

module.exports = { missedCallEligible, ringMissedCallIfUnanswered };

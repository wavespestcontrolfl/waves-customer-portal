/**
 * Staff repeat-caller alert, dark behind GATE_REPEAT_CALLER_BELL.
 * A per-number lock serializes a reclaimable delivery lease. Alerted-at is
 * terminal; delivery-id survives crashes and newer calls for push deduplication.
 * Both the post-call timer and durable sweep use the same claim path.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { toE164, isLikelyE164 } = require('../utils/phone');
const { isSentinelPhone } = require('./external-phone');
const { outcomeUnanswered } = require('./missed-call-bell');
const { whereNotBlockedCall, PHONE_KEY_SQL } = require('../middleware/spam-block');
const { whereNotSandboxCall, VOICE_RELAY_SANDBOX_SOURCE } = require('./voice-agent/relay-protocol');

const REPEAT_THRESHOLD = 3;
const REPEAT_WINDOW_MS = 3 * 60 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;
const SWEEP_GRACE_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['completed', 'no-answer', 'busy', 'canceled', 'failed']);
const CLAIM_FREE_SQL = "(COALESCE(metadata->>'repeat_caller_claim', '') = '' OR (metadata->>'repeat_caller_claim')::timestamptz < ?)";
const BOOKED_SQL = "EXISTS (SELECT 1 FROM scheduled_services s WHERE s.source_call_log_id = call_log.id AND s.status IN ('pending', 'confirmed', 'en_route', 'on_site', 'completed'))";

function callerKey(fromPhone) {
  if (isSentinelPhone(fromPhone)) return null;
  const e164 = toE164(fromPhone);
  return isLikelyE164(e164) ? String(e164).replace(/\D/g, '') : null;
}

// Calls are this number's inbound history, newest first.
function repeatCallerPlan(calls, now = Date.now()) {
  const recent = (calls || []).filter((c) => {
    const t = new Date(c.created_at).getTime();
    return Number.isFinite(t) && now - t <= REPEAT_WINDOW_MS;
  });
  if (recent.length < REPEAT_THRESHOLD) return null;
  const newest = recent[0];
  if (recent.some(call => !TERMINAL_STATUSES.has(call.status))
    || !(new Date(newest.updated_at || newest.created_at).getTime() <= now - SWEEP_GRACE_MS)) return null;
  if (recent.some((c) => c.repeat_caller_alerted_at)) return null;
  // A live lease belongs to another worker; only stale leases can be reclaimed.
  if (recent.some((c) => {
    const t = new Date(c.repeat_caller_claim || '').getTime();
    return Number.isFinite(t) && now - t < LEASE_MS;
  })) return null;
  if (recent.some((c) => c.booked)) return null;
  const unanswered = recent.filter(outcomeUnanswered).length;
  return { count: recent.length, unanswered, since: recent[recent.length - 1].created_at };
}

async function ringRepeatCallerIfNeeded(callSid) {
  if (!callSid || !isEnabled('repeatCallerBell')) return false;
  try {
    const call = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!call || call.direction !== 'inbound') return false;
    if (String(call.source || '') === VOICE_RELAY_SANDBOX_SOURCE) return false;
    const key = callerKey(call.from_phone);
    if (!key) return false;
    const token = new Date().toISOString();
    // Read and claim under the number lock so sibling timers see prior claims.
    const plan = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`repeat-caller:${key}`]);
      const rows = await trx('call_log')
        .where({ direction: 'inbound' })
        .whereRaw(`${PHONE_KEY_SQL} = ?`, [key])
        .modify((qb) => whereNotSandboxCall(qb))
        .modify(whereNotBlockedCall)
        .where('created_at', '>', new Date(Date.now() - REPEAT_WINDOW_MS))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .select('id', 'created_at', 'updated_at', 'status', 'answered_by', 'customer_id',
          trx.raw("(metadata->>'repeat_caller_alerted_at') as repeat_caller_alerted_at"),
          trx.raw("(metadata->>'repeat_caller_claim') as repeat_caller_claim"),
          trx.raw("(metadata->>'repeat_caller_delivery_id') as repeat_caller_delivery_id"),
          trx.raw(`${BOOKED_SQL} AS booked`));
      if (!rows.some(row => row.id === call.id)) return null;
      const p = repeatCallerPlan(rows);
      if (!p) return null;
      // Legacy claims use their original call ID; later retries carry that ID forward.
      const priorAttempt = rows.find(r => r.repeat_caller_delivery_id || r.repeat_caller_claim);
      p.reclaimed = !!priorAttempt;
      p.deliveryId = priorAttempt?.repeat_caller_delivery_id || priorAttempt?.id || call.id;
      p.windowIds = rows.map((r) => r.id);
      const claimed = await trx('call_log')
        .where({ id: call.id })
        .modify(whereNotBlockedCall)
        .whereRaw("COALESCE(metadata->>'repeat_caller_alerted_at','') = ''")
        .whereRaw(CLAIM_FREE_SQL, [new Date(Date.now() - LEASE_MS)])
        .update({ metadata: trx.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('repeat_caller_claim', ?::text, 'repeat_caller_delivery_id', ?::text)", [token, String(p.deliveryId)]) });
      return claimed ? p : null;
    });
    if (!plan) return false;
    // Fence every later write: a stale owner must not settle or release a newer claim.
    const fenced = () => db('call_log').where({ id: call.id }).whereRaw("metadata->>'repeat_caller_claim' = ?", [token]);
    const settle = () => fenced().update({ metadata: db.raw("(metadata - 'repeat_caller_claim') || jsonb_build_object('repeat_caller_alerted_at', ?::text)", [new Date().toISOString()]) });
    // A persisted bell proves delivery; push-only recovery reuses the stable tag.
    if (plan.reclaimed) {
      const prior = await db('notifications').where({ recipient_type: 'admin', category: 'missed_call' })
        .whereRaw("metadata->>'triggerKey' = 'repeat_caller'")
        .whereRaw("metadata->'payload'->>'callLogId' = ANY(?)", [plan.windowIds.map(String)]).first('id');
      if (prior) { await settle().catch(() => {}); return false; }
    }
    let stats = null;
    let delivered = false;
    const stillUnbooked = async () => !await db('call_log').whereIn('id', plan.windowIds).whereRaw(BOOKED_SQL).first('id');
    try {
      const customer = call.customer_id
        ? await db('customers').where('id', call.customer_id).first('first_name', 'last_name')
        : null;
      const meta = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : (call.metadata || {});
      const { triggerNotification } = require('./notification-triggers');
      if (!await stillUnbooked()) { stats = { superseded: true }; return false; }
      stats = await triggerNotification('repeat_caller', {
        customerId: call.customer_id || null,
        name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || null,
        phone: call.from_phone,
        line: meta.location || null,
        count: plan.count,
        unanswered: plan.unanswered,
        callLogId: call.id,
        repeatCallerDeliveryId: String(plan.deliveryId),
      }, { beforePush: stillUnbooked });
    } finally {
      // Settle only delivery or deliberate silence; release a failed attempt for retry.
      delivered = Boolean(stats && !stats.error
        && (stats.bellWritten || Number(stats.push?.sent || 0) > 0 || stats.suppressed || stats.policySilenced));
      if (delivered) {
        await settle().catch(() => {});
      } else {
        await fenced().update({ metadata: db.raw("metadata - 'repeat_caller_claim'") }).catch(() => {});
        if (!stats?.superseded) logger.warn(`[repeat-caller-bell] delivery did not happen for call ${String(callSid).slice(-6)} — lease released`);
      }
    }
    // A booking can commit while preferences or badge counts are loading.
    // Retire the persisted bell too, including when push is disabled.
    if (stats?.bellWritten && !await stillUnbooked()) {
      await require('./notification-service').supersedeMissedCallAdmin({ callLogId: call.id, triggerKey: 'repeat_caller' });
    }
    return delivered;
  } catch (err) {
    logger.warn(`[repeat-caller-bell] failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return false;
  }
}

async function sweepRepeatCallers({ limit = 50 } = {}) {
  if (!isEnabled('repeatCallerBell')) return 0;
  const windows = await db('call_log')
    .where({ direction: 'inbound' })
    .where('created_at', '>', new Date(Date.now() - REPEAT_WINDOW_MS))
    .modify((qb) => whereNotSandboxCall(qb))
    .modify(whereNotBlockedCall)
    .whereRaw(`LENGTH(${PHONE_KEY_SQL}) BETWEEN 10 AND 15`)
    .groupByRaw(PHONE_KEY_SQL)
    .havingRaw('COUNT(*) >= ?', [REPEAT_THRESHOLD])
    .havingRaw("BOOL_AND(COALESCE(metadata->>'repeat_caller_alerted_at', '') = '')")
    .havingRaw(`BOOL_AND(${CLAIM_FREE_SQL})`, [new Date(Date.now() - LEASE_MS)])
    .havingRaw(`NOT BOOL_OR(${BOOKED_SQL})`)
    .havingRaw('BOOL_AND(COALESCE(status, \'\') = ANY(?))', [[...TERMINAL_STATUSES]])
    .havingRaw('(array_agg(COALESCE(updated_at, created_at) ORDER BY created_at DESC, id DESC))[1] < ?', [new Date(Date.now() - SWEEP_GRACE_MS)])
    .select(db.raw('(array_agg(twilio_call_sid ORDER BY created_at DESC, id DESC))[1] AS newest_sid'))
    .limit(limit);
  let rang = 0;
  for (const w of windows) {
    if (w.newest_sid && await ringRepeatCallerIfNeeded(w.newest_sid)) rang += 1;
  }
  return rang;
}

module.exports = { repeatCallerPlan, ringRepeatCallerIfNeeded, sweepRepeatCallers, callerKey, REPEAT_THRESHOLD, REPEAT_WINDOW_MS, LEASE_MS };

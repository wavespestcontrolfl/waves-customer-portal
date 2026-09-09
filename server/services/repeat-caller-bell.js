/**
 * "This number keeps calling" bell (GATE_REPEAT_CALLER_BELL, ships dark).
 *
 * The call pipeline processes every call alone: a caller promised a
 * same-day callback who then rings five more times through the afternoon
 * and into the next morning produced two texts, a "no action needed" and
 * no escalation to anyone (2026-09-06..07 audit, seven calls from one
 * number). This rings the admin bell once when the SAME number has placed
 * REPEAT_THRESHOLD or more inbound calls inside REPEAT_WINDOW_MS, unless a
 * call in that window already rang it. Bell only — no customer comms.
 *
 * Delivery state lives on the triggering call_log row:
 *   repeat_caller_alerted_at — set on the call that rang, so the window's
 *   later calls see it and stay quiet. Read-and-claim run under a per-number
 *   advisory lock (codex r1 P2: sibling post-call timers each claimed their
 *   OWN row, so two could ring), and the claim is released again when the
 *   bell did not go out (codex r1 P2: a failed delivery must not silence the
 *   rest of the window).
 * Two entry points: the post-call timer (twilio-voice-webhook) and the
 * 2-minute durable sweep (codex r1 P2: an in-memory setTimeout dies with its
 * pod, so a window whose newest call lost its timer is re-offered).
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { whereNotSandboxCall, VOICE_RELAY_SANDBOX_SOURCE } = require('./voice-agent/relay-protocol');

const REPEAT_THRESHOLD = 3;
const REPEAT_WINDOW_MS = 3 * 60 * 60 * 1000;
// Grace before the sweep judges a window: the same 5 minutes the post-call
// timer waits (recording + voicemail callbacks land first).
const SWEEP_GRACE_MS = 5 * 60 * 1000;
const PHONE_KEY_SQL = "RIGHT(regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g'), 10)";

const digits10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

/** Pure decision — exported for tests. `calls` are this number's inbound calls, newest first. */
function repeatCallerPlan(calls, now = Date.now()) {
  const recent = (calls || []).filter((c) => {
    const t = new Date(c.created_at).getTime();
    return Number.isFinite(t) && now - t <= REPEAT_WINDOW_MS;
  });
  if (recent.length < REPEAT_THRESHOLD) return null;
  if (recent.some((c) => c.repeat_caller_alerted_at)) return null;
  // A booking created from one of these calls means someone handled it.
  if (recent.some((c) => c.booked)) return null;
  const answered = recent.filter((c) => c.answered_by === 'human' || c.answered_by === 'ai_agent').length;
  return { count: recent.length, unanswered: recent.length - answered, since: recent[recent.length - 1].created_at };
}

async function ringRepeatCallerIfNeeded(callSid) {
  if (!callSid || !isEnabled('repeatCallerBell')) return false;
  try {
    const call = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!call || call.direction !== 'inbound') return false;
    if (String(call.source || '') === VOICE_RELAY_SANDBOX_SOURCE) return false;
    const key = digits10(call.from_phone);
    if (key.length < 10) return false;
    // One evaluation per number at a time: the window is read and the claim
    // written under a transaction-scoped advisory lock keyed by the number,
    // so a concurrent sibling (another call's timer, or the sweep) re-reads
    // only AFTER this claim commits and sees the stamp.
    const plan = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`repeat-caller:${key}`]);
      const rows = await trx('call_log')
        .where({ direction: 'inbound' })
        .whereRaw(`${PHONE_KEY_SQL} = ?`, [key])
        .modify((qb) => whereNotSandboxCall(qb))
        .where('created_at', '>', new Date(Date.now() - REPEAT_WINDOW_MS))
        .orderBy('created_at', 'desc')
        .select('id', 'created_at', 'answered_by', 'customer_id',
          trx.raw("(metadata->>'repeat_caller_alerted_at') as repeat_caller_alerted_at"),
          trx.raw('EXISTS (SELECT 1 FROM scheduled_services s WHERE s.source_call_log_id = call_log.id) AS booked'));
      const p = repeatCallerPlan(rows);
      if (!p) return null;
      const claimed = await trx('call_log')
        .where({ id: call.id })
        .whereRaw("COALESCE(metadata->>'repeat_caller_alerted_at','') = ''")
        .update({ metadata: trx.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('repeat_caller_alerted_at', ?::text)", [new Date().toISOString()]) });
      return claimed ? p : null;
    });
    if (!plan) return false;
    const customer = call.customer_id
      ? await db('customers').where('id', call.customer_id).first('first_name', 'last_name')
      : null;
    const meta = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : (call.metadata || {});
    const { triggerNotification } = require('./notification-triggers');
    let stats = null;
    let delivered = false;
    try {
      stats = await triggerNotification('repeat_caller', {
        customerId: call.customer_id || null,
        name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || null,
        phone: call.from_phone,
        line: meta.location || null,
        count: plan.count,
        unanswered: plan.unanswered,
        callLogId: call.id,
      });
    } finally {
      // The claim stands only when the bell or push actually went out, or the
      // owner deliberately silenced the trigger; a delivery failure releases
      // it so the window's next call, or the sweep, tries again.
      delivered = Boolean(stats && !stats.error
        && (stats.bellWritten || Number(stats.push?.sent || 0) > 0 || stats.suppressed || stats.policySilenced));
      if (!delivered) {
        await db('call_log').where({ id: call.id }).update({ metadata: db.raw("metadata - 'repeat_caller_alerted_at'") }).catch(() => {});
        logger.warn(`[repeat-caller-bell] delivery did not happen for call ${String(callSid).slice(-6)} — claim released`);
      }
    }
    return delivered;
  } catch (err) {
    logger.warn(`[repeat-caller-bell] failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return false;
  }
}

/**
 * Durable retry (2-minute scheduler): every number with THRESHOLD or more
 * inbound calls in the window, none of them stamped, whose newest call is
 * past the grace — its post-call timer died with the pod. Re-offering the
 * newest call goes through the same lock + claim, so a live timer racing
 * the sweep still rings once.
 */
async function sweepRepeatCallers({ limit = 50 } = {}) {
  if (!isEnabled('repeatCallerBell')) return 0;
  const windows = await db('call_log')
    .where({ direction: 'inbound' })
    .where('created_at', '>', new Date(Date.now() - REPEAT_WINDOW_MS))
    .modify((qb) => whereNotSandboxCall(qb))
    .whereRaw(`LENGTH(${PHONE_KEY_SQL}) = 10`)
    .groupByRaw(PHONE_KEY_SQL)
    .havingRaw('COUNT(*) >= ?', [REPEAT_THRESHOLD])
    .havingRaw("BOOL_AND(COALESCE(metadata->>'repeat_caller_alerted_at', '') = '')")
    .havingRaw('MAX(created_at) < ?', [new Date(Date.now() - SWEEP_GRACE_MS)])
    .select(db.raw('(array_agg(twilio_call_sid ORDER BY created_at DESC))[1] AS newest_sid'))
    .limit(limit);
  let rang = 0;
  for (const w of windows) {
    if (w.newest_sid && await ringRepeatCallerIfNeeded(w.newest_sid)) rang += 1;
  }
  return rang;
}

module.exports = { repeatCallerPlan, ringRepeatCallerIfNeeded, sweepRepeatCallers, REPEAT_THRESHOLD, REPEAT_WINDOW_MS };

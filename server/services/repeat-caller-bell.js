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
 * Identity is the caller's full E.164 number (codex r3 P2): the voice path
 * keeps non-NANP numbers whole, so a ten-digit suffix would fold two
 * international callers — or one of them and a domestic line — into one.
 *
 * Delivery state lives on the triggering call_log row's metadata, the same
 * lease shape as the missed-call bell (codex r3 P2):
 *   repeat_caller_claim      — a LEASE (fence token; reclaimable once stale,
 *                              so a pod that dies between the claim and the
 *                              bell never loses the alert)
 *   repeat_caller_alerted_at — terminal: the bell went out (or the owner
 *                              deliberately silenced it); the window stays
 *                              quiet after it
 * Read-and-claim run under a per-number advisory lock (codex r1 P2), and a
 * delivery that did not happen releases the lease (codex r1 P2). Two entry
 * points: the post-call timer (twilio-voice-webhook) and the 2-minute
 * durable sweep (codex r1 P2).
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { toE164, isLikelyE164 } = require('../utils/phone');
const { isSentinelPhone } = require('./external-phone');
const { whereNotSandboxCall, VOICE_RELAY_SANDBOX_SOURCE } = require('./voice-agent/relay-protocol');

const REPEAT_THRESHOLD = 3;
const REPEAT_WINDOW_MS = 3 * 60 * 60 * 1000;
// Lease length: customer lookup + delivery with margin; a stale lease is
// reclaimed by the next call's timer or the sweep.
const LEASE_MS = 10 * 60 * 1000;
// Grace before the sweep judges a window: the same 5 minutes the post-call
// timer waits (recording + voicemail callbacks land first).
const SWEEP_GRACE_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['completed', 'no-answer', 'busy', 'canceled', 'failed']);
// Mirror toE164: an explicit '+' preserves the country code, including
// ten-digit international numbers; bare domestic formats use the last ten.
const PHONE_DIGITS_SQL = "regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g')";
const PHONE_KEY_SQL = `(CASE WHEN LEFT(BTRIM(COALESCE(from_phone, '')), 1) = '+' THEN ${PHONE_DIGITS_SQL}`
  + ` WHEN LENGTH(${PHONE_DIGITS_SQL}) >= 10 THEN '1' || RIGHT(${PHONE_DIGITS_SQL}, 10)`
  + ` ELSE ${PHONE_DIGITS_SQL} END)`;
const CLAIM_FREE_SQL = "(COALESCE(metadata->>'repeat_caller_claim', '') = '' OR (metadata->>'repeat_caller_claim')::timestamptz < ?)";

/** Full-number identity, or null for withheld / non-phone caller IDs. */
function callerKey(fromPhone) {
  if (isSentinelPhone(fromPhone)) return null;
  const e164 = toE164(fromPhone);
  return isLikelyE164(e164) ? String(e164).replace(/\D/g, '') : null;
}

/** Pure decision — exported for tests. `calls` are this number's inbound calls, newest first. */
function repeatCallerPlan(calls, now = Date.now()) {
  const recent = (calls || []).filter((c) => {
    const t = new Date(c.created_at).getTime();
    return Number.isFinite(t) && now - t <= REPEAT_WINDOW_MS;
  });
  if (recent.length < REPEAT_THRESHOLD) return null;
  const newest = recent[0];
  if (!TERMINAL_STATUSES.has(newest.status)
    || !(new Date(newest.updated_at || newest.created_at).getTime() <= now - SWEEP_GRACE_MS)) return null;
  if (recent.some((c) => c.repeat_caller_alerted_at)) return null;
  // A live lease means another worker is delivering right now; a stale one
  // is a dead worker's and may be reclaimed.
  if (recent.some((c) => {
    const t = new Date(c.repeat_caller_claim || '').getTime();
    return Number.isFinite(t) && now - t < LEASE_MS;
  })) return null;
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
    const key = callerKey(call.from_phone);
    if (!key) return false;
    const token = new Date().toISOString();
    // One evaluation per number at a time: the window is read and the lease
    // written under a transaction-scoped advisory lock keyed by the number,
    // so a concurrent sibling (another call's timer, or the sweep) re-reads
    // only AFTER this claim commits and sees the lease.
    const plan = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`repeat-caller:${key}`]);
      const rows = await trx('call_log')
        .where({ direction: 'inbound' })
        .whereRaw(`${PHONE_KEY_SQL} = ?`, [key])
        .modify((qb) => whereNotSandboxCall(qb))
        .where('created_at', '>', new Date(Date.now() - REPEAT_WINDOW_MS))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .select('id', 'created_at', 'updated_at', 'status', 'answered_by', 'customer_id',
          trx.raw("(metadata->>'repeat_caller_alerted_at') as repeat_caller_alerted_at"),
          trx.raw("(metadata->>'repeat_caller_claim') as repeat_caller_claim"),
          // Live or completed bookings only (the triage resolver's set): a
          // booking that was cancelled or skipped may be WHY the number
          // keeps calling (codex r4 P2).
          trx.raw("EXISTS (SELECT 1 FROM scheduled_services s WHERE s.source_call_log_id = call_log.id AND s.status IN ('pending', 'confirmed', 'en_route', 'on_site', 'completed')) AS booked"));
      const p = repeatCallerPlan(rows);
      if (!p) return null;
      // Any lease still present in the window is stale (a live one returned
      // null above): a previous owner — of THIS call or an earlier one in
      // the window — died mid-delivery (codex r5 P2).
      p.reclaimed = rows.some((r) => r.repeat_caller_claim);
      p.windowIds = rows.map((r) => r.id);
      const claimed = await trx('call_log')
        .where({ id: call.id })
        .whereRaw("COALESCE(metadata->>'repeat_caller_alerted_at','') = ''")
        .whereRaw(CLAIM_FREE_SQL, [new Date(Date.now() - LEASE_MS)])
        .update({ metadata: trx.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('repeat_caller_claim', ?::text)", [token]) });
      return claimed ? p : null;
    });
    if (!plan) return false;
    // Every later write is fenced on the token: a stale owner waking up late
    // cannot settle or release a lease someone else now holds.
    const fenced = () => db('call_log').where({ id: call.id }).whereRaw("metadata->>'repeat_caller_claim' = ?", [token]);
    const settle = () => fenced().update({ metadata: db.raw("(metadata - 'repeat_caller_claim') || jsonb_build_object('repeat_caller_alerted_at', ?::text)", [new Date().toISOString()]) });
    // Reclaimed a stale lease: the previous owner may have died AFTER the
    // bell row was written. A repeat_caller notification for ANY call in
    // this window means the window delivered — settle instead of ringing
    // twice (codex r4 / r5 P2; a push-only delivery leaves no row and its
    // re-send is coalesced by the per-call push tag).
    if (plan.reclaimed) {
      const prior = await db('notifications').where({ recipient_type: 'admin', category: 'missed_call' })
        .whereRaw("metadata->>'triggerKey' = 'repeat_caller'")
        .whereRaw("metadata->'payload'->>'callLogId' = ANY(?)", [plan.windowIds.map(String)]).first('id');
      if (prior) { await settle().catch(() => {}); return false; }
    }
    let stats = null;
    let delivered = false;
    try {
      const customer = call.customer_id
        ? await db('customers').where('id', call.customer_id).first('first_name', 'last_name')
        : null;
      const meta = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : (call.metadata || {});
      const { triggerNotification } = require('./notification-triggers');
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
      // Settle only when the bell or push actually went out, or the owner
      // deliberately silenced the trigger; anything else — a thrown lookup,
      // a failed dispatch — releases the lease so the window's next call,
      // or the sweep, tries again.
      delivered = Boolean(stats && !stats.error
        && (stats.bellWritten || Number(stats.push?.sent || 0) > 0 || stats.suppressed || stats.policySilenced));
      if (delivered) {
        await settle().catch(() => {});
      } else {
        await fenced().update({ metadata: db.raw("metadata - 'repeat_caller_claim'") }).catch(() => {});
        logger.warn(`[repeat-caller-bell] delivery did not happen for call ${String(callSid).slice(-6)} — lease released`);
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
 * inbound calls in the window, none settled and no live lease, whose newest
 * call is past the grace — its post-call timer died with the pod, or its
 * owner died holding the lease. Re-offering the newest call goes through
 * the same lock + claim, so a live timer racing the sweep still rings once.
 */
async function sweepRepeatCallers({ limit = 50 } = {}) {
  if (!isEnabled('repeatCallerBell')) return 0;
  const windows = await db('call_log')
    .where({ direction: 'inbound' })
    .where('created_at', '>', new Date(Date.now() - REPEAT_WINDOW_MS))
    .modify((qb) => whereNotSandboxCall(qb))
    .whereRaw(`LENGTH(${PHONE_KEY_SQL}) BETWEEN 10 AND 15`)
    .groupByRaw(PHONE_KEY_SQL)
    .havingRaw('COUNT(*) >= ?', [REPEAT_THRESHOLD])
    .havingRaw("BOOL_AND(COALESCE(metadata->>'repeat_caller_alerted_at', '') = '')")
    .havingRaw(`BOOL_AND(${CLAIM_FREE_SQL})`, [new Date(Date.now() - LEASE_MS)])
    // Filter on the newest row AFTER grouping: filtering terminal rows
    // before grouping would hide an active call and resurrect its predecessor.
    .havingRaw('(array_agg(status ORDER BY created_at DESC, id DESC))[1] = ANY(?)', [[...TERMINAL_STATUSES]])
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

/**
 * The "Waves Tech" voice line's billed-minute ledger (tech_voice_usage).
 *
 * Every call the line answers costs Twilio minutes (the voice relay and the
 * inbound call leg), and Twilio rounds each call UP to a whole minute. So the
 * limits are kept in billed minutes, in the database, before Twilio answers:
 *
 *   - reserveTechVoiceCall  under a per-technician advisory lock: refuse while
 *     another call of this technician is live (one call at a time), and refuse
 *     when RESERVE_MINUTES more would pass the daily or monthly limit (ET day
 *     and month). Otherwise insert the reservation. Idempotent on the CallSid
 *     (Twilio retries the voice webhook).
 *   - settleTechVoiceCall   on the call's final status callback: a completed
 *     call keeps its billed minutes (ceil of the duration, at least one) and
 *     gives back the rest of the reservation; a call that never connected
 *     settles at zero. Only an unsettled row changes, so a retried or late
 *     callback cannot settle twice. A call with no final callback keeps its
 *     full reservation (an unknown is counted as spent).
 *
 * RESERVE_MINUTES equals the per-call cap Twilio itself enforces on the call,
 * so a reservation is never smaller than what one call can bill.
 */
const { etDateString, etMonthStart, parseETDateTime } = require('../utils/datetime-et');

const RESERVE_MINUTES = 3;
const DAILY_LIMIT_MINUTES = 15;
const MONTHLY_LIMIT_MINUTES = 150;
// An unsettled reservation younger than this is a call still in progress.
const LIVE_CALL_WINDOW_MS = (RESERVE_MINUTES + 1) * 60 * 1000;
// Final statuses that never connected bill nothing.
const UNANSWERED_STATUSES = new Set(['busy', 'no-answer', 'failed', 'canceled']);


/**
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'call_in_progress'|'daily_limit'|'monthly_limit'|'call_sid_taken' }>}
 */
async function reserveTechVoiceCall(conn, { callSid, technicianId, now = new Date() }) {
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`tech-voice-usage:${technicianId}`]);
    const existing = await trx('tech_voice_usage').where({ call_sid: callSid }).first('technician_id');
    if (existing) return existing.technician_id === technicianId ? { ok: true } : { ok: false, reason: 'call_sid_taken' };
    const live = await trx('tech_voice_usage')
      .where({ technician_id: technicianId })
      .whereNull('settled_at')
      .where('created_at', '>', new Date(now.getTime() - LIVE_CALL_WINDOW_MS))
      .first('call_sid');
    if (live) return { ok: false, reason: 'call_in_progress' };
    const dayStart = parseETDateTime(`${etDateString(now)}T00:00`);
    const monthStart = parseETDateTime(`${etMonthStart(now)}T00:00`);
    // An unsettled row counts its whole reservation: an unknown is spent.
    const used = await trx('tech_voice_usage')
      .where({ technician_id: technicianId })
      .where('created_at', '>=', monthStart)
      .first(
        trx.raw('COALESCE(SUM(COALESCE(billed_minutes, reserved_minutes)) FILTER (WHERE created_at >= ?), 0)::int AS day', [dayStart]),
        trx.raw('COALESCE(SUM(COALESCE(billed_minutes, reserved_minutes)), 0)::int AS month'),
      );
    if (Number(used?.day || 0) + RESERVE_MINUTES > DAILY_LIMIT_MINUTES) return { ok: false, reason: 'daily_limit' };
    if (Number(used?.month || 0) + RESERVE_MINUTES > MONTHLY_LIMIT_MINUTES) return { ok: false, reason: 'monthly_limit' };
    await trx('tech_voice_usage').insert({
      call_sid: callSid, technician_id: technicianId, reserved_minutes: RESERVE_MINUTES, created_at: now,
    });
    return { ok: true };
  });
}

// The billed minutes for a final status, or null when the callback cannot
// settle the call (not final, or a completed call without a usable duration).
function billedMinutesFor(callStatus, durationSeconds) {
  const status = String(callStatus || '').toLowerCase();
  if (UNANSWERED_STATUSES.has(status)) return 0;
  if (status !== 'completed') return null;
  const secs = Number(durationSeconds);
  if (durationSeconds == null || durationSeconds === '' || !Number.isFinite(secs) || secs < 0) return null;
  return Math.max(1, Math.ceil(secs / 60));
}

async function settleTechVoiceCall(conn, { callSid, callStatus, durationSeconds, now = new Date() }) {
  const billed = billedMinutesFor(callStatus, durationSeconds);
  if (billed == null || !callSid) return false;
  const updated = await conn('tech_voice_usage')
    .where({ call_sid: callSid })
    .whereNull('settled_at')
    .update({ billed_minutes: billed, settled_at: now });
  return Number(updated) > 0;
}

module.exports = {
  RESERVE_MINUTES,
  DAILY_LIMIT_MINUTES,
  MONTHLY_LIMIT_MINUTES,
  reserveTechVoiceCall,
  settleTechVoiceCall,
  _test: { billedMinutesFor, LIVE_CALL_WINDOW_MS },
};

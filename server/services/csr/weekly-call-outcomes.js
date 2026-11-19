/**
 * How the week's new-customer calls ended (owner 2026-11-19, "do phase 1 first").
 *
 * A new-customer call is an inbound call whose reviewed extraction classes it `new_lead`
 * (call_nature, the same rule production uses for is_lead, extraction-compat.js, and that
 * caller-callback-bell.js reads in SQL), not a voice sandbox call. Its outcome is the call's
 * terminal disposition (call-disposition.js TERMINAL_DISPOSITIONS): 'booked' = an appointment
 * was created on the call, 'estimate_send' = a quote was promised or requested. A caller is counted
 * once per week, however many times they rang.
 * Read-only: one aggregate query. No recipient, no send.
 */

const db = require('../../models/db');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { whereNotSandboxCall } = require('../voice-agent/relay-protocol');
const { phoneIdentitySql } = require('../sms-response-policy');

const BOOKED_DISPOSITION = 'booked';
const ESTIMATE_DISPOSITION = 'estimate_send';
// The last seven ET calendar days ending today, the window generateWeeklyTeamRecommendation uses.
const WEEK_DAYS = 7;

/**
 * Each caller counts once for the week, however many times they rang: a caller who booked on any call
 * is booked; one who did not book but was promised or sent an estimate is estimate; the rest only add
 * to the total.
 * @returns {Promise<{from: Date, to: Date, newCustomerCalls: number, bookedOnCall: number,
 *   bookedPct: number, sentEstimate: number}>}
 */
async function loadWeeklyCallOutcomes({ now = new Date(), conn = db } = {}) {
  const from = parseETDateTime(`${etDateString(addETDays(now, 1 - WEEK_DAYS))}T00:00`);
  // A caller is their phone identity; a call with no number stands alone.
  const caller = `COALESCE(NULLIF(${phoneIdentitySql('cl.from_phone')}, ''), cl.id::text)`;
  const callers = whereNotSandboxCall(conn('call_log as cl'), 'cl.source')
    .whereRaw("cl.direction LIKE 'inbound%'")
    .whereRaw("cl.ai_extraction_enriched->>'call_nature' = 'new_lead'")
    .where('cl.created_at', '>=', from)
    .where('cl.created_at', '<=', now)
    .select(
      conn.raw(`${caller} AS caller`),
      conn.raw('bool_or(cl.disposition = ?) AS booked', [BOOKED_DISPOSITION]),
      conn.raw('bool_or(cl.disposition = ?) AS estimate', [ESTIMATE_DISPOSITION]),
    )
    .groupByRaw(caller)
    .as('callers');
  const row = await conn.from(callers)
    .select(
      conn.raw('COUNT(*)::int AS total'),
      conn.raw('COUNT(*) FILTER (WHERE booked)::int AS booked'),
      conn.raw('COUNT(*) FILTER (WHERE estimate AND NOT booked)::int AS estimates'),
    )
    .first();
  const total = Number(row?.total) || 0;
  const booked = Number(row?.booked) || 0;
  return {
    from,
    to: now,
    newCustomerCalls: total,
    bookedOnCall: booked,
    bookedPct: total > 0 ? Math.round((booked / total) * 100) : 0,
    sentEstimate: Number(row?.estimates) || 0,
  };
}

// "New-customer calls: 40. Booked on the call: 8 (20%). Sent an estimate: 20."
function formatWeeklyCallOutcomes(o) {
  const pct = o.newCustomerCalls > 0 ? ` (${o.bookedPct}%)` : '';
  return `New-customer calls: ${o.newCustomerCalls}. Booked on the call: ${o.bookedOnCall}${pct}. Sent an estimate: ${o.sentEstimate}.`;
}

module.exports = { loadWeeklyCallOutcomes, formatWeeklyCallOutcomes, BOOKED_DISPOSITION, ESTIMATE_DISPOSITION };

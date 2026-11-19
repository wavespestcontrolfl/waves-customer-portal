/**
 * How the week's new-customer calls ended (owner 2026-11-19, "do phase 1 first").
 *
 * A new-customer call is an inbound call whose reviewed extraction classes it `new_lead`
 * (call_nature, the same rule production uses for is_lead, extraction-compat.js, and that
 * caller-callback-bell.js reads in SQL), not a voice sandbox call. Its outcome is the call's
 * terminal disposition (call-disposition.js TERMINAL_DISPOSITIONS): 'booked' = an appointment
 * was created on the call, 'estimate_send' = a quote was promised or requested (not proof it was sent).
 * A caller is counted once per week, however many times they rang, so the counts are callers, not calls.
 * Dispositions are written only while GATE_CALL_DISPOSITION_V1 is on, so a caller can have no outcome
 * on record: the booked share is taken over callers with a known outcome, and is null when none has one.
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
 * to the total. A caller has a known outcome when any of their calls carries a disposition.
 * @returns {Promise<{from: Date, to: Date, newCustomerCallers: number, callersWithOutcome: number,
 *   bookedOnCall: number, bookedPct: number|null, estimatePromised: number}>}
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
    // A street-level hold is a visit the caller took on the call; the office confirms it later and only
    // then stamps 'booked' (outbound-review-confirm.js stampBookedDispositionForStreetLevelHold). The
    // hold is made by the call's own booking, so a later confirm still counts as booked on the call.
    .select(
      conn.raw(`${caller} AS caller`),
      conn.raw('bool_or(cl.disposition IS NOT NULL) AS known'),
      conn.raw('bool_or(cl.disposition = ?) AS booked', [BOOKED_DISPOSITION]),
      conn.raw('bool_or(cl.disposition = ?) AS estimate', [ESTIMATE_DISPOSITION]),
    )
    .groupByRaw(caller)
    .as('callers');
  const row = await conn.from(callers)
    .select(
      conn.raw('COUNT(*)::int AS total'),
      conn.raw('COUNT(*) FILTER (WHERE known)::int AS known'),
      conn.raw('COUNT(*) FILTER (WHERE booked)::int AS booked'),
      conn.raw('COUNT(*) FILTER (WHERE estimate AND NOT booked)::int AS estimates'),
    )
    .first();
  const total = Number(row?.total) || 0;
  const known = Number(row?.known) || 0;
  const booked = Number(row?.booked) || 0;
  return {
    from,
    to: now,
    newCustomerCallers: total,
    callersWithOutcome: known,
    bookedOnCall: booked,
    // Over callers with a known outcome only; null (no rate) when none has one, never a false 0%.
    bookedPct: known > 0 ? Math.round((booked / known) * 100) : null,
    estimatePromised: Number(row?.estimates) || 0,
  };
}

// "New-customer callers: 40. Outcome known for 30. Booked on the call: 8 of 30 (27%). Estimate promised: 20."
function formatWeeklyCallOutcomes(o) {
  const head = `New-customer callers: ${o.newCustomerCallers}.`;
  if (o.newCustomerCallers === 0) return `${head} Booked on the call: 0. Estimate promised: 0.`;
  if (!o.callersWithOutcome) return `${head} No call outcomes recorded yet, so no booking rate.`;
  return `${head} Outcome known for ${o.callersWithOutcome}. Booked on the call: ${o.bookedOnCall} of ${o.callersWithOutcome} (${o.bookedPct}%). Estimate promised: ${o.estimatePromised}.`;
}

module.exports = { loadWeeklyCallOutcomes, formatWeeklyCallOutcomes, BOOKED_DISPOSITION, ESTIMATE_DISPOSITION };

/**
 * How the week's new-customer calls ended (owner 2026-11-19, "do phase 1 first").
 *
 * A new-customer call is an inbound call, not a voice sandbox call, that staff tagged a new lead
 * (STAFF_NEW_LEAD_TAGS: the tag decides, whatever the extraction says or if there is none), or whose valid
 * extraction (v2_extraction_status 'valid', the processor's one extraction success) classes it `new_lead`
 * (call_nature, the same rule production uses for is_lead, extraction-compat.js, and that
 * caller-callback-bell.js reads in SQL) and whose outcome does not say it was no prospect (NO_PROSPECT_OUTCOMES). The week is by when
 * the call STARTED (callStartedAtSql: a row inserted after hangup has a later created_at).
 * Its outcome is call_log.disposition, written by the AI (call-disposition.js TERMINAL_DISPOSITIONS) or by
 * staff tagging the call (admin-call-recordings.js DISPOSITION_LABELS): 'booked' or the staff tag
 * 'new_lead_booked' = an appointment was made on the call. A quote was requested or promised (not proof it
 * was sent) when the outcome is 'estimate_send' or a valid extraction's service_request flags say so
 * (call-disposition.js step 5 reads the same flags; a quote can come with another outcome, e.g.
 * callback_task_created on an out-of-area hold). A caller is counted once per week, however many times they rang, so
 * the counts are callers, not calls. AI dispositions are written only while GATE_CALL_DISPOSITION_V1 is
 * on, so a caller can have no outcome on record: the booked share is taken over callers with a known
 * outcome, and is null when none has one.
 * Read-only: one aggregate query. No recipient, no send.
 */

const db = require('../../models/db');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { whereNotSandboxCall } = require('../voice-agent/relay-protocol');
const { phoneIdentitySql } = require('../sms-response-policy');
const { callStartedAtSql } = require('../sms-pending-conversations');

// The AI's 'booked' and the staff tag 'new_lead_booked' both mean an appointment was made on the call.
const BOOKED_DISPOSITIONS = Object.freeze(['booked', 'new_lead_booked']);
const ESTIMATE_DISPOSITION = 'estimate_send';
// Outcomes that say the caller was no prospect, whatever the extraction classed: an existing customer
// (the AI's routing or a staff tag), spam, a wrong number or a vendor. Not 'no_action_needed': the processor
// also writes it after a real new-lead conversation (an out-of-area caller with nothing owed,
// call-recording-processor.js), so that caller stays in the count as one who did not book.
const NO_PROSPECT_OUTCOMES = Object.freeze([
  'existing_customer_routed', 'existing_service_q', 'existing_complaint',
  'spam_discarded', 'wrong_number_closed', 'vendor_logged',
]);
// Staff tags that say the call was a new lead (admin-call-recordings.js DISPOSITION_LABELS). Staff can tag a call whose
// extraction is missing, failed validation, or classed it otherwise; the tag alone qualifies the call.
const STAFF_NEW_LEAD_TAGS = Object.freeze(['new_lead_booked', 'new_lead_no_booking']);
// Only a valid extraction is evidence: a payload that failed validation can still carry call_nature and flags.
const VALID_EXTRACTION_SQL = "cl.v2_extraction_status = 'valid'";
const placeholders = (list) => list.map(() => '?').join(', ');
// The valid extraction's own quote flags, JSON true only (call-disposition.js tests `=== true`).
const QUOTE_FLAGS_SQL = "cl.ai_extraction_enriched #> '{service_request,quote_requested}' = 'true'::jsonb"
  + " OR cl.ai_extraction_enriched #> '{service_request,quote_promised}' = 'true'::jsonb";
// The valid extraction says the number is not the caller's own (caller.caller_id_disclaimed, JSON true only): an office
// line or a borrowed phone that more than one prospect may call from.
const CALLER_ID_DISCLAIMED_SQL = "cl.ai_extraction_enriched #> '{caller,caller_id_disclaimed}' = 'true'::jsonb";
// Seven ET calendar days: by default the last seven ending now (the CSR overview's live view); for a report run every
// seven days (`completedDays`), the seven completed days before today, so successive reports cover every call once.
const WEEK_DAYS = 7;

// The seven completed ET dates before `now`'s date: fromDate inclusive, toDate (today) exclusive. The Friday tip reads
// its call outcomes and its scored-call recommendation over exactly these dates, so the tip covers one period.
function completedWeekDates(now = new Date()) {
  return { fromDate: etDateString(addETDays(now, -WEEK_DAYS)), toDate: etDateString(now) };
}

/**
 * Each caller counts once for the week, however many times they rang: a caller who booked on any call
 * is booked; one who did not book but asked for or was promised an estimate is estimate; the rest only
 * add to the total. A caller has a known outcome when any of their calls carries a disposition.
 * `completedDays`: the window is the seven completed ET dates before today, midnight to midnight (the Friday 8 AM
 * tip covers Friday through Thursday, and the next tip starts where it ended). Without it the window is the seven
 * ET dates ending now.
 * @returns {Promise<{from: Date, to: Date, newCustomerCallers: number, callersWithOutcome: number,
 *   bookedOnCall: number, bookedPct: number|null, estimateRequestedOrPromised: number}>}
 */
async function loadWeeklyCallOutcomes({ now = new Date(), conn = db, completedDays = false } = {}) {
  const week = completedWeekDates(now);
  const from = parseETDateTime(`${completedDays ? week.fromDate : etDateString(addETDays(now, 1 - WEEK_DAYS))}T00:00`);
  // A completed window ends at today's ET midnight, exclusive; the live window ends now.
  const to = completedDays ? parseETDateTime(`${week.toDate}T00:00`) : now;
  // A caller is their phone identity. A call with no number stands alone, and so does a call whose number the caller
  // disclaimed: two prospects on one shared line are two callers. (A prospect who rings twice from a disclaimed line
  // counts twice; that is the safer error, since merging would hide one caller's outcome behind the other's.) Only a
  // valid extraction's disclaimer counts.
  const caller = `CASE WHEN ${VALID_EXTRACTION_SQL} AND ${CALLER_ID_DISCLAIMED_SQL} THEN cl.id::text`
    + ` ELSE COALESCE(NULLIF(${phoneIdentitySql('cl.from_phone')}, ''), cl.id::text) END`;
  const started = callStartedAtSql('cl');
  const callers = whereNotSandboxCall(conn('call_log as cl'), 'cl.source')
    .whereRaw("cl.direction LIKE 'inbound%'")
    // Staff tagged it a new lead, or its valid extraction classes it new_lead and no outcome says it was no prospect.
    .whereRaw(
      `(cl.disposition IN (${placeholders(STAFF_NEW_LEAD_TAGS)}) OR (${VALID_EXTRACTION_SQL}`
        + " AND cl.ai_extraction_enriched->>'call_nature' = 'new_lead'"
        + ` AND (cl.disposition IS NULL OR cl.disposition NOT IN (${placeholders(NO_PROSPECT_OUTCOMES)}))))`,
      [...STAFF_NEW_LEAD_TAGS, ...NO_PROSPECT_OUTCOMES],
    )
    // A call's row is never written before the call starts, so created_at >= from keeps every call that
    // started in the week (and lets the index narrow the scan); the start time decides the week.
    .where('cl.created_at', '>=', from)
    .whereRaw(`${started} >= ?`, [from])
    .whereRaw(`${started} ${completedDays ? '<' : '<='} ?`, [to])
    // A street-level hold is a visit the caller took on the call; the office confirms it later and only
    // then stamps 'booked' (outbound-review-confirm.js stampBookedDispositionForStreetLevelHold). The
    // hold is made by the call's own booking, so a later confirm still counts as booked on the call.
    .select(
      conn.raw(`${caller} AS caller`),
      conn.raw('bool_or(cl.disposition IS NOT NULL) AS known'),
      conn.raw('bool_or(cl.disposition IN (?, ?)) AS booked', [...BOOKED_DISPOSITIONS]),
      // The quote flags count only from a valid extraction; a staff-tagged call without one counts by its outcome.
      conn.raw(`bool_or(cl.disposition = ? OR (${VALID_EXTRACTION_SQL} AND (${QUOTE_FLAGS_SQL}))) AS estimate`, [ESTIMATE_DISPOSITION]),
    )
    .groupByRaw(caller)
    .as('callers');
  const row = await conn.from(callers)
    .select(
      conn.raw('COUNT(*)::int AS total'),
      conn.raw('COUNT(*) FILTER (WHERE known)::int AS known'),
      conn.raw('COUNT(*) FILTER (WHERE booked)::int AS booked'),
      // A caller with no disposition on any call has booked NULL (bool_or of NULLs), not false; their quote flags
      // still count, so the test is IS NOT TRUE.
      conn.raw('COUNT(*) FILTER (WHERE estimate AND booked IS NOT TRUE)::int AS estimates'),
    )
    .first();
  const total = Number(row?.total) || 0;
  const known = Number(row?.known) || 0;
  const booked = Number(row?.booked) || 0;
  return {
    from,
    to,
    newCustomerCallers: total,
    callersWithOutcome: known,
    bookedOnCall: booked,
    // Over callers with a known outcome only; null (no rate) when none has one, never a false 0%.
    bookedPct: known > 0 ? Math.round((booked / known) * 100) : null,
    estimateRequestedOrPromised: Number(row?.estimates) || 0,
  };
}

// "New-customer callers: 40. Outcome known for 30. Booked on the call: 8 of 30 (27%). Estimate requested or promised, no booking recorded: 20."
function formatWeeklyCallOutcomes(o) {
  const head = `New-customer callers: ${o.newCustomerCallers}.`;
  if (o.newCustomerCallers === 0) return `${head} Booked on the call: 0. Estimate requested or promised, no booking recorded: 0.`;
  // The extraction's quote flags need no recorded outcome, so the estimate count shows even with no booking rate.
  if (!o.callersWithOutcome) return `${head} No call outcomes recorded yet, so no booking rate. Estimate requested or promised, no booking recorded: ${o.estimateRequestedOrPromised}.`;
  return `${head} Outcome known for ${o.callersWithOutcome}. Booked on the call: ${o.bookedOnCall} of ${o.callersWithOutcome} (${o.bookedPct}%). Estimate requested or promised, no booking recorded: ${o.estimateRequestedOrPromised}.`;
}

module.exports = {
  loadWeeklyCallOutcomes, formatWeeklyCallOutcomes, completedWeekDates, BOOKED_DISPOSITIONS, ESTIMATE_DISPOSITION,
  NO_PROSPECT_OUTCOMES, STAFF_NEW_LEAD_TAGS,
};

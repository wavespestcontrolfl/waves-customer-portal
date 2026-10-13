/**
 * Held visits: the "Promised on a call, not booked" strip on admin Dispatch.
 *
 * Owner 2026-10-12: when staff agree a visit with a caller on a recorded call
 * and nothing is on the calendar for it, show that visit on the day as a
 * display-only HELD row with a "Book it" button. Display only: it writes no
 * visit, no customer and no message.
 *
 * Two kinds of row, both read from the stored V2 extraction
 * (call_log.ai_extraction_enriched, a jsonb object or a JSON string):
 *   confirmed - scheduling.status 'confirmed' with a concrete slot on the
 *               requested ET date (the same slot the booking-miss watchdog
 *               pages on; its helpers are reused here, not copied).
 *   day_only  - a requested / offered / ambiguous visit on a two-party call whose date
 *               range is exactly the requested day, with no time ("time not set").
 *               Never a voicemail, spam or a call that needed no action.
 * One row per call; confirmed wins when a call qualifies as both.
 *
 * A held row clears when the office has acted: a visit carries the call (any
 * date, any customer), the call's customer has a live visit that day, a
 * namesake account booked the confirmed slot after the call (watchdog rule),
 * a day-only call's customer got any live visit after the call, or the office
 * closed the call's triage cards. Dates come from to_char in SQL, never a JS
 * Date round-trip. Dark behind GATE_CALL_HELD_VISIT; read-only.
 */

const db = require('../models/db');
const {
  extractConfirmedSlot,
  rowCarriesCall,
  namesakeRowClearsSlot,
  loadNamesakeAccounts,
  officeClosedCall,
  INACTIVE_STATUSES,
} = require('./call-booking-miss-watchdog');
const { etDateString } = require('../utils/datetime-et');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');

const LOOKBACK_DAYS = 30;
const NOTES_MAX_CHARS = 200;
const DAY_ONLY_STATUSES = new Set(['requested', 'offered', 'ambiguous']);
// The call was handled or is not a visit request: never a day-only row.
const CLOSED_DISPOSITIONS = new Set(['no_action_needed', 'spam_discarded', 'wrong_number_closed', 'vendor_logged']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseExtraction(raw) {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function timeLabel(minutes) {
  if (!Number.isFinite(minutes)) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Calls that could be held on dateET, before any booking evidence is read.
// Returns [{ call, extraction, kind, minutes }]. confirmed beats day_only.
function heldCandidates(calls, dateET, now = new Date()) {
  const since = now.getTime() - LOOKBACK_DAYS * 86400 * 1000;
  const out = [];
  for (const call of calls) {
    const createdAt = call.created_at ? new Date(call.created_at) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime()) || createdAt.getTime() < since) continue;
    if (call.v2_extraction_status !== undefined && call.v2_extraction_status !== 'valid') continue;
    if (!call.processing_status || call.processing_status === 'processing') continue;
    const extraction = parseExtraction(call.ai_extraction_enriched);
    if (!extraction) continue;

    const slot = extractConfirmedSlot(extraction);
    if (slot && slot.dateET === dateET) {
      out.push({ call, extraction, kind: 'confirmed', minutes: slot.minutes, slot });
      continue;
    }

    const sched = extraction.scheduling || {};
    const start = sched.requested_date_range_start;
    if (!DAY_ONLY_STATUSES.has(sched.status)) continue;
    if (!ISO_DATE.test(String(start || '')) || start !== dateET || sched.requested_date_range_end !== start) continue;
    if (call.processing_status !== 'processed') continue;
    // A voicemail lead is 'processed' too, but a one-sided message is a request, not a visit
    // staff agreed on the line.
    if (extraction.meta?.is_voicemail === true || call.answered_by === 'voicemail') continue;
    const spamKind = extraction.spam_verdict?.spam_kind;
    if (spamKind && spamKind !== 'not_spam') continue;
    if (CLOSED_DISPOSITIONS.has(extraction.recommended_disposition)) continue;
    if (dateET < etDateString(createdAt)) continue;
    out.push({ call, extraction, kind: 'day_only', minutes: null, slot: null });
  }
  return out;
}

// Pure. `calls` are call_log rows ({ id, twilio_call_sid, customer_id,
// direction, created_at, from_phone, to_phone, answered_by, processing_status,
// v2_extraction_status, ai_extraction_enriched }); `bookedRows` are
// scheduled_services rows ({ customer_id, status, sched_date ('YYYY-MM-DD'),
// window_start, created_at, source_call_log_id, notes }); `triageRows` are
// triage_items ({ call_log_id, status, resolution_source }). `namesakes` is
// the watchdog's call id -> Set(customer id) map; `customerNames` maps a
// customer id to "First Last".
function computeHeldVisits(calls, bookedRows, triageRows, {
  dateET, namesakes = new Map(), customerNames = new Map(), now = new Date(),
} = {}) {
  const rows = [];
  for (const { call, extraction, kind, minutes, slot } of heldCandidates(calls, dateET, now)) {
    const own = (row) => !!call.customer_id && row.customer_id === call.customer_id && !INACTIVE_STATUSES.has(row.status);
    const sameName = namesakes.get(call.id);
    const callAt = new Date(call.created_at).getTime();
    const cleared = bookedRows.some((row) => (
      rowCarriesCall(row, call)
      || (own(row) && row.sched_date === dateET)
      || (kind === 'confirmed' && !!sameName && sameName.has(row.customer_id) && namesakeRowClearsSlot(row, call, slot))
      || (kind === 'day_only' && own(row) && new Date(row.created_at).getTime() > callAt)
    ));
    if (cleared) continue;
    if (officeClosedCall(triageRows.filter((r) => r.call_log_id === call.id))) continue;

    const outbound = String(call.direction || '').startsWith('outbound');
    const svc = extraction.property?.service_address || {};
    const caller = extraction.caller || {};
    const spokenName = caller.name_full || [caller.first_name, caller.last_name].filter(Boolean).join(' ');
    const notes = String(extraction.scheduling?.scheduling_notes_raw || '').trim();
    rows.push({
      call_log_id: call.id,
      kind,
      date_et: dateET,
      minutes,
      time_label: timeLabel(minutes),
      caller_name: (call.customer_id && customerNames.get(call.customer_id)) || spokenName || 'Unknown caller',
      phone: (outbound ? call.to_phone : call.from_phone) || null,
      address: { line1: svc.street_line_1 || null, city: svc.city || null, zip: svc.postal_code || null },
      service: extraction.service_request?.specific_service_name
        || extraction.service_request?.primary_service_category
        || null,
      call_at: new Date(call.created_at).toISOString(),
      customer_id: call.customer_id || null,
      notes: notes ? notes.slice(0, NOTES_MAX_CHARS) : null,
    });
  }
  rows.sort((a, b) => {
    if ((a.minutes === null) !== (b.minutes === null)) return a.minutes === null ? 1 : -1;
    if (a.minutes !== b.minutes) return a.minutes - b.minutes;
    return a.call_at < b.call_at ? -1 : a.call_at > b.call_at ? 1 : 0;
  });
  return rows;
}

async function listHeldVisits(dateET, { now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callHeldVisit')) return [];

  // The date text appears verbatim in both storage eras of the extraction
  // (jsonb::text and stringified JSON). A foreign-instant confirmed stamp can
  // land on the neighbouring ET day, so scan three dates; JS decides exactly.
  const neighbour = (offset) => new Date(Date.parse(`${dateET}T12:00:00Z`) + offset * 86400 * 1000).toISOString().slice(0, 10);
  const dateTexts = [dateET, neighbour(-1), neighbour(1)].map((d) => `%${d}%`);
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000);
  const calls = await db('call_log')
    .where('created_at', '>=', since)
    .where({ v2_extraction_status: 'valid' })
    .whereRaw("processing_status IS NOT NULL AND processing_status <> 'processing'")
    .whereNotNull('ai_extraction_enriched')
    // Voice-agent sandbox test calls are ordinary inbound rows; they are never a promised visit.
    .modify(whereNotSandboxCall)
    .whereRaw('ai_extraction_enriched::text LIKE ANY(?)', [dateTexts])
    .select('id', 'twilio_call_sid', 'customer_id', 'direction', 'created_at', 'from_phone', 'to_phone', 'answered_by',
      'processing_status', 'v2_extraction_status', 'ai_extraction_enriched');
  const candidates = heldCandidates(calls, dateET, now);
  if (!candidates.length) return [];

  const confirmed = candidates.filter((c) => c.kind === 'confirmed');
  const { namesakes } = confirmed.length ? await loadNamesakeAccounts(confirmed) : { namesakes: new Map() };
  const customerIds = [...new Set([
    ...candidates.map((c) => c.call.customer_id).filter(Boolean),
    ...[...namesakes.values()].flatMap((ids) => [...ids]),
  ])];
  const callIds = candidates.map((c) => c.call.id);
  const sidPatterns = candidates.map((c) => c.call.twilio_call_sid).filter(Boolean).map((sid) => `%Call SID: ${sid}%`);
  const earliestCall = new Date(Math.min(...candidates.map((c) => new Date(c.call.created_at).getTime())));

  const bookedRows = await db('scheduled_services')
    .where(function heldEvidence() {
      this.whereIn('source_call_log_id', callIds);
      if (sidPatterns.length) this.orWhereRaw('notes LIKE ANY(?)', [sidPatterns]);
      if (customerIds.length) {
        this.orWhere(function ownOrNamesake() {
          this.whereIn('customer_id', customerIds)
            .andWhere(function onDateOrAfterCall() {
              this.whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [dateET])
                .orWhere('created_at', '>=', earliestCall);
            });
        });
      }
    })
    .select(
      'customer_id', 'status', 'window_start', 'created_at', 'source_call_log_id', 'notes',
      db.raw("to_char(scheduled_date, 'YYYY-MM-DD') AS sched_date"),
    );
  const triageRows = await db('triage_items').whereIn('call_log_id', callIds).select('call_log_id', 'status', 'resolution_source');
  const linkedIds = [...new Set(candidates.map((c) => c.call.customer_id).filter(Boolean))];
  const people = linkedIds.length ? await db('customers').whereIn('id', linkedIds).select('id', 'first_name', 'last_name') : [];
  const customerNames = new Map(people
    .map((p) => [p.id, [p.first_name, p.last_name].map((v) => String(v || '').trim()).filter(Boolean).join(' ')])
    .filter(([, name]) => name));

  return computeHeldVisits(calls, bookedRows, triageRows, { dateET, namesakes, customerNames, now });
}

module.exports = { computeHeldVisits, listHeldVisits, heldCandidates };

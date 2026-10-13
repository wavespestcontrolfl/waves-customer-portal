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
 * A held row clears when the office has acted:
 *   - a visit carries the call (source_call_log_id or the Call SID note), any date, any customer;
 *   - the call's customer has a live visit on the promised day;
 *   - a namesake account booked the confirmed slot after the call (the watchdog rule);
 *   - a live visit created after the call, on the promised day, sits under a customer who
 *     carries the caller's number, or at the property stated on the call (house number,
 *     street, unit, and the city and ZIP when stated). This covers the normal hand booking
 *     and "Book it", which carry no call reference;
 *   - the office closed the call's triage cards.
 * "Live" is on the calendar or done; a skipped, cancelled or rescheduled visit never counts.
 * A visit on ANOTHER day clears only through the call reference: a recurring visit generated
 * after the call is not this promise.
 * Dates come from to_char in SQL, never a JS
 * Date round-trip. Dark behind GATE_CALL_HELD_VISIT; read-only.
 */

const db = require('../models/db');
const {
  extractConfirmedSlot,
  rowCarriesCall,
  namesakeRowClearsSlot,
  loadNamesakeAccounts,
  officeClosedCall,
  NAMESAKE_LIVE_STATUSES: LIVE_STATUSES,
} = require('./call-booking-miss-watchdog');
const { etDateString } = require('../utils/datetime-et');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { phoneIdentityKey, phoneMatchDigits } = require('../utils/phone');
const { statedAddressCorroborates } = require('./call-family-name-link');

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

const externalPhone = (call) => (String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone) || null;

// The office booked this caller after the call: a visit that is on the calendar or done
// (LIVE_STATUSES, an allow-list: a skipped visit is not a booking), created after the call,
// under a customer who carries the caller's number, or at the address stated on the call.
// The address must be the same property: house number and street, the ZIP and city when the
// call stated them, and the same unit (statedAddressCorroborates, fail closed). `row` carries
// customer_phone, customer_secondary_phone and the visit's address parts (visit_address,
// visit_address_line2, visit_city, visit_zip: the visit's own, else the customer's).
function bookedForCallerAfterCall(row, call, extraction, dateET) {
  // On the promised day only: a later visit on another day (a recurring visit generated after
  // the call, another service) is not this promise. That needs the call reference.
  if (!LIVE_STATUSES.has(row.status) || row.sched_date !== dateET) return false;
  const rowAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
  const callAt = call.created_at ? new Date(call.created_at).getTime() : NaN;
  if (!Number.isFinite(rowAt) || !Number.isFinite(callAt) || rowAt <= callAt) return false;
  const callerKey = phoneIdentityKey(externalPhone(call));
  if (callerKey && [row.customer_phone, row.customer_secondary_phone].some((p) => p && phoneIdentityKey(p) === callerKey)) return true;
  return statedAddressCorroborates(extraction?.property?.service_address, {
    address_line1: row.visit_address, address_line2: row.visit_address_line2, city: row.visit_city, zip: row.visit_zip,
  });
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
// window_start, created_at, source_call_log_id, notes, customer_phone,
// customer_secondary_phone, visit_address, visit_address_line2, visit_city,
// visit_zip }); `triageRows` are
// triage_items ({ call_log_id, status, resolution_source }). `namesakes` is
// the watchdog's call id -> Set(customer id) map; `customerNames` maps a
// customer id to "First Last".
function computeHeldVisits(calls, bookedRows, triageRows, {
  dateET, namesakes = new Map(), customerNames = new Map(), now = new Date(),
} = {}) {
  const rows = [];
  for (const { call, extraction, kind, minutes, slot } of heldCandidates(calls, dateET, now)) {
    // A visit that is on the calendar or done; a skipped, cancelled or rescheduled one is not a booking.
    const own = (row) => !!call.customer_id && row.customer_id === call.customer_id && LIVE_STATUSES.has(row.status);
    const sameName = namesakes.get(call.id);
    const cleared = bookedRows.some((row) => (
      rowCarriesCall(row, call)
      || (own(row) && row.sched_date === dateET)
      || (kind === 'confirmed' && !!sameName && sameName.has(row.customer_id) && namesakeRowClearsSlot(row, call, slot))
      || bookedForCallerAfterCall(row, call, extraction, dateET)
    ));
    if (cleared) continue;
    if (officeClosedCall(triageRows.filter((r) => r.call_log_id === call.id))) continue;

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
      phone: externalPhone(call),
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

  // Hand bookings carry no call reference: also read live visits created after the earliest
  // candidate call whose customer carries a caller's number or whose address starts with a
  // stated house number. The pure function decides the exact match per call.
  const phoneForms = [...new Set(candidates.flatMap((c) => phoneMatchDigits(externalPhone(c.call) || '')))];
  const houseNumbers = [...new Set(candidates
    .map((c) => (String(c.extraction?.property?.service_address?.street_line_1 || '').trim().match(/^\d+/) || [])[0])
    .filter(Boolean))].map((n) => `${n} %`);
  const digits = (col) => `regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g')`;
  // The visit's own service address when it has one, else the customer's: all four parts from
  // the same source.
  const hasOwnAddress = "NULLIF(btrim(ss.service_address_line1), '') IS NOT NULL";
  const part = (visitCol, customerCol) => `CASE WHEN ${hasOwnAddress} THEN ss.${visitCol} ELSE cu.${customerCol} END`;
  const visitAddress = part('service_address_line1', 'address_line1');
  const bookedRows = await db('scheduled_services as ss')
    .leftJoin('customers as cu', 'cu.id', 'ss.customer_id')
    .where(function heldEvidence() {
      this.whereIn('ss.source_call_log_id', callIds);
      if (sidPatterns.length) this.orWhereRaw('ss.notes LIKE ANY(?)', [sidPatterns]);
      if (customerIds.length) {
        this.orWhere(function ownOrNamesake() {
          this.whereIn('ss.customer_id', customerIds).whereRaw("to_char(ss.scheduled_date, 'YYYY-MM-DD') = ?", [dateET]);
        });
      }
      if (phoneForms.length || houseNumbers.length) {
        this.orWhere(function handBookedAfterCall() {
          this.where('ss.created_at', '>=', earliestCall).whereRaw("to_char(ss.scheduled_date, 'YYYY-MM-DD') = ?", [dateET]).andWhere(function callerOrAddress() {
            if (phoneForms.length) {
              this.whereRaw(`${digits('cu.phone')} = ANY(?)`, [phoneForms]).orWhereRaw(`${digits('cu.secondary_phone')} = ANY(?)`, [phoneForms]);
            }
            if (houseNumbers.length) this.orWhereRaw(`${visitAddress} LIKE ANY(?)`, [houseNumbers]);
          });
        });
      }
    })
    .select(
      'ss.customer_id', 'ss.status', 'ss.window_start', 'ss.created_at', 'ss.source_call_log_id', 'ss.notes',
      'cu.phone as customer_phone', 'cu.secondary_phone as customer_secondary_phone',
      db.raw(`${visitAddress} AS visit_address`),
      db.raw(`${part('service_address_line2', 'address_line2')} AS visit_address_line2`),
      db.raw(`${part('service_address_city', 'city')} AS visit_city`),
      db.raw(`${part('service_address_zip', 'zip')} AS visit_zip`),
      db.raw("to_char(ss.scheduled_date, 'YYYY-MM-DD') AS sched_date"),
    );
  const triageRows = await db('triage_items').whereIn('call_log_id', callIds).select('call_log_id', 'status', 'resolution_source');
  const linkedIds = [...new Set(candidates.map((c) => c.call.customer_id).filter(Boolean))];
  const people = linkedIds.length ? await db('customers').whereIn('id', linkedIds).select('id', 'first_name', 'last_name') : [];
  const customerNames = new Map(people
    .map((p) => [p.id, [p.first_name, p.last_name].map((v) => String(v || '').trim()).filter(Boolean).join(' ')])
    .filter(([, name]) => name));

  return computeHeldVisits(calls, bookedRows, triageRows, { dateET, namesakes, customerNames, now });
}

module.exports = { computeHeldVisits, listHeldVisits, heldCandidates, bookedForCallerAfterCall };

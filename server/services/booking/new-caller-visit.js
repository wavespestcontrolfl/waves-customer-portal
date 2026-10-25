// New-caller visit (GATE_NEW_CALLER_BOOKING, owner 2026-10-25, decision page
// 2CGso96J). The office, still on the phone with a NEW caller, picks the
// caller's address in New Appointment's New customer block and books ONE
// visit before any customer record exists. The visit is a committed booking
// with no customer: customer_id NULL, the picked address and coordinates,
// source_action 'admin_new_caller', and the live call the office answered
// (source_call_log_id) so the call-recording agent can link the customer it
// creates from that call's recording. Nothing reaches the caller here: no
// confirmation, no reminder row, no inspection credit (each needs a
// customer; the link step runs them).
//
// Which call: an inbound call the office accepted (the press-1 screen stamps
// metadata.forward_acceptance) or an outbound bridge, started within the last
// PICKABLE_ANSWERED_MINUTES and still live or ended within the last
// PICKABLE_ENDED_MINUTES. Calls the voice agent still holds never carry
// forward_acceptance, so they never list. A call's end comes from
// utils/call-timeline.js callEndedAt, never updated_at: recording processing
// and metadata writes bump that long after hangup.

const db = require('../../models/db');
const { isEnabled } = require('../../config/feature-gates');
const { TERMINAL_CALL_STATUSES, callEndedAt } = require('../../utils/call-timeline');
const { whereNotSandboxCall } = require('../voice-agent/relay-protocol');
// booking-insert-contract.test.js recognizes the contract helper by this path.
const { completeScheduledServiceInsert } = require('../booking/create-scheduled-service');
const { assertAdminAppointmentWindow, probeSlotOverlap, slotOverlapWarning } = require('../scheduling/window-rules');
const { assertAssignableTechnician } = require('../technician-eligibility');
const mistingRefill = require('../misting-refill');
const logger = require('../logger');
const { lockCustomerComms } = require('../../utils/customer-comms-lock');
const { dateOnlyString } = require('../../utils/datetime-et');
const { ensurePrimaryProperty, recordCallProperty } = require('../customer-properties');
const { addressKey } = require('../customer-property-address-keys');
const { closeAdminAlertKeys } = require('../admin-alert-episodes');

const NEW_CALLER_SOURCE_ACTION = 'admin_new_caller';
const PICKABLE_ANSWERED_MINUTES = 30;
const PICKABLE_ENDED_MINUTES = 10;
// The save re-checks the picked call with this much extra room: the office
// may finish the form a few minutes after the picker loaded.
const SAVE_GRACE_MINUTES = 30;
// A call answered inside the window began at most this long before its
// answer: a coarse created_at bound so the picker never scans all of call_log.
const RING_BEFORE_ANSWER_MINUTES = 120;
const MAX_PICKABLE_CALLS = 10;
// Calls answered in the window, newest first, before the ended-call check
// drops the long-ended ones (staff answer far fewer calls than this in 30 minutes).
const MAX_ANSWERED_CANDIDATES = 50;
// callEndedAt reads created_at, metadata and both lengths; the save locks on the Call SID.
const CALL_COLUMNS = ['id', 'twilio_call_sid', 'direction', 'from_phone', 'to_phone', 'status', 'created_at', 'metadata', 'duration_seconds', 'recording_duration_seconds'];

// The bell for a visit booked by address that still waits for its customer
// (D4): one row per visit, closed by the link.
const newCallerVisitAlertKey = (visitId) => `new-caller-visit:${visitId}`;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZIP = /^\d{5}(-\d{4})?$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.isOperational = true;
  return err;
}

function text(value, max) {
  if (value == null) return '';
  if (typeof value !== 'string') throw httpError(400, 'Every address and note field must be text.');
  const trimmed = value.trim();
  if (trimmed.length > max) throw httpError(400, `A field is longer than ${max} characters.`);
  return trimmed;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function matchOrThrow(value, pattern, message) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!pattern.test(trimmed)) throw httpError(400, message);
  return trimmed;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim() || null;
}

function optionalNumber(value, { min, max, integer = false, message }) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw httpError(400, message);
  return n;
}

// The picked suggestion: street line (with any unit), ZIP and coordinates are
// required, so the visit has a stop every route and pin reader can place.
function validateAddress(raw) {
  const address = raw && typeof raw === 'object' ? raw : {};
  const line1 = text(address.line1, 200);
  const zip = text(address.zip, 10);
  const lat = finiteNumber(address.lat);
  const lng = finiteNumber(address.lng);
  if (!line1 || !ZIP.test(zip) || lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw httpError(400, 'Pick the caller\'s address from the address suggestions.');
  }
  return {
    line1,
    line2: text(address.line2, 100),
    city: text(address.city, 100),
    state: text(address.state, 2).toUpperCase() || 'FL',
    zip,
    lat,
    lng,
  };
}

// Validates and normalizes the Book request. Throws a 400 with a message the
// modal shows as is.
function validateNewCallerInput(input = {}) {
  const serviceId = optionalString(input.serviceId);
  if (!serviceId) throw httpError(400, 'Pick a service from the list.');
  const callLogId = optionalString(input.callLogId);
  if (callLogId && !UUID.test(callLogId)) throw httpError(400, 'Pick the call again.');
  const linePrice = optionalNumber(input.linePrice, { min: 0, max: 100000, message: 'The price must be a number from 0 to 100000.' });
  return {
    scheduledDate: matchOrThrow(input.scheduledDate, YMD, 'Pick a date.'),
    windowStart: matchOrThrow(typeof input.windowStart === 'string' ? input.windowStart.slice(0, 5) : '', HHMM, 'Pick a time.'),
    serviceId,
    durationMinutes: optionalNumber(input.durationMinutes, { min: 1, max: 720, integer: true, message: 'The visit length must be between 1 and 720 minutes.' }),
    linePrice: linePrice == null ? null : Math.round(linePrice * 100) / 100,
    technicianId: optionalString(input.technicianId),
    callLogId,
    address: validateAddress(input.address),
    notes: text(input.notes, 2000),
    internalNotes: text(input.internalNotes, 2000),
    createInvoice: input.createInvoice !== false,
  };
}

function parseMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'object') return metadata;
  try { return JSON.parse(metadata) || {}; } catch { return {}; }
}

function maskedPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `•••-${digits.slice(-4)}` : null;
}

// One call_log row as the picker shows it: the caller's number masked to its
// last four digits, who answered, when it started and whether it is live.
function toPickableCall(row) {
  if (!row?.id) return null;
  const meta = parseMetadata(row.metadata);
  const acceptance = meta.forward_acceptance || {};
  const inbound = row.direction === 'inbound';
  return {
    id: row.id,
    direction: inbound ? 'inbound' : 'outbound',
    caller: maskedPhone(inbound ? row.from_phone : row.to_phone),
    answeredBy: inbound ? (acceptance.csr_name || maskedPhone(acceptance.answered_by_number) || null) : null,
    startedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    live: !TERMINAL_CALL_STATUSES.has(String(row.status || '')),
  };
}

// A live call stays pickable; an ended one only while its end (callEndedAt:
// the /call-status stamp, else start + length) is inside the last
// `endedMinutes`. An ended call with no known end is not pickable.
function stillPickable(row, { now, endedMinutes }) {
  if (!TERMINAL_CALL_STATUSES.has(String(row?.status || ''))) return true;
  const ended = callEndedAt(row);
  return Boolean(ended) && ended.getTime() >= now.getTime() - endedMinutes * 60 * 1000;
}

function answeredCallsQuery(conn, { now, answeredMinutes }) {
  const answeredSince = new Date(now.getTime() - answeredMinutes * 60 * 1000);
  return conn('call_log')
    .modify((q) => whereNotSandboxCall(q))
    .where('created_at', '>=', new Date(answeredSince.getTime() - RING_BEFORE_ANSWER_MINUTES * 60 * 1000))
    .where((scope) => {
      scope.where((inbound) => {
        inbound.where('direction', 'inbound')
          .whereRaw(
            "(CASE WHEN (metadata #>> '{forward_acceptance,accepted_at}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' "
              + "THEN (metadata #>> '{forward_acceptance,accepted_at}')::timestamptz END) >= ?",
            [answeredSince],
          );
      }).orWhere((outbound) => {
        outbound.where('direction', 'outbound')
          .where('created_at', '>=', answeredSince)
          .where((agent) => agent.whereNull('answered_by').orWhereNot('answered_by', 'ai_agent'));
      });
    });
}

async function listPickableCalls({ conn = db, now = new Date() } = {}) {
  const rows = await answeredCallsQuery(conn, { now, answeredMinutes: PICKABLE_ANSWERED_MINUTES })
    .orderBy('created_at', 'desc')
    .limit(MAX_ANSWERED_CANDIDATES)
    .select(CALL_COLUMNS);
  return rows
    .filter((row) => stillPickable(row, { now, endedMinutes: PICKABLE_ENDED_MINUTES }))
    .slice(0, MAX_PICKABLE_CALLS)
    .map(toPickableCall)
    .filter(Boolean);
}

async function findPickableCallForSave(conn, callLogId, now) {
  const row = await answeredCallsQuery(conn, { now, answeredMinutes: PICKABLE_ANSWERED_MINUTES + SAVE_GRACE_MINUTES })
    .where('id', callLogId)
    .first(CALL_COLUMNS);
  return row && stillPickable(row, { now, endedMinutes: PICKABLE_ENDED_MINUTES + SAVE_GRACE_MINUTES }) ? row : null;
}

// The call locks, before rung 1, in the order the recording processor's
// booking transaction takes its own (call-recording-processor.js): the call
// row's id first, so two writers for one call run one after the other even
// while an outbound bridge has no Call SID yet, then the processor's Call SID
// lock. Whoever runs second sees the first one's visit.
async function lockCallForBooking(trx, call) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['new-caller-visit-call', call.id]);
  if (call.twilio_call_sid) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['call-recording-schedule', call.twilio_call_sid]);
  }
}

// Books the visit. `zone` comes from the route (admin-schedule.js getZone,
// the same zone the office create route stamps). Returns the inserted row
// and any advisory overlap warning; admin writes never block on a clash.
async function bookNewCallerVisit({ input, zone = null, adminUserId = null, conn = db, now = new Date() } = {}) {
  if (!isEnabled('newCallerBooking')) throw httpError(404, 'Not found');
  const v = validateNewCallerInput(input);

  const serviceRecord = await conn('services').where({ id: v.serviceId }).first();
  if (!serviceRecord) throw httpError(400, 'Pick a service from the list.');
  // A misting refill is an add-on of a misting plan visit, never the visit
  // itself: the same refusal buildAppointmentPricing throws (GATE_MOSQUITO_MISTING).
  if (mistingRefill.refillLive() && mistingRefill.isRefillKey(serviceRecord.service_key)) {
    throw mistingRefill.refusalError(await mistingRefill.resolveRefillAttachment({ parentServiceKey: serviceRecord.service_key }, conn));
  }
  // A lot-size price needs the customer's property data; the office types
  // the price or adds the customer first (buildAppointmentPricing).
  if (serviceRecord.service_key === 'mosquito_one_time' && v.linePrice == null) {
    throw httpError(400, 'This service is priced by lot size. Type the price, or add the customer first.');
  }
  const durationMinutes = v.durationMinutes || serviceRecord.default_duration_minutes || 60;
  const window = assertAdminAppointmentWindow({ windowStart: v.windowStart, windowEnd: null, durationMinutes });
  // Same base rule as buildAppointmentPricing for a line with no discount:
  // a typed price wins, else the catalog base price.
  const estimatedPrice = v.linePrice != null
    ? v.linePrice
    : (serviceRecord.base_price != null && Number.isFinite(Number(serviceRecord.base_price)) ? Number(serviceRecord.base_price) : null);

  return conn.transaction(async (trx) => {
    let callLogId = null;
    if (v.callLogId) {
      const call = await findPickableCallForSave(trx, v.callLogId, now);
      if (!call) throw httpError(409, 'That call is no longer live. Pick the call again.');
      // A repeated Book, or the processor's own booking of this call, is refused below.
      await lockCallForBooking(trx, call);
      const owned = await trx('scheduled_services')
        .whereNull('parent_service_id')
        .whereNotIn('status', ['cancelled', 'rescheduled'])
        .where((linked) => {
          linked.where('source_call_log_id', call.id);
          if (call.twilio_call_sid) linked.orWhere('notes', 'like', `%Call SID: ${call.twilio_call_sid}%`);
        })
        .first('id');
      if (owned) throw httpError(409, 'This call already has a visit. Find it on Dispatch.');
      callLogId = call.id;
    }
    // Rung 1 (occupancy.js ordering contract), then the row locks.
    const clash = await probeSlotOverlap({
      trx, date: v.scheduledDate, windowStart: window.window_start, windowEnd: window.window_end,
    });
    if (v.technicianId) await assertAssignableTechnician(v.technicianId, { conn: trx, date: v.scheduledDate });

    const cols = await trx('scheduled_services').columnInfo();
    const insertData = {
      customer_id: null,
      technician_id: v.technicianId,
      scheduled_date: v.scheduledDate,
      window_start: window.window_start,
      window_end: window.window_end,
      service_type: serviceRecord.name,
      status: 'pending',
      zone,
      estimated_duration_minutes: durationMinutes,
      notes: v.notes || null,
      is_recurring: false,
      source_action: NEW_CALLER_SOURCE_ACTION,
      service_address_line1: v.address.line1,
      service_address_line2: v.address.line2,
      service_address_city: v.address.city,
      service_address_state: v.address.state,
      service_address_zip: v.address.zip,
      lat: v.address.lat,
      lng: v.address.lng,
    };
    const optional = {
      service_id: serviceRecord.id,
      estimated_price: estimatedPrice,
      primary_line_price: estimatedPrice,
      source_call_log_id: callLogId,
      // internal_notes, never notes: notes are customer-visible. The marker is
      // the provenance the call pagers already read (call-booking-miss-watchdog).
      internal_notes: [callLogId ? `Booked for a new caller by address. Call ID: ${callLogId}.` : 'Booked for a new caller by address. No live call was found.', v.internalNotes]
        .filter(Boolean).join('\n'),
      create_invoice_on_complete: v.createInvoice,
    };
    for (const [field, value] of Object.entries(optional)) {
      if (cols[field]) insertData[field] = value;
    }
    const data = await completeScheduledServiceInsert(insertData, {
      trx, cols, source: { sourceAction: NEW_CALLER_SOURCE_ACTION }, allowNewCallerVisit: true,
    });
    const [visit] = await trx('scheduled_services').insert(data).returning('*');
    await trx('activity_log').insert({
      admin_user_id: adminUserId,
      customer_id: null,
      action: 'new_caller_visit_booked',
      description: `Visit ${visit.id} booked by address for a new caller${callLogId ? ` (call ${callLogId})` : ' (no live call found)'}.`,
      metadata: JSON.stringify({ scheduled_service_id: visit.id, call_log_id: callLogId }),
    });
    return { visit, warnings: clash.length ? [slotOverlapWarning(v.scheduledDate)] : [] };
  });
}

// Links a visit booked by address to its customer: the office's Link, and
// the call-recording agent's link step. Serialized with Book and the
// processor's booking on the visit's call. D6: an address that is not on the
// customer's account yet becomes one of its properties, and the visit points
// at it. The visit's bell closes. armLinkedVisitComms arms the reminders and
// the confirmation after the commit. propertySource labels a property the
// link adds: 'manual' for the office, 'call_pipeline' for the agent.
async function linkNewCallerVisit({ visitId, customerId, adminUserId = null, propertySource = 'manual', conn = db } = {}) {
  if (!isEnabled('newCallerBooking')) throw httpError(404, 'Not found');
  matchOrThrow(visitId, UUID, 'Open the visit again.');
  matchOrThrow(customerId, UUID, 'Pick the customer again.');
  const linked = await conn.transaction(async (trx) => {
    const visit = await trx('scheduled_services').where({ id: visitId }).first();
    if (!visit || visit.source_action !== NEW_CALLER_SOURCE_ACTION) throw httpError(404, 'This visit was not booked by address for a new caller.');
    if (visit.source_call_log_id) {
      const call = await trx('call_log').where({ id: visit.source_call_log_id }).first('id', 'twilio_call_sid');
      if (call) await lockCallForBooking(trx, call);
    }
    // Rung 6 before any row lock (occupancy.js ordering contract), then the
    // customer row itself (customers before the child rows written below), so
    // a merge cannot archive it between this check and the link.
    await lockCustomerComms(trx, customerId);
    const customer = await trx('customers').where({ id: customerId }).forUpdate().first('id', 'deleted_at');
    if (!customer) throw httpError(400, 'That customer was not found. Pick the customer again.');
    if (customer.deleted_at) {
      throw httpError(409, 'That customer was merged into another account. Search again and pick the current one.');
    }
    const address = {
      address_line1: visit.service_address_line1, address_line2: visit.service_address_line2,
      city: visit.service_address_city, state: visit.service_address_state, zip: visit.service_address_zip,
    };
    // The customer's own home first (an older customer may have no property row
    // yet), so a different booked address is added beside it, never as its primary.
    await ensurePrimaryProperty(customerId, { conn: trx });
    const recorded = await recordCallProperty({
      customerId, ...address, latitude: visit.lat, longitude: visit.lng, source: propertySource, conn: trx,
    });
    // Every row, removed ones too: recordCallProperty never re-adds a removed
    // address, and a removed property is never booked.
    const key = addressKey(address);
    const properties = await trx('customer_properties').where({ customer_id: customerId })
      .select('id', 'active', 'address_line1', 'address_line2', 'city', 'zip');
    const property = properties.find((p) => key && addressKey(p) === key);
    if (!property || !property.active) {
      throw httpError(409, property
        ? 'This address was removed from the customer\'s account, so the visit cannot use it. Check the customer, or book the visit again.'
        : 'The visit address could not be added to this customer. Try again.');
    }
    const note = 'Linked to its customer after the call.';
    const [row] = await trx('scheduled_services')
      .where({ id: visit.id })
      .whereNull('customer_id')
      .whereNotIn('status', ['cancelled', 'rescheduled'])
      .update({
        customer_id: customerId,
        property_id: property.id,
        internal_notes: visit.internal_notes ? `${visit.internal_notes}\n${note}` : note,
        updated_at: new Date(),
      })
      .returning('*');
    if (!row) throw httpError(409, 'This visit already has a customer, or it was cancelled.');
    await trx('activity_log').insert({
      admin_user_id: adminUserId,
      customer_id: customerId,
      action: 'new_caller_visit_linked',
      description: `Visit ${row.id} booked by address is linked to its customer.`,
      metadata: JSON.stringify({ scheduled_service_id: row.id, call_log_id: row.source_call_log_id || null, property_added: recorded.created === true }),
    });
    return { visit: row, addedProperty: recorded.created === true };
  });
  await closeAdminAlertKeys(conn, [newCallerVisitAlertKey(visitId)], 'linked', { resolution: 'Linked to its customer' })
    .catch((err) => logger.warn(`[new-caller] bell close failed for visit ${visitId}: ${err.message}`));
  return linked;
}

// After a link: the calls the office create route makes for a new visit
// (registerAppointment, then the deferred sendConfirmation). Both catch their
// own failures and answer null / false, so the outcome is read from their
// answers: { remindersArmed, confirmationSent }.
async function armLinkedVisitComms({ visit, sendConfirmation = true }) {
  const AppointmentReminders = require('../appointment-reminders');
  const windowStart = visit.window_start ? String(visit.window_start).slice(0, 5) : null;
  const registered = await AppointmentReminders.registerAppointment(
    visit.id, visit.customer_id,
    `${dateOnlyString(visit.scheduled_date)}T${windowStart || '08:00'}`,
    visit.service_type, 'admin_manual',
    { sendConfirmation, deferConfirmation: true, closeReminderWindows: !windowStart, fromCommittedRow: true },
  );
  if (!registered) return { remindersArmed: false, confirmationSent: false };
  if (!sendConfirmation) return { remindersArmed: true, confirmationSent: false };
  return { remindersArmed: true, confirmationSent: (await AppointmentReminders.sendConfirmation(visit.id)) === true };
}

module.exports = {
  NEW_CALLER_SOURCE_ACTION,
  PICKABLE_ANSWERED_MINUTES,
  PICKABLE_ENDED_MINUTES,
  validateNewCallerInput,
  toPickableCall,
  stillPickable,
  listPickableCalls,
  bookNewCallerVisit,
  linkNewCallerVisit,
  armLinkedVisitComms,
  newCallerVisitAlertKey,
};

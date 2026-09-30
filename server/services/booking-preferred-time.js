'use strict';

/**
 * /book "Can't find a time?" preferred-time request (GATE_BOOK_PREFERRED_TIME,
 * owner 2026-09-29).
 *
 * A visitor who sees no workable time (far towns often get none) tells us the
 * day and time of day they'd like. The request becomes OFFICE WORK: one lead
 * (lead_type 'book_preferred_time', status 'new', so it shows in Leads, the
 * "leads awaiting contact" dashboard alert and the new_lead admin bell) that
 * staff answer by hand.
 *
 * NOTHING here sends to the customer — no SMS, no email, no confirmation text.
 * The only outbound side effect is the internal new_lead admin bell. To keep
 * the abandoned-booking recovery worker from texting the same person about the
 * slot they walked away from, every OPEN booking_intent for the same phone or
 * session is retired (suppressed) INSIDE the submit's own transaction, and
 * capture-intent skips a phone that filed a request in the last day (see
 * hasRecentPreferredTimeRequest). The booking_intents ROW is the chokepoint with
 * the recovery worker: the submit's UPDATE and the worker's SELECT ... FOR
 * UPDATE contend on the same row, so exactly one of them goes first (see
 * withLockedRecoveryIntent in booking-abandon-recovery.js).
 *
 * Pure validation is separate from persistence so both are unit-testable.
 */

const logger = require('./logger');
const { resolveLeadSource } = require('./lead-source-resolver');
const { etDateString, addETDays, parseETDateTime, validCalendarDate } = require('../utils/datetime-et');

const { OPEN_LEAD_STATUSES } = require('./lead-statuses');

const LEAD_TYPE = 'book_preferred_time';
// When the customer last asked: the submit-only stamp in extracted_data, falling
// back to created_at for a row without one. leads.updated_at is deliberately
// NOT used — office edits (status, notes, assignment) stamp it.
const LAST_REQUESTED_SQL = "COALESCE(NULLIF(extracted_data->>'last_requested_at', '')::timestamptz, created_at) > ?";
const FIRST_CONTACT_CHANNEL = 'book_preferred_time';
const HORIZON_DAYS = 120;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Customer-facing time-of-day choices — the ONLY strings that persist for it.
const TIME_OF_DAY_LABELS = {
  morning: 'Morning',
  midday: 'Midday',
  afternoon: 'Afternoon',
  any: 'Any time',
};

// Same allowlist the other public funnels use for first-touch attribution
// (routes/public-lawn-assessment.js) — required lazily: that route module is
// heavy and only the rare submit needs it.
const sanitizeAttribution = (raw) => require('../routes/public-lawn-assessment').sanitizeAttribution(raw);

const clean = (value, max) => {
  const s = (value == null ? '' : String(value)).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : '';
};

// Same normalizer shape the /book funnel uses: last ten digits of a US number.
function tenDigitPhone(raw) {
  const d = String(raw == null ? '' : raw).replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? ten : null;
}

function validPreferredDate(raw, today) {
  const date = validCalendarDate(String(raw == null ? '' : raw).slice(0, 10));
  if (!date) return null;
  const last = etDateString(addETDays(parseETDateTime(`${today}T12:00`), HORIZON_DAYS));
  return date >= today && date <= last ? date : null;
}

/**
 * Validate + normalize the request body. Returns { ok:true, value } or
 * { ok:false, error }. `honeypot:true` means a bot filled the hidden field —
 * the caller answers success and stores nothing.
 */
function validatePreferredTimeRequest(body, { now = new Date() } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (clean(b.website, 200)) return { ok: false, honeypot: true, error: 'honeypot' };

  const today = etDateString(now);
  const name = clean(b.name, 120);
  if (!name) return { ok: false, error: 'Please tell us your name.' };
  const [firstName, ...rest] = name.split(' ');
  const lastName = rest.join(' ') || null;

  const phone = tenDigitPhone(b.phone);
  if (!phone) return { ok: false, error: 'Please enter a 10-digit phone number.' };

  const firstDate = validPreferredDate(b.preferred_date, today);
  if (!firstDate) return { ok: false, error: 'Please pick a day in the next few months.' };
  let secondDate = null;
  if (clean(b.second_date, 20)) {
    secondDate = validPreferredDate(b.second_date, today);
    if (!secondDate) return { ok: false, error: 'That second day is not valid.' };
    if (secondDate === firstDate) secondDate = null;
  }

  const timeKey = clean(b.time_of_day, 20).toLowerCase() || 'any';
  if (!Object.prototype.hasOwnProperty.call(TIME_OF_DAY_LABELS, timeKey)) {
    return { ok: false, error: 'Please choose morning, midday, afternoon or any time.' };
  }

  const email = clean(b.email, 200);
  return {
    ok: true,
    value: {
      firstName,
      lastName,
      phone,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null,
      addressLine1: clean(b.address_line1, 200) || null,
      addressLine2: clean(b.address_line2, 100) || null,
      city: clean(b.city, 100) || null,
      state: clean(b.state, 40) || null,
      zip: clean(b.zip, 20) || null,
      preferredDate: firstDate,
      secondDate,
      timeOfDay: timeKey,
      note: clean(b.note, 500) || null,
      sessionId: clean(b.session_id, 80) || null,
      attribution: sanitizeAttribution(b.attribution),
    },
  };
}

function formatDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Plain-English line the Leads page shows under "Notes" (transcript_summary).
function buildSummary(value, serviceLabel) {
  const parts = [
    `Could not find an online time on /book${serviceLabel ? ` for ${serviceLabel}` : ''}.`,
    `Would like ${formatDay(value.preferredDate)}, ${TIME_OF_DAY_LABELS[value.timeOfDay].toLowerCase()}.`,
  ];
  if (value.secondDate) parts.push(`Second choice: ${formatDay(value.secondDate)}.`);
  if (value.note) parts.push(`Note: ${value.note}`);
  parts.push('Text or call them to set a time. No automatic message was sent.');
  return parts.join(' ');
}

const tenMatch = (q, ten) => q.whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten]);

/**
 * Retire every open abandoned-booking intent for this phone or session so the
 * recovery worker sends nothing about the slot they walked away from. Runs on
 * the submit's transaction handle: the UPDATE takes a row lock on each matching
 * intent, so it waits out a recovery worker that holds the row for a send, and
 * a worker that arrives afterwards waits for the submit's commit and then reads
 * the row as suppressed. Matches by phone OR funnel session, so a visitor who
 * corrected their phone mid-session (the intent row keeps ONE row per session)
 * is still found.
 */
async function retireOpenBookingIntents(db, { phone, sessionId }) {
  await db('booking_intents')
    .whereNull('converted_at')
    .where('suppressed', false)
    .where((q) => {
      tenMatch(q, phone);
      if (sessionId) q.orWhere('session_id', sessionId);
    })
    .update({ suppressed: true, updated_at: db.fn.now() });
}

/**
 * True when this phone (or the same funnel session) filed a preferred-time
 * request since `since` (default: the last 24h). capture-intent uses the
 * default; the recovery worker passes the intent's own capture time so a
 * request filed AFTER the abandonment always blocks its send.
 */
async function hasRecentPreferredTimeRequest(db, phone, { sessionId = null, since = null } = {}) {
  const floor = since ? new Date(Math.min(new Date(since).getTime(), Date.now() - DEDUPE_WINDOW_MS)) : new Date(Date.now() - DEDUPE_WINDOW_MS);
  const q = db('leads')
    .where({ lead_type: LEAD_TYPE })
    .whereNull('deleted_at')
    .whereRaw(LAST_REQUESTED_SQL, [floor])
    .where((w) => {
      tenMatch(w, phone);
      if (sessionId) w.orWhereRaw("extracted_data->>'session_id' = ?", [sessionId]);
    });
  return !!(await q.first('id'));
}

// Per-phone transaction-scoped advisory lock: serializes two SUBMITS for the
// same phone so the lookup-then-write below cannot create two leads. It is NOT
// what fences the recovery worker (that is the booking_intents row lock).
async function lockPhone(trx, phone) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`book_preferred_time:${phone}`]);
}

/**
 * True when this phone's owner booked on /book at or after `since` AND that
 * booking's conversion took the (just filed) preferred-time lead — via
 * convertPreferredTimeLeadsOnBooking, the same lifecycle path /confirm runs, so
 * a Waves Assessment booking or an ambiguous phone still leaves the lead open.
 * Runs AFTER the submit's commit: a booking that commits later than this check
 * finds the committed lead and converts it itself; one that committed earlier
 * is seen here. Never throws.
 */
async function reconcileBookingSince(db, { phone, since }) {
  try {
    const booked = await db('self_booked_appointments as sba')
      .leftJoin('customers as c', 'sba.customer_id', 'c.id')
      .whereRaw("RIGHT(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone])
      .where('sba.created_at', '>=', since)
      .whereNot('sba.status', 'cancelled')
      .orderBy('sba.created_at', 'desc')
      .first('sba.id', 'sba.customer_id');
    if (!booked) return false;
    const service = await db('scheduled_services').where({ self_booking_id: booked.id }).first();
    const out = await convertPreferredTimeLeadsOnBooking(db, { customerId: booked.customer_id, booking: service || null });
    return out.converted > 0;
  } catch (err) {
    logger.warn(`[booking:preferred-time] booking reconcile failed: ${err.message}`);
    return false;
  }
}

/**
 * Persist the request. Returns { created, leadId }. A second submit from the
 * same phone within 24h refreshes the one lead (no second row, no second
 * bell). The lookup and write run under a per-phone advisory lock. Never
 * sends to the customer.
 */
async function recordPreferredTimeRequest(db, value, { serviceLabel = null, serviceKey = null, notify = true } = {}) {
  // Taken BEFORE the transaction: a booking that commits from here on may have
  // run its own conversion before this lead became visible (see
  // reconcileBookingSince below). A minute of slack absorbs app/DB clock skew;
  // a booking that close before the request is moot for it too.
  const startedAt = new Date(Date.now() - 60 * 1000);
  const attr = value.attribution || null;
  const clickId = (v) => (v ? String(v).slice(0, 255) : null);
  const requestFields = {
    source: FIRST_CONTACT_CHANNEL,
    preferred_date: value.preferredDate,
    second_date: value.secondDate,
    time_of_day: value.timeOfDay,
    note: value.note,
    service_key: serviceKey,
    address_line1: value.addressLine1,
    address_line2: value.addressLine2 || null,
    state: value.state,
    session_id: value.sessionId,
    customer_messaged: false,
    // The customer's latest submit — written ONLY by a submit (never by office
    // edits, which stamp updated_at), so suppression and dedupe recency mean
    // "when the customer last asked".
    last_requested_at: new Date().toISOString(),
  };
  // First-touch attribution is written once, when the lead is CREATED; a
  // refresh keeps the original (see the merge in the refresh UPDATE).
  const extractedNew = {
    ...requestFields,
    utm: attr?.utm || null,
    referrer: attr?.referrer || null,
    landing_url: attr?.landing_url || null,
  };
  // leads has no unit column: keep the unit inline with the street line, the
  // way capture-intent stores it for booking_intents.
  const streetAddress = [value.addressLine1, value.addressLine2].filter(Boolean).join(', ');
  const summary = buildSummary(value, serviceLabel);
  const phoneE164 = `+1${value.phone}`;
  const sourceMeta = await resolveLeadSource(attr);
  const attribution = {
    lead_source_id: sourceMeta?.leadSourceId || null,
    gclid: clickId(attr?.gclid),
    wbraid: clickId(attr?.wbraid),
    gbraid: clickId(attr?.gbraid),
    fbclid: clickId(attr?.fbclid),
    fbc: clickId(attr?.fbc),
    fbp: clickId(attr?.fbp),
  };

  // ONE transaction: suppress the open recovery intents, then refresh-or-create
  // the lead and its funnel row. The intent UPDATE comes first because it is the
  // serialization point with the recovery worker (row locks on booking_intents);
  // any failure here fails the request — nothing is left half-written and no
  // lead is ever visible without its funnel row.
  const { leadId, created } = await db.transaction(async (trx) => {
    await lockPhone(trx, value.phone);
    await retireOpenBookingIntents(trx, { phone: value.phone, sessionId: value.sessionId });

    const existing = await tenMatch(
      trx('leads')
        .where({ lead_type: LEAD_TYPE })
        .whereNull('deleted_at')
        // Sliding window on the customer's latest submit (LAST_REQUESTED_SQL),
        // and only a lead the office has not already worked or closed — a
        // genuinely new request after that is a new lead + bell.
        .whereIn('status', OPEN_LEAD_STATUSES)
        .whereNull('converted_at')
        .whereRaw(LAST_REQUESTED_SQL, [new Date(Date.now() - DEDUPE_WINDOW_MS)]),
      value.phone,
    ).orderBy('created_at', 'desc').first('id');

    if (existing) {
      // The staff writers do not take the phone lock, so the refresh is
      // conditional on the lead STILL being open and unconverted: a lead staff
      // closed/converted since the lookup updates 0 rows and this request
      // becomes a new lead (with its bell) instead of writing onto a closed one.
      const refreshed = await trx('leads')
        .where({ id: existing.id })
        .whereNull('deleted_at')
        .whereIn('status', OPEN_LEAD_STATUSES)
        .whereNull('converted_at')
        .update({
          first_name: value.firstName,
          last_name: value.lastName,
          email: value.email,
          address: streetAddress,
          city: value.city,
          zip: value.zip,
          service_interest: serviceLabel,
          transcript_summary: summary,
          // Merge, never replace: only this request's own fields are written;
          // the lead's first-touch UTM / referrer / landing URL stay (they
          // agree with its stored lead_source_id and click ids). Done in SQL
          // so a concurrent staff edit of another key is not lost either.
          extracted_data: trx.raw("COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify(requestFields)]),
          updated_at: trx.fn.now(),
        });
      if (refreshed) return { leadId: existing.id, created: false };
    }
    const [row] = await trx('leads').insert({
      first_name: value.firstName,
      last_name: value.lastName,
      phone: phoneE164,
      email: value.email,
      address: streetAddress,
      city: value.city,
      zip: value.zip,
      lead_type: LEAD_TYPE,
      service_interest: serviceLabel,
      first_contact_at: new Date(),
      first_contact_channel: FIRST_CONTACT_CHANNEL,
      status: 'new',
      is_residential: true,
      transcript_summary: summary,
      extracted_data: JSON.stringify(extractedNew),
      ...attribution,
    }).returning('*');

    // The ONE ad_service_attribution funnel row a lead's own intake stamps,
    // rebuilt from what the lead stored (its snapshot + click ids), written in
    // the SAME transaction as the lead so a booking that converts it the instant
    // it is visible always finds the row to advance to 'booked'. Idempotent on
    // the unique lead_id. rethrow: a failed statement must abort this
    // transaction rather than be swallowed against an aborted handle.
    const { stampLeadFunnelRow } = require('./lead-funnel-bridge');
    await stampLeadFunnelRow(trx, row, { rethrow: true });
    return { leadId: row.id, created: true };
  });

  // A booking that won the race with this submit (its post-commit conversion
  // ran before this lead was visible) is reconciled here, through the same
  // bridge, so an already-booked customer neither keeps an open lead nor rings
  // the bell. Best-effort: on any failure the lead simply stays open and rings.
  const alreadyBooked = await reconcileBookingSince(db, { phone: value.phone, since: startedAt });

  if (created && notify && !alreadyBooked) {
    try {
      const { triggerNotification } = require('./notification-triggers');
      await triggerNotification('new_lead', {
        title: 'Preferred-time request',
        name: `${value.firstName}${value.lastName ? ` ${value.lastName}` : ''}`,
        source: 'the /book page (no time found)',
        area: value.city || null,
        zip: value.zip || null,
        service: serviceLabel || null,
        phone: phoneE164,
        leadId,
      });
    } catch (err) {
      logger.warn(`[booking:preferred-time] admin bell failed: ${err.message}`);
    }
  }

  return { created, leadId };
}

/**
 * A customer who just completed a booking no longer needs the office to chase
 * their preferred-time request: convert THE open preferred-time lead for the
 * booked customer's verified phone through the EXISTING lead lifecycle —
 * convertLeadFromEvent (an explicit lead id) → markConverted → the funnel
 * settlement that advances the lead's ad_service_attribution row to 'booked'.
 * No raw status write. The lead is linked to the customer by markConverted, so
 * the new_lead bell's relevance sweep retires the bell. A Waves Assessment
 * booking is not a win (convertLeadFromEvent's own rule) and leaves the lead
 * open.
 *
 * Converts exactly ONE lead, and only when that is unambiguous: a phone with
 * two or more open preferred-time requests (asks more than a day apart, or a
 * shared household number) could be two different people, and one booking
 * proves only one of them — the same rule convertLeadFromEvent applies to a
 * phone-matched lead ('ambiguous_contact'). Those stay open for staff. Nothing
 * is retired without a win.
 *
 * Idempotent (a converted lead is no longer open) so the normal commit path and
 * the txResult.existing replay path can both call it. Never throws into the
 * booking. Returns { converted, ambiguous } — converted is 1 only when
 * markConverted actually won its conditional write, so the caller can tell
 * attributeSelfBooking that the funnel entry is the lead's.
 */
async function convertPreferredTimeLeadsOnBooking(db, { customerId, booking = null } = {}) {
  if (!customerId) return { converted: 0 };
  try {
    const customer = await db('customers').where({ id: customerId }).first('phone');
    const ten = tenDigitPhone(customer && customer.phone);
    if (!ten) return { converted: 0 };
    const q = db('leads')
      .where({ lead_type: LEAD_TYPE })
      .whereNull('deleted_at')
      .whereIn('status', OPEN_LEAD_STATUSES)
      .whereNull('converted_at');
    const open = (await tenMatch(q, ten).select('id')) || [];
    if (!open.length) return { converted: 0 };
    if (open.length > 1) {
      logger.warn(`[booking:preferred-time] ${open.length} open preferred-time leads for customer=${customerId}'s phone — not converting any (ambiguous); staff resolve`);
      return { converted: 0, ambiguous: true };
    }
    const { convertLeadFromEvent } = require('./lead-estimate-link');
    const result = await convertLeadFromEvent({
      source: 'preferred_time_booked',
      customerId,
      leadId: open[0].id,
      booking,
      database: db,
    });
    return { converted: result && result.converted ? 1 : 0 };
  } catch (err) {
    logger.warn(`[booking:preferred-time] converting preferred-time lead on booking failed for customer=${customerId}: ${err.message}`);
    return { converted: 0 };
  }
}

module.exports = {
  convertPreferredTimeLeadsOnBooking,
  LEAD_TYPE,
  TIME_OF_DAY_LABELS,
  validatePreferredTimeRequest,
  recordPreferredTimeRequest,
  hasRecentPreferredTimeRequest,
  retireOpenBookingIntents,
  buildSummary,
};

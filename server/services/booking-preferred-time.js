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
 * session is retired (suppressed) in the same call, and capture-intent skips a
 * phone that filed a request in the last day (see hasRecentPreferredTimeRequest).
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
 * recovery worker sends nothing about the slot they walked away from.
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

// ONE per-phone chokepoint (transaction-scoped advisory lock) shared by the
// submit path and the abandoned-booking recovery worker. A submit holds it
// while it looks up + writes the lead; the worker holds it across its final
// preferred-time re-check AND the send, so a submit can never commit between
// the worker's last look and its dispatch: either the submit finishes first
// (the worker then sees the lead and sends nothing) or the send finishes
// first (the submit waits, and the send counts as already happened).
async function lockPhone(trx, phone) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`book_preferred_time:${phone}`]);
}

/**
 * Run `fn(trx)` holding the per-phone preferred-time lock. The lock is held
 * only for the duration of `fn` (one provider call for the worker) and only
 * ever contends with a submit for the SAME phone. A phone that cannot be
 * normalized has nothing to serialize and runs `fn` on the plain handle. Any
 * lock/transaction failure propagates — callers treat it as "do not send".
 */
async function withPreferredTimePhoneLock(db, phone, fn) {
  const ten = tenDigitPhone(phone);
  if (!ten) return fn(db);
  return db.transaction(async (trx) => {
    await lockPhone(trx, ten);
    return fn(trx);
  });
}

/**
 * Persist the request. Returns { created, leadId }. A second submit from the
 * same phone within 24h refreshes the one lead (no second row, no second
 * bell). The lookup and write run under a per-phone advisory lock. Never
 * sends to the customer.
 */
async function recordPreferredTimeRequest(db, value, { serviceLabel = null, serviceKey = null, notify = true } = {}) {
  const attr = value.attribution || null;
  const clickId = (v) => (v ? String(v).slice(0, 255) : null);
  const extracted = {
    source: FIRST_CONTACT_CHANNEL,
    preferred_date: value.preferredDate,
    second_date: value.secondDate,
    time_of_day: value.timeOfDay,
    note: value.note,
    service_key: serviceKey,
    address_line1: value.addressLine1,
    state: value.state,
    session_id: value.sessionId,
    customer_messaged: false,
    // The customer's latest submit — written ONLY by a submit (never by office
    // edits, which stamp updated_at), so suppression and dedupe recency mean
    // "when the customer last asked".
    last_requested_at: new Date().toISOString(),
    utm: attr?.utm || null,
    referrer: attr?.referrer || null,
    landing_url: attr?.landing_url || null,
  };
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

  const { leadId, created, leadRow } = await db.transaction(async (trx) => {
    await lockPhone(trx, value.phone);
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
      await trx('leads').where({ id: existing.id }).update({
        first_name: value.firstName,
        last_name: value.lastName,
        email: value.email,
        address: value.addressLine1 || '',
        city: value.city,
        zip: value.zip,
        service_interest: serviceLabel,
        transcript_summary: summary,
        extracted_data: JSON.stringify(extracted),
        updated_at: trx.fn.now(),
      });
      return { leadId: existing.id, created: false };
    }
    const [row] = await trx('leads').insert({
      first_name: value.firstName,
      last_name: value.lastName,
      phone: phoneE164,
      email: value.email,
      address: value.addressLine1 || '',
      city: value.city,
      zip: value.zip,
      lead_type: LEAD_TYPE,
      service_interest: serviceLabel,
      first_contact_at: new Date(),
      first_contact_channel: FIRST_CONTACT_CHANNEL,
      status: 'new',
      is_residential: true,
      transcript_summary: summary,
      extracted_data: JSON.stringify(extracted),
      ...attribution,
    }).returning('*');
    return { leadId: row.id, created: true, leadRow: row };
  });

  // File the ONE ad_service_attribution funnel row a lead's own intake stamps,
  // rebuilt from what the lead stored (its snapshot + click ids), so the later
  // booking conversion has a row to advance to 'booked' and the request counts
  // in channel reporting like every other public lead. Idempotent on the unique
  // lead_id; best-effort like the other creators.
  if (created) {
    try {
      const { stampLeadFunnelRow } = require('./lead-funnel-bridge');
      await stampLeadFunnelRow(db, leadRow);
    } catch (err) {
      logger.warn(`[booking:preferred-time] funnel row stamp failed for lead ${leadId}: ${err.message}`);
    }
  }

  // Best effort from here: the lead is saved, so a failure below must not
  // become an error the visitor sees. The recovery worker re-checks for this
  // lead at send time (booking-abandon-recovery.js), so a failed suppression
  // here can never lead to a message.
  try {
    await retireOpenBookingIntents(db, { phone: value.phone, sessionId: value.sessionId });
  } catch (err) {
    logger.warn(`[booking:preferred-time] intent retire failed: ${err.message}`);
  }

  if (created && notify) {
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
 * their preferred-time request: convert every OPEN preferred-time lead for the
 * booked customer's verified phone through the EXISTING lead lifecycle —
 * convertLeadFromEvent (an explicit lead id) → markConverted → the funnel
 * settlement that advances the lead's ad_service_attribution row to 'booked'.
 * No raw status write. The lead is linked to the customer by markConverted, so
 * the new_lead bell's relevance sweep retires the bell. A Waves Assessment
 * booking is not a win (convertLeadFromEvent's own rule) and leaves the lead
 * open. Idempotent: a converted lead is no longer open, so the normal commit
 * path and the txResult.existing replay path can both call it. Never throws
 * into the booking. Returns { converted } — the number of leads converted — so
 * the caller can tell attributeSelfBooking that the funnel entry is the lead's.
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
    const open = await tenMatch(q, ten).select('id');
    const { convertLeadFromEvent } = require('./lead-estimate-link');
    let converted = 0;
    for (const lead of open || []) {
      const result = await convertLeadFromEvent({
        source: 'preferred_time_booked',
        customerId,
        leadId: lead.id,
        booking,
        database: db,
      });
      if (result && result.converted) converted += result.count || 1;
    }
    return { converted };
  } catch (err) {
    logger.warn(`[booking:preferred-time] converting preferred-time lead on booking failed for customer=${customerId}: ${err.message}`);
    return { converted: 0 };
  }
}

module.exports = {
  convertPreferredTimeLeadsOnBooking,
  withPreferredTimePhoneLock,
  LEAD_TYPE,
  TIME_OF_DAY_LABELS,
  validatePreferredTimeRequest,
  recordPreferredTimeRequest,
  hasRecentPreferredTimeRequest,
  retireOpenBookingIntents,
  buildSummary,
};

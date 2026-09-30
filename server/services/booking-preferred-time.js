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

const LEAD_TYPE = 'book_preferred_time';
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
    // updated_at, not created_at: a resubmit refreshes the one lead in place
    // (updated_at = now), and the request is as recent as its LAST refresh.
    .where('updated_at', '>', floor)
    .where((w) => {
      tenMatch(w, phone);
      if (sessionId) w.orWhereRaw("extracted_data->>'session_id' = ?", [sessionId]);
    });
  return !!(await q.first('id'));
}

// Serializes concurrent submits for one phone (two tabs, a retry) so exactly
// one lead + one bell is created per 24h. Transaction-scoped advisory lock.
async function lockPhone(trx, phone) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`book_preferred_time:${phone}`]);
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

  const { leadId, created } = await db.transaction(async (trx) => {
    await lockPhone(trx, value.phone);
    const existing = await tenMatch(
      trx('leads')
        .where({ lead_type: LEAD_TYPE })
        .whereNull('deleted_at')
        // Sliding window on the last refresh (see hasRecentPreferredTimeRequest).
        .where('updated_at', '>', new Date(Date.now() - DEDUPE_WINDOW_MS)),
      value.phone,
    ).orderBy('updated_at', 'desc').first('id');

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
    }).returning('id');
    return { leadId: row && row.id ? row.id : row, created: true };
  });

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

module.exports = {
  LEAD_TYPE,
  TIME_OF_DAY_LABELS,
  validatePreferredTimeRequest,
  recordPreferredTimeRequest,
  hasRecentPreferredTimeRequest,
  retireOpenBookingIntents,
  buildSummary,
};

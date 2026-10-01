'use strict';

/**
 * /book "Can't find a time?" preferred-time request (GATE_BOOK_PREFERRED_TIME,
 * owner 2026-09-29).
 *
 * A visitor who sees no workable time (far towns often get none) tells us the
 * day and time of day they'd like. The request becomes OFFICE WORK: one lead
 * (lead_type 'book_preferred_time', status 'new', so it shows in Leads, the
 * "leads awaiting contact" dashboard alert and the new_lead admin bell) that
 * staff answer by hand — or that closes itself ('handled') when the customer
 * then books online (closeBookedPreferredLeads below).
 *
 * NOTHING here sends to the customer — no SMS, no email, no confirmation text.
 * The only outbound side effects are internal: the new_lead admin bell, and
 * the one admin FYI when a booking closes the request. To keep
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
const { etDateString, addETDays, parseETDateTime, validCalendarDate, dateOnlyString } = require('../utils/datetime-et');

const { OPEN_LEAD_STATUSES } = require('./lead-statuses');
const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');

const LEAD_TYPE = 'book_preferred_time';
// When the customer last asked: the submit-only stamp in extracted_data, falling
// back to created_at for a row without one. leads.updated_at is deliberately
// NOT used — office edits (status, notes, assignment) stamp it.
const LAST_REQUESTED_SQL = "COALESCE(NULLIF(extracted_data->>'last_requested_at', '')::timestamptz, created_at) > ?";
// 'booking' (the /book page's own channel), not a novel value: the shared
// customer-originated-contact allowlist (collections/consent-provenance.js,
// reused by outbound-call-reason.js) fails closed on unknown channels, which
// would hide this prospect-initiated contact from the call pipeline.
const FIRST_CONTACT_CHANNEL = 'booking';
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

// Visit statuses that no longer hold a self-booking; mirrors the replay guard in
// routes/booking.js (createSelfBooking) so both agree on "live".
const DEAD_VISIT_STATUSES = ['cancelled', 'skipped', 'rescheduled'];
// App/DB clock skew a booking may sit either side of a request it belongs to.
const BOOKING_SLACK_MS = 60 * 1000;

/**
 * True when this phone's owner booked on /book at or after `since` and that
 * booking holds a LIVE, non-callback visit: the request is then moot, so the
 * caller must not ring the new_lead bell for it. A booking never converts a
 * preferred-time lead (codex #5399 r13): closeBookedPreferredLeads closes it
 * as 'handled' with the one admin FYI instead (owner ruling 2026-10-01), the
 * same close every booking path makes. Runs AFTER the submit's commit: a
 * booking that commits later than this check finds the committed lead and
 * closes it itself; one that committed earlier is seen here. Never throws.
 */
async function reconcileBookingSince(db, { phone, since, leadId = null }) {
  try {
    const bookings = await db('self_booked_appointments as sba')
      .leftJoin('customers as c', 'sba.customer_id', 'c.id')
      .whereRaw("RIGHT(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone])
      .where('sba.created_at', '>=', since)
      .whereNot('sba.status', 'cancelled')
      .orderBy('sba.created_at', 'desc')
      .limit(10)
      .select('sba.id', 'sba.customer_id', 'sba.created_at');
    for (const candidate of bookings || []) {
      const out = await closeBookedPreferredLeads(db, { customerId: candidate.customer_id, booking: candidate });
      // The booking's own funnel row may already exist (its attribution ran before
      // this close): then this closer is the second and drops the request's row.
      await dropSupersededPreferredFunnelRows(db, { booking: candidate });
      // The bell is moot only when THIS request is now closed (a booking on a shared
      // phone that does not corroborate it leaves it open). Judged on THIS request: on a shared phone the close may have taken an older
      // request of the booker's and left the new one open (its bell must ring).
      if (leadId) {
        const row = await db('leads').where({ id: leadId }).first('status');
        if (row && row.status === CLOSED_STATUS) return true;
      } else if (out.closed > 0) {
        return true;
      }
    }
    return false;
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
  // run its own close step before this lead became visible (see
  // reconcileBookingSince below). A minute of slack absorbs app/DB clock skew;
  // a booking that close before the request is moot for it too.
  const startedAt = new Date(Date.now() - 60 * 1000);
  const attr = value.attribution || null;
  const clickId = (v) => (v ? String(v).slice(0, 255) : null);
  const requestFields = {
    source: LEAD_TYPE,
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
      if (refreshed) {
        // The lead's funnel row was classified from the FIRST request's
        // service; a refresh that changes service_interest must reclassify it
        // (same classifier the stamp uses), in this transaction, or a later
        // booking conversion reports the wrong service line. Only the
        // classification moves — stage, source and dedupe scope are untouched.
        await trx('ad_service_attribution')
          .where({ lead_id: existing.id })
          .update({
            service_line: inferServiceLine(serviceLabel),
            specific_service: inferSpecificService(serviceLabel),
            service_bucket: inferServiceBucket(serviceLabel),
          });
        return { leadId: existing.id, created: false };
      }
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
    // the SAME transaction as the lead so no lead is ever visible without its
    // funnel row (staff who later win it settle that row). Idempotent on
    // the unique lead_id. rethrow: a failed statement must abort this
    // transaction rather than be swallowed against an aborted handle.
    const { stampLeadFunnelRow } = require('./lead-funnel-bridge');
    await stampLeadFunnelRow(trx, row, { rethrow: true });
    return { leadId: row.id, created: true };
  });

  // A booking that won the race with this submit (its post-commit close ran
  // before this lead was visible) is reconciled here: the lead closes the same
  // way (with the admin FYI) and an already-booked customer does not ring the
  // new_lead bell. Best-effort: on any failure the lead simply stays open and
  // rings.
  const alreadyBooked = await reconcileBookingSince(db, { phone: value.phone, since: startedAt, leadId });

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

const CLOSE_REASON = 'booking_on_preferred_request';

// A phone is not an identity: a household or business line is shared by people
// whose requests are their own (codex #5477 r2 P1). A request closes itself only
// when something besides the phone ties it to the booked customer: its own
// customer link, the same email, or the same first AND last name (letters only,
// case and punctuation ignored). The booking carries no funnel session id and
// booking_intents are converted by phone alone, so a session match would prove
// nothing here. Anything else stays open for the office.
const normName = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^\p{L}]/gu, '');
const normEmail = (v) => String(v == null ? '' : v).trim().toLowerCase();
function corroboratesBookedCustomer(lead, customer, customerId) {
  if (lead.customer_id && String(lead.customer_id) === String(customerId)) return true;
  const email = normEmail(customer && customer.email);
  if (email && email === normEmail(lead.email)) return true;
  const first = normName(customer && customer.first_name);
  const last = normName(customer && customer.last_name);
  return !!(first && last && first === normName(lead.first_name) && last === normName(lead.last_name));
}
const CLOSED_STATUS = 'handled';

// The one FYI the office gets when a request closes itself. composeAdminAlert
// enforces docs/admin-notifications.md (headline 60, one-sentence why of 110, no
// code-shaped tokens), so the customer-supplied name and service are tidied
// first. Best-effort and deduped per (lead, visit): a replay never rings twice.
async function notifyRequestClosed({ lead, customerName, service, day, visitId }) {
  try {
    const { raiseAdminAlert, cutAtWord } = require('./admin-alert-compose');
    const who = clean(customerName, 40).replace(/[._]+/g, ' ').trim() || 'The customer';
    const what = service.replace(/_/g, ' ');
    await raiseAdminAlert('lead', {
      area: 'Leads',
      action: 'Request closed, customer booked online',
      why: cutAtWord(`${who} booked ${what} for ${day}; the time request closed on its own.`, 110),
      severity: 'fyi',
      link: `/admin/leads?lead=${lead.id}`,
      subject: { type: 'lead', id: String(lead.id) },
      doneWhen: 'already_done',
      who: 'person',
    }, { dedupeKey: `preferred-time-auto-close:${lead.id}:${visitId}`, bell: true, fyiRow: true });
  } catch (err) {
    logger.warn(`[booking:preferred-time] auto-close admin notice failed for lead=${lead.id}: ${err.message}`);
  }
}

/**
 * A customer who books on /book after asking for a preferred time no longer
 * needs the office to chase that request, so it closes itself (owner ruling
 * 2026-10-01, superseding the 2026-09-30 note-only rule): each open
 * preferred-time lead on the booked customer's phone that the customer asked
 * for at or before the booking (60 s of app/DB clock slack) moves to the
 * terminal status 'handled' — closed, neither won nor lost. It deliberately
 * never converts the lead and settles no funnel row (the booking's own attribution
 * runs exactly as for any other booking; 'handled' has no funnel mapping), so
 * no deal is counted twice and no lost-lead number moves. ONE status_change
 * activity row is the audit trail, deduped per (lead, visit), and the office
 * gets ONE admin FYI per close — nothing goes to the customer.
 *
 * `booking` is the self_booked_appointments row ({ id, created_at }). Only a
 * LIVE, non-callback visit counts: a free re-service callback is a warranty
 * visit and a cancelled / skipped / rescheduled one no longer holds the booking.
 * Returns { live, closed }: `live` = the booking holds such a visit (the
 * submit's reconcile keys its new_lead bell on it), `closed` = leads closed by
 * this call. Best-effort; never throws into the booking.
 */
async function closeBookedPreferredLeads(db, { customerId, booking = null, convertedLeadIds = [] } = {}) {
  const none = { live: false, closed: 0 };
  if (!customerId || !booking || !booking.id) return none;
  try {
    const visit = await db('scheduled_services')
      .where({ self_booking_id: booking.id })
      .whereNotIn('status', DEAD_VISIT_STATUSES)
      .first();
    if (!visit || visit.is_callback) return none;
    const bookedMs = new Date(booking.created_at).getTime();
    const convertedIds = (Array.isArray(convertedLeadIds) ? convertedLeadIds : []).filter(Boolean).map(String);
    if (Number.isNaN(bookedMs)) return { live: true, closed: 0 };
    const customer = await db('customers').where({ id: customerId }).first('phone', 'first_name', 'last_name', 'email');
    const ten = tenDigitPhone(customer && customer.phone);
    if (!ten) return { live: true, closed: 0 };
    const open = (await tenMatch(
      db('leads')
        .where({ lead_type: LEAD_TYPE })
        .whereNull('deleted_at')
        .whereIn('status', OPEN_LEAD_STATUSES)
        .whereNull('converted_at')
        .whereRaw(LAST_REQUESTED_SQL.replace(' > ?', ' <= ?'), [new Date(bookedMs + BOOKING_SLACK_MS)]),
      ten,
    ).select('id')) || [];
    const service = clean(visit.service_type, 120) || 'a service';
    const day = visit.scheduled_date ? formatDay(dateOnlyString(visit.scheduled_date)) : 'the scheduled day';
    let closed = 0;
    for (const lead of open) {
      // Per-(lead, visit) advisory lock: the booking's own post-commit path and
      // the submit's reconcile can both arrive for the same visit.
      const result = await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`book_preferred_note:${lead.id}:${visit.id}`]);
        const seen = await trx('lead_activities')
          .where({ lead_id: lead.id, activity_type: 'status_change' })
          .whereRaw("metadata->>'reason' = ? AND metadata->>'visit_id' = ?", [CLOSE_REASON, String(visit.id)])
          .first('id');
        if (seen) return null;
        // Re-read the lead under a row lock (codex #5399 r14): staff may have
        // reassigned its phone, linked it to another customer or closed it since
        // the open-lead query above, and the customer may have refreshed the
        // request (a newer last_requested_at is new work, never this booking's
        // to close). The advisory lock only orders closers, so the lead's own
        // state, phone identity and request recency are re-proven right here.
        const current = await trx('leads').where({ id: lead.id }).forUpdate().first(
          'lead_type', 'status', 'converted_at', 'deleted_at', 'phone', 'customer_id', 'first_name', 'last_name', 'email',
          trx.raw(`(${LAST_REQUESTED_SQL.replace(' > ?', ' <= ?')}) AS requested_in_time`, [new Date(bookedMs + BOOKING_SLACK_MS)]),
        );
        const stillOurs = current
          && current.lead_type === LEAD_TYPE
          && OPEN_LEAD_STATUSES.includes(current.status)
          && !current.converted_at
          && !current.deleted_at
          && current.requested_in_time === true
          && String(current.phone || '').replace(/\D/g, '').slice(-10) === ten // same last-10 rule as tenMatch
          && (!current.customer_id || String(current.customer_id) === String(customerId))
          && corroboratesBookedCustomer(current, customer, customerId);
        if (!stillOurs) return null;
        await trx('leads').where({ id: lead.id }).update({ status: CLOSED_STATUS, updated_at: trx.fn.now() });
        await trx('lead_activities').insert({
          lead_id: lead.id,
          activity_type: 'status_change',
          description: `Closed automatically — customer booked ${service} for ${day} (visit ${visit.id}) on /book`,
          performed_by: 'system',
          metadata: JSON.stringify({
            reason: CLOSE_REASON,
            visit_id: String(visit.id),
            booking_id: String(booking.id),
            previous_status: current.status,
            status: CLOSED_STATUS,
            auto: true,
            // The genuine lead(s) this booking's own conversion converted (the funnel-row
            // cleanup's replacement lineage when the booking records no row of its own).
            ...(convertedIds.length ? { converted_lead_ids: convertedIds } : {}),
          }),
        });
        return { name: [current.first_name, current.last_name].filter(Boolean).join(' ') };
      });
      if (!result) continue;
      closed += 1;
      await notifyRequestClosed({ lead, customerName: result.name, service, day, visitId: visit.id });
    }
    return { live: true, closed };
  } catch (err) {
    logger.warn(`[booking:preferred-time] booking close failed for customer=${customerId}: ${err.message}`);
    return none;
  }
}

/**
 * Once a booking's OWN attribution row exists, the funnel row of a request that
 * booking closed is a duplicate of the same journey (one lead + one booked row =
 * two leads, one booking in the dashboard / Ads funnels; codex #5477 r1 P1), so
 * it is removed. Only then: a booking that recorded no row (no attribution
 * capture, an owned recovery / estimate-originated link, a replay that never
 * reached attributeSelfBooking) leaves the request's row as the journey's only
 * funnel entry.
 *
 * The requests are resolved from the persisted audit rows THIS booking wrote when
 * it closed them (status_change, reason booking_on_preferred_request, this
 * booking_id; the lead still 'handled'), never from an in-memory result, so it
 * does not matter which closer won the race (the booking's own post-commit close,
 * the submit's reconcileBookingSince, or a replay): each calls this after its
 * own step and whichever runs SECOND, once the booking's row exists, deletes.
 * Idempotent. The replacement (a row keyed to this booking's id, or the booked /
 * completed row of a genuine lead THIS booking converted: ids passed by the
 * booking path or persisted on its close audit row) belonging to another lead is
 * verified in the same statement as the delete, and a row already at booked /
 * completed (revenue attached) is never removed.
 * Best-effort: never throws into the booking. Returns the rows removed.
 */
async function dropSupersededPreferredFunnelRows(db, { booking = null, convertedLeadIds = [] } = {}) {
  if (!booking || !booking.id) return 0;
  try {
    // The genuine lead(s) this booking converted, from its own lineage only: the ids
    // the booking path passes, plus the ids it persisted on the close's audit rows
    // for THIS booking (a later closer, such as the reconcile or a replay, reads those).
    // Never "any recently updated booked/completed row for the customer".
    const audits = (await db('lead_activities')
      .where('activity_type', 'status_change')
      .whereRaw("metadata->>'reason' = ?", [CLOSE_REASON])
      .whereRaw("metadata->>'booking_id' = ?", [String(booking.id)])
      .select('metadata')) || [];
    const persisted = audits.flatMap((row) => {
      let meta = row && row.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
      return meta && Array.isArray(meta.converted_lead_ids) ? meta.converted_lead_ids : [];
    });
    const converted = [...new Set([...(Array.isArray(convertedLeadIds) ? convertedLeadIds : []), ...persisted].filter(Boolean).map(String))];
    return (await db('ad_service_attribution')
      .whereIn('lead_id', function closedByThisBooking() {
        this.select('a.lead_id').from('lead_activities as a')
          .join('leads as l', 'l.id', 'a.lead_id')
          .where('a.activity_type', 'status_change')
          .whereRaw("a.metadata->>'reason' = ?", [CLOSE_REASON])
          .whereRaw("a.metadata->>'booking_id' = ?", [String(booking.id)])
          .where('l.status', CLOSED_STATUS);
      })
      .where((q) => q.whereNull('funnel_stage').orWhereNotIn('funnel_stage', ['booked', 'completed']))
      .whereExists(function replacementRow() {
        // The booking's own row (keyed to this booking), OR the booked / completed
        // funnel row of a genuine lead this booking converted instead (recurring /
        // estimate-linked bookings convert that lead, so attributeSelfBooking writes
        // no row of its own).
        this.select(1).from('ad_service_attribution as booked')
          .whereRaw('booked.lead_id IS DISTINCT FROM ad_service_attribution.lead_id')
          .where((q) => {
            q.whereRaw('booked.self_booked_appointment_id = ?', [booking.id]);
            if (converted.length) {
              q.orWhere((c) => c.whereIn('booked.lead_id', converted).whereIn('booked.funnel_stage', ['booked', 'completed']));
            }
          });
      })
      .del()) || 0;
  } catch (err) {
    logger.warn(`[booking:preferred-time] superseded funnel row cleanup failed for booking=${booking.id}: ${err.message}`);
    return 0;
  }
}

module.exports = {
  closeBookedPreferredLeads,
  dropSupersededPreferredFunnelRows,
  reconcileBookingSince,
  LEAD_TYPE,
  TIME_OF_DAY_LABELS,
  validatePreferredTimeRequest,
  recordPreferredTimeRequest,
  hasRecentPreferredTimeRequest,
  retireOpenBookingIntents,
  buildSummary,
};

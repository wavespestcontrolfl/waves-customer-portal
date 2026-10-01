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
// no_show (20260615000005) is terminal too: the customer missed it (codex #5477 r14).
const DEAD_VISIT_STATUSES = ['cancelled', 'skipped', 'rescheduled', 'no_show'];
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
    // A booking can close the request after the reconcile above, even while the
    // bell is being dispatched (codex #5477 r14): the dispatcher re-asks right
    // before it writes the bell (shouldContinue) and again before the push
    // (beforePush), so a committed close suppresses both. A failed read rings
    // (the request then simply stays open work, as on any failure here).
    const stillOpen = async () => {
      try {
        const now = await db('leads').where({ id: leadId }).first('status');
        return now?.status !== CLOSED_STATUS;
      } catch (err) {
        logger.warn(`[booking:preferred-time] pre-bell status recheck failed: ${err.message}`);
        return true;
      }
    };
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
      }, { shouldContinue: stillOpen, beforePush: stillOpen });
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
// The whole identity test the close applies under its locks: the request's phone
// (same last-10 rule as tenMatch) still matches the booked customer's CURRENT phone,
// it is linked to no customer or to this one (`customerIds`: the visit's current
// owner, and the booking's own id when a merge has since repointed the visit), and
// something besides the phone corroborates it.
function requestIdentifiesCustomer(lead, customer, customerIds) {
  const ten = tenDigitPhone(customer && customer.phone);
  const ids = customerIds.filter(Boolean).map(String);
  return !!ten
    && String(lead.phone || '').replace(/\D/g, '').slice(-10) === ten
    && (!lead.customer_id || ids.includes(String(lead.customer_id)))
    && corroboratesBookedCustomer(lead, customer, ids[0]);
}
const CLOSED_STATUS = 'handled';
// A booking settles only the request it answers (codex #5477 r9/r10): every service
// line the request asked for (lawn, pest, mosquito, termite...) must be in the booked
// visit. Both sides may be composites ('Lawn Care + Pest Control', the multi-service
// label; 'Lawn & Pest'), so each is read as its full set of lines. A request that
// named no service is answered by any booking; one asking for a line the visit does
// not carry (a lawn + pest request, then a lawn-only booking) stays open.
const serviceLines = (text) => new Set(String(text || '').split(/[+&]/)
  .map((part) => part.trim()).filter(Boolean).map(inferServiceLine));
function bookingAnswersRequest(requestedService, bookedService) {
  const booked = serviceLines(bookedService);
  return [...serviceLines(requestedService)].every((line) => booked.has(line));
}
// A booking settles only a request for the SAME property (terminal Codex passes
// 3-4): a customer with two homes on one phone and name can ask for lawn at A and
// book lawn at B. Judged by /book's own address matcher (addressMatchesCustomer:
// normalized street with suffix variants, unit value, zip), so 'St' vs 'Street'
// never splits one home while a different street or unit never joins two. The
// visit's service address is its own stamp, else the customer's (the COALESCE
// every dispatch reader uses). A side with no street cannot be told apart and does
// not block the close.
function sameProperty(lead, visit, customer) {
  const meta = typeof lead.extracted_data === 'string'
    ? (() => { try { return JSON.parse(lead.extracted_data); } catch { return {}; } })()
    : (lead.extracted_data || {});
  const requestedStreet = meta.address_line1;
  const booked = {
    address_line1: visit.service_address_line1 || (customer && customer.address_line1),
    address_line2: visit.service_address_line1 ? visit.service_address_line2 : (customer && customer.address_line2),
    zip: visit.service_address_zip || (customer && customer.zip),
  };
  if (!String(requestedStreet || '').trim() || !String(booked.address_line1 || '').trim()) return true;
  // Lazy: routes/booking requires this module (the matcher is on its _internals).
  const { addressMatchesCustomer } = require('../routes/booking')._internals;
  return addressMatchesCustomer(booked, requestedStreet, lead.zip, meta.address_line2 || null);
}
// The words the audit row and the FYI name the visit by.
const visitWords = (visit) => ({
  service: clean(visit.service_type, 120) || 'a service',
  day: visit.scheduled_date ? formatDay(dateOnlyString(visit.scheduled_date)) : 'the scheduled day',
});

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
 * The close FYI is best-effort and written AFTER the status commit, so a failure
 * (or a crash) there would lose it for good: a replay finds the lead already
 * handled and the audit row already written. Every closer therefore re-sends it
 * for every request THIS booking closed, found from the persisted close audit
 * rows (the lookup the funnel cleanup uses). The send is deduped by its
 * persistent key (preferred-time-auto-close:<lead>:<visit>, an advisory-locked
 * lookup on notifications.metadata->>'dedupeKey'), so a retry never rings twice.
 * Best-effort; never throws into the booking.
 */
async function resendCloseNotices(db, { booking }) {
  try {
    const audits = (await db('lead_activities as a')
      .join('leads as l', 'l.id', 'a.lead_id')
      .where('a.activity_type', 'status_change')
      .whereRaw("a.metadata->>'reason' = ?", [CLOSE_REASON])
      .whereRaw("a.metadata->>'booking_id' = ?", [String(booking.id)])
      .where('l.status', CLOSED_STATUS)
      .select('a.lead_id', 'a.metadata', 'l.first_name', 'l.last_name')) || [];
    for (const row of audits) {
      let meta = row.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
      const visitId = meta && meta.visit_id;
      if (!visitId) continue;
      const visit = await db('scheduled_services').where({ id: visitId }).first('service_type', 'scheduled_date');
      if (!visit) continue;
      await notifyRequestClosed({
        lead: { id: row.lead_id },
        customerName: [row.first_name, row.last_name].filter(Boolean).join(' '),
        ...visitWords(visit), visitId,
      });
    }
  } catch (err) {
    logger.warn(`[booking:preferred-time] close notice retry failed for booking=${booking.id}: ${err.message}`);
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
    // The visit's current owner (a merge since the booking repoints it; codex #5477 r12).
    const customer = await db('customers').where({ id: visit.customer_id || customerId }).first('phone', 'first_name', 'last_name', 'email');
    const ten = tenDigitPhone(customer && customer.phone);
    if (!ten) return { live: true, closed: 0 };
    const open = (await tenMatch(
      db('leads')
        .where({ lead_type: LEAD_TYPE })
        .whereNull('deleted_at')
        .whereIn('status', OPEN_LEAD_STATUSES)
        .whereNull('converted_at')
        // A request staff worked into an estimate is that estimate's deal, never
        // 'handled' (codex #5477 r5/r6): it stays open, exactly as on main, and
        // converts the way any estimate-linked lead does (the estimate's
        // acceptance, markLinkedLeadEstimateAccepted) or by staff.
        .whereNull('estimate_id')
        .whereRaw(LAST_REQUESTED_SQL.replace(' > ?', ' <= ?'), [new Date(bookedMs + BOOKING_SLACK_MS)]),
      ten,
    ).select('id')) || [];
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
        // The visit read above is a point-in-time check (codex #5477 r5): it may
        // have been cancelled, skipped or rescheduled since. Lock and re-read it
        // here so a request never closes on a booking that no longer holds a
        // live, non-callback visit.
        // The booked customer's identity, re-read under a share lock (codex #5477 r8):
        // staff may have corrected or reassigned their phone, email or name since the
        // snapshot above, and the corroboration must judge the identity as it is now.
        // Taken BEFORE the visit lock (codex #5477 r9): a customer merge locks the
        // customer rows first and then sweeps their visits, so this order matches it.
        // The customer is the visit's CURRENT owner (codex #5477 r12): a merge that
        // committed since the booking repointed the visit to the winner and retired
        // the loser's phone, so the booking's own customer id may be stale.
        const owner = await trx('scheduled_services').where({ id: visit.id }).first('customer_id');
        let ownerId = (owner && owner.customer_id) || customerId;
        const readCustomer = (id) => trx('customers').where({ id }).forShare()
          .first('phone', 'first_name', 'last_name', 'email', 'address_line1', 'address_line2', 'zip');
        let liveCustomer = await readCustomer(ownerId);
        const liveVisit = await trx('scheduled_services').where({ id: visit.id }).forUpdate()
          .first('status', 'is_callback', 'service_type', 'scheduled_date', 'customer_id', 'service_address_line1', 'service_address_line2', 'service_address_zip');
        if (!liveVisit || liveVisit.is_callback || DEAD_VISIT_STATUSES.includes(liveVisit.status)) return null;
        // A merge repointed the visit between the owner read and the lock (codex #5477
        // r13): it has committed (the visit lock waited for it), so judge the request
        // on the winner now instead of leaving it for a later closer the primary
        // booking path may never run.
        if (liveVisit.customer_id && String(liveVisit.customer_id) !== String(ownerId)) {
          ownerId = liveVisit.customer_id;
          liveCustomer = await readCustomer(ownerId);
        }
        // Re-read the lead under a row lock (codex #5399 r14): staff may have
        // reassigned its phone, linked it to another customer or closed it since
        // the open-lead query above, and the customer may have refreshed the
        // request (a newer last_requested_at is new work, never this booking's
        // to close). The advisory lock only orders closers, so the lead's own
        // state, phone identity and request recency are re-proven right here.
        const current = await trx('leads').where({ id: lead.id }).forUpdate().first(
          'lead_type', 'status', 'converted_at', 'deleted_at', 'phone', 'customer_id', 'first_name', 'last_name', 'email', 'estimate_id', 'service_interest', 'extracted_data', 'zip',
          trx.raw(`(${LAST_REQUESTED_SQL.replace(' > ?', ' <= ?')}) AS requested_in_time`, [new Date(bookedMs + BOOKING_SLACK_MS)]),
        );
        const stillOurs = current
          && current.lead_type === LEAD_TYPE
          && OPEN_LEAD_STATUSES.includes(current.status)
          && !current.converted_at
          && !current.deleted_at
          && !current.estimate_id // staff may have attached an estimate since the query above
          && current.requested_in_time === true
          && requestIdentifiesCustomer(current, liveCustomer, [ownerId, customerId])
          && bookingAnswersRequest(current.service_interest, liveVisit.service_type)
          && sameProperty(current, liveVisit, liveCustomer);
        if (!stillOurs) return null;
        // Named from the visit as locked (codex #5477 r10), not the earlier read.
        const { service, day } = visitWords(liveVisit);
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
        return { name: [current.first_name, current.last_name].filter(Boolean).join(' '), service, day };
      });
      if (!result) continue;
      closed += 1;
      await notifyRequestClosed({ lead, customerName: result.name, service: result.service, day: result.day, visitId: visit.id });
    }
    // Every request THIS booking closed (just now, or on an earlier run), including one
    // whose FYI above failed and was swallowed: the FYI is re-sent here. The persistent
    // dedupe key makes the repeat for one that did go out a no-op, so the normal, replay
    // and reconcile closers all heal a lost FYI.
    await resendCloseNotices(db, { booking });
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
 * completed row of a genuine lead THIS booking converted: won_booking_id stamped
 * on the lead by the conversion itself, or ids passed by the booking path or
 * persisted on its close audit row) belonging to another lead is
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
    // One transaction that LOCKS the closed requests' lead rows and re-checks 'handled'
    // under the lock before deleting: staff reopening a request (and the funnel bridge
    // restoring its row, which takes the same lock) goes before or after, never in between.
    return await db.transaction(async (trx) => {
      const locked = (await trx('leads as l')
        .whereIn('l.id', function closedByThisBooking() {
          // ...whose CURRENT close is this booking's (terminal Codex pass 3): staff may
          // have reopened a request this booking closed and a later booking closed it
          // again, and that later close's funnel row is not this booking's to drop.
          this.select('a.lead_id').from('lead_activities as a')
            .where('a.activity_type', 'status_change')
            .whereRaw("a.metadata->>'reason' = ?", [CLOSE_REASON])
            .whereRaw("a.metadata->>'booking_id' = ?", [String(booking.id)])
            .whereNotExists(function laterClose() {
              this.select(1).from('lead_activities as later')
                .whereRaw('later.lead_id = a.lead_id AND later.id > a.id')
                .where('later.activity_type', 'status_change')
                .whereRaw("later.metadata->>'reason' = ?", [CLOSE_REASON]);
            });
        })
        .where('l.status', CLOSED_STATUS)
        .forUpdate()
        .select('l.id')) || [];
      const closedIds = locked.map((r) => r.id);
      if (!closedIds.length) return 0;
      // The rows that replace a closed request's row: the booking's own row (keyed to
      // this booking), OR the booked / completed funnel row of a genuine lead this
      // booking converted instead (recurring / estimate-linked bookings convert that
      // lead, so attributeSelfBooking writes no row of its own). The converted lead is
      // known from the ids the booking path passes or persisted on its close audit
      // rows, or from the lineage persisted AT the conversion (extracted_data.
      // won_booking_id, written in the same statement as the win), so a crash between
      // the conversion and the close loses nothing. One scope for the transfer target
      // and the delete's existence check.
      const replacementScope = (q) => {
        q.whereRaw('booked.self_booked_appointment_id = ?', [booking.id]);
        if (converted.length) {
          q.orWhere((c) => c.whereIn('booked.lead_id', converted).whereIn('booked.funnel_stage', ['booked', 'completed']));
        }
        q.orWhere((c) => c.whereIn('booked.funnel_stage', ['booked', 'completed'])
          .whereIn('booked.lead_id', function convertedByThisBooking() {
            this.select('w.id').from('leads as w').whereNull('w.deleted_at').where('w.status', 'won')
              .whereRaw("w.extracted_data->>'won_booking_id' = ?", [String(booking.id)]);
          }));
      };
      // First touch keeps the credit (owner ruling 2026-10-01, codex #5477 r8-r11): a
      // request that came in paid (is_paid: a paid click, or paid UTMs whose click id
      // was stripped) is the journey's first touch unless the replacement's own touch
      // is older, so the replacement takes the request's touch before the request's
      // row goes, the same credit an ordinary lead's own row gets when its booking
      // advances it. The earliest paid request wins; a replacement with a paid click of
      // its own keeps it (whatever its is_paid: attributeSelfBooking's new-customer
      // mint leaves it NULL), and so does a converted lead whose own first contact
      // came no later than the request. The booking's own row is preferred as the target.
      // The touch columns are the ones lead-funnel-bridge stampLeadFunnelRow writes
      // (fbp is a browser id, not a click).
      const { CLICK_ID_COLUMNS, PAID_CLICK_ID_COLUMNS } = require('./lead-funnel-bridge');
      const touchColumns = ['lead_source', 'lead_source_detail', 'lead_date', ...CLICK_ID_COLUMNS, 'utm_campaign', 'utm_term', 'is_paid'];
      const target = await trx('ad_service_attribution as booked')
        .where((q) => q.whereNull('booked.lead_id').orWhereNotIn('booked.lead_id', closedIds))
        .where(replacementScope)
        .orderByRaw('(booked.self_booked_appointment_id = ?) DESC NULLS LAST, booked.id ASC', [booking.id])
        .forUpdate()
        .first('booked.*');
      const hasPaidClick = (row) => PAID_CLICK_ID_COLUMNS.some((col) => !!row[col]);
      const CONTACTED_AT = 'COALESCE(%s.first_contact_at, %s.created_at)';
      const contactedAt = (alias) => CONTACTED_AT.replace(/%s/g, alias);
      // Provenance (terminal Codex pass 4): the request whose touch an earlier cleanup
      // already gave this target, recorded on that request's close audit (touch_to).
      // A close that runs in parts (one request now, an older one on a replay) is then
      // judged on the same earliest-contact rule whatever the order: an inherited click
      // is not the target's own, and a later cleanup compares against its instant.
      const inherited = target ? await trx('lead_activities as a')
        .join('leads as il', 'il.id', 'a.lead_id')
        .where('a.activity_type', 'status_change')
        .whereRaw("a.metadata->>'reason' = ?", [CLOSE_REASON])
        .whereRaw("a.metadata->>'touch_to' = ?", [String(target.id)])
        .orderByRaw(`${contactedAt('il')} ASC`)
        .first(trx.raw(`${contactedAt('il')} AS contacted_at`)) : null;
      if (target && (inherited || !hasPaidClick(target))) {
        // Earliest first contact wins: ordered by the requests' contact instants (the
        // calendar lead_date ties same-day, and the row id is not contact order).
        const requestRows = (await trx('ad_service_attribution as r')
          .join('leads as rl', 'rl.id', 'r.lead_id')
          .whereIn('r.lead_id', closedIds)
          .where((q) => q.whereNull('r.funnel_stage').orWhereNotIn('r.funnel_stage', ['booked', 'completed']))
          .orderByRaw(`${contactedAt('rl')} ASC NULLS LAST, r.lead_date ASC NULLS LAST, r.id ASC`)
          .select('r.*', trx.raw(`${contactedAt('rl')} AS contacted_at`))) || [];
        const firstPaid = requestRows.find((row) => row.is_paid === true);
        // The touch the target holds now, and since when: one it inherited from an
        // earlier request, else a converted genuine lead's own (codex #5477 r12: judged
        // on first-contact instants, not the calendar lead_date). A booking's own row
        // with no paid click holds nothing to defend. A tie, or no instant to compare,
        // keeps what the target holds.
        let held = null;
        if (inherited) held = { at: inherited.contacted_at };
        else if (target.lead_id) {
          held = { at: (await trx('leads').where({ id: target.lead_id }).first(trx.raw(`${contactedAt('leads')} AS contacted_at`)))?.contacted_at };
        }
        const keepsHeld = !!held && (!held.at || !firstPaid?.contacted_at
          || new Date(held.at).getTime() <= new Date(firstPaid.contacted_at).getTime());
        if (firstPaid && !keepsHeld) {
          await trx('ad_service_attribution').where({ id: target.id })
            .update({ ...Object.fromEntries(touchColumns.map((col) => [col, firstPaid[col] ?? null])), updated_at: trx.fn.now() });
          await trx('lead_activities')
            .where({ lead_id: firstPaid.lead_id, activity_type: 'status_change' })
            .whereRaw("metadata->>'reason' = ? AND metadata->>'booking_id' = ?", [CLOSE_REASON, String(booking.id)])
            .update({ metadata: trx.raw("metadata || ?::jsonb", [JSON.stringify({ touch_to: String(target.id) })]) });
        }
      }
      return (await trx('ad_service_attribution')
        .whereIn('lead_id', closedIds)
        .where((q) => q.whereNull('funnel_stage').orWhereNotIn('funnel_stage', ['booked', 'completed']))
        .whereExists(function replacementRow() {
          this.select(1).from('ad_service_attribution as booked')
            .whereRaw('booked.lead_id IS DISTINCT FROM ad_service_attribution.lead_id')
            .where(replacementScope);
        })
        .del()) || 0;
    });
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

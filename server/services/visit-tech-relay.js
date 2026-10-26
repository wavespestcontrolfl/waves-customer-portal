/**
 * VISIT TECH RELAY — a customer's text to an office line during their visit
 * also reaches the visit's technician. GATE_CUSTOMER_TEXT_TO_VISIT_TECH
 * (census M3, second technician, 2026-10-25); off, nothing here runs.
 *
 * Every automated text (on-the-way, arrived, reminders) leaves from the
 * location line (services/twilio.js deriveOutboundNumber). So "the gate is
 * open", "the dog is out" or "running 10 minutes late", sent as a reply,
 * lands in the office inbox and the owner's bell only; the technician on the
 * way never sees it unless someone relays it.
 *
 * On: a known customer's text to an office line (not a technician line:
 * tech-line.js handles those), from the customer's own phone or a saved
 * service-contact or second phone that only ONE customer holds, writes the
 * tech-home text card
 * (tech-line.js TEXT_CARD_TYPE, headline "Text from your customer") and one
 * push to the technician of each of the customer's visits TODAY (Eastern)
 * that is en route or on site, or is that technician's next open stop. The
 * next stop is the first open visit of the technician's day plan that is not
 * already en route or on site, in the dispatch day-plan order
 * (stops-ahead.js: COALESCE(route_order, 999), COALESCE(window_start,
 * '23:59'), created_at, id). One card per technician per text.
 *
 * A visit counts only while it is a live stop, by the same predicates
 * stops-ahead.js uses: no terminal or rescheduled status, no tracker-terminal
 * track_state ('complete' / 'cancelled'; NULL-safe), and no expired
 * estimate-slot hold. En route or on site reads from the status OR the
 * tracker (track_state 'en_route' / 'on_property'), since either can lead.
 * The next stop is a physical stop: the rows of one appointment (stops-ahead.js
 * sibling identity: technician, date, customer, window) are one stop, so a row
 * whose sibling is already underway is part of the CURRENT stop, never the
 * next one (tech-track moves rows by id).
 *
 * An admin technician (the owner) already gets the office bell for the same
 * text, so an admin gets no copy. The office inbox, bell and owner forward are
 * unchanged. Sends nothing to a customer. Fails soft: an error is logged and
 * the inbound webhook carries on.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { NOT_A_STOP_STATUSES } = require('./stops-ahead');
const { KNOWN_CALLER_PHONE_COLS, customerPhoneLookupKey } = require('../utils/known-caller-phone');

const ACTIVE_STATUSES = ['en_route', 'on_site'];
const ACTIVE_TRACK_STATES = ['en_route', 'on_property'];
const TRACKER_DONE_STATES = ['complete', 'cancelled'];
const PUSH_SNIPPET_CHARS = 80;
const CARD_BODY_CHARS = 500;

const DAY_PLAN_ORDER = "COALESCE(route_order, 999), COALESCE(window_start, '23:59'), created_at, id";

// A logged Knex error message can carry its bindings (the sender's phone, the
// customer's name, the text): log the code or name only, as tech-line.js does.
function errorTag(err) {
  return String((err && (err.code || err.name)) || 'error');
}

// The stops-ahead.js live-stop predicates (see the header). `p` qualifies the
// columns for an aliased table ('sib.').
function liveStops(query, conn, p = '') {
  return query
    .whereNotIn(`${p}status`, NOT_A_STOP_STATUSES)
    .where((q) => q.whereNull(`${p}track_state`).orWhereNotIn(`${p}track_state`, TRACKER_DONE_STATES))
    .where((q) => q.whereNull(`${p}reservation_expires_at`).orWhere(`${p}reservation_expires_at`, '>', conn.fn.now()));
}

const isUnderway = (visit) => ACTIVE_STATUSES.includes(visit.status) || ACTIVE_TRACK_STATES.includes(visit.track_state);

/**
 * Technicians (non-admin, active) whose visit today with this customer is en
 * route, on site, or their next open stop. Returns [{ id, name }], one per
 * technician.
 */
async function visitTechniciansFor(customerId, { conn = db, today = etDateString() } = {}) {
  const visits = await liveStops(conn('scheduled_services'), conn)
    .where({ customer_id: customerId, scheduled_date: today })
    .whereNotNull('technician_id')
    .select('id', 'technician_id', 'status', 'track_state');
  if (!visits.length) return [];

  const techIds = [...new Set(visits.map((v) => String(v.technician_id)))];
  const techs = await conn('technicians')
    .whereIn('id', techIds)
    .where({ employment_status: 'active' })
    .whereNot('role', 'admin')
    .select('id', 'name');
  const out = [];
  for (const tech of techs) {
    const own = visits.filter((v) => String(v.technician_id) === String(tech.id));
    let relay = own.some(isUnderway);
    if (!relay) {
      const next = await liveStops(conn('scheduled_services'), conn)
        .where({ technician_id: tech.id, scheduled_date: today })
        .whereNotIn('status', ACTIVE_STATUSES)
        .where((q) => q.whereNull('track_state').orWhereNotIn('track_state', ACTIVE_TRACK_STATES))
        // A LIVE sibling that is underway: a cancelled, done or dead-hold row
        // with a stale tracker state is not.
        .whereNotExists((sib) => liveStops(sib.select(conn.raw('1')).from('scheduled_services as sib'), conn, 'sib.')
          .whereRaw('sib.technician_id = scheduled_services.technician_id')
          .whereRaw('sib.scheduled_date = scheduled_services.scheduled_date')
          .whereRaw('sib.customer_id = scheduled_services.customer_id')
          .whereRaw('sib.window_start IS NOT DISTINCT FROM scheduled_services.window_start')
          .where((q) => q.whereIn('sib.status', ACTIVE_STATUSES).orWhereIn('sib.track_state', ACTIVE_TRACK_STATES)))
        .orderByRaw(DAY_PLAN_ORDER)
        .first('id');
      relay = !!next && own.some((v) => String(v.id) === String(next.id));
    }
    if (relay) out.push(tech);
  }
  return out;
}

// The sender's customer: the ONE live customer holding this number in any
// identity slot (primary, service contacts, second phone: the known-caller-phone.js
// column set), so a spouse or tenant texting from a saved service-contact
// number reaches the visit too. None, or more than one, = no relay: a shared
// number is never guessed, even when the webhook matched one customer by the
// primary phone alone (or picked one under GATE_SMS_SHARED_PHONE_LINK).
async function customerForPhone(conn, phone) {
  const key = customerPhoneLookupKey(phone);
  if (!key) return null;
  const keys = key.length === 10 ? [key, `1${key}`] : [key];
  const placeholder = keys.map(() => '?').join(', ');
  const frag = KNOWN_CALLER_PHONE_COLS
    .map((col) => `regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g') IN (${placeholder})`)
    .join(' OR ');
  const rows = await conn('customers')
    .whereNull('deleted_at')
    .whereRaw(`(${frag})`, KNOWN_CALLER_PHONE_COLS.flatMap(() => keys))
    .limit(2)
    .select('id', 'first_name', 'last_name');
  return rows.length === 1 ? rows[0] : null;
}

async function relayCustomerTextToVisitTech({ from, body, mediaCount = 0, conn = db } = {}) {
  const customer = await customerForPhone(conn, from);
  if (!customer?.id) return 0;
  const techs = await visitTechniciansFor(customer.id, { conn });
  if (!techs.length) return 0;
  const { TEXT_CARD_TYPE } = require('./tech-line');
  const senderName = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || 'Your customer';
  const text = String(body || '').trim();
  const mediaText = mediaCount > 0 ? `${mediaCount} photo${mediaCount === 1 ? '' : 's'}` : '';
  const snippet = text || mediaText || '(empty message)';
  let sent = 0;
  for (const tech of techs) {
    try {
      await conn('tech_notifications').insert({
        technician_id: tech.id,
        type: TEXT_CARD_TYPE,
        message: `Text from ${senderName}: ${snippet.slice(0, PUSH_SNIPPET_CHARS)}`,
        payload: JSON.stringify({
          headline: 'Text from your customer',
          from,
          customer_id: customer.id,
          customer_name: senderName,
          body: text.slice(0, CARD_BODY_CHARS),
          media_count: mediaCount,
        }),
      });
    } catch (err) {
      logger.error(`[visit-tech-relay] text card failed for technician ${tech.id} (${errorTag(err)})`);
      continue;
    }
    sent += 1;
    try {
      await require('./push-notifications').sendToAdminUser(tech.id, {
        title: `Text from ${senderName}`,
        body: snippet.slice(0, PUSH_SNIPPET_CHARS),
        url: '/tech',
        tag: `visit-text-${customer.id}`,
        priority: 'high',
      });
    } catch (pushErr) {
      logger.warn(`[visit-tech-relay] push failed for technician ${tech.id} (card already written, ${errorTag(pushErr)})`);
    }
  }
  return sent;
}

module.exports = { relayCustomerTextToVisitTech, visitTechniciansFor, customerForPhone, errorTag };

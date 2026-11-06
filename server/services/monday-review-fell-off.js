'use strict';

// Customer alerts that fell off the bell with no reply: list 1 of the Monday review bell while
// GATE_MONDAY_FELL_OFF_LINE is on (owner 2026-11-05, "go" on the admin-bell plan, decision D3).
//
// Why: the quiet fall-off (admin-alert-retention.js, GATE_ALERT_QUIET_FALL_OFF) marks a bell row done after 72 hours
// with no new activity, so the old list 1 ("needs-you alerts nobody read for 14+ days") can never fire. A customer who
// wrote or called and was never answered now leaves the bell without anyone seeing it. This list names them once a week.
//
// What counts, read fresh on every run:
//   - A row the quiet rule closed (done_by 'quiet-72h', still done) in the 7 days before the run. A row a person
//     reopened is open again and a row a person or another closer took over has another done_by: neither is here.
//   - A customer contact: a bell row in a customer-contact category (admin-alert-routing.js
//     CUSTOMER_CONTACT_CATEGORIES) or one that declares `contact`/`promise` itself or through its registry type
//     (admin-alert-send-to-claude.js declaredContact). The money categories never fall off, so none is judged here.
//   - No reply reached that person after the alert's latest event (its creation, or the last ringing refresh or
//     ask time, admin-alert-relevance.js bellEventAt). The witnesses are the sweep's own, loaded by
//     admin-alert-contact-witnesses.js loadContactBundles and never re-derived here:
//       texts   a person's delivered text (staff-contact.js operatorReplySql + smsDeliveredSql, minus a proactive draft);
//       calls   a call a person placed and spoke on, or an inbound call a human answered (ended calls only);
//       emails  a person's Gmail SENT row linked to the customer;
//       quotes  handedOffWithin + whereEstimateCustomerOwnership (admin-alert-relevance.js quoteAnswered), never sent_at;
//       visits  the new-lead class's live top-level booking predicate (whereLiveBooking).
//     A text alert is answered by a text or a call only (the Messages reader's own rule); the other kinds also count
//     a booking and a quote. A call_log row alone is never contact: a bridge row is written before Twilio dials.
//     read_at is never evidence.
//   - When the reply cannot be checked (the sender or customer cannot be identified, or the witness read fails) the
//     alert is LISTED. The owner reads the list: an alert shown that was answered costs a glance, one hidden that was
//     not costs a customer.
//   - Internal test customers are left out.
//
// Read only. Sends nothing to a customer, calls no paid API.

const db = require('../models/db');
const logger = require('./logger');
const { QUIET_BY } = require('./admin-alert-retention');
const { cutAtWord } = require('./admin-alert-compose');

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;
// The runaway bound on rows read; 7 days of quiet closes is a few dozen.
const CANDIDATE_LIMIT = 1000;
const ENTRY_SHOWN = 15;
const TITLE_CHARS = 60;

const toDate = (value) => {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

function parseMeta(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string') return {};
  try { const parsed = JSON.parse(metadata); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

// A customer contact, as the repo already classifies it (see the header).
function isCustomerContact(row, meta) {
  const { CUSTOMER_CONTACT_CATEGORIES } = require('./admin-alert-routing');
  const { declaredContact } = require('./admin-alert-send-to-claude');
  return CUSTOMER_CONTACT_CATEGORIES.has(row.category) || declaredContact(meta);
}

// The alert's latest event: its creation, its ask time, or the last ringing refresh (never a Reopen's hold stamp).
function latestEventAt(row) {
  const { bellEventAt } = require('./admin-alert-relevance');
  const times = [toDate(row.created_at), bellEventAt(row)].filter(Boolean);
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}

function linkParam(link, name) {
  try { return new URL(String(link || ''), 'http://monday.local').searchParams.get(name); } catch { return null; }
}

// What the witness loader needs for one row: the kind of contact and the references it reads. `alt` is the customer-level
// reading to try when the text, call or email it names cannot be found. Null when the row names nothing the witnesses
// can find (it is listed, unchecked).
function witnessItem(row, meta, named, eventAt) {
  const payload = parseMeta(meta.payload);
  const customerId = named?.id || null;
  const sid = linkParam(row.link, 'message') || payload.twilioSid || null;
  const byCustomer = customerId ? { id: row.id, kind: 'customer', bellAt: eventAt, refs: { customerId } } : null;
  if (sid && (row.category === 'inbound_sms' || !customerId)) {
    return { id: row.id, kind: 'sms', bellAt: eventAt, refs: { sid, customerId, unknownSender: !customerId }, alt: byCustomer };
  }
  if (byCustomer) return byCustomer;
  if (payload.callLogId) return { id: row.id, kind: 'voice', bellAt: eventAt, refs: { callLogId: payload.callLogId, customerId: null, phone: payload.phone } };
  if (payload.emailId) return { id: row.id, kind: 'email', bellAt: eventAt, refs: { emailId: payload.emailId, customerId: null } };
  return null;
}

// Did a person reach the customer after the alert's latest event? `bundle` is the witness bundle (absent = unchecked).
async function answered({ item, bundle, eventAt, meta, database }) {
  if (!bundle) return false;
  const floor = Math.max(bundle.anchor.getTime(), eventAt.getTime(), bundle.lastInboundAt ? new Date(bundle.lastInboundAt).getTime() : 0);
  const after = (at) => !!at && new Date(at).getTime() > floor;
  if (after(bundle.textAt) || after(bundle.backAt) || after(bundle.inAt) || after(bundle.replyAt)) return true;
  // A text's bundle carries `shared` (true or false); every other kind carries null. A text alert read by its customer
  // after the text could not be found is a text alert still.
  if (bundle.shared !== null || item.kind === 'sms') return false;
  if (after(bundle.visitAt) || bundle.quote) return true;
  const customerId = item.refs.customerId;
  if (!customerId) return false;
  const { quoteAnswered } = require('./admin-alert-relevance');
  return quoteAnswered(database, { meta, customerId, bellAt: new Date(floor) });
}

// The witness bundles for these items (a Map by notification id), or null when the read fails (every alert is then
// listed, unchecked). An item whose named text, call or email is not on file is read again by its customer.
async function loadBundles(items, database) {
  if (!items.length) return new Map();
  try {
    const { loadContactBundles } = require('./admin-alert-contact-witnesses');
    const { bookedVisitsByCustomer } = require('./admin-alert-relevance');
    const deps = { conn: database, bookedVisits: (ids) => bookedVisitsByCustomer(database, ids) };
    const bundles = await loadContactBundles(items, deps);
    const retry = items.filter((i) => i.alt && !bundles.has(String(i.id))).map((i) => i.alt);
    if (retry.length) for (const [id, bundle] of await loadContactBundles(retry, deps)) bundles.set(id, bundle);
    return bundles;
  } catch (err) {
    logger.warn(`[monday-review] reply witnesses failed to load; the fell-off list is unchecked: ${require('./notification-service').safeErrorSummary(err)}`);
    return null;
  }
}

/**
 * -> { kind: 'fell-off', count, capped, unchecked, entries: [{ name, title, at }] } (newest first).
 * `entries` holds every alert found; the Monday text shows the first ENTRY_SHOWN.
 */
async function loadFellOffAlerts({ now = new Date(), database = db, limit = CANDIDATE_LIMIT } = {}) {
  const { customersForAlerts } = require('./admin-alert-customer');
  const { isInternalTestCustomerId } = require('./internal-test-customers');
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const rows = await database('notifications')
    .where({ recipient_type: 'admin', done_by: QUIET_BY }).whereNotNull('done_at').where('done_at', '>=', since)
    .whereRaw("COALESCE(metadata->>'feed', '') <> 'activity'")
    .whereRaw("COALESCE(metadata->>'claudeQueue', '') = ''")
    .orderByRaw('done_at DESC, id DESC').limit(limit)
    .select('id', 'category', 'title', 'link', 'metadata', 'created_at', 'done_at');
  const capped = rows.length >= limit;
  if (capped) logger.warn(`[monday-review] fell-off scan stopped at ${limit} rows; the count is a floor`);
  const contact = rows.filter((row) => isCustomerContact(row, parseMeta(row.metadata)));
  const named = await customersForAlerts(database, contact);
  const kept = contact.filter((row) => !isInternalTestCustomerId(named.get(String(row.id))?.id));
  const judged = kept.map((row) => {
    const meta = parseMeta(row.metadata);
    const eventAt = latestEventAt(row) || toDate(row.created_at) || now;
    return { row, meta, eventAt, who: named.get(String(row.id)) || null };
  }).map((entry) => ({ ...entry, item: witnessItem(entry.row, entry.meta, entry.who, entry.eventAt) }));
  const bundles = await loadBundles(judged.map((e) => e.item).filter(Boolean), database);
  const entries = [];
  for (const entry of judged) {
    const bundle = entry.item && bundles ? bundles.get(String(entry.row.id)) : null;
    if (await answered({ item: entry.item, bundle, eventAt: entry.eventAt, meta: entry.meta, database })) continue;
    entries.push({ name: entry.who?.name || '', title: String(entry.row.title || '').trim(), at: entry.eventAt });
  }
  entries.sort((a, b) => b.at.getTime() - a.at.getTime());
  return { kind: 'fell-off', count: entries.length, capped, unchecked: bundles === null, entries };
}

// "Jane Doe: SMS from Jane Doe" would say the name twice, so a title that already holds the name stands alone.
function entryLine(entry, shortDate) {
  const title = cutAtWord(entry.title || 'Customer alert', TITLE_CHARS);
  const named = entry.name && !title.toLowerCase().includes(entry.name.toLowerCase());
  return `   - ${named ? `${entry.name}: ` : ''}${title} (${shortDate(entry.at)})`;
}

module.exports = {
  loadFellOffAlerts,
  entryLine,
  ENTRY_SHOWN,
  WINDOW_DAYS,
  _private: { isCustomerContact, witnessItem, answered, latestEventAt },
};

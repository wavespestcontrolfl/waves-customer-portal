/**
 * Admin alert relevance — an unread admin bell clears itself when the visit,
 * series move or lead it is about has moved on (owner ruling 2026-09-28: "we
 * don't want garbage"; live with the ADMIN_ALERT_RELEVANCE kill switch, rule
 * 14: auto-applied, audit-trailed, no bell).
 *
 * Why this is a sweep and not another hook (AGENTS.md "extend the existing
 * mechanism"): the retire helpers that exist today — supersedeMissedCallAdmin,
 * markInboundSmsReadAdmin, first-application-sibling-split's clearStandingAlerts
 * — are per-class event hooks: each fires from the one code path its author
 * knew moves that subject on. Subjects move on through paths no hook sees (a
 * visit closed by a direct database edit, a lead quoted from another surface),
 * and every new alert class would need its own hook. This module judges the
 * LIVE record instead. It does not replace those hooks (their classes are
 * untouched); it only adds the classes below, judged by ONE periodic sweep,
 * runAdminAlertRelevanceSweep (scheduler.js, every 10 minutes):
 *   - It retires unread rows whose subject has moved on. Unread rows never
 *     age out of it (a refreshed bell keeps its first created_at). Each
 *     retirement is judged on a fresh read right before it is written, lands
 *     only on the version judged, and is judged once more after it; a change
 *     that landed in between, or a check after the write that could not
 *     finish, puts the bell back.
 *   - A retirement holds only while its rule does: each run first judges
 *     again what it retired in the last REARM_DAYS and puts back any row
 *     whose subject is relevant again (a booking cancelled, a visit
 *     reopened), since the emitters in the table never raise it again.
 *   - No row locks, ever: the sweep is advisory and must never block or fail
 *     a money path (invoice settlement takes the visit FOR UPDATE NOWAIT).
 * A bell is always rung as its emitter wrote it; the sweep clears it within
 * minutes once its subject has moved on.
 *
 * "Moved on" is judged from what the bell itself is about, never from the
 * customer's account: a stale visit by the bell's own predicate, a series-move
 * card by each item it flagged, and a new lead only by what happened AFTER the
 * bell was raised — the lead's current state can predate it (a website
 * submission attached to a lead already quoted or worked), so a status or an
 * earlier estimate is never read as the new bell handled.
 *
 * A retire is DONE (done_by 'relevance', the reason in words as the resolution,
 * `metadata.retired = {by, reason, at}`): the subject moved on, so the row
 * leaves the bell whether or not someone had already read it (read is not
 * done; a person's own read_at is kept, an unread row is read at the same
 * instant). A put-back clears the done fields and the stamp, and un-reads the
 * row only when the read was this module's own.
 *
 * The table holds only classes whose emitter never re-raises the same alert
 * on a stable dedupe key: a new lead (one intake event per submission), a
 * series-move card (written once per move), a stale-visit bell (its emitter
 * is gone). An alert
 * whose emitter re-raises a stable key — the first-application split, the
 * schedule watchdog's price / prepay / plan reviews, the estimate hot view —
 * is its emitter's to clear, with the emitter's own recurrence rules: a
 * retire from outside would either keep the key (and swallow the bell when
 * the subject comes back) or free it (and fight the emitter's dedupe). The
 * repeat-form alert (owner 2026-10-24) re-raises a stable key but dedupes on
 * open rows only, so freeing it is the intent: a retirement once the lead was
 * contacted ends the episode, and the next form rings a fresh row.
 *
 * Customer-initiated contact bells close once a person answers (owner
 * 2026-10-24: "most of these should close automatically ... text sent, agent
 * confirms resolved, appt booked, rescheduled"; this replaces the earlier
 * line that kept them out of the sweep). A text (inbound_sms) closes when the
 * Messages "needs a reply" reader no longer counts its conversation; a voicemail
 * callback request, an email and a new lead close when a person
 * called back and spoke, a person's text reached the customer, a visit was
 * booked or a quote was handed off, each judged only by what came AFTER the
 * event the bell is about. Every such fact is a shared witness read in
 * admin-alert-contact-witnesses.js, and read_at is never evidence. Behind
 * GATE_ALERT_CONTACT_CLOSE (alertContactCloseMode): off = these classes are not
 * judged; `shadow` = judged, with what WOULD close recorded in audit_log and
 * no bell changed; `true` = closed like any other class. Review bells and
 * money-owed/failed/refund alerts are still never in the table: a class is
 * only in it if its category (plus dedupeKey prefix or trigger) is listed
 * below. A missed call (customer_missed_call) is NOT in the table: its one owner
 * is missed-call-bell.js (retireCalledBackMissedCalls, every 2 minutes), which
 * judges the same contact facts behind the same gate. A new text from a known
 * sender rewrites the sender's one thread bell and rings it again (the refresh clears done and the retired stamp). An
 * unknown sender's text bell (no customer on file) is not judged at all: it
 * stays a person's to close. Two other customer-contact bells are in it by owner
 * ruling (2026-10-03), each closed only by the record that answers it: the
 * promise-chaser bell once the promise it chases is closed, and a portal chat
 * hand-off about adding a service once an estimate is handed off to that
 * customer (a person's contact also closes it, below). A self-booked re-service bell (owner 2026-10-05) closes once its
 * booked visit is completed, cancelled or gone. A phone-booking rain notice
 * (owner 2026-10-08) closes once its visit is closed, gone, moved off the
 * date or start it was booked for, or past its date. A call last-name
 * suggestion (owner 2026-10-08) closes once its customer has a last name or is
 * gone. Every other missed-call bell stays a person's to close, and so does a
 * portal chat topic that no person has answered (owner 2026-10-31: "A chat item
 * closes itself when someone texts, calls or emails that customer after the
 * request"; below). A promise-chaser retirement is final (`rearm: false`),
 * like the close its own emitter writes inside its 30-minute window: a
 * promise reopened later is the promise list's and the SLA pager's to
 * surface, and a later callback rings its own bell.
 *
 * Three more rules carry their OWN three-state gate (owner 2026-10-29, "Stuck
 * Alert Fixes"; the third 2026-10-31), so they can run in shadow while GATE_ALERT_CONTACT_CLOSE is
 * `true`. A class (`gate`) is not offered at all while its gate is off, except
 * to the re-arm pass, so turning a gate off puts back what it closed; a single
 * reason (a contact rule answering `{ reason, mode }`) is silent while its mode
 * is off and never closes more than the contact gate allows.
 *   - GATE_VOICEMAIL_VISIT_UNDERWAY: a voicemail callback request also closes
 *     once the voicemail's customer has a visit that completed after the call
 *     on the same Eastern day, when no person's contact did (voice items only).
 *   - GATE_LEAD_CONTACTED_CLOSE: the Leads bells whose emitters promise
 *     `doneWhen: 'lead_contacted'` (call or reply to a lead) close once a
 *     person's text or call reached the lead, a visit was booked for the lead's
 *     customer, or an estimate was handed off, each after the bell.
 *   - GATE_PORTAL_CHAT_ANSWERED_CLOSE: a portal chat hand-off bell (dedupeKey
 *     `portal-chat-escalation:`, `doneWhen: 'customer_answered'`, a customer id) closes once a
 *     person called back, answered the customer's call, texted or emailed that customer after the
 *     bell's latest event (bellEventAt: a re-rung bell's `rungAt`). Rides on
 *     GATE_ALERT_CONTACT_CLOSE (the weaker of the two wins). The add-a-service chat keeps its
 *     estimate rule, and also closes on this contact. The confirmed-email-change bell
 *     (`portal-chat-email-change:`) is never judged: its answer is the account change.
 *   - GATE_PORTAL_ITEM_CLOSE (boolean, own gate; owner 2026-11-01): two more portal classes. A portal request
 *     bell (category `service`, `doneWhen: 'request_answered'`, a request id and a customer id) closes on the
 *     same person contact after the bell as the chat hand-off. An add-service request bell (trigger
 *     `bundle_quote_requested` carrying its request id at the top of its metadata) closes once an estimate was
 *     handed to that customer after the bell. Whenever the sweep closes one of them it also resolves that
 *     request row quietly (portal-inbox.js resolveRequestQuietly: no customer email). The contact close rides
 *     on GATE_ALERT_CONTACT_CLOSE like the chat class. A cancellation bell (`cancellation_reviewed`) is never judged.
 */

const db = require('../models/db');
const logger = require('./logger');
const { adminAlertRelevanceLive, alertContactCloseMode, voicemailVisitUnderwayMode, leadContactedCloseMode, staffActionAnswersMode, portalChatAnsweredCloseMode } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { VISIT_NEVER_RAN_STATUSES } = require('./invoice-helpers');
// The dedupeKey prefix call-last-name-lookup.js gives its suggestion (its
// SUGGESTION_KEY_PREFIX). Repeated here, not imported: that module pulls in
// the county parcel lookup, and this one loads in the scheduler, the triggers
// and Needs Me. A test pins the two together.
const SUGGESTION_KEY_PREFIX = 'call-last-name-suggestion:';
// The dedupeKey prefix of the repeat-form alert (lead-webhook.js
// ringRepeatFormAlert). Repeated, not imported (a route module); a test pins
// the two together.
const REPEAT_FORM_PREFIX = 'lead-repeat-form:';
// The dedupeKey prefix of a known sender's shared thread bell
// (sms-reply-alert-delivery.js threadBellKey). Repeated, not imported (it pulls
// in the webhook's delivery code); a test pins the two together.
const SMS_THREAD_PREFIX = 'sms-thread:';

// GATE_PORTAL_ITEM_CLOSE as a class gate: 'true' or 'off' (a boolean gate has no shadow). Read at call
// time, and guarded like the other late-added readers: a test that mocks feature-gates without it reads off.
const portalItemGate = () => (require('../config/feature-gates').portalItemCloseLive?.() ? 'true' : 'off');

const RETIRED_BY = 'alert-relevance';
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
// How long a retirement stays open to being put back: after this, final.
const REARM_DAYS = 14;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A visit that has finished or will never run: no longer worth a bell that
// asks someone to complete, price or review it. 'rescheduled' stays open (a
// pending reschedule request parks the same row).
const CLOSED_VISIT_STATUSES = new Set([...VISIT_NEVER_RAN_STATUSES, 'completed']);
// The statuses the stale in-progress bell was raised for (the removed
// schedule-integrity-watchdog class's STALE_STATUSES).
const STALE_IN_PROGRESS_STATUSES = new Set(['on_site', 'en_route']);

// notification-service's done helpers, read lazily like candidateQuery's.
const doneState = () => require('./notification-service')._private;
// A log line never carries err.message: knex puts the SQL and its bindings there, and the witness
// queries bind customer phone numbers and email addresses (AGENTS.md: no PII in logs).
const errSummary = (err) => require('./notification-service').safeErrorSummary(err);

const uuidOrNull = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const first = (...vals) => vals.find((v) => v != null && v !== '');

function parseMeta(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string') return {};
  try { const m = JSON.parse(metadata); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

function linkParams(link) {
  try { return new URL(String(link || ''), 'http://relevance.local').searchParams; } catch { return new URLSearchParams(); }
}

// Every record an alert points at, from its metadata and deep link. Bad ids
// parse to null/dropped — never a throw.
function refsFromRow(row) {
  const meta = parseMeta(row.metadata);
  const payload = parseMeta(meta.payload);
  const params = linkParams(row.link);
  // The alert's own visit first, then every other visit it names: a series
  // move's windowless conflicts and preserved occurrences (each { id, date }).
  const visitIds = [first(meta.scheduledServiceId, meta.scheduled_service_id, params.get('appointment')),
    ...arr(meta.conflicts).map((c) => c?.id), ...arr(meta.preservedOccurrences).map((c) => c?.id)]
    .map(uuidOrNull).filter(Boolean);
  return {
    meta,
    visitId: visitIds[0] || null,
    visitIds: [...new Set(visitIds)],
    estimateId: uuidOrNull(first(meta.estimateId, meta.estimate_id, payload.estimateId, params.get('estimateId'))),
    leadId: uuidOrNull(first(payload.leadId, meta.leadId, params.get('lead'))),
    promiseIds: arr(meta.promise_ids).map(uuidOrNull).filter(Boolean),
    // The one promise a promise-chaser bell is about (promise-chaser-bell.js).
    owedPromiseId: meta.triggerKey === 'promise_chaser' ? uuidOrNull(payload.commitmentId) : null,
    // The customer a last-name suggestion is about (call-last-name-lookup.js):
    // only that class names one, so no other bell loads a customer.
    nameCustomerId: String(meta.dedupeKey || '').startsWith(SUGGESTION_KEY_PREFIX)
      ? uuidOrNull(first(meta.customerId, params.get('customerId'))) : null,
  };
}

// A non-empty id as text (customer ids are stored as text here; bad values
// drop, never throw).
function idTextOrNull(value) {
  const text = value == null ? '' : String(value).trim();
  return text && text.length <= 64 ? text : null;
}

// Which live records this row is about, resolved against loaded maps (an id
// the maps do not hold resolves to undefined = the record is gone).
function resolveRefs(row, data) {
  const refs = refsFromRow(row);
  const visit = refs.visitId ? data.visits.get(refs.visitId) : undefined;
  const lead = refs.leadId ? data.leads.get(refs.leadId) : undefined;
  const estimateId = refs.estimateId || (lead?.estimate_id ? String(lead.estimate_id) : null);
  const estimate = estimateId ? data.estimates.get(estimateId) : undefined;
  const customer = refs.nameCustomerId ? data.customers.get(refs.nameCustomerId) : undefined;
  return { refs, visit, lead, estimate, customer };
}

const emptyData = () => ({ visits: new Map(), leads: new Map(), estimates: new Map(), leadVisits: new Map(), leadQuotes: new Map(), quoteHandedOff: new Set(), promises: new Map(), consents: new Map(), customers: new Map(), contacts: new Map(), contact: new Map(), contactMode: 'off', contactFailed: false });
const byId = (rows) => new Map(rows.map((r) => [String(r.id), r]));

// The latest valid time per customer across rows (a bad time is skipped).
function keepLatestPerCustomer(map, rows, timeKey) {
  for (const row of rows) {
    const key = String(row.customer_id);
    const at = new Date(row[timeKey]);
    if (!Number.isNaN(at.getTime()) && !(map.get(key) >= at)) map.set(key, at);
  }
}

// The customer a repeat-form alert is about (its own metadata), else null.
function repeatFormCustomerId(meta) {
  return String(meta.dedupeKey || '').startsWith(REPEAT_FORM_PREFIX) ? idTextOrNull(meta.customerId) : null;
}

// A booking someone made that is still to run or ran: never a child the
// system generated on its own (the nightly series top-up, a booking's seeded
// follow-ups — those land on an existing customer's plan whether or not anyone
// worked the lead), and never one that did not run (cancelled, no-show,
// skipped). The newest such booking's creation time per customer.
// The live-booking predicate: not one that did not run, and never a child the
// system generated on its own. Exported for missed-call-bell.js's SQL form.
function whereLiveBooking(q) {
  return q.where((w) => w.whereNull('status').orWhereNotIn('status', VISIT_NEVER_RAN_STATUSES))
    .whereNull('recurring_parent_id').whereNull('parent_service_id');
}

async function bookedVisitsByCustomer(conn, customerIds) {
  if (!customerIds.length) return new Map();
  const booked = await whereLiveBooking(conn('scheduled_services').whereIn('customer_id', customerIds))
    .groupBy('customer_id').select('customer_id').max('created_at as latest_created_at');
  return new Map(booked.map((r) => [String(r.customer_id), r.latest_created_at]));
}

// When a bell last became news. A refresh that changes content and rings (notifyAdmin's
// refreshOnDedupe, the default for ringOnRefresh) stamps `metadata.rungAt` and clears the done
// fields, but keeps `created_at` unless the emitter also asked for `bumpOnRefresh`; a quiet refresh
// stamps nothing. So the evidence boundary of a bell that can refresh is the later of the two, or
// contact that predates the new request would settle it (Codex on #6961). Null when neither parses.
function bellEventAt(row) {
  const times = [row.created_at, parseMeta(row.metadata).rungAt].map((v) => (v ? new Date(v) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()));
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}

const BELL_EVENT_CLASSES = new Set(['lead_contacted', 'portal_chat_add_service', 'portal_chat_answered', 'portal_request_answered']);

// What a customer-contact bell is about, for the witnesses: the text, call or
// email it names, or the lead's own phone. Nothing here reads the customer's
// account at large.
function contactRefs(kind, row, data) {
  const refs = refsFromRow(row);
  const payload = parseMeta(refs.meta.payload);
  const params = linkParams(row.link);
  if (kind === 'sms') {
    const key = String(refs.meta.dedupeKey || '');
    const customerId = key.startsWith(SMS_THREAD_PREFIX) ? uuidOrNull(key.slice(SMS_THREAD_PREFIX.length)) : uuidOrNull(first(payload.threadId, params.get('thread')));
    // An unknown sender's bell (no customer on file) is not judged: its emitter keeps a row per 4-hour window
    // and suppresses a second text inside it, so no anchor here can stand for its latest text. It stays a
    // person's to close; the 30-day retention sweep closes it if nobody does.
    if (!customerId) return null;
    return { sid: first(params.get('message'), payload.twilioSid), customerId };
  }
  if (kind === 'voice') return { callLogId: uuidOrNull(payload.callLogId), customerId: uuidOrNull(payload.customerId), phone: payload.phone };
  if (kind === 'email') return { emailId: uuidOrNull(payload.emailId), customerId: uuidOrNull(payload.customerId) };
  // A portal chat hand-off is about its customer alone (metadata.customerId); one without is not judged.
  if (kind === 'customer') {
    const customerId = uuidOrNull(refs.meta.customerId);
    return customerId ? { customerId } : null;
  }
  const lead = refs.leadId ? data.leads.get(refs.leadId) : null;
  return lead ? { customerId: uuidOrNull(lead.customer_id), phone: lead.phone } : null;
}

// GATE_ALERT_CONTACT_CLOSE on (shadow or true): load the witnesses for the
// customer-contact rows of this batch. A load that fails is no verdict, never
// a guess: rows stay unjudged and the re-arm pass leaves them as they are.
async function loadContact(rows, data, conn) {
  const items = [];
  for (const row of rows) {
    const cls = classify(row);
    // A class with its own gate (the lead_contacted class) reads witnesses by that gate; every
    // other class by GATE_ALERT_CONTACT_CLOSE, as before.
    if (!cls || (cls.gate ? cls.gate() === 'off' : data.contactMode === 'off')) continue;
    // A gated class that judges by the contact witnesses also rides on GATE_ALERT_CONTACT_CLOSE.
    if (cls.gate && cls.contactRule && data.contactMode === 'off') continue;
    // The portal chat contact witnesses (customer kind) are read only while their own gate is on.
    // (The portal item classes read them under their own gate, GATE_PORTAL_ITEM_CLOSE, checked above.)
    if (cls.contact === 'customer' && cls.gate !== portalItemGate && portalChatAnsweredCloseMode() === 'off') continue;
    const refs = cls.contact ? contactRefs(cls.contact, row, data) : null;
    if (!refs) continue;
    // A lead_contacted or portal chat bell can be refreshed and rung again: its boundary is its latest event.
    const bellAt = BELL_EVENT_CLASSES.has(cls.key) ? bellEventAt(row) : (row.created_at ? new Date(row.created_at) : null);
    items.push({ id: row.id, kind: cls.contact, bellAt: bellAt && !Number.isNaN(bellAt.getTime()) ? bellAt : null, refs });
  }
  if (!items.length) return;
  try {
    const { loadContactBundles } = require('./admin-alert-contact-witnesses');
    data.contact = await loadContactBundles(items, {
      conn,
      bookedVisits: (ids) => bookedVisitsByCustomer(conn, ids),
      visitRan: voicemailVisitUnderwayMode() !== 'off',
      staffActions: staffActionAnswersMode() !== 'off',
    });
  } catch (err) {
    data.contactFailed = true;
    logger.warn(`[alert-relevance] customer-contact witnesses failed to load: ${errSummary(err)}`);
  }
}

// Each add-a-service portal chat bell, add-service request bell (GATE_PORTAL_ITEM_CLOSE) and repeat-form
// alert: was an estimate handed off to its customer after the bell? The promise lane's own handoff witness
// (call-commitments.js handedOffWithin: a real delivery or the customer's acceptance after the boundary) and
// its estimate-ownership fence, never sent_at: a suppressed send stamps sent_at with nothing delivered, and
// an estimate accepted during its first send is delivered with sent_at still null. One small query per bell
// (these classes are a handful of rows).
async function loadQuoteHandoffs(rows, data, conn) {
  for (const row of rows) {
    const meta = parseMeta(row.metadata);
    const customerId = isAddServiceChat(meta) || (isBundleRequestBell(meta) && portalItemGate() !== 'off')
      ? uuidOrNull(meta.customerId) : uuidOrNull(repeatFormCustomerId(meta));
    const bellAt = row.created_at ? new Date(row.created_at) : null;
    if (!customerId || !bellAt || Number.isNaN(bellAt.getTime())) continue;
    const { handedOffWithin, whereEstimateCustomerOwnership } = require('./call-commitments');
    const handedOff = await whereEstimateCustomerOwnership(handedOffWithin(conn('estimates'), bellAt), customerId).first('estimates.id');
    if (handedOff) data.quoteHandedOff.add(String(row.id));
  }
}

// GATE_LEAD_CONTACTED_CLOSE on (shadow or true): was an estimate handed off to each
// lead_contacted bell's lead after the bell? The promise lane's own witness again (a real
// delivery or the customer's acceptance, never sent_at), by the lead's customer. One small
// query per bell, and only for these bells. Needs the batch's leads loaded.
async function loadLeadHandoffs(rows, data, conn) {
  if (leadContactedCloseMode() === 'off') return;
  for (const row of rows) {
    const cls = classify(row);
    if (cls?.key !== 'lead_contacted') continue;
    const lead = data.leads.get(refsFromRow(row).leadId);
    const customerId = lead?.customer_id ? uuidOrNull(String(lead.customer_id)) : null;
    const bellAt = bellEventAt(row);
    if (!customerId || !bellAt) continue;
    const { handedOffWithin, whereEstimateCustomerOwnership } = require('./call-commitments');
    if (await whereEstimateCustomerOwnership(handedOffWithin(conn('estimates'), bellAt), customerId).first('estimates.id')) data.quoteHandedOff.add(String(row.id));
  }
}

// The live records for a batch of notification rows: one query per table per
// batch (a lead's estimate is only known once the lead is loaded, so estimates
// run second). Plain reads — never a lock.
async function loadSubjects(rows, conn = db) {
  const data = emptyData();
  data.contactMode = alertContactCloseMode();
  const all = rows.map(refsFromRow);
  const ids = (pick) => [...new Set(all.flatMap(pick))];
  const visitIds = ids((r) => r.visitIds);
  const leadIds = ids((r) => (r.leadId ? [r.leadId] : []));
  const promiseIds = ids((r) => [...r.promiseIds, ...(r.owedPromiseId ? [r.owedPromiseId] : [])]);
  const nameCustomerIds = ids((r) => (r.nameCustomerId ? [r.nameCustomerId] : []));
  // The last-name bells' customers, live ones only: a soft-deleted customer
  // is not in the map, which reads as gone. The name itself is the rule's.
  if (nameCustomerIds.length) {
    data.customers = byId(await conn('customers').whereIn('id', nameCustomerIds).whereNull('deleted_at').select('id', 'last_name'));
  }
  if (promiseIds.length) {
    data.promises = byId(await conn('call_commitments').whereIn('id', promiseIds).select('id', 'status', 'human_state', 'reviewed_at'));
  }
  await loadQuoteHandoffs(rows, data, conn);
  if (visitIds.length) {
    // The service date as text: a DATE parsed to a JS Date lands at the
    // host's midnight, the previous ET day on a UTC host.
    data.visits = byId(await conn('scheduled_services as ss').whereIn('ss.id', visitIds)
      .select('ss.id', 'ss.customer_id', 'ss.status', 'ss.window_start', conn.raw("to_char(ss.scheduled_date, 'YYYY-MM-DD') as service_date")));
  }
  if (leadIds.length) {
    data.leads = byId(await conn('leads').whereIn('id', leadIds)
      .select('id', 'deleted_at', 'customer_id', 'estimate_id', 'status', 'phone'));
  }
  if (data.contactMode !== 'off' || leadContactedCloseMode() !== 'off') await loadContact(rows, data, conn);
  await loadLeadHandoffs(rows, data, conn);
  // The stale-consent bells' customers: when did each last record a consent
  // at a CURRENT recurring-card text version — the base text or the
  // after-visit variant's (local max-effort review on #5434: an after-visit
  // reauthorization lands as AFTER_VISIT_CONSENT_VERSION, and it settles
  // the bell exactly like the base text does). A card-hold consent is not a
  // recurring authorization and never settles it.
  // (A customer id is deliberately NOT a subject ref — only this class reads
  // it, straight from its own metadata.)
  const consentCustomerIds = [...new Set(rows
    .map((row) => parseMeta(row.metadata))
    .filter((meta) => String(meta.dedupeKey || '').startsWith(CONSENT_STALE_PREFIX))
    .map((meta) => idTextOrNull(meta.customerId)).filter(Boolean))];
  if (consentCustomerIds.length) {
    const { CONSENT_VERSION, AFTER_VISIT_CONSENT_VERSION } = require('./payment-method-consent-text');
    const recorded = await conn('payment_method_consents').whereIn('customer_id', consentCustomerIds)
      .whereIn('consent_text_version', [CONSENT_VERSION, AFTER_VISIT_CONSENT_VERSION])
      .groupBy('customer_id').select('customer_id').max('created_at as latest_created_at');
    data.consents = new Map(recorded.map((r) => [String(r.customer_id), r.latest_created_at]));
  }
  // The repeat-form alerts' customers: the latest staff text that reached
  // each (deliveredTexts, the one definition of a text that reached the other
  // side). Never a call row: a dialer bridge writes it before Twilio dials,
  // and the customer leg is recorded only for callback attempts, so it does
  // not prove the lead was reached. Their quotes and bookings load below
  // with the leads' customers, with or without a lead row.
  const contactCustomerIds = [...new Set(rows.map((row) => repeatFormCustomerId(parseMeta(row.metadata))).filter(Boolean))];
  if (contactCustomerIds.length) {
    const { deliveredTexts } = require('./messaging/auto-text-holds');
    const { HUMAN_REPLY_TYPES } = require('./sms-suggest-mode');
    const texts = await deliveredTexts(conn).whereIn('customer_id', contactCustomerIds)
      .where({ direction: 'outbound' }).whereIn('message_type', HUMAN_REPLY_TYPES)
      .groupBy('customer_id').select('customer_id').max('created_at as latest_created_at');
    keepLatestPerCustomer(data.contacts, texts, 'latest_created_at');
  }
  const resolved = rows.map((row) => resolveRefs(row, data));
  const estimateIds = [...new Set(resolved.flatMap((r) => [r.refs.estimateId, r.lead?.estimate_id && String(r.lead.estimate_id)]).filter(Boolean))];
  const leadCustomerIds = [...new Set([...[...data.leads.values()].map((l) => l.customer_id && String(l.customer_id)), ...contactCustomerIds].filter(Boolean))];
  if (estimateIds.length) {
    data.estimates = byId(await conn('estimates').whereIn('id', estimateIds).select('id', 'sent_at'));
  }
  if (leadCustomerIds.length) {
    data.leadVisits = await bookedVisitsByCustomer(conn, leadCustomerIds);
    // Every quote sent to the lead's customer, not only the one the lead
    // points at now: a newer draft can take over leads.estimate_id
    // (draft-builder's writeGuardedLeadEstimateLink) without un-sending it.
    const quotes = await conn('estimates').whereIn('customer_id', leadCustomerIds).whereNotNull('sent_at').select('customer_id', 'sent_at');
    keepLatestPerCustomer(data.leadQuotes, quotes, 'sent_at');
  }
  return data;
}

function subjectFor(row, data, todayET) {
  const resolved = resolveRefs(row, data);
  const bellAt = row.created_at ? new Date(row.created_at) : null;
  // A repeat-form alert is about its own customer, with or without a lead row.
  const repeatCustomer = repeatFormCustomerId(resolved.refs.meta);
  const leadCustomer = repeatCustomer || (resolved.lead?.customer_id ? String(resolved.lead.customer_id) : null);
  return {
    ...resolved,
    meta: resolved.refs.meta,
    todayET,
    // When the bell was raised: a new lead is judged only by what came after.
    bellAt: bellAt && !Number.isNaN(bellAt.getTime()) ? bellAt : null,
    // The bell's latest event (its creation, or the last ringing refresh): the lead_contacted boundary.
    eventAt: bellEventAt(row),
    // A visit the row names, by id; loaded ids only, so a miss is a visit gone.
    visitOf: (id) => data.visits.get(id),
    // A promise the row names, by id; loaded ids only, so a miss is a promise gone.
    promiseOf: (id) => data.promises.get(id),
    leadBookedAt: leadCustomer ? data.leadVisits.get(leadCustomer) : null,
    leadQuotedAt: leadCustomer ? data.leadQuotes.get(leadCustomer) : null,
    // The latest consent the bell's customer recorded at the current text
    // version (loaded for stale-consent bells only).
    consentRecordedAt: (() => { const id = idTextOrNull(resolved.refs.meta.customerId); return id ? data.consents.get(id) : null; })(),
    // An estimate was handed off to the bell's customer after the bell
    // (loaded for add-a-service portal chat bells, repeat-form alerts and lead_contacted bells only).
    quoteHandedOff: data.quoteHandedOff.has(String(row.id)),
    // The latest staff text that reached the bell's customer (loaded for
    // repeat-form alerts only).
    leadContactedAt: repeatCustomer ? data.contacts.get(repeatCustomer) : null,
    // GATE_ALERT_CONTACT_CLOSE: its mode when the batch was read, and this
    // row's witnesses (absent = the subject could not be identified, or the
    // load failed — contactUnknown — and either way nothing is judged).
    contactMode: data.contactMode,
    contactUnknown: data.contactFailed,
    contact: data.contact.get(String(row.id)) || null,
  };
}

// The stale in-progress bell's own predicate, judged again: a visit from
// before today (ET) still on_site or en_route (the removed watchdog class's
// isStaleInProgress). Settled once that no longer holds — the visit is gone,
// has left those statuses (closed, or corrected back to pending, confirmed or
// rescheduled), or was moved to today or later. A bell naming no visit is
// never judged.
function staleVisitSettled(s) {
  if (!s.refs.visitId) return null;
  if (!s.visit) return 'Visit is gone';
  if (!STALE_IN_PROGRESS_STATUSES.has(String(s.visit.status))) return 'Visit is no longer in progress';
  const day = String(s.visit.service_date || '');
  return DATE_RE.test(day) && day < s.todayET ? null : 'Visit is no longer past its date';
}

// A series-move card's own work (admin-dispatch.js applySeriesMoveEffects):
// each windowless conflict needs a time, each preserved occurrence a cadence
// review, each overlap date a route check. The card is settled once every
// item is — a conflict given a time, closed or gone; a preserved occurrence
// closed or gone; any item whose day has passed (the visit's current date
// when it is loaded, else the date the card stored). A card that names no
// item is never judged. Not the moved visit itself (the card's subject, not
// its work), and never the customer's account: the card is written once per
// move (conflict_card_at).
function seriesMoveMovedOn(s) {
  const past = (day) => DATE_RE.test(day) && day < s.todayET;
  const visitItem = (item, settled) => {
    const id = uuidOrNull(item?.id);
    const visit = id ? s.visitOf(id) : undefined;
    if (id && !visit) return true;
    if (visit && settled(visit)) return true;
    return past(String(visit?.service_date || item?.date || '').slice(0, 10));
  };
  const closed = (v) => CLOSED_VISIT_STATUSES.has(String(v.status));
  const items = [
    ...arr(s.meta.conflicts).map((c) => visitItem(c, (v) => closed(v) || v.window_start != null)),
    ...arr(s.meta.preservedOccurrences).map((c) => visitItem(c, closed)),
    ...arr(s.meta.overlapDates).map((d) => past(String(d || '').slice(0, 10))),
  ];
  return items.length && items.every(Boolean) ? 'Everything it flagged is settled' : null;
}

// A new-lead bell is about the submission that raised it, so only what
// happened AFTER the bell counts: the lead deleted, a quote sent (the one it
// points at, or any to its customer), or a live visit booked for its customer. Timestamped facts only — a status
// carries no time, and the lead's state can predate the bell (a website
// submission attached to a lead already quoted or worked, and a lead whose current status is 'handled', which no
// timestamp is needed for). Not converted_at:
// booking the lead stamps it and cancelling that visit never clears it, so
// the booking itself — while it is live — is the evidence.
function newLeadMovedOn(s) {
  const lead = s.lead;
  // A missing lead row is "unknown", never "gone": the emitter falls back to a
  // customer id when lead creation failed.
  if (!lead || !s.bellAt) return null;
  const after = (at) => !!at && new Date(at).getTime() > s.bellAt.getTime();
  if (after(lead.deleted_at)) return 'Lead was deleted';
  // A lead whose CURRENT status is 'handled' (a /book request its own booking, or
  // staff, closed) is moved on whatever the timestamps say: the close can land
  // before the bell is even written, which no time comparison could see. A lead
  // reopened since is not 'handled', so it reads relevant again.
  if (lead.status === 'handled') return 'Request was handled';
  if (after(s.estimate?.sent_at) || after(s.leadQuotedAt)) return 'Estimate was sent';
  if (after(s.leadBookedAt)) return 'A visit was booked';
  return null;
}

// The repeat-form alert asks the office to call a lead who sent the quote
// form again (GATE_LEAD_REPEAT_FORM). Only what reached the customer after
// its latest form counts, each by its shared witness: a staff text
// (deliveredTexts), an estimate handed off (handedOffWithin, never sent_at),
// a live visit booked; or the lead deleted. A call alone is a person's to mark
// done (no call row proves the customer leg was reached). Never the new-lead
// bell's handled shortcut: a lead marked handled before this form is the
// lead coming back.
function repeatFormSettled(s) {
  if (!s.bellAt) return null;
  const after = (at) => !!at && new Date(at).getTime() > s.bellAt.getTime();
  if (after(s.leadContactedAt)) return 'Lead was contacted';
  if (s.quoteHandedOff) return 'Estimate was sent';
  if (after(s.leadBookedAt)) return 'A visit was booked';
  if (after(s.lead?.deleted_at)) return 'Lead was deleted';
  return null;
}

// The stale-consent bell (payment-method-consents.js
// refuseDeferredConsentRecording, dedupeKey consent_version_stale:<intent>):
// a deferred capture carried a consent text version that was no longer
// current, so the authorization was withheld and the office asked to
// re-collect it. Settled only by the customer re-authorizing — a consent row
// at a CURRENT recurring-card text version (base or after-visit) recorded
// after the bell; never by the intent
// (its stamp stays stale for good) and never by an older-version row
// (codex local max-effort review on #5434).
const CONSENT_STALE_PREFIX = 'consent_version_stale:';
function consentReauthorized(s) {
  if (!s.bellAt || !idTextOrNull(s.meta.customerId)) return null;
  const at = s.consentRecordedAt ? new Date(s.consentRecordedAt) : null;
  return at && !Number.isNaN(at.getTime()) && at.getTime() > s.bellAt.getTime() ? 'Authorization was re-collected' : null;
}

// A promise-mark bell (visit-promises.js alertUnsavedVisitPromiseMarks) is
// about technician marks that never reached the office's promise list. It is
// settled once every promise it names is closed (done or dismissed), gone,
// or acted on by the office after the bell (reviewed_at, stamped by a Mark
// done, an edit, a confirm, a Reopen). A bell naming no promise is never
// judged. The emitter closes its own bell when a resumed completion saves the
// marks.
function promiseMarksSettled(s) {
  const ids = s.refs.promiseIds;
  if (!ids.length || !s.bellAt) return null;
  const settled = ids.every((id) => {
    const promise = s.promiseOf(id);
    if (!promise || String(promise.status) !== 'open') return true;
    const reviewedAt = promise.reviewed_at ? new Date(promise.reviewed_at).getTime() : NaN;
    return reviewedAt > s.bellAt.getTime();
  });
  return settled ? 'Every promise it named is settled' : null;
}

// A promise-chaser bell (promise-chaser-bell.js: a caller rang back while a
// Waves promise to them was still open) is settled once that promise is
// closed: kept, dismissed, or dismissed by staff while its status stays open
// (call-commitments.js reads human_state the same way). A promise row that is
// gone is "unknown", never "closed". Final, never re-armed: the emitter's own
// close (ringForCall, inside its 30-minute window) is final too, so the two
// closes read the same; see the module header.
function chasedPromiseClosed(s) {
  const promise = s.refs.owedPromiseId ? s.promiseOf(s.refs.owedPromiseId) : undefined;
  if (!promise) return null;
  return String(promise.status) !== 'open' || promise.human_state === 'dismissed' ? 'The promise was closed' : null;
}

// A portal chat hand-off (ai-assistant/assistant.js notifyTeamOfEscalation)
// about adding a service is answered by an estimate: settled once one is
// handed off to that customer after the bell (owner 2026-10-03; the witness
// is loadSubjects'). Any estimate counts, not
// only one for the service asked about: the bell records the topic, not the
// service. Every other topic (a cancellation, a complaint, a schedule change)
// is never judged, and neither is a bell written before the topic was stored.
const PORTAL_CHAT_PREFIX = 'portal-chat-escalation:';
function isAddServiceChat(meta) {
  return String(meta.dedupeKey || '').startsWith(PORTAL_CHAT_PREFIX) && meta.topic === 'add_service';
}
// An add-service request bell (GATE_PORTAL_ITEM_CLOSE): the trigger `bundle_quote_requested` rung for a
// request row (a portal home card, a service report card, a public estimate), carrying that request id and
// its customer at the TOP of its metadata (notification-triggers.js adds both while the gate is on; the
// trigger's own fields stay nested under `payload`). The same answer as the add-service chat: an estimate.
const BUNDLE_QUOTE_TRIGGER = 'bundle_quote_requested';
function isBundleRequestBell(meta) {
  return meta.triggerKey === BUNDLE_QUOTE_TRIGGER && !!uuidOrNull(meta.requestId) && !!uuidOrNull(meta.customerId);
}
function addServiceQuoted(s) {
  return (isAddServiceChat(s.meta) || isBundleRequestBell(s.meta)) && s.quoteHandedOff ? 'Estimate was sent' : null;
}
// A portal request bell (POST /api/requests: category `service`, `doneWhen: 'request_answered'`, its request
// and customer ids). A cancellation bell has another promise (`cancellation_reviewed`) and never matches.
function isPortalRequestBell(meta) {
  return meta.doneWhen === 'request_answered' && !!uuidOrNull(meta.requestId) && !!uuidOrNull(meta.customerId);
}
// Any portal chat hand-off that asks for a customer answer (`doneWhen: 'customer_answered'`) and names
// its customer. The confirmed-email-change bell (`portal-chat-email-change:`, `doneWhen: 'email_changed'`)
// has another prefix and another promise: the account change is its answer, so it never matches.
function isAnswerableChat(meta) {
  return meta.doneWhen === 'customer_answered' && !!uuidOrNull(meta.customerId);
}

// A re-service request bell (notification-triggers.js reservice_self_booked)
// is about its booked visit: done once that visit is completed, cancelled or
// gone. Its emitter re-raises the same per-visit key only while the visit is
// open and new (reservice-public.js ringReserviceBooked), so a retire never
// fights it.
function reserviceVisitClosed(s) {
  if (!s.refs.visitId) return null;
  if (!s.visit) return 'Visit is gone';
  return CLOSED_VISIT_STATUSES.has(String(s.visit.status)) ? 'Visit is closed' : null;
}

// A phone-booking rain notice (call-booking-rain-flag.js) is about ONE visit
// at the date and start it was booked for: done once that visit is closed or
// gone, was moved off that date or start (the forecast it quoted no longer
// describes the visit), or its date has passed. Its emitter raises it once
// per visit and never again, so a retire never fights it.
function callBookingRainSettled(s) {
  if (!s.refs.visitId) return null;
  if (!s.visit) return 'Visit is gone';
  if (CLOSED_VISIT_STATUSES.has(String(s.visit.status))) return 'Visit is closed';
  const day = String(s.visit.service_date || '');
  const bookedDay = String(s.meta.scheduled_date || '');
  const bookedStart = String(s.meta.window_start || '').slice(0, 5);
  if (DATE_RE.test(bookedDay) && day !== bookedDay) return 'Visit was moved';
  if (bookedStart && String(s.visit.window_start || '').slice(0, 5) !== bookedStart) return 'Visit was moved';
  return DATE_RE.test(day) && day < s.todayET ? 'Visit date has passed' : null;
}

// A last-name suggestion (call-last-name-lookup.js: one bell per customer who
// gave a first name on a call) is about that customer's missing last name:
// done once the customer has a non-blank last name, or is gone (deleted or
// soft-deleted). A live customer with a blank last name keeps it. The emitter
// raises it once per customer and never again, so a retire never fights it; a
// name blanked again inside the re-arm window puts the bell back. A bell naming
// no usable customer id is never judged.
function lastNameSaved(s) {
  if (!s.refs.nameCustomerId) return null;
  if (!s.customer) return 'Customer is gone';
  return String(s.customer.last_name ?? '').trim() ? 'Last name was saved' : null;
}

// ---- Customer-contact bells (GATE_ALERT_CONTACT_CLOSE) ---------------------
// Each rule reads `s.contact`, the witnesses admin-alert-contact-witnesses.js
// loaded for the row; a row with none (its subject could not be identified, or
// the load failed) is never judged. Only events AFTER the bundle's anchor count
// (the text, call or email the bell is about). Reasons are plain words.
const contactAfter = (c, at) => !!at && new Date(at).getTime() > c.anchor.getTime();

// A text (notification-triggers.js sms_reply): closed once the Messages
// "needs a reply" reader (loadPendingSmsConversations) no longer counts the
// sender's conversation. The reader already counts a person's text and a
// person's call after the text as answers, and a courtesy text as needing none;
// the reason only names which, from the same witnesses (the reader also counts
// the texting assistant's reply as an answer, which has no witness of its own
// here, hence the plain last reason).
// A SHARED phone (another customer is tied to the number) is the exception: the
// reader judges by phone alone and cannot say whom a reply reached, so its verdict
// is not used. The bell closes only on this customer's own evidence by customer id
// (a person's reply to them, a person's call with them), loaded as textAt / backAt /
// inAt, or a staff action; nothing else, and never "no reply needed".
function textAnswered(s) {
  const c = s.contact;
  if (!c) return null;
  const action = staffActionAnswer(c);
  if (c.shared) {
    if (contactAfter(c, c.textAt)) return 'Answered by text';
    if (contactAfter(c, c.backAt) || contactAfter(c, c.inAt)) return 'Answered by a call';
    return action;
  }
  if (c.pending !== false) return action;
  if (contactAfter(c, c.textAt)) return 'Answered by text';
  if (contactAfter(c, c.backAt) || contactAfter(c, c.inAt)) return 'Answered by a call';
  // Before the plain fallback so the reason names the action. Only while live: in `shadow` the
  // reader still answers this text by its own rules, so the real close keeps its plain reason.
  if (action?.mode === 'true') return action;
  return 'Answered, or no reply needed';
}

// A staff action for the text's customer after the text (GATE_SMS_STAFF_ACTION_ANSWERS, "Stuck Alert
// Fixes" F1: a visit a person booked in the admin, or a payment a person recorded, within 24 hours,
// by customer id): answered with its own mode so it can run in shadow while the contact gate is `true`.
let staffActionReasons;
function staffActionAnswer(c) {
  if (!c.staffActionKind || !contactAfter(c, c.staffActionAt)) return null;
  const mode = staffActionAnswersMode();
  if (mode === 'off') return null;
  staffActionReasons ||= require('./sms-staff-action-answers').STAFF_ACTION_REASONS;
  const reason = staffActionReasons[c.staffActionKind];
  return reason ? { reason, mode } : null;
}

// A voicemail callback request: a person called back and
// spoke with them, the customer called in and a person answered, a person's
// text reached them, a visit was booked, or a quote was handed off.
function callerReached(s) {
  const c = s.contact;
  if (!c) return null;
  if (contactAfter(c, c.backAt)) return 'A person called back';
  if (contactAfter(c, c.inAt)) return 'A person answered their call';
  if (contactAfter(c, c.textAt)) return 'Answered by text';
  if (contactAfter(c, c.visitAt)) return 'A visit was booked';
  return c.quote ? 'Estimate was sent' : null;
}

// The voicemail's customer has a visit that completed after the call on the same Eastern
// day (GATE_VOICEMAIL_VISIT_UNDERWAY; the real case: the tech arrived at 10:17, the
// customer left a voicemail about the visit at 10:20 and the visit completed). The
// reason is the missed-call lane's wording for the same fact. Answered with its own
// mode so it can run in shadow while the contact gate is `true`; voice items only (the
// email class falls back to callerReached, never to this).
let visitUnderwayResolution;
function visitWentAhead(s) {
  const c = s.contact;
  if (!c || !contactAfter(c, c.visitRanAt)) return null;
  const mode = voicemailVisitUnderwayMode();
  if (mode === 'off') return null;
  visitUnderwayResolution ||= require('./missed-call-bell').VISIT_UNDERWAY_RESOLUTION;
  return { reason: visitUnderwayResolution, mode };
}

// A voicemail callback request: any contact witness first (callerReached), else the visit.
function voicemailAnswered(s) {
  return callerReached(s) || visitWentAhead(s);
}

// An email from a customer: a person's reply in its Gmail thread, else the
// same witnesses as a call (owner 2026-09-28: a text or call back closes an
// email ask).
function emailAnswered(s) {
  const c = s.contact;
  if (!c) return null;
  return contactAfter(c, c.replyAt) ? 'Answered by email' : callerReached(s);
}

// A new lead that a person's text reached or called back, after the bell: the
// part of the new-lead class the gate controls (its other reasons are
// newLeadMovedOn's and always on).
function leadContacted(s) {
  const c = s.contact;
  if (!c || !s.lead) return null;
  return contactAfter(c, c.textAt) || contactAfter(c, c.backAt) ? 'Lead was contacted' : null;
}

// The first fact, in order, that a person reached the customer after the bell's anchor: a call back, an
// answered call, a text, a Gmail send. The reasons are plain words (they become the bell's resolution).
function personContactReason(c) {
  if (contactAfter(c, c.backAt)) return 'A person called back';
  if (contactAfter(c, c.inAt)) return 'A person answered their call';
  if (contactAfter(c, c.textAt)) return 'Answered by text';
  if (contactAfter(c, c.replyAt)) return 'Answered by email';
  return null;
}
// A portal chat hand-off (GATE_PORTAL_CHAT_ANSWERED_CLOSE; owner 2026-10-31: "a chat item closes itself
// when someone texts, calls or emails that customer after the request"): a person called back, answered
// the customer's call, texted or emailed that customer after the bell's latest event (the witnesses'
// anchor, bellEventAt). Answered with the gate's own mode, so it follows the weaker of that and
// GATE_ALERT_CONTACT_CLOSE (judge). No visit or estimate reason here: the add-a-service chat keeps its
// estimate rule beside it.
function portalChatAnswered(s) {
  const c = s.contact;
  if (!c) return null;
  const mode = portalChatAnsweredCloseMode();
  if (mode === 'off') return null;
  const reason = personContactReason(c);
  return reason ? { reason, mode } : null;
}
// The same contact for a portal request bell, under GATE_PORTAL_ITEM_CLOSE (the class gate, so 'true' here).
function portalItemAnswered(s) {
  const c = s.contact;
  const reason = c ? personContactReason(c) : null;
  return reason ? { reason, mode: 'true' } : null;
}

// What closing a portal item bell also settles: its request row, resolved quietly with the reason as the
// admin note (portal-inbox.js; no customer email). Failing here never undoes the bell's close.
function resolveRequestOf(bell, note) {
  const meta = parseMeta(bell.metadata);
  return require('./portal-inbox').resolveRequestQuietly(uuidOrNull(meta.requestId), uuidOrNull(meta.customerId), note);
}

// A lead_contacted Leads bell (GATE_LEAD_CONTACTED_CLOSE): the emitters promise "done when
// the lead is contacted" and nothing closed it. Judged only by what came AFTER the bell
// (its latest event, bellEventAt: created_at or the last ringing refresh's rungAt): a person's text or call back reached the lead (the
// lead contact kind's witnesses), a live top-level visit was booked for the lead's customer,
// or an estimate was handed off (loadLeadHandoffs). A lead row that is gone is unknown.
const LEAD_CONTACTED = 'lead_contacted';
function leadContactedMovedOn(s) {
  if (!s.lead || !s.eventAt) return null;
  const c = s.contact;
  if (c && (contactAfter(c, c.textAt) || contactAfter(c, c.backAt))) return 'Lead was contacted';
  if (s.leadBookedAt && new Date(s.leadBookedAt).getTime() > s.eventAt.getTime()) return 'A visit was booked';
  return s.quoteHandedOff ? 'Estimate was sent' : null;
}

// Alert classes: category (+ dedupeKey prefix, looked up in each emitter) → a
// rule returning null while the alert is still relevant, else a short reason.
const CLASSES = [
  { // payment-method-consents.js refuseDeferredConsentRecording — one bell per intent
    key: 'consent_version_stale', categories: ['billing'], prefix: CONSENT_STALE_PREFIX, rule: consentReauthorized,
  },
  { // emitter removed in #5223; unread rows remain. Only the visit itself settles it.
    key: 'stale_visit', categories: ['alert'], prefix: 'stale-visit:', rule: staleVisitSettled,
  },
  { // admin-dispatch.js applySeriesMoveEffects — one card per move
    key: 'series_move', categories: ['schedule_conflict'], match: (meta) => !!meta.seriesMoveId, rule: seriesMoveMovedOn,
  },
  { // notification-triggers.js new_lead — the intake bell, one event per
    // submission, no dedupe key. A direct notifyAdmin('new_lead') (a repeat
    // submission filed as a duplicate, an email follow-up's new draft) is
    // fresh work about a lead already on file, never judged.
    key: 'new_lead', categories: ['new_lead'], match: (meta, row) => meta.triggerKey === 'new_lead' && !!refsFromRow(row).leadId, rule: newLeadMovedOn,
    // GATE_ALERT_CONTACT_CLOSE: also "Lead was contacted" (a person's text or call back after the bell).
    contact: 'lead', contactRule: leadContacted,
  },
  { // visit-promises.js alertUnsavedVisitPromiseMarks — one bell per visit,
    // raised again (same key) only while a mark is still unsaved.
    key: 'promise_marks', categories: ['alert'], prefix: 'visit-promise-marks:', rule: promiseMarksSettled,
  },
  { // promise-chaser-bell.js — one bell per promise and call day
    key: 'promise_chaser', categories: ['missed_call'], prefix: 'promise_chaser:', match: (meta) => meta.triggerKey === 'promise_chaser', rule: chasedPromiseClosed, rearm: false,
  },
  { // reservice-public.js ringReserviceBooked — one bell per self-booked visit
    key: 'reservice_booked', categories: ['schedule'], prefix: 'reservice-booked:', match: (meta) => meta.triggerKey === 'reservice_self_booked', rule: reserviceVisitClosed,
  },
  { // call-booking-rain-flag.js — one notice per phone-booked visit
    key: 'call_booking_rain', categories: ['schedule'], prefix: 'call-booking-rain:', rule: callBookingRainSettled,
  },
  { // call-last-name-lookup.js — one suggestion per customer
    key: 'call_last_name_suggestion', categories: ['customer'], prefix: SUGGESTION_KEY_PREFIX, rule: lastNameSaved,
  },
  { // ai-assistant/assistant.js notifyTeamOfEscalation — one bell per hand-off
    key: 'portal_chat_add_service', categories: ['alert'], prefix: PORTAL_CHAT_PREFIX, match: isAddServiceChat, rule: addServiceQuoted,
    // Also closed by a person's contact after the bell (GATE_PORTAL_CHAT_ANSWERED_CLOSE, own mode).
    contact: 'customer', contactRule: portalChatAnswered,
  },
  { // the same hand-off for every other topic: closed only by a person's contact (add_service matched above)
    key: 'portal_chat_answered', categories: ['alert'], prefix: PORTAL_CHAT_PREFIX, match: isAnswerableChat,
    gate: portalChatAnsweredCloseMode, contact: 'customer', contactRule: portalChatAnswered,
  },
  { // requests.js POST /api/requests — a customer's request from the app (GATE_PORTAL_ITEM_CLOSE). Closed by a
    // person's contact with that customer after the bell, like a chat hand-off; its request row is resolved quietly.
    key: 'portal_request_answered', categories: ['service'], doneWhen: 'request_answered', match: isPortalRequestBell,
    gate: portalItemGate, contact: 'customer', contactRule: portalItemAnswered,
    onRetired: (bell, reason) => resolveRequestOf(bell, reason),
  },
  { // notification-triggers.js bundle_quote_requested — an add-service request (GATE_PORTAL_ITEM_CLOSE). Closed by
    // an estimate handed to that customer after the bell; its request row is resolved quietly as "Estimate sent".
    key: 'portal_add_service_request', categories: ['estimate'], triggerKey: BUNDLE_QUOTE_TRIGGER, match: isBundleRequestBell,
    gate: portalItemGate, rule: addServiceQuoted,
    onRetired: (bell) => resolveRequestOf(bell, 'Estimate sent'),
  },
  { // lead-webhook.js ringRepeatFormAlert — it dedupes on OPEN rows only, so a
    // retirement ends the episode and the lead's next form rings a fresh row.
    // Final, like the promise chaser's: a put-back would stand beside that row.
    key: 'lead_repeat_form', categories: ['lead'], prefix: REPEAT_FORM_PREFIX, rule: repeatFormSettled, rearm: false,
  },
  // Customer-initiated contact bells (owner 2026-10-24), all behind
  // GATE_ALERT_CONTACT_CLOSE (`contactOnly`: not in the table at all while it is
  // off) and keyed by the emitter's trigger.
  { // notification-triggers.js sms_reply. A known sender's texts share ONE row
    // (sms-thread:<customer>) that a new text rewrites, bumps and rings again,
    // which also clears the done fields and the retired stamp (notification-
    // service mergeRefreshMetadata), so a text after a close always rings. An
    // unknown sender's bell (a row per 4-hour window, sms-reply:<sid>) is NOT
    // judged (contactRefs returns null): a second text inside the window raises
    // no new row, so no anchor can stand for its latest text.
    key: 'inbound_sms', categories: ['inbound_sms'], triggerKey: 'sms_reply', contactOnly: true, contact: 'sms', contactRule: textAnswered,
  },
  { // call-recording-processor.js — one bell per voicemail, no dedupe key
    key: 'voicemail_callback', categories: ['voicemail_callback'], triggerKey: 'customer_voicemail_callback', contactOnly: true, contact: 'voice', contactRule: voicemailAnswered,
  },
  // Missed calls (customer_missed_call) are NOT here: missed-call-bell.js owns them
  // (retireCalledBackMissedCalls, every 2 minutes, one owner), and it judges the
  // contact clauses below behind the same gate. The promise chaser, repeat caller
  // and Sandy hand-off bells share the category and keep their own owners.
  { // email-sync.js ringCustomerEmailBell — one bell per email
    key: 'inbound_email', categories: ['inbound_email'], triggerKey: 'customer_email_received', contactOnly: true, contact: 'email', contactRule: emailAnswered,
  },
  // Leads bells that promise `doneWhen: 'lead_contacted'` and name a lead (lead-call-text-followup,
  // lead-call-reply-ring, sms-lead-extraction, lead-unverified-hold; the lead id is in metadata.leadId
  // and the link's ?lead=). The repeat-form alert (same doneWhen) is the lead_repeat_form class above,
  // matched first. A bid-invite Leads bell (doneWhen bid_decided) never matches. The whole class runs
  // under GATE_LEAD_CONTACTED_CLOSE (`gate`), whatever GATE_ALERT_CONTACT_CLOSE says.
  {
    key: 'lead_contacted', categories: ['lead'], doneWhen: LEAD_CONTACTED, gate: leadContactedCloseMode, contact: 'lead', rule: leadContactedMovedOn,
    match: (meta, row) => meta.doneWhen === LEAD_CONTACTED && !!refsFromRow(row).leadId,
  },
];

// One row's verdict. `reason` closes it now (the always-on rule, or the
// contact rule while the gate is `true`); `would` is what the contact rule
// says while the gate is `shadow`, recorded and never acted on. A contact rule
// is silent when the gate is off or its witnesses did not load.
//
// Own gates (owner 2026-10-29): a class with a `gate` reader judges nothing while it reads
// 'off' and only records (`would`) while it reads 'shadow'. A contact rule may answer
// `{ reason, mode }` instead of a string: its reason then follows the weaker of the contact
// gate and its own mode (off = silent), so a new reason can run in shadow while the
// contact gate is `true`. A plain string keeps following the contact gate alone.
const NONE = Object.freeze({ reason: null, would: null });
function judge(cls, s) {
  const own = cls.gate ? cls.gate() : 'true';
  if (own === 'off') return NONE;
  const base = cls.rule ? cls.rule(s) : null;
  if (base) return own === 'true' ? { reason: base, would: null } : { reason: null, would: base };
  if (!cls.contactRule || s.contactMode === 'off') return NONE;
  const extra = cls.contactRule(s);
  if (!extra) return NONE;
  const { reason, mode } = typeof extra === 'string' ? { reason: extra, mode: 'true' } : extra;
  if (mode === 'off') return NONE;
  return s.contactMode === 'true' && mode === 'true' ? { reason, would: null } : { reason: null, would: reason };
}

// The class a row belongs to, or null. Category first, then the emitter's
// dedupeKey prefix / trigger / extra metadata test. The contact-only classes
// exist only while GATE_ALERT_CONTACT_CLOSE is shadow or true, and a class with its
// own `gate` only while that gate is; the re-arm pass asks for them in every mode
// (`anyMode`) so a gate switched back off puts back what it closed.
function classify(row, { anyMode = false } = {}) {
  const meta = parseMeta(row.metadata);
  const dedupeKey = String(meta.dedupeKey || '');
  const contactLive = anyMode || alertContactCloseMode() !== 'off';
  return CLASSES.find((c) => (!c.contactOnly || contactLive)
    && (!c.gate || anyMode || c.gate() !== 'off')
    && c.categories.includes(row.category)
    && (!c.prefix || dedupeKey.startsWith(c.prefix))
    && (!c.triggerKey || meta.triggerKey === c.triggerKey)
    && (!c.match || c.match(meta, row))) || null;
}

// Open (not done) admin rows this sweep could judge: bell-visible, of a class
// in the table, never one already retired (a person who reopened a retired row
// keeps it open: the stamp survives a reopen and a put-back removes it), of any age (a refreshed bell keeps its first created_at, so an age
// cut-off would hide a re-rung one for good). Keyset-paged on id: retiring a
// row removes it from the set, so an offset would skip rows.
function candidateQuery(cursor) {
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  return excludeActivityOnlyFromBell(db('notifications').where({ recipient_type: 'admin' }))
    // Open rows, and rows a PERSON marked done (openToCloser's rule): when the
    // subject moves on, the sweep takes the close over so their Reopen can't
    // bring back an obsolete alert. A row any system component closed is left.
    // Bounded to the Recently done window (7 days), the only place a Reopen is
    // offered, so a person-done row is not re-read by every sweep forever.
    .where((q) => q.whereNull('done_at').orWhere((p) => p
      .whereRaw(`COALESCE(${require('./notification-service')._private.PERSON_DONE_BY_SQL}, false)`)
      .whereRaw("done_at >= now() - interval '7 days'")))
    .whereRaw("metadata->'retired' IS NULL")
    .where((q) => {
      const contactLive = alertContactCloseMode() !== 'off';
      for (const c of CLASSES) {
        if (c.contactOnly && !contactLive) continue;
        if (c.gate && c.gate() === 'off') continue;
        q.orWhere((cq) => {
          cq.whereIn('category', c.categories);
          if (c.doneWhen) cq.whereRaw("metadata->>'doneWhen' = ?", [c.doneWhen]);
          if (c.prefix) cq.whereRaw("left(COALESCE(metadata->>'dedupeKey', ''), ?) = ?", [c.prefix.length, c.prefix]);
          if (c.triggerKey) cq.whereRaw("metadata->>'triggerKey' = ?", [c.triggerKey]);
        });
      }
    })
    .modify((q) => { if (cursor) q.where('id', '>', cursor); })
    .orderBy('id', 'asc')
    .limit(PAGE_SIZE)
    .select('id', 'category', 'link', 'metadata', 'created_at', 'done_at', 'done_by');
}

// The row as the batch read it, still: a refresh that rewrote it since is
// left for the next sweep to judge.
const sameRow = (a, b) => a.category === b.category && (a.link || null) === (b.link || null)
  && JSON.stringify(parseMeta(a.metadata)) === JSON.stringify(parseMeta(b.metadata));

// The same predicate as a write condition: the retire lands only on the
// version it judged (category, link and metadata — everything the rule reads),
// never on a bell an emitter refreshed in between.
const sameVersion = (q, row) => q.where('category', row.category)
  .whereRaw('link IS NOT DISTINCT FROM ?', [row.link ?? null])
  .whereRaw('metadata IS NOT DISTINCT FROM ?::jsonb', [row.metadata == null ? null : JSON.stringify(parseMeta(row.metadata))]);

// The bell as it read before this module's stamp.
function unretired(metadata) {
  const { retired: _stamp, ...meta } = parseMeta(metadata);
  return meta;
}

// Judges one row on a fresh read and retires it only if it is still moved on
// and still the version judged, then judges it once more AFTER the write, on
// the bell as it stands then (a quiet refresh rewrites content without
// touching done_at): a change that landed between the read and the write (a
// visit reopened, a lead reopened) puts the bell back — unless a person
// reopened it since, or a refresh rang it again (the emitter's: a ringing
// refresh clears the done fields, so the fence below no longer matches). A check after the write that fails
// is no verdict, so it puts the bell back too; a put-back that fails is
// judged again by the next run's re-arm pass (rearmRelevantAgain). No row
// locks: see the module header. A change after the final judgement is the
// re-arm pass's.
async function retireIfStillMovedOn(row, cls, todayET, now) {
  if (row.done_at) return takeOverPersonDone(row, cls, todayET);
  const current = await db('notifications').where({ id: row.id, recipient_type: 'admin' }).whereNull('done_at')
    .first('id', 'category', 'link', 'metadata', 'created_at');
  if (!current || !sameRow(current, row)) return null;
  const reason = judge(cls, subjectFor(current, await loadSubjects([current]), todayET)).reason;
  if (!reason) return null;
  // The stamp's `at` IS the done_at this write stores — an explicit
  // millisecond instant, not NOW() (Postgres keeps microseconds, which a JS
  // Date read back would truncate) — so every put-back, now or on a later
  // run, can require that this module's done is still the one on the row.
  const doneAt = new Date(now.getTime());
  const stamp = { by: RETIRED_BY, reason, at: doneAt.toISOString() };
  const [retired] = await sameVersion(db('notifications').where({ id: row.id, recipient_type: 'admin' }).whereNull('done_at'), current)
    .update({
      ...doneState().doneColumns({ by: 'relevance', resolution: reason, at: doneAt, keepExisting: true }),
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ retired: stamp })]),
    })
    .returning(['id']);
  if (!retired) return null;
  const stillOurs = (q) => q.where({ id: row.id, done_at: doneAt }).whereRaw("metadata->'retired'->>'at' = ?", [stamp.at]);
  try {
    const latest = await stillOurs(db('notifications')).first('id', 'category', 'link', 'metadata', 'created_at');
    if (!latest) return null;
    const judged = { ...latest, metadata: unretired(latest.metadata) };
    if (judge(cls, subjectFor(judged, await loadSubjects([judged]), todayET)).reason) {
      await settleAfterRetire(cls, judged, reason);
      return reason;
    }
  } catch (err) {
    logger.warn(`[alert-relevance] notification ${row.id}: the check after retiring failed, putting it back: ${errSummary(err)}`);
  }
  await stillOurs(db('notifications')).update(undone(doneAt));
  return null;
}

// A class that settles more than its bell (the portal request classes also resolve their request row) says
// so in `onRetired`. It runs once the retirement stood its final judgement, and a failure is logged and
// never undoes the close.
async function settleAfterRetire(cls, bell, reason) {
  if (!cls.onRetired) return;
  try {
    await cls.onRetired(bell, reason);
  } catch (err) {
    logger.warn(`[alert-relevance] notification ${bell.id}: the request behind it was not resolved: ${errSummary(err)}`);
  }
}

// Rows this module retired (done, stamped) in the last REARM_DAYS,
// keyset-paged on id.
function retiredQuery(cursor, since) {
  return db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->'retired'->>'by' = ?", [RETIRED_BY])
    .whereRaw("metadata->'retired'->>'at' > ?", [since])
    .modify((q) => { if (cursor) q.where('id', '>', cursor); })
    .orderBy('id', 'asc')
    .limit(PAGE_SIZE)
    .select('id', 'category', 'link', 'metadata', 'read_at', 'created_at');
}

// A row a person already marked done whose subject has moved on: the sweep
// takes the close over (done_by 'relevance'), fenced on that person's done_by
// still being the one on the row. Their done time, read and resolution stand.
// No retired stamp: the row is already out of the bell, so there is nothing
// for the re-arm pass to put back — it only stops a stale Reopen.
async function takeOverPersonDone(row, cls, todayET) {
  // The exact completion and content judged: done_at at full precision (text,
  // microseconds) plus category / link / metadata. A refresh and a newer Done
  // in between never match, so only the close that was judged is taken over.
  const current = await db('notifications').where({ id: row.id, recipient_type: 'admin', done_by: row.done_by })
    .whereNotNull('done_at').first('id', 'category', 'link', 'metadata', 'created_at', db.raw('done_at::text AS done_at_token'));
  if (!current || !sameRow(current, row)) return null;
  const reason = judge(cls, subjectFor(current, await loadSubjects([current]), todayET)).reason;
  if (!reason) return null;
  const exact = (q, by) => sameVersion(q.where({ id: row.id, recipient_type: 'admin', done_by: by })
    .whereRaw('done_at = ?::timestamptz', [current.done_at_token]), current);
  const updated = await exact(db('notifications'), row.done_by).update({ done_by: 'relevance', resolution: db.raw('COALESCE(resolution, ?)', [reason]) });
  if (!updated) return null;
  // Judged once more after the write, like a retire: a subject that came back
  // in between hands the close back to the person (their Reopen returns).
  let stillMovedOn = false;
  try {
    stillMovedOn = !!judge(cls, subjectFor(current, await loadSubjects([current]), todayET)).reason;
  } catch (err) {
    logger.warn(`[alert-relevance] notification ${row.id}: the check after a takeover failed, handing it back: ${errSummary(err)}`);
  }
  if (!stillMovedOn) {
    await exact(db('notifications'), 'relevance').update({ done_by: row.done_by });
    return null;
  }
  // Not counted as a retire: the row was already out of the bell.
  logger.info(`[alert-relevance] notification ${row.id}: took over a person's Done (${reason})`);
  return null;
}

// The put-back write: not done, no retired stamp, and unread only when the
// read was this module's own (a read at the stamp's instant). A person's own
// read, before or after the retire, stands.
const undone = (ourDone) => ({
  read_at: db.raw('CASE WHEN read_at = ?::timestamptz THEN NULL ELSE read_at END', [ourDone]),
  ...doneState().DONE_CLEARED,
  metadata: db.raw("metadata - 'retired'"),
});

// Puts back one retired row whose subject is relevant again onto exactly the
// version read (category, link, metadata) and only while the row's done is
// still the one this module wrote (the stamp's `at`): a row a person reopened
// is theirs, on this run and every later one. Nothing is pushed.
function putBack(row) {
  const ourDone = new Date(parseMeta(row.metadata).retired?.at || NaN);
  if (Number.isNaN(ourDone.getTime())) return 0;
  return sameVersion(db('notifications').where({ id: row.id, recipient_type: 'admin' }), row)
    .where({ done_at: ourDone })
    .update(undone(ourDone));
}

// The emitters in the table are one-shot: a booking cancelled or a visit or
// lead reopened raises nothing. So each run judges again what this module
// retired in the last REARM_DAYS, on the bell as it read before the stamp,
// and puts back any row whose rule no longer holds. Also the
// retry for a retire whose put-back failed. A retirement older than that is
// final: a subject that comes back weeks later is a new event, not this bell.
// Walked across runs like the retire pass (resumeAfter below): a run that
// stops at the page cap leaves where it stopped, so rows past it are reached
// by the next run instead of waiting behind the same first pages.
let rearmResumeAfter = null;

async function rearmRelevantAgain(now, todayET) {
  const since = new Date(now.getTime() - REARM_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let rearmed = 0;
  let cursor = rearmResumeAfter;
  rearmResumeAfter = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await retiredQuery(cursor, since);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    if (rows.length === PAGE_SIZE && page === MAX_PAGES - 1) rearmResumeAfter = cursor;
    const judged = rows.map((row) => ({ row, bell: { ...row, metadata: unretired(row.metadata) } }));
    const data = await loadSubjects(judged.map((j) => j.bell));
    for (const { row, bell } of judged) {
      try {
        const cls = classify(bell, { anyMode: true });
        if (!cls || cls.rearm === false) continue;
        const subject = subjectFor(bell, data, todayET);
        // Witnesses that failed to load are no verdict: leave the row as it is.
        if (cls.contact && subject.contactUnknown) continue;
        if (judge(cls, subject).reason) continue;
        rearmed += await putBack(row);
      } catch (err) {
        logger.warn(`[alert-relevance] notification ${row.id} not re-armed: ${errSummary(err)}`);
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return rearmed;
}

// A backlog bigger than one run (MAX_PAGES pages) is walked across runs: a
// run that stops at the cap leaves where it stopped, and the next run
// resumes after it; a run that reaches the end leaves nothing, so the next
// one starts over. In-process: a restart simply starts over.
let resumeAfter = null;

// GATE_ALERT_CONTACT_CLOSE=shadow: one audit_log row per bell per class per
// Eastern day for what the contact rules would close. The bell, its metadata
// and its read / done state are untouched (the emitters compare metadata on a
// refresh and the retire's version fence reads it). Advisory: a failed write is
// logged, never fatal.
async function recordWouldClose(items, now, todayET) {
  if (!items.length) return 0;
  try {
    const { auditAlertWouldClose } = require('./audit-log');
    return await auditAlertWouldClose({
      et_day: todayET,
      items: items.map(({ row, cls, reason }) => ({ notification_id: row.id, alert_class: cls.key, reason, judged_at: now.toISOString() })),
    });
  } catch (err) {
    logger.warn(`[alert-relevance] could not record ${items.length} would-close verdict(s): ${errSummary(err)}`);
    return 0;
  }
}

// One row of a batch. The batch read is a first pass: only a row that looks
// moved on pays for the fresh recheck that actually retires it. A shadow
// verdict (GATE_ALERT_CONTACT_CLOSE=shadow) is only collected: an open row is
// recorded, a person's own Done is not ours to judge there.
async function sweepRow(row, cls, subject, { now, todayET, byClass, shadowed }) {
  const verdict = judge(cls, subject);
  if (verdict.would) {
    if (!row.done_at) shadowed.push({ row, cls, reason: verdict.would });
    return;
  }
  if (verdict.reason && await retireIfStillMovedOn(row, cls, todayET, now)) byClass[cls.key] = (byClass[cls.key] || 0) + 1;
}

async function runAdminAlertRelevanceSweep({ now = new Date() } = {}) {
  if (!adminAlertRelevanceLive()) return { skipped: true, reason: 'switch_off' };
  const todayET = etDateString(now);
  // First, so a row put back is judged again by the retire pass below.
  const rearmed = await rearmRelevantAgain(now, todayET);
  const byClass = {};
  let scanned = 0;
  let wouldClose = 0;
  let cursor = resumeAfter;
  resumeAfter = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await candidateQuery(cursor);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;
    if (rows.length === PAGE_SIZE && page === MAX_PAGES - 1) resumeAfter = cursor;
    const data = await loadSubjects(rows);
    const shadowed = [];
    for (const row of rows) {
      try {
        const cls = classify(row);
        if (cls) await sweepRow(row, cls, subjectFor(row, data, todayET), { now, todayET, byClass, shadowed });
      } catch (err) {
        logger.warn(`[alert-relevance] notification ${row.id} skipped: ${errSummary(err)}`);
      }
    }
    wouldClose += await recordWouldClose(shadowed, now, todayET);
    if (rows.length < PAGE_SIZE) break;
  }
  const retired = Object.values(byClass).reduce((a, b) => a + b, 0);
  if (retired) logger.info(`[alert-relevance] retired ${retired} of ${scanned} unread alert(s): ${JSON.stringify(byClass)}`);
  if (rearmed) logger.info(`[alert-relevance] put back ${rearmed} alert(s) whose subject is relevant again`);
  if (wouldClose) logger.info(`[alert-relevance] shadow: recorded ${wouldClose} alert(s) the customer-contact rules would close`);
  const anyShadow = [alertContactCloseMode, voicemailVisitUnderwayMode, leadContactedCloseMode, staffActionAnswersMode, portalChatAnsweredCloseMode].some((mode) => mode() === 'shadow');
  const lateReRung = await lateReRingPass(now);
  return { skipped: false, scanned, retired, byClass, rearmed, ...(anyShadow ? { wouldClose } : {}), ...(lateReRung ? { lateReRung } : {}) };
}

// GATE_PORTAL_LATE_RERING: portal items past their one business hour ring once more (portal-late-rering.js).
// After the closes above, so a bell this run just closed is not rung. Off: nothing is read or written. A
// failure is logged and never fails the sweep.
async function lateReRingPass(now) {
  if (!require('../config/feature-gates').portalLateReringLive?.()) return null;
  try {
    return (await require('./portal-late-rering').runPortalLateRering({ now })).rung;
  } catch (err) {
    logger.warn(`[alert-relevance] the late re-ring pass failed: ${errSummary(err)}`);
    return null;
  }
}

module.exports = {
  runAdminAlertRelevanceSweep,
  classify,
  loadSubjects,
  subjectFor,
  refsFromRow,
  bellEventAt,
  parseMeta,
  judge,
  whereLiveBooking,
  CLASSES,
};

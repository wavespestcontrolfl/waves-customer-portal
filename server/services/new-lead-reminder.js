/**
 * New-lead re-alert (owner 2026-11-19, "do phase 1 first"; plan: "15 min, no person contact: push again; 60 min:
 * phone call to the owner's cell; at most twice per lead; Mon-Sat 8-6").
 *
 * In production (12 weeks to 2026-11-19) 82 of 437 leads never got a call, text, email or estimate from a person, and
 * none of them booked. A form lead gets one bell and one push; 44 of 129 form bells in 30 days were never opened.
 *
 * An OPEN new-lead bell (category `new_lead`, naming a lead), or the repeat-form bell (lead-webhook.js
 * ringRepeatFormAlert: a lead sent the quote form again; the relevance sweep's lead_repeat_form class), that no person
 * has reached gets ONE more phone push 15 minutes after the bell's latest event. No gate: the push goes to admin users
 * only. (A second step, a ring to the owner's cell at 60 minutes behind its own gate, is a separate change.)
 * At most one push per bell row: it is stamped first, in one statement fenced on the row being open and unchanged since
 * it was read (metadata.newLeadRealertAt), under notifyAdmin's lock for the bell's dedupe key. Stamp first, then send:
 * a send that fails after its stamp is lost, never repeated. The push goes only while the row is still an open bell in
 * the bell feed with exactly the stamped metadata (a bell that rang again since then sends nothing), and while the lead
 * still waits when judged again with fresh reads just before it goes (lead-reminder-sweep.js).
 *
 * - The clock counts only Monday to Saturday, 8:00 AM to 6:00 PM America/New_York (callback-cards staffedDeadline;
 *   holidays are not skipped). Nothing is sent outside those hours. A push more than 2 business hours past its due time
 *   is dropped, so a restart cannot burst old bells. Both are asked again with a fresh clock before the stamp and at
 *   dispatch (lead-reminder-sweep.js), since the reads in between take time.
 * - Bells of the last 48 hours only (a 6 PM Saturday bell is due Monday morning).
 * - "Reached" (reachedLeads) is judged on the lead, whatever the close gates of admin-alert-relevance.js say, and NOT
 *   only after the bell: a "New call lead" bell is written minutes after a call a person already answered. Reached =
 *   the lead is deleted, not open or already converted (lead-statuses.js isOpenLeadRow: spam, cancelled, won, lost and the like
 *   are out), or has an estimate sent or viewed; the call that made the lead was
 *   answered by a person (only for the lead's intake bell: the one the new-lead trigger writes for a lead its writer
 *   created, metadata.triggerKey new_lead and payload.createdLead, within 15 minutes of the lead's creation; every other
 *   bell, such as a repeat form, a form attached to an open call lead, an email follow-up's draft or a bell written
 *   before that mark existed, is a fresh inquiry); a person's
 *   text or call, or a Gmail send, or a visit
 *   booked, reached the lead's customer or phone after that bell's inquiry began (for the intake bell:
 *   the earlier of the bell and the lead's first_contact_at, else created_at; for a later bell: the bell itself; a bell that
 *   names an email, metadata.emailId, counts from that message's received_at; the push deadline stays on the bell);
 *   a person's email to the lead's own address since the same moment (one the shared linkage ties to this lead's customer,
 *   or to nobody while no other customer holds the address); or an estimate was sent (sent_at, as the new-lead
 *   class of admin-alert-relevance.js reads it: the one the bell names, the lead's own, or any to its customer) or handed
 *   off to the customer. A lead needs a customer, a 10-digit
 *   phone or an email address to be judged: an email-only lead is judged on email and estimate evidence. A lead row that is
 *   missing, or a witness read that fails, is no verdict: nothing is sent.
 * - The scan, stamp, open-row recheck and push are the shared steps of lead-reminder-sweep.js, which also carries a capped
 *   scan across sweeps, so old reached bells cannot hide a due one.
 * - Sends nothing to a lead or a customer. Never throws into the sweep.
 *
 * Runs inside the alert-relevance sweep (every 10 minutes), after its closes. Read-only apart from its stamp.
 */

const db = require('../models/db');
const { etParts } = require('../utils/datetime-et');
const logger = require('./logger');
const sweep = require('./lead-reminder-sweep');
const { isOpenLeadRow } = require('./lead-statuses');

const LABEL = 'new-lead-reminder';
const PUSH_STAMP = 'newLeadRealertAt';
const PUSH_AFTER_MINUTES = 15;
const PUSH_LATE_MINUTES = 120;
const WINDOW_MS = 48 * 60 * 60 * 1000;
// A bell written within this long of the lead's creation was raised with the lead itself (the intake bell, or the call
// lead's bell minutes after the call); a later one is a fresh inquiry on a lead already on file.
const INTAKE_BELL_MS = 15 * 60 * 1000;
const OPEN_HOUR = 8;
const CLOSE_HOUR = 18;
// Monday to Saturday: a closed day is a Sunday (staffedDeadline asks `.has(date)` for each ET date).
const OFFICE = Object.freeze({
  start: '08:00',
  end: '18:00',
  closed: { has: (date) => new Date(`${date}T12:00:00Z`).getUTCDay() === 0 },
});
// A lead the shared open-lead predicate admits (lead-statuses.js: new, contacted, estimate_sent, estimate_viewed, and not
// converted) but that already has a quote: this reminder is for a lead nobody has answered, so these two are out.
const ESTIMATE_STATUSES = new Set(['estimate_sent', 'estimate_viewed']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const relevance = () => require('./admin-alert-relevance');

// Monday to Saturday, 8:00 AM up to 6:00 PM Eastern, read in America/New_York for the instant given.
function inBusinessHours(date) {
  const { hour, dayOfWeek } = etParts(date);
  return dayOfWeek !== 0 && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
}

// `minutes` of business time after `from`.
const businessDueAt = (from, minutes) => require('./callback-cards').staffedDeadline(from, OFFICE, minutes);

// The push window of a bell whose latest event is `askedAt`: due `afterMinutes` of business time after it, and stale
// (`expiresAt`) `lateMinutes` of business time after that.
function pushWindow(askedAt, afterMinutes, lateMinutes) {
  const dueAt = businessDueAt(askedAt, afterMinutes);
  return { dueAt, expiresAt: businessDueAt(dueAt, lateMinutes) };
}

// The relevance sweep's own class for the repeat-form bell (lead-webhook.js ringRepeatFormAlert): its category and
// dedupeKey prefix. lead-webhook-repeat-form.test.js pins the writer to it.
const repeatFormClass = () => relevance().CLASSES.find((c) => c.key === 'lead_repeat_form');

// The open, unpushed bell rows: the shared read (lead-reminder-sweep.js) of every new-lead bell, and of the repeat-form
// bell by its relevance class, so the two read one definition.
function kind() {
  const repeatForm = repeatFormClass();
  return { stamp: PUSH_STAMP, match: [{ categories: ['new_lead'] }, { categories: repeatForm.categories, keyPrefixes: [repeatForm.prefix] }] };
}
const candidateQuery = (since, cursor, pageSize) => sweep.__private.candidateQuery(kind(), since, cursor, pageSize);

// The rows with a push due now: { row, meta, askedAt, leadId, expiresAt, intakeTrigger }. A row that names no lead (a
// tracking-line text, or a repeat form from a customer row with no lead row) cannot be judged, so it sends nothing.
// intakeTrigger: the new-lead trigger wrote this bell (notification-triggers.js new_lead, metadata.triggerKey) for a lead
// its writer had just created, which the writer marks payload.createdLead (lead-webhook.js, call-recording-processor.js
// notifyNewCallLead, booking-preferred-time.js). Any other bell is a later inquiry: a form the webhook attached to an
// open call lead (createdLead false), or a bell written before the mark existed. inquiryOf reads it.
function dueItems(rows, now) {
  const { bellEventAt, parseMeta, refsFromRow } = relevance();
  const floor = now.getTime() - WINDOW_MS;
  const items = [];
  for (const row of rows) {
    const meta = parseMeta(row.metadata);
    const askedAt = bellEventAt(row);
    const leadId = refsFromRow(row).leadId;
    if (!leadId || !askedAt || askedAt.getTime() <= floor || meta[PUSH_STAMP]) continue;
    const { dueAt, expiresAt } = pushWindow(askedAt, PUSH_AFTER_MINUTES, PUSH_LATE_MINUTES);
    if (dueAt.getTime() > now.getTime() || expiresAt.getTime() < now.getTime()) continue;
    items.push({ row, meta, askedAt, leadId, expiresAt, intakeTrigger: meta.triggerKey === 'new_lead' && meta.payload?.createdLead === true });
  }
  return items;
}

const lastTen = (value) => String(value || '').replace(/\D/g, '').slice(-10);
// The lead's own email address as a mailbox address, or '' (the shared parser the Gmail linkage uses).
const leadEmail = (lead) => require('./email/email-customer-link').extractEmailAddresses(lead.email)[0] || '';

// When each email bell's message came in: { emailId -> Date }, one batched read. An email bell written for a follow-up on a
// lead already on file (email-actions.js) comes after classification and drafting, so staff may have replied before the
// bell; the message's own received_at is where their reply counts from.
async function emailReceivedAt(items) {
  const ids = [...new Set(items.map(({ meta }) => String(meta.emailId || '').toLowerCase()).filter((id) => UUID_RE.test(id)))];
  const rows = ids.length ? await db('emails').whereIn('id', ids).select('id', 'received_at') : [];
  return new Map(rows.filter((r) => r.received_at).map((r) => [String(r.id).toLowerCase(), new Date(r.received_at)]));
}

// When the inquiry this bell reports began, and whether it is the lead's intake bell. The intake bell is the one the
// new-lead trigger writes when it creates a lead (notification-triggers.js, metadata.triggerKey new_lead: the relevance
// sweep's own definition, its new_lead class; payload.createdLead set by the writer that made the lead), within 15
// minutes of the lead's creation. It looks back to the lead's
// first contact (an email lead's first_contact_at is the message's receipt time, before the classification that created
// the lead), and the call that made the lead counts only for it. Every other bell is a fresh inquiry about a lead already
// on file, however soon after the lead it came: a repeat form (category lead), a form attached to an open call lead, or a
// bell written straight to the bell (notifyAdmin('new_lead'): an email follow-up's draft, a duplicate submission). Its
// evidence counts only from the bell
// itself, or, for a bell that names an email (`emailAt`, the message's received_at), from the message. The push deadline
// stays on the bell.
function inquiryOf({ askedAt, lead, intakeTrigger = false }, emailAt = null) {
  const intake = intakeTrigger && askedAt.getTime() - new Date(lead.created_at).getTime() <= INTAKE_BELL_MS;
  const starts = [askedAt.getTime()];
  if (intake) starts.push(new Date(lead.first_contact_at || lead.created_at).getTime());
  if (emailAt) starts.push(emailAt.getTime());
  // No look-back before the start: a person's call or text just before a fresh form is not an answer to it.
  return { intake, anchor: new Date(Math.min(...starts)) };
}

// The leads that still wait on a person, each item with `lead` and `customerId`. Throws when a read fails: no verdict.
async function reachedLeads(items) {
  const leadIds = [...new Set(items.map((item) => item.leadId))];
  const leads = new Map((await db('leads').whereIn('id', leadIds)
    .select('id', 'customer_id', 'phone', 'first_name', 'last_name', 'status', 'deleted_at', 'created_at', 'first_contact_at', 'converted_at', 'twilio_call_sid', 'estimate_id', 'email'))
    .map((lead) => [String(lead.id).toLowerCase(), lead]));
  const received = await emailReceivedAt(items);
  // A lead is judged when it is open and unconverted (the shared predicate: spam, cancelled, won, lost and the rest are out),
  // has no quote yet, and has a customer, a phone or an email address (an email-only lead has the address alone).
  const open = items
    .map((item) => ({ ...item, lead: leads.get(item.leadId) }))
    .filter(({ lead }) => lead && !lead.deleted_at && isOpenLeadRow(lead) && !ESTIMATE_STATUSES.has(String(lead.status))
      && (lead.customer_id || lastTen(lead.phone).length === 10 || leadEmail(lead)))
    .map((item) => ({ ...item, ...inquiryOf(item, received.get(String(item.meta.emailId || '').toLowerCase())) }));
  if (!open.length) return [];
  // The call that made the lead, when a person answered it: its bell is written after that call, so the witnesses below
  // (judged after the lead came in) cannot see it. It says nothing about a later bell on the same lead.
  const sids = open.filter((item) => item.intake).map(({ lead }) => lead.twilio_call_sid).filter(Boolean);
  const answered = new Set((sids.length
    ? await db('call_log').whereIn('twilio_call_sid', sids).where({ direction: 'inbound', status: 'completed', answered_by: 'human' }).select('twilio_call_sid')
    : []).map((call) => call.twilio_call_sid));
  const waiting = open.filter((item) => !(item.intake && answered.has(item.lead.twilio_call_sid)));
  if (!waiting.length) return [];
  const { loadContactBundles } = require('./admin-alert-contact-witnesses');
  const { reached, estimateHandedOff } = require('./lead-call-reminder').__private;
  // Kind 'customer', as lead-call-reminder does: it also reads a person's Gmail send to the customer's own address.
  const bundles = await loadContactBundles(
    waiting.map((item) => ({ id: item.row.id, kind: 'customer', bellAt: item.anchor, refs: { customerId: item.lead.customer_id || null, phone: item.lead.phone || null } })),
    { conn: db, bookedVisits: (ids) => relevance().bookedVisitsByCustomer(db, ids) },
  );
  const sent = await estimatesSent(waiting);
  const emailed = await personEmailed(waiting);
  const still = [];
  for (const item of waiting) {
    // The witnesses return no bundle for a lead with no customer and no phone of its own (an email-only lead): its text,
    // call and visit evidence is empty, and the email and estimate checks below judge it.
    const bundle = bundles.get(String(item.row.id)) || { anchor: item.anchor, textAt: null, backAt: null, inAt: null, replyAt: null, visitAt: null };
    const customerId = item.lead.customer_id || null;
    if (reached(bundle) || sent(item, bundle.anchor) || emailed(item, bundle.anchor)) continue;
    if (customerId && await estimateHandedOff(customerId, bundle.anchor)) continue;
    still.push({ ...item, customerId });
  }
  return still;
}

// An email a person sent to the lead's own address since the item's anchor (a Gmail SENT row): the witnesses read only a
// customer's address, and a lead that came in by email may have no customer yet. A send counts only when it is this
// lead's, by the witnesses' own linkage (resolveEmailCustomerLink): linked to the lead's customer, or linked to nobody
// while no other customer holds the address. A send linked to another customer, or one to a mailbox another customer
// shares, says nothing about this lead. The read starts at the earliest anchor of these items, so a reply inside an old
// lead's own window is never cut off. Returns the test for one item.
async function personEmailed(items) {
  const { personSentFilter, extractEmailAddresses, resolveEmailCustomerLink } = require('./email/email-customer-link');
  const addresses = [...new Set(items.map(({ lead }) => leadEmail(lead)).filter(Boolean))];
  if (!addresses.length) return () => false;
  const earliest = new Date(Math.min(...items.map((item) => item.anchor.getTime())));
  const rows = await db('emails as er').whereRaw(personSentFilter('er'))
    .where('er.received_at', '>', earliest)
    .whereRaw("EXISTS (SELECT 1 FROM unnest(?::text[]) AS a(addr) WHERE strpos(LOWER(CONCAT_WS(',', er.to_address, er.cc_address, er.bcc_address)), a.addr) > 0)", [addresses])
    .select('er.id', 'er.gmail_thread_id', 'er.to_address', 'er.cc_address', 'er.bcc_address', 'er.received_at');
  // The customers holding each address, read the way the linkage matches a customer's email.
  const holders = new Map();
  const customers = await db('customers').whereNull('deleted_at').whereIn(db.raw('LOWER(TRIM(email))'), addresses).select('id', 'email');
  for (const customer of customers) {
    for (const address of extractEmailAddresses(customer.email)) holders.set(address, new Set([...(holders.get(address) || []), String(customer.id)]));
  }
  const sent = [];
  for (const r of rows) {
    sent.push({
      at: new Date(r.received_at).getTime(),
      to: new Set(extractEmailAddresses([r.to_address, r.cc_address, r.bcc_address].filter(Boolean).join(','))),
      linked: await resolveEmailCustomerLink(db, r),
    });
  }
  return ({ lead }, anchor) => {
    const address = leadEmail(lead);
    if (!address) return false;
    const own = lead.customer_id ? String(lead.customer_id) : null;
    const shared = [...(holders.get(address) || [])].some((id) => id !== own);
    return sent.some((m) => m.at > anchor.getTime() && m.to.has(address) && (m.linked ? String(m.linked) === own : !shared));
  };
}

// A quote sent to the lead since `anchor`, the way the new-lead class of admin-alert-relevance.js (newLeadMovedOn) reads
// it: the estimate the bell names (an email lead's draft bell carries metadata.estimateId, and the lead may since point
// at another draft), the lead's own estimate, or any estimate to its customer, with a sent_at. Returns the test for one
// item.
async function estimatesSent(items) {
  const { refsFromRow } = relevance();
  const named = ({ row, lead }) => [refsFromRow(row).estimateId, lead.estimate_id].filter(Boolean).map((id) => String(id).toLowerCase());
  const customerIds = [...new Set(items.map(({ lead }) => lead.customer_id).filter(Boolean).map(String))];
  const estimateIds = [...new Set(items.flatMap(named))];
  const rows = customerIds.length || estimateIds.length
    ? await db('estimates').whereNotNull('sent_at').where((q) => {
      if (customerIds.length) q.whereIn('customer_id', customerIds);
      if (estimateIds.length) q.orWhereIn('id', estimateIds);
    }).select('id', 'customer_id', 'sent_at')
    : [];
  return (item, anchor) => {
    const { lead } = item;
    const ids = new Set(named(item));
    return rows.some((e) => new Date(e.sent_at).getTime() > anchor.getTime()
      && ((lead.customer_id && String(e.customer_id) === String(lead.customer_id)) || ids.has(String(e.id).toLowerCase())));
  };
}

/**
 * One pass. Returns { skipped, reason } or { skipped: false, due, pushed, sends }; `sends` are the push sends, never
 * awaited here (tests await them). Throws only when a page cannot be read; the sweep catches it.
 */
async function runNewLeadReminder({ now = new Date(), pageSize, clock } = {}) {
  if (!inBusinessHours(now)) return { skipped: true, reason: 'quiet_hours' };
  const out = await sweep.runSweep({ ...kind(), label: LABEL, windowMs: WINDOW_MS, dueItems, waiting: reachedLeads, inHours: inBusinessHours }, { now, pageSize, clock });
  if (out.sent) logger.info(`[${LABEL}] queued ${out.sent} push(es): a new lead nobody has reached`);
  return { skipped: false, due: out.due, pushed: out.sent, sends: out.sends };
}

module.exports = {
  runNewLeadReminder,
  PUSH_STAMP,
  __private: { inBusinessHours, businessDueAt, pushWindow, kind, dueItems, reachedLeads, inquiryOf, emailReceivedAt, candidateQuery, ESTIMATE_STATUSES },
};

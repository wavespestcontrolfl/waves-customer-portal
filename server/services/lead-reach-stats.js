/**
 * Honest speed-to-lead for the Leads page (owner 2026-11-19, "do phase 1 first").
 *
 * leads.response_time_minutes is stamped only when someone RECORDS a response, so a
 * lead nobody ever contacted has no value and drops out of the median. The median
 * therefore reads fast while some leads were never answered at all. This module
 * answers the two questions the median cannot, for the same cohort of leads:
 *   - reachedWithin: how many were reached by a person within 15 minutes of
 *     first_contact_at;
 *   - neverReached: how many have no person contact on record at all.
 *
 * "Reached" is the FIRST PERSON CONTACT, judged with the repo's existing definitions
 * (staff-contact.js, the same ones lead-contact-sync.js and the admin-alert witnesses
 * read) and never an automated message:
 *   - a text a person typed and that was delivered (operatorReplySql + smsDeliveredSql);
 *   - a call a person spoke on: an outbound call the lead answered (personCallBackSql),
 *     or an inbound call a person answered (answered_by = 'human'). The call that
 *     created the lead counts when a person answered it (matched by twilio_call_sid),
 *     because that is the lead's first contact; any other call must come after
 *     first_contact_at. A call with no trustworthy end (callEndedAtSql) counts for nothing. The
 *     time a call reached a person is when the staff phone accepted an inbound call
 *     (forward_acceptance.accepted_at) or the customer's leg connected on an outbound bridge call
 *     (customer_leg ended_at minus duration_seconds); with neither it is somewhere between the
 *     call's start and its end (callTiming);
 *   - an email a person sent (a Gmail SENT row, personSentFilter) to the lead's address, leaving out
 *     the SEO link outreach job's sends (its stored Gmail thread ref, seo_link_prospects);
 *   - an estimate a person sent: the lead's estimate (leads.estimate_id, or the public-quote mirror
 *     estimate_data.lead_id under the ownership checks) at its FIRST REAL delivery,
 *     estimate_data.deliveryState.firstDeliveredAt. That stamp is written only when a channel really
 *     delivered, so a suppressed send, a website self-service publication (sent_at with nothing
 *     delivered) and a later resend cannot move it. The app has no per-delivery "who sent it"
 *     record (deliveryState keeps timestamps only, manualSendAttempts exists only when the client
 *     sent a key), so provenance is per estimate: one the app's automation delivered first
 *     (automation.autoSend or .moveAutoSend result 'sent') is not a person and does not count. If
 *     it was then delivered again beyond the deliveries the automation records prove, that delivery
 *     may have been a person's. The lead's 'estimate_sent' activity row is not used: it is written even
 *     when every channel was suppressed.
 * Uncertainty is judged in one place, bucketReach: a lead is NOT JUDGED (left out of every count)
 * only when an uncertain item (a call with no known answer time, a possible person's resend) could
 * move it to a different bucket. One that cannot (all after the window, or after a proven contact
 * inside it) leaves the lead judged.
 * The call agent's own verdict (lead-contact-sync's third call clause) is NOT a person
 * and does not count here.
 *
 * Whose contact it is, the same rules as lead-contact-sync.js (contactSkipReason): phone and email
 * evidence counts for a lead only when the contact row is not another customer's and no other open
 * lead (or other lead in this figure) shares that phone or email. A sent email's customer comes from
 * its Gmail thread and its recipients (emailOwners). The originating call is the one exception: it is
 * matched by its twilio_call_sid, whatever callback number the lead gave. A call has one owner,
 * resolved once (indexEvidence): the processor's settled stamp (metadata.lead_id), then a cohort
 * lead's originating sid, then the phone it was on; it credits that lead alone.
 * Read-only: five batched queries for the whole cohort (a sent email adds two set queries for its
 * owner), never one per lead.
 */

const db = require('../models/db');
const { phoneIdentitySql } = require('./sms-response-policy');
const { operatorReplySql, smsDeliveredSql, personCallBackSql } = require('./staff-contact');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { callEndedAtSql, callStartedAtSql } = require('./sms-pending-conversations');
const { personSentFilter, capturedRecipients } = require('./email/email-customer-link');
const { openLeadIdentities, contactSkipReason, usablePhoneKey, leadEmail } = require('./lead-contact-sync');
const { leadMatchesEstimateContact } = require('./lead-estimate-link');
const { NON_ENGAGED_LEAD_STATUSES } = require('./lead-statuses');

const REACH_WITHIN_MINUTES = 15;
const MINUTE_MS = 60 * 1000;
// Spam, cancelled, duplicate and handled are not prospects (lead-statuses.js); a
// disqualified lead is not one either (owner 2026-11-19). Deleted leads never reach here.
const EXCLUDED_STATUSES = new Set([...NON_ENGAGED_LEAD_STATUSES, 'disqualified']);

const asMs = (value) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const uniq = (list) => [...new Set(list.filter(Boolean))];
const idOrNull = (id) => (id == null ? null : String(id));

// The leads this figure counts: engaged prospects with a first-contact time.
function reachCohort(leads) {
  return (leads || []).filter((lead) => lead && !EXCLUDED_STATUSES.has(lead.status) && asMs(lead.first_contact_at) != null);
}

// ---- Witness reads: one query per kind for the whole cohort ----------------

async function personTexts(conn, peers, since) {
  if (!peers.length) return [];
  const peer = phoneIdentitySql('os.to_phone');
  const rows = await excludeUnresolvedSendReservations(conn('sms_log as os').where('os.direction', 'outbound'), 'os')
    .whereRaw(operatorReplySql('os'))
    .whereRaw(smsDeliveredSql('os'))
    .where('os.created_at', '>', since)
    .whereRaw(`${peer} = ANY(?)`, [peers])
    .select('os.created_at as at', 'os.customer_id', conn.raw(`${peer} as peer`));
  return rows.map((row) => ({ key: `phone:${row.peer}`, scope: 'phone', customerId: idOrNull(row.customer_id), at: asMs(row.at) }));
}

// Calls a person spoke on, on a lead phone OR the lead's own originating call sid.
// A call the processor stamped (metadata.lead_id) and settled belongs to THAT lead: the stamp wins over
// the sid and the phone, as the lead detail route's settled-stamp rule does (admin-leads.js, the
// settledDissentingStamp / settledLeadStamp arms; the same precedence as google-call-bridge's
// whereCallStillLinked). Settled = no pass in flight (processing_token IS NULL) and a legacy NULL or
// 'processed' status. Those closures are per-lead SQL on the route, so the batch reads the stamp and
// the settled flag and applies the same precedence in judgeReach.
const SETTLED_CALL_SQL = "(cl.processing_token IS NULL AND (cl.processing_status IS NULL OR cl.processing_status = 'processed'))";
// Outbound staff-bridge calls: the row is created when the bridge rings the employee, before the
// customer's leg exists, so its start is not the time the customer was reached. The bridge records the
// customer leg only on some calls (metadata.customer_leg = { status, duration_seconds, ended_at },
// twilio-voice-webhook.js /outbound-dial-complete): when it is there the customer connected at
// ended_at minus duration_seconds. When it is not, the only bound is the call's own end (callEndedAtSql,
// start plus duration): see crossesWindow in reachTimes.
async function personCalls(conn, peers, sids, leadIds, since) {
  if (!peers.length && !sids.length && !leadIds.length) return [];
  const started = callStartedAtSql('cl');
  const peerSql = `(CASE WHEN cl.direction = 'inbound' THEN ${phoneIdentitySql('cl.from_phone')} ELSE ${phoneIdentitySql('cl.to_phone')} END)`;
  const rows = await whereNotSandboxCall(conn('call_log as cl'), 'cl.source')
    .where('cl.status', 'completed')
    .whereIn('cl.direction', ['inbound', 'outbound'])
    .whereRaw(`${callEndedAtSql('cl')} IS NOT NULL`)
    .where((spoke) => spoke
      .where((placed) => placed.where('cl.direction', 'outbound').whereRaw(personCallBackSql('cl')))
      .orWhere((answered) => answered.where('cl.direction', 'inbound').where('cl.answered_by', 'human')))
    .where((mine) => mine
      .where((onPhone) => onPhone.whereRaw(`${started} > ?`, [since]).whereRaw(`${peerSql} = ANY(?)`, [peers]))
      .orWhereIn('cl.twilio_call_sid', sids)
      // A later call the processor settled onto one of these leads carries another sid and may carry
      // another phone.
      .orWhere((stamped) => stamped.whereRaw("cl.metadata->>'lead_id' = ANY(?)", [leadIds]).whereRaw(SETTLED_CALL_SQL)))
    .select('cl.twilio_call_sid as sid', 'cl.customer_id', conn.raw(`${started} as at`), conn.raw(`${peerSql} as peer`),
      conn.raw("cl.metadata->>'lead_id' as stamp_lead_id"), conn.raw(`${SETTLED_CALL_SQL} as settled`),
      'cl.direction', conn.raw(`${callEndedAtSql('cl')} as ended_at`),
      conn.raw("cl.metadata->'forward_acceptance'->>'accepted' as accepted"),
      conn.raw("cl.metadata->'forward_acceptance'->>'accepted_at' as accepted_at"),
      conn.raw("cl.metadata->'customer_leg'->>'ended_at' as leg_ended_at"),
      conn.raw("cl.metadata->'customer_leg'->>'duration_seconds' as leg_seconds"));
  return rows.map((row) => ({
    key: `phone:${row.peer}`, scope: 'phone', customerId: idOrNull(row.customer_id), sid: row.sid ? String(row.sid) : null,
    ...callTiming(row),
    stampedTo: row.settled && row.stamp_lead_id ? String(row.stamp_lead_id) : null,
  }));
}

// When a call reached a person: { at, spanEnd }. `at` is the earliest the contact could have happened;
// `spanEnd` is the latest (the call's own end), or null when `at` is exact.
//  - Outbound bridge call with a customer leg: exact, when that leg connected.
//  - Inbound call with forward_acceptance: exact, when the staff phone accepted it
//    (metadata.forward_acceptance.accepted_at, written by /inbound-forward-accept).
//  - Anything else: somewhere between the call's start and its end.
function callTiming(row) {
  const start = asMs(row.at);
  const end = asMs(row.ended_at);
  const span = { at: start, spanEnd: end != null && end > start ? end : null };
  if (row.direction === 'outbound') {
    const legEnd = row.leg_ended_at ? Date.parse(row.leg_ended_at) : NaN;
    const legSeconds = row.leg_seconds == null || row.leg_seconds === '' ? NaN : Number(row.leg_seconds);
    return Number.isFinite(legEnd) && Number.isFinite(legSeconds) && legSeconds >= 0 ? { at: legEnd - legSeconds * 1000, spanEnd: null } : span;
  }
  const acceptedAt = row.accepted === 'true' || row.accepted === true ? asMs(row.accepted_at) : null;
  return acceptedAt != null ? { at: acceptedAt, spanEnd: null } : span;
}

// The lead each call sid originated, from ALL leads, not just the cohort: an older lead's phone must
// not take a call that a lead outside the date range originated from it.
async function sidOwnersOf(conn, calls) {
  const sids = uniq(calls.map((w) => w.sid));
  if (!sids.length) return new Map();
  const rows = await conn('leads').whereIn('twilio_call_sid', sids).select('id', 'twilio_call_sid');
  return new Map(rows.filter((r) => r.twilio_call_sid).map((r) => [String(r.twilio_call_sid), String(r.id)]));
}

// Who a batch of Gmail SENT rows belongs to, Map(row id -> customer id, AMBIGUOUS, or null). Email
// sync leaves customer_id empty on mail sent from the office, so the owner comes from the same two
// linkages as email-customer-link.js resolveEmailCustomerLink, read for the whole batch in two set
// queries: (a) customers linked to inbound rows of the send's Gmail thread, (b) active customers whose
// own email is a recipient. More than one distinct customer is ambiguous, never a guess. This is the
// resolver's linkage without its thread-reach refinement (threadSendReachesCustomer), so it can only
// skip more sends than the resolver would, never credit one the resolver would refuse.
const AMBIGUOUS_CUSTOMER = 'ambiguous-customer';
async function emailOwners(conn, rows) {
  const threads = uniq(rows.map((row) => row.gmail_thread_id));
  const recipients = uniq(rows.flatMap((row) => capturedRecipients(row) || []));
  const [threadRows, customerRows] = await Promise.all([
    threads.length
      ? conn('emails').whereIn('gmail_thread_id', threads).whereNotNull('customer_id').select('id', 'gmail_thread_id', 'customer_id')
      : [],
    recipients.length
      ? conn('customers').whereNull('deleted_at').whereNotNull('email')
        .whereIn(conn.raw('LOWER(TRIM(email))'), recipients).select('id', conn.raw('LOWER(TRIM(email)) as address'))
      : [],
  ]);
  const owners = new Map();
  for (const row of rows) {
    const found = new Set();
    if (row.customer_id != null) found.add(String(row.customer_id));
    for (const t of threadRows) {
      if (row.gmail_thread_id && String(t.gmail_thread_id) === String(row.gmail_thread_id) && String(t.id) !== String(row.id)) found.add(String(t.customer_id));
    }
    const mine = new Set(capturedRecipients(row) || []);
    for (const c of customerRows) if (mine.has(c.address)) found.add(String(c.id));
    owners.set(String(row.id), found.size > 1 ? AMBIGUOUS_CUSTOMER : ([...found][0] ?? null));
  }
  return owners;
}

// Gmail SENT rows whose To/Cc/Bcc text carries one of the lead addresses. The text match is a
// prefilter; the parsed address list decides.
async function personEmails(conn, addresses, since) {
  if (!addresses.length) return [];
  const recipientText = "LOWER(CONCAT_WS(',', er.to_address, er.cc_address, er.bcc_address))";
  const rows = await conn('emails as er')
    .whereRaw(personSentFilter('er'))
    // The SEO link outreach job sends through the same Gmail account. It stores the Gmail thread (or
    // message) id of every pitch it sends in seo_link_prospects.outreach_thread_ref, and its follow-up
    // joins that thread: a send in one of those threads is automated outreach, not staff contact.
    .whereRaw('NOT EXISTS (SELECT 1 FROM seo_link_prospects slp WHERE slp.outreach_thread_ref IN (er.gmail_thread_id, er.gmail_id))')
    .where('er.received_at', '>', since)
    .whereRaw(`EXISTS (SELECT 1 FROM unnest(?::text[]) AS a(addr) WHERE strpos(${recipientText}, a.addr) > 0)`, [addresses])
    .select('er.id', 'er.gmail_thread_id', 'er.to_address', 'er.cc_address', 'er.bcc_address', 'er.customer_id', 'er.received_at as at');
  if (!rows.length) return [];
  // A row whose recipients are not all known (Cc/Bcc never captured) names no one: another customer may
  // have been copied, so it is no evidence (the resolver's own guard, capturedRecipients).
  const known = rows.filter((row) => capturedRecipients(row));
  const owners = await emailOwners(conn, known);
  const wanted = new Set(addresses);
  return known.flatMap((row) => capturedRecipients(row)
    .filter((addr) => wanted.has(addr))
    .map((addr) => ({ key: `email:${addr}`, scope: 'email', customerId: owners.get(String(row.id)), at: asMs(row.at) })));
}

// An estimate for the lead, at its first REAL delivery (deliveryState.firstDeliveredAt, stamped only for
// a real handoff and carried across resends; the stamp is read as text and parsed in JS, so a malformed
// value cannot abort the batch). The lead is reached two ways, as resolveEstimateEventLeads has it:
// the FK (leads.estimate_id, authoritative), or, only when no lead is FK-linked to the estimate, the
// public-quote mirror estimate_data.lead_id, accepted under the same ownership checks (the lead is not
// linked to another estimate and its contact matches the estimate's: leadMatchesEstimateContact).
// `automated` marks an estimate the app's own automation delivered first; `deliveries` counts every
// recorded real delivery and `autoDeliveries` the ones the automation's own records prove. No
// per-delivery record names who sent it, so judgeReach treats only the deliveries beyond the proven
// automated ones as possibly a person's: not judged, never "never reached".
const FIRST_DELIVERED_SQL = "e.estimate_data #>> '{deliveryState,firstDeliveredAt}'";
const AUTOMATED_SQL = "(COALESCE(e.estimate_data->'automation'->'autoSend'->>'result', '') = 'sent' OR COALESCE(e.estimate_data->'automation'->'moveAutoSend'->>'result', '') = 'sent')";
// Real deliveries the automation's own records prove: the lead auto-send's send, the moving job's
// overnight email, and its recorded morning text (a second delivery of the same estimate).
const AUTO_DELIVERIES_SQL = `(CASE WHEN COALESCE(e.estimate_data->'automation'->'autoSend'->>'result', '') = 'sent' THEN 1 ELSE 0 END
  + CASE WHEN COALESCE(e.estimate_data->'automation'->'moveAutoSend'->>'result', '') = 'sent' THEN 1 ELSE 0 END
  + CASE WHEN COALESCE(e.estimate_data->'automation'->'moveAutoSend'->>'textResult', '') = 'sent' THEN 1 ELSE 0 END)`;
const DELIVERIES_SQL = "(CASE WHEN jsonb_typeof(e.estimate_data #> '{deliveryState,deliveredAt}') = 'array' THEN jsonb_array_length(e.estimate_data #> '{deliveryState,deliveredAt}') ELSE 0 END)";
async function estimateSends(conn, cohort) {
  if (!cohort.length) return [];
  const leadIds = cohort.map((lead) => String(lead.id));
  const byId = new Map(cohort.map((lead) => [String(lead.id), lead]));
  const rows = await conn('estimates as e').leftJoin('leads as l', 'l.estimate_id', 'e.id')
    .whereRaw(`${FIRST_DELIVERED_SQL} IS NOT NULL`)
    .where((mine) => mine
      .whereRaw('l.id::text = ANY(?)', [leadIds])
      .orWhereRaw("e.estimate_data->>'lead_id' = ANY(?)", [leadIds]))
    .select('e.id', 'e.customer_id', 'e.customer_phone', 'e.customer_email', 'l.id as linked_lead_id',
      conn.raw("e.estimate_data->>'lead_id' as data_lead_id"), conn.raw(`${FIRST_DELIVERED_SQL} as at`),
      conn.raw("e.estimate_data #> '{deliveryState,deliveredAt}' as delivered_at"),
      conn.raw(`${AUTOMATED_SQL} as automated`), conn.raw(`${AUTO_DELIVERIES_SQL} as auto_deliveries`), conn.raw(`${DELIVERIES_SQL} as deliveries`));
  return rows.flatMap((row) => {
    let leadId = null;
    if (row.linked_lead_id) leadId = String(row.linked_lead_id);
    else if (row.data_lead_id) {
      const named = byId.get(String(row.data_lead_id));
      // The named lead must not belong to another estimate, and must match this estimate's contact.
      if (named && !named.estimate_id && leadMatchesEstimateContact(named, row)) leadId = String(named.id);
    }
    if (!leadId || !byId.has(leadId)) return [];
    // The second real delivery in time: with the first automated, it is the earliest a person could have sent one.
    const times = (Array.isArray(row.delivered_at) ? row.delivered_at : []).map(asMs).filter((t) => t != null).sort((a, b) => a - b);
    return [{
      leadId, at: asMs(row.at), automated: !!row.automated, deliveries: Number(row.deliveries) || 0, autoDeliveries: Number(row.auto_deliveries) || 0,
      resendAt: times[1] ?? null,
    }];
  });
}

// Open leads sharing a phone or email with the cohort, plus the cohort itself (a won or lost lead is
// not open but is still a lead the contact could belong to), as Map(key -> Set(lead ids)).
async function identityOwners(conn, cohort, peers, addresses) {
  const owners = await openLeadIdentities(conn, { peers, emails: addresses, customerIds: [] });
  for (const lead of cohort) {
    for (const key of [`phone:${usablePhoneKey(lead.phone)}`, `email:${leadEmail(lead.email)}`]) {
      owners.set(key, (owners.get(key) || new Set()).add(String(lead.id)));
    }
  }
  return owners;
}

// ---- Judging (pure) --------------------------------------------------------

const NOT_JUDGED = 'not_judged';

// Witnesses indexed once for the whole cohort. Each call is owned once, in this priority: the
// processor's settled stamp (metadata.lead_id), then the lead that originated its sid (read from ALL
// leads, `sidOwners`), then (left unowned) the phone it was on. An owned call credits that lead alone,
// whatever its phone says, and no cohort lead takes it when its owner is outside the cohort; an unowned
// witness is matched by identity key.
function indexEvidence(evidence, sidOwners) {
  const index = { byKey: new Map(), owned: new Map(), estimates: new Map() };
  const push = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);
  for (const w of [...evidence.texts, ...evidence.calls, ...evidence.emails]) {
    if (w.at == null) continue;
    const ownerId = w.stampedTo || (w.sid && sidOwners.get(w.sid)) || null;
    if (ownerId) push(index.owned, ownerId, w);
    else push(index.byKey, w.key, w);
  }
  for (const e of evidence.estimates) push(index.estimates, e.leadId, e);
  return index;
}

// ---- The bucket of one lead (the only place uncertainty is judged) --------------------------------

/**
 * Items are possible person contacts: { earliest, latest }. `latest` is when the contact had certainly
 * happened by (null when it may never have happened at all); `earliest` is the soonest it could have.
 * A text has earliest = latest; a call whose answer time is unknown spans its start to its end; an
 * estimate resent after an automated delivery may or may not have been a person's, so latest is null.
 * Returns minutes to the first certain contact (0 when it came first), null when there is none, or
 * NOT_JUDGED when an uncertain item could move the lead to a different bucket (within / later /
 * never): it could land inside the window while the certain contact is outside it, or, with no certain
 * contact, it could turn never into reached at all. An uncertain item that cannot change the bucket
 * (every one of them is after the window, or after a proven contact inside it) leaves the lead judged.
 */
function bucketReach(items, firstAt) {
  const cutoff = firstAt + REACH_WITHIN_MINUTES * MINUTE_MS;
  const certain = items.filter((i) => i.latest != null).map((i) => i.latest);
  const best = certain.length ? Math.min(...certain) : null;
  const minutes = best == null ? null : Math.max(0, (best - firstAt) / MINUTE_MS);
  if (best != null && best <= cutoff) return minutes;
  const uncertain = items.filter((i) => i.latest == null || i.earliest < i.latest);
  const couldChange = best == null ? uncertain.length > 0 : uncertain.some((i) => i.earliest <= cutoff);
  return couldChange ? NOT_JUDGED : minutes;
}

// Every possible person contact of one lead, as bucketReach items.
function reachItems(lead, index, owners) {
  const id = String(lead.id);
  const firstAt = asMs(lead.first_contact_at);
  const sid = lead.twilio_call_sid ? String(lead.twilio_call_sid) : null;
  const customerId = idOrNull(lead.customer_id);
  const keys = [`phone:${usablePhoneKey(lead.phone)}`, `email:${leadEmail(lead.email)}`];
  // Contact on the lead's phone or email must come after first_contact_at, and must be this lead's:
  // not another customer's, not an identity another lead shares.
  const byIdentity = keys.flatMap((key) => index.byKey.get(key) || [])
    .filter((w) => w.at > firstAt && !contactSkipReason(w, customerId, owners));
  // A call owned by this lead counts after first contact; the originating call is its first contact
  // even though it came before first_contact_at.
  const owned = (index.owned.get(id) || []).filter((w) => w.at > firstAt || (sid && w.sid === sid));
  const items = [...byIdentity, ...owned].map((w) => ({ earliest: w.at, latest: w.spanEnd ?? w.at }));
  for (const e of index.estimates.get(id) || []) {
    // A first delivery nothing automated is a person's. After an automated first delivery, deliveries
    // beyond the ones the automation's records prove may be a person's; the earliest such one is the
    // second delivery in time.
    if (!e.automated && e.at != null && e.at >= firstAt) items.push({ earliest: e.at, latest: e.at });
    if (e.automated && e.deliveries > (e.autoDeliveries || 0)) items.push({ earliest: Math.max(firstAt, e.resendAt ?? e.at ?? firstAt), latest: null });
  }
  return items;
}

/**
 * @param {Array} cohort leads from reachCohort
 * @param {{texts, calls, emails, estimates, owners}} evidence witness rows from the loaders above;
 *   owners is Map(identity key -> Set(lead ids sharing it)), empty when nothing is shared.
 * @param {Map<string, string>} sidOwners call sid -> id of the lead that originated it (all leads)
 * @returns {Map<string, number|null|string>} lead id -> bucketReach result
 */
function judgeReach(cohort, evidence, sidOwners = new Map(cohort.filter((l) => l.twilio_call_sid).map((l) => [String(l.twilio_call_sid), String(l.id)]))) {
  const owners = evidence.owners || new Map();
  const index = indexEvidence(evidence, sidOwners);
  return new Map(cohort.map((lead) => [String(lead.id), bucketReach(reachItems(lead, index, owners), asMs(lead.first_contact_at))]));
}

/**
 * Count a cohort: how many were reached within the window, and how many never were.
 * `leads` are rows with id, status, phone, email, customer_id, estimate_id, first_contact_at,
 * twilio_call_sid. Returns { cohort, reachedWithin, reachedLater, neverReached, notJudged,
 * withinMinutes }; cohort leaves out the notJudged leads, so they are in no other count.
 */
async function loadLeadReachStats(leads, { conn = db } = {}) {
  const cohort = reachCohort(leads);
  const stats = { cohort: cohort.length, reachedWithin: 0, reachedLater: 0, neverReached: 0, notJudged: 0, withinMinutes: REACH_WITHIN_MINUTES };
  if (!cohort.length) return stats;

  const since = new Date(Math.min(...cohort.map((l) => asMs(l.first_contact_at))));
  const peers = uniq(cohort.map((l) => usablePhoneKey(l.phone)));
  const addresses = uniq(cohort.map((l) => leadEmail(l.email)));
  const sids = uniq(cohort.map((l) => (l.twilio_call_sid ? String(l.twilio_call_sid) : null)));
  const [texts, calls, emails, estimates, owners] = await Promise.all([
    personTexts(conn, peers, since),
    personCalls(conn, peers, sids, cohort.map((l) => String(l.id)), since),
    personEmails(conn, addresses, since),
    estimateSends(conn, cohort),
    identityOwners(conn, cohort, peers, addresses),
  ]);

  const sidOwners = await sidOwnersOf(conn, calls);
  for (const minutes of judgeReach(cohort, { texts, calls, emails, estimates, owners }, sidOwners).values()) {
    if (minutes === NOT_JUDGED) { stats.notJudged += 1; stats.cohort -= 1; }
    else if (minutes == null) stats.neverReached += 1;
    else if (minutes <= REACH_WITHIN_MINUTES) stats.reachedWithin += 1;
    else stats.reachedLater += 1;
  }
  return stats;
}

module.exports = { loadLeadReachStats, judgeReach, reachCohort, REACH_WITHIN_MINUTES, NOT_JUDGED, _test: { usablePhoneKey, leadEmail, bucketReach } };

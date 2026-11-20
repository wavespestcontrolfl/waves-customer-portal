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
 *     because that is the lead's first contact; any other call must reach a person after
 *     first_contact_at (one with no known answer time that rang before it and ended after it may
 *     have, so bucketReach judges it). A call with no trustworthy end (callEndedAtSql) counts for nothing. The
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
 *     delivered) and a later resend cannot move it. deliveryState keeps timestamps only, so
 *     provenance is per estimate: one the app's automation delivered first (automation.autoSend or
 *     .moveAutoSend result 'sent') is not a person and does not count; a delivery beyond the ones the
 *     automation's records prove may have been a person's. A group send records its automation on
 *     the one estimate it sent but publishes every sibling, so a sibling's deliveries may be that
 *     send's or a person's: possible, never certain. A staff send's receipt (manualSendAttempts,
 *     written only for a send a person started) that really handed off is a person's contact between
 *     its start and its completion. An estimate created before the stamp existed
 *     (FIRST_DELIVERY_STAMP_SINCE) may have been delivered with no stamp: possible from first contact
 *     on. The lead's 'estimate_sent' activity row is not used: it is written even when every channel
 *     was suppressed.
 * Uncertainty is judged in one place, bucketReach: a lead is NOT JUDGED (left out of every count)
 * only when an uncertain item (a call with no known answer time, a possible person's resend) could
 * move it to a different bucket. One that cannot (all after the window, or after a proven contact
 * inside it) leaves the lead judged.
 * The call agent's own verdict (lead-contact-sync's third call clause) is NOT a person
 * and does not count here.
 *
 * Whose contact it is: phone and email evidence counts for a lead only when the contact row is not
 * another customer's and no OTHER open lead shares that phone or email (lead-contact-sync.js
 * contactSkipReason, with the lead itself one of the sharers whatever its status), and no prospect
 * lead that first contacted us on that phone or email after this lead did, and before the contact,
 * takes it (a contact goes to the newest lead). Both read ALL leads, never the report's date range, so
 * a lead's bucket does not depend on the range it is shown in. A sent email's customer is the one
 * email-customer-link.js emailCustomerLink settles, read for the batch (emailOwners); a send it cannot
 * settle is no evidence. The originating call is the one exception: it is
 * matched by its twilio_call_sid, whatever callback number the lead gave. A call has one owner,
 * resolved once (indexEvidence): the processor's settled stamp (metadata.lead_id), then a cohort
 * lead's originating sid, then the phone it was on; it credits that lead alone.
 * Read-only: one batched query per kind of evidence and per owner rule for the whole cohort (a sent
 * email adds three set queries for its owner), never one per lead.
 */

const db = require('../models/db');
const { phoneIdentitySql } = require('./sms-response-policy');
const { operatorReplySql, smsDeliveredSql, personCallBackSql } = require('./staff-contact');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { callEndedAtSql, callStartedAtSql } = require('./sms-pending-conversations');
const { personSentFilter, capturedRecipients, extractEmailAddresses } = require('./email/email-customer-link');
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
// start plus duration): see bucketReach. The phone branch reads every call that ENDED after the earliest
// first contact: one that rang before a lead's first contact can still reach a person after it.
async function personCalls(conn, peers, sids, leadIds, since) {
  if (!peers.length && !sids.length && !leadIds.length) return [];
  const started = callStartedAtSql('cl');
  const ended = callEndedAtSql('cl');
  const peerSql = `(CASE WHEN cl.direction = 'inbound' THEN ${phoneIdentitySql('cl.from_phone')} ELSE ${phoneIdentitySql('cl.to_phone')} END)`;
  const rows = await whereNotSandboxCall(conn('call_log as cl'), 'cl.source')
    .where('cl.status', 'completed')
    .whereIn('cl.direction', ['inbound', 'outbound'])
    .whereRaw(`${ended} IS NOT NULL`)
    .where((spoke) => spoke
      .where((placed) => placed.where('cl.direction', 'outbound').whereRaw(personCallBackSql('cl')))
      .orWhere((answered) => answered.where('cl.direction', 'inbound').where('cl.answered_by', 'human')))
    .where((mine) => mine
      .where((onPhone) => onPhone.whereRaw(`${ended} > ?`, [since]).whereRaw(`${peerSql} = ANY(?)`, [peers]))
      .orWhereIn('cl.twilio_call_sid', sids)
      // A later call the processor settled onto one of these leads carries another sid and may carry
      // another phone.
      .orWhere((stamped) => stamped.whereRaw("cl.metadata->>'lead_id' = ANY(?)", [leadIds]).whereRaw(SETTLED_CALL_SQL)))
    .select('cl.twilio_call_sid as sid', 'cl.customer_id', conn.raw(`${started} as at`), conn.raw(`${peerSql} as peer`),
      conn.raw("cl.metadata->>'lead_id' as stamp_lead_id"), conn.raw(`${SETTLED_CALL_SQL} as settled`),
      'cl.direction', conn.raw(`${ended} as ended_at`),
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

// Who a batch of Gmail SENT rows belongs to, Map(row id -> customer id, null, or AMBIGUOUS), by the same
// precedence as email-customer-link.js emailCustomerLink (email sync leaves customer_id empty on mail sent
// from the office), read for the whole batch in three set queries:
//  - more than one customer linked in the send's Gmail thread: unsettled;
//  - one: that customer only when the send provably reaches them (threadSendReachesCustomer: a recipient
//    is their email or an address they wrote from in the thread, and no recipient is another active
//    customer's email), else unsettled;
//  - none: the active customers whose own email is a recipient: one is that customer, none is null (the
//    send names no customer), more than one is unsettled.
// An unsettled send is AMBIGUOUS, which contactSkipReason reads as another customer's: no lead's
// evidence, never a guess. Rows reach here only with their recipients captured (capturedRecipients).
const AMBIGUOUS_CUSTOMER = 'ambiguous-customer';
async function emailOwners(conn, rows) {
  const threads = uniq(rows.map((row) => row.gmail_thread_id));
  const recipients = uniq(rows.flatMap((row) => capturedRecipients(row) || []));
  const [threadRows, recipientRows] = await Promise.all([
    threads.length
      ? conn('emails').whereIn('gmail_thread_id', threads).whereNotNull('customer_id').select('id', 'gmail_thread_id', 'customer_id', 'from_address')
      : [],
    recipients.length
      ? conn('customers').whereNull('deleted_at').whereNotNull('email')
        .whereIn(conn.raw('LOWER(TRIM(email))'), recipients).select('id', conn.raw('LOWER(TRIM(email)) as address'))
      : [],
  ]);
  // The thread customers' own emails; a deleted customer is not here, so no send reaches them.
  const threadCustomerIds = uniq(threadRows.map((t) => idOrNull(t.customer_id)));
  const emailOf = new Map((threadCustomerIds.length
    ? await conn('customers').whereIn('id', threadCustomerIds).whereNull('deleted_at').select('id', 'email')
    : []).map((c) => [String(c.id), c.email]));
  const owners = new Map();
  for (const row of rows) {
    const mine = capturedRecipients(row) || [];
    const named = uniq(recipientRows.filter((c) => mine.includes(c.address)).map((c) => String(c.id)));
    const inThread = row.gmail_thread_id ? threadRows.filter((t) => String(t.gmail_thread_id) === String(row.gmail_thread_id)) : [];
    const threadCustomers = uniq(inThread.filter((t) => String(t.id) !== String(row.id)).map((t) => String(t.customer_id)));
    let owner;
    if (threadCustomers.length > 1) owner = AMBIGUOUS_CUSTOMER;
    else if (threadCustomers.length === 1) {
      const [customer] = threadCustomers;
      const theirs = new Set([emailOf.get(customer), ...inThread.filter((t) => String(t.customer_id) === customer).map((t) => t.from_address)]
        .flatMap(extractEmailAddresses));
      const reaches = emailOf.has(customer) && mine.some((addr) => theirs.has(addr)) && named.every((id) => id === customer);
      owner = reaches ? customer : AMBIGUOUS_CUSTOMER;
    } else owner = named.length > 1 ? AMBIGUOUS_CUSTOMER : (named[0] ?? null);
    owners.set(String(row.id), owner);
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
    .select('er.id', 'er.gmail_thread_id', 'er.to_address', 'er.cc_address', 'er.bcc_address', 'er.received_at as at');
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
const automatedSql = (a) => `(COALESCE(${a}.estimate_data->'automation'->'autoSend'->>'result', '') = 'sent' OR COALESCE(${a}.estimate_data->'automation'->'moveAutoSend'->>'result', '') = 'sent')`;
const AUTOMATED_SQL = automatedSql('e');
// A group send records its automation on the one estimate it sent (lead-estimate-auto-send.js), but
// sendEstimateNow publishes and stamps the delivery of every sibling in the group. A sibling whose
// group another member's automation sent may have been delivered by that send, or by a person on its
// own (a sibling added later and sent by staff): `group_automated`, whose deliveries judgeReach takes as
// possible, never certain.
const GROUP_AUTOMATED_SQL = `EXISTS (SELECT 1 FROM estimates g WHERE e.estimate_group_id IS NOT NULL
  AND g.estimate_group_id = e.estimate_group_id AND g.id <> e.id AND ${automatedSql('g')})`;
// Real deliveries the automation's own records prove: the lead auto-send's send, the moving job's
// overnight email, and its recorded morning text (a second delivery of the same estimate).
const AUTO_DELIVERIES_SQL = `(CASE WHEN COALESCE(e.estimate_data->'automation'->'autoSend'->>'result', '') = 'sent' THEN 1 ELSE 0 END
  + CASE WHEN COALESCE(e.estimate_data->'automation'->'moveAutoSend'->>'result', '') = 'sent' THEN 1 ELSE 0 END
  + CASE WHEN COALESCE(e.estimate_data->'automation'->'moveAutoSend'->>'textResult', '') = 'sent' THEN 1 ELSE 0 END)`;
const DELIVERIES_SQL = "(CASE WHEN jsonb_typeof(e.estimate_data #> '{deliveryState,deliveredAt}') = 'array' THEN jsonb_array_length(e.estimate_data #> '{deliveryState,deliveredAt}') ELSE 0 END)";
// #3391 (merged 2026-08-13 20:04 ET) began stamping firstDeliveredAt; this cutoff gives its deploy a day.
// An estimate created before it may have been delivered with no stamp, or stamped only at a later
// resend. With the evidence estimate-draft-retire.js accepts for such legacy rows (sent_at on a sent,
// non-draft row that is not a website quote or a publish-without-delivery mint), it is read too.
const FIRST_DELIVERY_STAMP_SINCE = '2026-08-15T00:00:00-04:00';
const LEGACY_SENT_SQL = `(e.created_at < ?::timestamptz AND e.sent_at IS NOT NULL AND e.status <> 'draft'
  AND COALESCE(e.source, '') NOT IN ('quote_wizard', 'service_report_cta', 'plan_restart', 'plan_start'))`;

// A staff send's receipts (estimate_data.manualSendAttempts, admin-estimates.js sendEstimateNow): written
// only for a send a person started (a staff key or a staff schedule; the automation passes none) and
// completed with the provider's result. One that really handed off (a text the provider accepted,
// channels.sms.real; an email it accepted, channels.email.providerAccepted) reached the customer between
// its start and its completion.
function personSendsOf(attempts) {
  return (Array.isArray(attempts) ? attempts : []).flatMap((attempt) => {
    const channels = attempt?.result?.channels || {};
    const handedOff = channels.sms?.real === true || channels.email?.providerAccepted === true;
    const startedAt = asMs(attempt?.startedAt);
    const completedAt = asMs(attempt?.completedAt);
    return handedOff && startedAt != null && completedAt != null && completedAt >= startedAt ? [{ startedAt, completedAt }] : [];
  });
}

async function estimateSends(conn, cohort) {
  if (!cohort.length) return [];
  const leadIds = cohort.map((lead) => String(lead.id));
  const byId = new Map(cohort.map((lead) => [String(lead.id), lead]));
  const rows = await conn('estimates as e').leftJoin('leads as l', 'l.estimate_id', 'e.id')
    .where((sent) => sent
      .whereRaw(`${FIRST_DELIVERED_SQL} IS NOT NULL`)
      .orWhereRaw(LEGACY_SENT_SQL, [FIRST_DELIVERY_STAMP_SINCE]))
    .where((mine) => mine
      .whereRaw('l.id::text = ANY(?)', [leadIds])
      .orWhereRaw("e.estimate_data->>'lead_id' = ANY(?)", [leadIds]))
    .select('e.id', 'e.customer_id', 'e.customer_phone', 'e.customer_email', 'l.id as linked_lead_id', 'e.created_at', 'e.sent_at',
      conn.raw("e.estimate_data->>'lead_id' as data_lead_id"), conn.raw(`${FIRST_DELIVERED_SQL} as at`),
      conn.raw("e.estimate_data #> '{deliveryState,deliveredAt}' as delivered_at"),
      conn.raw("e.estimate_data->'manualSendAttempts' as manual_attempts"),
      conn.raw(`${AUTOMATED_SQL} as automated`), conn.raw(`${GROUP_AUTOMATED_SQL} as group_automated`),
      conn.raw(`${AUTO_DELIVERIES_SQL} as auto_deliveries`), conn.raw(`${DELIVERIES_SQL} as deliveries`));
  return rows.flatMap((row) => {
    let leadId = null;
    if (row.linked_lead_id) leadId = String(row.linked_lead_id);
    else if (row.data_lead_id) {
      const named = byId.get(String(row.data_lead_id));
      // The named lead must not belong to another estimate, and must match this estimate's contact.
      if (named && !named.estimate_id && leadMatchesEstimateContact(named, row)) leadId = String(named.id);
    }
    if (!leadId || !byId.has(leadId)) return [];
    // The second real delivery in time: with the first automated, it is the earliest a person could have
    // sent one. deliveredAt keeps only the newest entries (DELIVERY_HISTORY_MAX in admin-estimates.js):
    // when its oldest entry is not the first delivery, older ones were dropped, and the second delivery
    // may be any time after the first.
    const first = asMs(row.at);
    const times = (Array.isArray(row.delivered_at) ? row.delivered_at : []).map(asMs).filter((t) => t != null).sort((a, b) => a - b);
    const complete = first != null && times.length > 0 && times[0] <= first;
    const created = asMs(row.created_at);
    const sends = [asMs(row.sent_at), first, times[times.length - 1]].filter((t) => t != null);
    return [{
      leadId, at: first, automated: !!row.automated, groupAutomated: !!row.group_automated,
      deliveries: Number(row.deliveries) || 0, autoDeliveries: Number(row.auto_deliveries) || 0,
      resendAt: complete ? (times[1] ?? null) : first,
      lastAt: times.length ? times[times.length - 1] : first,
      personSends: personSendsOf(row.manual_attempts),
      // Created before the stamp existed: when it last went out (or was last tried), and when it was made.
      legacy: created != null && created < Date.parse(FIRST_DELIVERY_STAMP_SINCE)
        ? { createdAt: created, lastSentAt: sends.length ? Math.max(...sends) : null } : null,
    }];
  });
}

// Who else a phone or email could belong to, read from ALL leads, never the report's date range:
//  - open: the open leads sharing it (lead-contact-sync.js openLeadIdentities), Map(key -> Set(lead ids));
//  - prospects: every prospect lead sharing it (any status but the non-prospect ones, any date), with
//    its first contact, Map(key -> [{ id, firstAt }]).
async function identityOwners(conn, peers, addresses) {
  const peerSql = phoneIdentitySql('leads.phone');
  const [open, rows] = await Promise.all([
    openLeadIdentities(conn, { peers, emails: addresses, customerIds: [] }),
    peers.length || addresses.length
      ? conn('leads').whereNull('deleted_at').whereNotIn('status', [...EXCLUDED_STATUSES]).whereNotNull('first_contact_at')
        .where((same) => same
          .orWhereRaw(`${peerSql} = ANY(?)`, [peers])
          .orWhereRaw('EXISTS (SELECT 1 FROM unnest(?::text[]) AS a(addr) WHERE strpos(LOWER(leads.email), a.addr) > 0)', [addresses]))
        .select('id', 'email', 'first_contact_at', conn.raw(`${peerSql} as peer`))
      : [],
  ]);
  const prospects = new Map();
  for (const row of rows) {
    const firstAt = asMs(row.first_contact_at);
    if (firstAt == null) continue;
    for (const key of [`phone:${row.peer}`, `email:${leadEmail(row.email)}`]) {
      prospects.set(key, [...(prospects.get(key) || []), { id: String(row.id), firstAt }]);
    }
  }
  return { open, prospects };
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
  // not another customer's, not an identity another open lead shares (contactSkipReason, with this lead
  // one of the sharers whatever its status), and not one a newer prospect lead had already contacted us
  // on by then (a contact goes to the newest lead). A call with no known answer time (spanEnd) that rang
  // before first contact and ended after it may have reached the person after it.
  const mayFollow = (w) => (w.spanEnd ?? w.at) > firstAt;
  const sharers = { get: (key) => new Set([...(owners.open.get(key) || []), id]) };
  const newerLeadTook = (w) => (owners.prospects.get(w.key) || []).some((m) => m.id !== id && m.firstAt > firstAt && m.firstAt <= w.at);
  const byIdentity = keys.flatMap((key) => index.byKey.get(key) || [])
    .filter((w) => mayFollow(w) && !contactSkipReason(w, customerId, sharers) && !newerLeadTook(w));
  // A call owned by this lead counts after first contact; the originating call is its first contact
  // even though it came before first_contact_at.
  const isOrigin = (w) => !!sid && w.sid === sid;
  const owned = (index.owned.get(id) || []).filter((w) => mayFollow(w) || isOrigin(w));
  // That straddling call may also have reached the person before first contact, which never counts:
  // possible from first contact on, never certain.
  const items = [...byIdentity, ...owned].map((w) => (w.at > firstAt || isOrigin(w)
    ? { earliest: w.at, latest: w.spanEnd ?? w.at }
    : { earliest: firstAt, latest: null }));
  for (const e of index.estimates.get(id) || []) {
    items.push(...estimateItems(e, firstAt));
  }
  return items;
}

// One estimate's possible person contacts after first contact (firstAt).
function estimateItems(e, firstAt) {
  const items = [];
  if (e.automated) {
    // After an automated first delivery, deliveries beyond the ones the automation's records prove may be
    // a person's; the earliest such one is the second delivery in time.
    if (e.deliveries > (e.autoDeliveries || 0)) items.push({ earliest: Math.max(firstAt, e.resendAt ?? e.at ?? firstAt), latest: null });
  } else if (e.groupAutomated) {
    // Another member's automation may have published it, or a person sent it: any delivery after first
    // contact is possible, never certain.
    if (e.at != null && (e.lastAt ?? e.at) >= firstAt) items.push({ earliest: Math.max(firstAt, e.at), latest: null });
  } else if (e.at != null && e.at >= firstAt) {
    // A first delivery nothing automated is a person's.
    items.push({ earliest: e.at, latest: e.at });
  }
  // A staff send's receipt: a person reached the customer between its start and its completion.
  for (const send of e.personSends || []) {
    if (send.startedAt >= firstAt) items.push({ earliest: send.startedAt, latest: send.completedAt });
    else if (send.completedAt >= firstAt) items.push({ earliest: firstAt, latest: null });
  }
  // Created before the first-delivery stamp existed: a delivery may carry no stamp, so one may have come
  // any time from first contact (or the estimate's creation) on, when it went out after first contact.
  if (e.legacy && e.legacy.lastSentAt != null && e.legacy.lastSentAt >= firstAt) {
    items.push({ earliest: Math.max(firstAt, e.legacy.createdAt), latest: null });
  }
  return items;
}

/**
 * @param {Array} cohort leads from reachCohort
 * @param {{texts, calls, emails, estimates, owners}} evidence witness rows from the loaders above;
 *   owners is identityOwners' { open, prospects }, empty when nothing is shared.
 * @param {Map<string, string>} sidOwners call sid -> id of the lead that originated it (all leads)
 * @returns {Map<string, number|null|string>} lead id -> bucketReach result
 */
function judgeReach(cohort, evidence, sidOwners = new Map(cohort.filter((l) => l.twilio_call_sid).map((l) => [String(l.twilio_call_sid), String(l.id)]))) {
  const owners = { open: evidence.owners?.open || new Map(), prospects: evidence.owners?.prospects || new Map() };
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
    identityOwners(conn, peers, addresses),
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

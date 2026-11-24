const db = require('../../models/db');
const logger = require('../../services/logger');
const { etDateString, addETDays, parseETDateTime, etWallClockOccurrences } = require('../../utils/datetime-et');
const { toE164, phoneIdentityKey } = require('../../utils/phone');
const { findOnlyKnownCallerCustomer } = require('../../utils/known-caller-phone');
const { whereNotSandboxCall } = require('../voice-agent/relay-protocol');
const { callStartedAt } = require('../../utils/call-timeline');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');
const { errorText } = require('./google-ads-config');
const GoogleLsa = require('./google-lsa');

// ---------------------------------------------------------------------------
// Google Local Services Ads: lead match, step A (owner 2026-11-23, "track LSA
// calls for free").
//
// Google forbids a tracking number on the Local Services profile, so those calls
// ring the Bradenton office line (941) 318-7612 and the portal files them as
// website calls. Google's API lists each lead with the consumer's phone and
// time. This job stores every lead of the last 30 days in lsa_leads and matches
// each to the portal's call_log row, lead and customer.
//
// Step A only READS Google and writes lsa_leads. Step B (relabelMatches, owner
// 2026-11-23 "do step b next") then files the funnel row of each matched call as
// google_lsa instead of waves_website. It changes no call_log, leads or
// customers row and messages no one.
//
// Field names are checked against the google-ads-api v23 typings. The typings
// list local_services_lead.contact_details as ONE field (a message with
// phone_number, consumer_name and email), so the query selects it whole and
// the mappers read the parts.
// ---------------------------------------------------------------------------

const LOOKBACK_DAYS = 30;
// A consumer's call reaches the office line after the lead's own time stamp by
// seconds or minutes; the call can also be logged a little before Google stamps
// the lead. The window is wide enough for both and narrow enough that two
// separate calls from one number are rarely both inside it.
const MATCH_BEFORE_MS = 10 * 60 * 1000;
const MATCH_AFTER_MS = 30 * 60 * 1000;
const LEAD_TYPE = { 2: 'messages', 3: 'calls', 4: 'bookings', MESSAGE: 'messages', PHONE_CALL: 'calls', BOOKING: 'bookings' };
// LocalServicesLeadStatus (UNSPECIFIED and UNKNOWN stay null).
const LEAD_STATUS = { 2: 'NEW', 3: 'ACTIVE', 4: 'BOOKED', 5: 'DECLINED', 6: 'EXPIRED', 7: 'DISABLED', 8: 'CONSUMER_DECLINED', 9: 'WIPED_OUT' };
// LocalServicesCreditState (the sync's own CREDITED set is 3).
const CREDIT_STATE = { 2: 'PENDING', 3: 'CREDITED', 4: 'NOT_CHARGED' };
// The Local Services profile's phone: its calls ring the Bradenton office line.
// A call to any other Waves number is never an LSA call.
const LSA_PROFILE_PHONE = TWILIO_NUMBERS.locations.bradenton.number;
// The call processor's lead stamp, read with the call.
const stampedLead = () => db.raw("metadata->>'lead_id' AS stamped_lead_id");
const PHONE_CALL_CONVERSATION = new Set([4, 'PHONE_CALL']);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// Google gives a time as 'YYYY-MM-DD HH:MM:SS' in the ACCOUNT's time zone
// (America/New_York for this account). Convert with the zone, never a fixed
// offset: parseETDateTime resolves the offset in force at that instant, so the
// fall-back and spring-forward days come out right. null = not readable.
function parseAccountTime(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?$/.exec(value.trim());
  if (!m) return null;
  const at = parseETDateTime(`${m[1]}T${m[2]}`);
  return Number.isNaN(at.getTime()) ? null : at;
}

// The last ten digits, or '' when the number has fewer.
function last10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

// E.164 when parseable, else Google's raw text, else null.
function consumerPhone(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text ? toE164(text) || text : null;
}

// The ONE key of a lead: Google's resource name, 'customers/<account>/
// localServicesLeads/<id>'. local_services_lead.resource_name and
// local_services_lead_conversation.lead both carry it exactly, while
// local_services_lead.id is only the number. '' when Google gave none.
function leadKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function secondsFromMillis(millis) {
  const n = Number(millis);
  return Number.isFinite(n) && n >= 0 ? Math.round(n / 1000) : null;
}

// One lsa_leads row's Google-owned fields from a local_services_lead row and
// the lead's phone-call conversation (if any). Never carries a match field, so
// an upsert of it can never clear a match.
function mapLead(row, conversation, account) {
  const lead = row.local_services_lead || {};
  const id = leadKey(lead.resource_name);
  if (!id) return null;
  const contact = lead.contact_details || {};
  const credit = lead.credit_details?.credit_state;
  return {
    google_lead_id: id,
    account_id: account,
    lead_type: LEAD_TYPE[lead.lead_type] || null,
    lead_status: LEAD_STATUS[lead.lead_status] || (typeof lead.lead_status === 'string' ? lead.lead_status : null),
    category_id: lead.category_id ? String(lead.category_id) : null,
    service_id: lead.service_id ? String(lead.service_id) : null,
    consumer_phone: consumerPhone(contact.phone_number),
    consumer_name: contact.consumer_name ? String(contact.consumer_name) : null,
    lead_created_at: parseAccountTime(lead.creation_date_time),
    charged: typeof lead.lead_charged === 'boolean' ? lead.lead_charged : null,
    credit_state: CREDIT_STATE[credit] || (typeof credit === 'string' ? credit : null),
    // Only when Google's conversation read gave this lead's call: an upsert
    // never replaces a stored call time with a gap.
    ...(conversation ? { call_started_at: conversation.startedAt, call_duration_seconds: conversation.durationSeconds } : {}),
  };
}

// local_services_lead_conversation rows -> Map(lead id -> { startedAt,
// durationSeconds }), PHONE_CALL only; the earliest event stands for the call.
function callsByLead(conversationRows) {
  const byLead = new Map();
  for (const row of conversationRows) {
    const c = row.local_services_lead_conversation || {};
    if (!PHONE_CALL_CONVERSATION.has(c.conversation_channel)) continue;
    const id = leadKey(c.lead);
    const startedAt = parseAccountTime(c.event_date_time);
    if (!id || !startedAt) continue;
    const seen = byLead.get(id);
    if (seen && seen.startedAt <= startedAt) continue;
    byLead.set(id, { startedAt, durationSeconds: secondsFromMillis(c.phone_call_details?.call_duration_millis) });
  }
  return byLead;
}

const HOUR_MS = 60 * 60 * 1000;

// The call window for a lead: [from - 10 min, from + 30 min], from = the call's
// own start when Google gave one, else the lead's creation time. On the
// fall-back day the 1 AM hour happens twice, and parseAccountTime keeps the
// first instant; a time in that repeated hour could be either, so the window
// runs from the earlier instant - 10 min to the later instant + 30 min.
function matchWindow(lead) {
  const from = lead.call_started_at || lead.lead_created_at;
  if (!from) return null;
  const at = new Date(from);
  const t = at.getTime();
  if (!Number.isFinite(t)) return null;
  const repeat = etWallClockOccurrences(at) === 2 ? HOUR_MS : 0;
  return { start: new Date(t - MATCH_BEFORE_MS), end: new Date(t + repeat + MATCH_AFTER_MS) };
}

// A match is final only after the window has closed, so a second call inside it
// can still make the lead ambiguous. No window = nothing to wait for.
function windowClosed(lead, now = new Date()) {
  const window = matchWindow(lead);
  return !window || now.getTime() >= window.end.getTime();
}

// Pure choice among the inbound calls found for a lead. Exactly one -> that
// call. None -> 'none'. Two or more -> 'ambiguous': never guess between calls.
function chooseCandidate(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 1) return { status: 'matched', call: list[0] };
  return { status: list.length ? 'ambiguous' : 'none', call: null };
}

// ---------------------------------------------------------------------------
// Google reads
// ---------------------------------------------------------------------------

function sinceString(now = new Date()) {
  return etDateString(addETDays(now, -LOOKBACK_DAYS));
}

// Both edges are account-local days, like the daily sync's lead query.
function leadQuery(since, until) {
  return `
    SELECT
      local_services_lead.resource_name,
      local_services_lead.id,
      local_services_lead.lead_type,
      local_services_lead.lead_status,
      local_services_lead.category_id,
      local_services_lead.service_id,
      local_services_lead.contact_details,
      local_services_lead.creation_date_time,
      local_services_lead.lead_charged,
      local_services_lead.credit_details.credit_state
    FROM local_services_lead
    WHERE local_services_lead.creation_date_time >= '${since} 00:00:00'
      AND local_services_lead.creation_date_time <= '${until} 23:59:59'
  `;
}

// A conversation row names its lead. Its time stamp is the start of the call
// event, so the call can be placed in time even when the lead's own stamp lags.
function conversationQuery(since, until) {
  return `
    SELECT
      local_services_lead_conversation.lead,
      local_services_lead_conversation.conversation_channel,
      local_services_lead_conversation.event_date_time,
      local_services_lead_conversation.phone_call_details.call_duration_millis
    FROM local_services_lead_conversation
    WHERE local_services_lead_conversation.conversation_channel = 'PHONE_CALL'
      AND local_services_lead_conversation.event_date_time >= '${since} 00:00:00'
      AND local_services_lead_conversation.event_date_time <= '${until} 23:59:59'
  `;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

// Update Google-owned fields only. mapLead carries no match column, so the
// merge can never clear call_log_id, lead_id, customer_id, match_basis or
// matched_at.
async function upsertLeads(leads) {
  for (const lead of leads) {
    await db('lsa_leads')
      .insert({ ...lead, first_seen_at: new Date(), updated_at: new Date() })
      .onConflict('google_lead_id')
      .merge({ ...lead, updated_at: new Date() });
  }
  return leads.length;
}

// Pure. Both numbers must be the same line: phoneIdentityKey reads a US number
// (10 digits, 1 + 10, +1) as its ten digits, and any other country code as its
// full +digits, so +44 7911 123456 never meets a US number that shares its last
// ten digits.
function samePhone(a, b) {
  const x = phoneIdentityKey(a);
  return !!x && x === phoneIdentityKey(b);
}

// Pure. A call is a candidate when it came from the consumer's number to the
// Local Services profile line.
function isCandidateCall(call, consumerPhoneValue) {
  return samePhone(call.from_phone, consumerPhoneValue) && samePhone(call.to_phone, LSA_PROFILE_PHONE);
}

// A row written AFTER the call (status-callback / recording-recovery paths) is
// stamped at the call's end, so the query reaches this far past the window and
// callStartedAt (utils/call-timeline) then places each call at its real start.
const POST_CALL_ROW_SLACK_MS = 4 * 3600 * 1000;

// Pure. The call started inside the window (normalized start, not row time).
function startedInWindow(call, window) {
  const started = callStartedAt(call);
  return Boolean(started) && started >= window.start && started <= window.end;
}

// Inbound calls from the same number to the Local Services profile line that
// STARTED inside the window. The query narrows on the last ten digits and a
// widened time range; isCandidateCall then compares the whole numbers and
// startedInWindow the real start.
async function findCandidateCalls(lead) {
  const key = last10(lead.consumer_phone);
  const window = matchWindow(lead);
  if (!key || !window) return [];
  // A voice-agent sandbox or tech-voice call is never a customer's call.
  const rows = await whereNotSandboxCall(db('call_log')
    .where({ direction: 'inbound' }))
    .whereRaw("right(regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [key])
    .whereRaw("right(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10(LSA_PROFILE_PHONE)])
    .where('created_at', '>=', window.start)
    .where('created_at', '<=', new Date(window.end.getTime() + POST_CALL_ROW_SLACK_MS))
    .select('id', 'customer_id', 'twilio_call_sid', 'from_phone', 'to_phone', 'created_at', 'metadata',
      'duration_seconds', 'recording_duration_seconds', stampedLead());
  return rows.filter((call) => isCandidateCall(call, lead.consumer_phone) && startedInWindow(call, window));
}

// The portal's lead for a call. The call processor's own link comes first:
// call_log.metadata.lead_id, the stamp it writes when a call reuses an existing
// lead (the lead keeps its ORIGINAL call's sid, so the sid cannot find it).
// Without a stamp, or with one that names no lead, leads.twilio_call_sid =
// call_log.twilio_call_sid. Null when the call has no lead, or two (never guess).
// Same order as the call processor (call-recording-processor.js, "The SID
// stays AUTHORITATIVE over the stamp"): the lead this call's SID created comes
// first; the call_log.metadata.lead_id stamp (a call that reused an older
// lead) only when no SID lead exists. Two SID leads = no guess.
async function leadIdForCall(call) {
  if (call.twilio_call_sid) {
    const rows = await db('leads').where({ twilio_call_sid: call.twilio_call_sid }).select('id').limit(2);
    if (rows.length === 1) return rows[0].id;
    if (rows.length > 1) return null;
  }
  if (!call.stamped_lead_id) return null;
  const stamped = await db('leads').whereRaw('id::text = ?', [String(call.stamped_lead_id)]).select('id').limit(1);
  return stamped.length ? stamped[0].id : null;
}

// The one live customer whose phone columns hold this number; null for none or
// for two or more (never guess). Same columns as the call pipeline's identity
// match (utils/known-caller-phone).
async function findOnlyCustomer(phone) {
  const row = await findOnlyKnownCallerCustomer(db, phone, ['id']);
  return row ? row.id : null;
}

// What to write for one lead, or null for "leave it as it is". A phone-call
// lead matches a call by phone and time; any other lead matches the one
// customer who has the number.
async function decideMatch(lead) {
  if (lead.lead_type === 'calls') {
    const choice = chooseCandidate(await findCandidateCalls(lead));
    if (choice.status === 'none') return null;
    if (choice.status === 'ambiguous') return { match_basis: 'ambiguous' };
    const call = choice.call;
    return {
      call_log_id: call.id,
      customer_id: call.customer_id || null,
      lead_id: await leadIdForCall(call),
      match_basis: 'phone_time',
      matched_at: new Date(),
    };
  }
  const customerId = await findOnlyCustomer(lead.consumer_phone);
  if (!customerId) return null;
  return { customer_id: customerId, match_basis: 'phone_customer', matched_at: new Date() };
}

const AMBIGUOUS = { match_basis: 'ambiguous' };


// Pure. One portal call belongs to ONE Google lead: when two open leads chose
// the same call in a run, neither gets it (both become ambiguous, no ids).
// A lead still inside its window (pending) is counted as a claimant but never
// written: a closed lead that shares a call with a pending one waits too
// (pending), so it cannot take the call before the other lead's window ends.
function resolveSharedCalls(plans) {
  const taken = new Map();
  const pendingCalls = new Set();
  for (const { update, pending } of plans) {
    if (!update?.call_log_id) continue;
    taken.set(update.call_log_id, (taken.get(update.call_log_id) || 0) + 1);
    if (pending) pendingCalls.add(update.call_log_id);
  }
  return plans.map((plan) => {
    const callId = plan.update?.call_log_id;
    if (plan.pending || (callId && pendingCalls.has(callId))) return { ...plan, pending: true };
    if (callId && taken.get(callId) > 1) return { ...plan, update: { ...AMBIGUOUS } };
    return plan;
  });
}

// True when another lsa_leads row already holds this call.
async function callHeldByOther(leadId, callId) {
  const rows = await db('lsa_leads').where({ call_log_id: callId }).whereNot('id', leadId).select('id').limit(1);
  return rows.length > 0;
}

// Write one decided match. A call another lead already holds is never taken:
// this lead is marked ambiguous instead, with no ids.
async function applyPlan({ lead, update }, counts) {
  let write = update;
  if (write.call_log_id && await callHeldByOther(lead.id, write.call_log_id)) write = { ...AMBIGUOUS };
  if (write.match_basis === 'ambiguous') {
    counts.ambiguous += 1;
    if (lead.match_basis === 'ambiguous') return; // already marked
  } else {
    counts.matched += 1;
  }
  await db('lsa_leads').where({ id: lead.id }).update({ ...write, updated_at: new Date() });
}

// Leads with no real match yet: never matched, or marked ambiguous (a later
// call may settle it). A 'phone_time' or 'phone_customer' match is final.
async function matchOpenLeads(now = new Date()) {
  const open = await db('lsa_leads')
    .whereNotNull('consumer_phone')
    .where('lead_created_at', '>=', new Date(Date.now() - (LOOKBACK_DAYS + 5) * 24 * 3600 * 1000))
    .where((q) => q.whereNull('match_basis').orWhere('match_basis', 'ambiguous'))
    .select('id', 'lead_type', 'consumer_phone', 'lead_created_at', 'call_started_at', 'match_basis');
  const counts = { matched: 0, ambiguous: 0, unmatched: 0, pending: 0 };
  const plans = [];
  for (const lead of open) {
    // A phone-call lead still inside its window is never written, but its
    // candidate call still counts against other leads (resolveSharedCalls).
    const pending = lead.lead_type === 'calls' && !windowClosed(lead, now);
    const update = await decideMatch(lead);
    if (update) plans.push({ lead, update, pending });
    else if (pending) counts.pending += 1;
    else counts.unmatched += 1;
  }
  for (const plan of resolveSharedCalls(plans)) {
    if (plan.pending) counts.pending += 1;
    else await applyPlan(plan, counts);
  }
  return counts;
}

// Pure. The fields a phone_time match can still gain: the portal's lead and the
// call's customer, each only while empty and now known. call_log_id and
// match_basis are never touched. null = nothing to fill.
function refillFields(row, call, leadId) {
  const fill = {};
  if (!row.lead_id && leadId) fill.lead_id = leadId;
  if (!row.customer_id && call?.customer_id) fill.customer_id = call.customer_id;
  return Object.keys(fill).length ? fill : null;
}

// The call processor creates the portal's lead and customer minutes AFTER the
// call, so a phone_time match made in between has them empty. Each run fills
// them for the last 35 days.
async function refillMatches() {
  const rows = await db('lsa_leads')
    .where({ match_basis: 'phone_time' })
    .whereNotNull('call_log_id')
    .where('lead_created_at', '>=', new Date(Date.now() - (LOOKBACK_DAYS + 5) * 24 * 3600 * 1000))
    .where((q) => q.whereNull('lead_id').orWhereNull('customer_id'))
    .select('id', 'call_log_id', 'lead_id', 'customer_id');
  if (!rows.length) return 0;
  const calls = await db('call_log').whereIn('id', rows.map((r) => r.call_log_id)).select('id', 'customer_id', 'twilio_call_sid', stampedLead());
  const byId = new Map(calls.map((c) => [c.id, c]));
  let filled = 0;
  for (const row of rows) {
    const call = byId.get(row.call_log_id);
    if (!call) continue;
    const fill = refillFields(row, call, row.lead_id ? null : await leadIdForCall(call));
    if (!fill) continue;
    await db('lsa_leads').where({ id: row.id }).update({ ...fill, updated_at: new Date() });
    filled += 1;
  }
  return filled;
}

// ---------------------------------------------------------------------------
// Step B: file a matched call's funnel row as google_lsa
//
// The office line is a main_site source, so the call pipeline files each Local
// Services call's ad_service_attribution row as waves_website (organic). A lead
// matched by phone and time (match_basis phone_time) PROVES the call was a
// Local Services call, so its row is relabeled. The rules keep first touch
// first: only a row the pipeline filed as waves_website FOR THIS CALL changes.
// ---------------------------------------------------------------------------
const RELABEL_LOOKBACK_DAYS = 90;
const RELABEL_BASIS = 'lsa_lead_match';
const RELABEL_DETAIL = 'Local Services';
// recordCallPpcAttribution refusals that will not change on a retry: the lead's
// row belongs to another source, another call, a web click, or has no call id.
// Anything else (no_customer, no_lead, an insert error) can still come right.
const UNPROVEN_REFUSALS = new Set(['other_source', 'other_call', 'unprovenanced_row', 'web_attributed']);

// Pure. What to do with a lead's funnel row (null = the lead has none yet).
//   create  - no row: file one as google_lsa (the writer may still refuse)
//   relabel - a waves_website row that came from this very call
//   keep    - leave the row; `result` is the audit text
function relabelAction(row, lsaLead) {
  if (!row) return { type: 'create' };
  if (row.lead_source === 'google_lsa') return { type: 'keep', result: 'already_lsa' };
  if (row.lead_source === 'waves_website') {
    const sameCall = row.source_call_id && lsaLead.call_log_id
      && String(row.source_call_id) === String(lsaLead.call_log_id);
    return sameCall
      ? { type: 'relabel', from: 'waves_website', result: 'relabeled' }
      : { type: 'keep', result: 'unproven' };
  }
  // First touch wins: a web form, google_ads, referral... keeps its channel.
  return { type: 'keep', result: `kept_${row.lead_source || 'none'}`.slice(0, 40) };
}

// { ok } | { retry } | { unproven: reason }. A lead born from another call
// (it only reused this one) is unproven: first touch keeps its channel.
async function callStillAttributable(trx, lsaLead, lead) {
  // Lazy require: call-attribution loads google-call-bridge, which is heavy.
  const { resolveSourceCallProvenanceLocked } = require('./call-attribution');
  const prov = await resolveSourceCallProvenanceLocked(trx, { leadId: lead.id, twilioCallSid: lead.twilio_call_sid });
  if (prov.refusedReason === 'call_unsettled') return { retry: 'call_unsettled' };
  if (prov.refusedReason === 'call_rejected') {
    // The resolver also says call_rejected while a reprocess holds the call.
    // Only the durable verdict (metadata.no_attribution) is final.
    const call = await trx('call_log').where({ id: lsaLead.call_log_id }).first('metadata');
    if (!noAttributionVerdict(call?.metadata)) return { retry: 'call_processing' };
  }
  if (prov.refusedReason) return { unproven: String(prov.refusedReason).slice(0, 40) };
  if (!prov.sourceCallId || String(prov.sourceCallId) !== String(lsaLead.call_log_id)) return { unproven: 'lead_not_from_call' };
  return { ok: true };
}

function noAttributionVerdict(metadata) {
  try {
    const md = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
    return md?.no_attribution === true;
  } catch { return false; }
}

async function markLsaLead(trx, lsaLead, result, from) {
  await trx('lsa_leads').where({ id: lsaLead.id }).update({
    relabeled_at: new Date(),
    relabel_result: result,
    relabeled_from: from,
    updated_at: new Date(),
  });
  return { result };
}

// One lead, one transaction. Lock order is the repo's: the lead, then its
// funnel row. { retry: reason } = nothing written, try again next run.
async function relabelInTransaction(trx, lsaLead, startedAt) {
  // The match may have moved since the batch read (a refill, a re-match):
  // act only on the ids still on the row, under its lock.
  const current = await trx('lsa_leads').where({ id: lsaLead.id }).forUpdate()
    .first('lead_id', 'customer_id', 'call_log_id', 'match_basis', 'relabeled_at');
  if (!current || current.relabeled_at || current.match_basis !== 'phone_time'
    || String(current.lead_id) !== String(lsaLead.lead_id)
    || String(current.customer_id) !== String(lsaLead.customer_id)
    || String(current.call_log_id) !== String(lsaLead.call_log_id)) return { retry: 'match_changed' };
  const lead = await trx('leads').where({ id: lsaLead.lead_id }).forUpdate().first('id', 'customer_id', 'twilio_call_sid', 'status');
  if (!lead) return { retry: 'no_lead' };
  // Paid credit needs the lead's CURRENT owner to be the matched customer.
  if (!lead.customer_id || String(lead.customer_id) !== String(lsaLead.customer_id)) return { retry: 'customer_changed' };
  // The pipeline's own check, under the same lead -> call_log lock order: the
  // call still belongs to this lead and was not rejected (spam, not a lead),
  // repointed or left unsettled. A rejected call never regains paid credit.
  const proof = await callStillAttributable(trx, lsaLead, lead);
  if (proof.retry) return proof;
  if (proof.unproven) return markLsaLead(trx, lsaLead, 'unproven', proof.unproven);
  const row = await trx('ad_service_attribution')
    .where({ lead_id: lsaLead.lead_id })
    .forUpdate()
    .first('id', 'lead_source', 'source_call_id');
  const action = relabelAction(row, lsaLead);
  let result = action.result;
  let from = action.from || null;
  if (action.type === 'create') {
    const { recordCallPpcAttribution } = require('./call-attribution');
    const recorded = await recordCallPpcAttribution({
      customerId: lsaLead.customer_id,
      leadId: lsaLead.lead_id,
      leadSource: 'google_lsa',
      isPaid: true,
      leadSourceDetail: RELABEL_DETAIL,
      leadDate: startedAt || lsaLead.lead_created_at,
      sourceCallId: lsaLead.call_log_id,
      attributionBasis: RELABEL_BASIS,
      dbc: trx,
    });
    if (!recorded.recorded) {
      // The pipeline says the lead's row is not provably this call's: final.
      if (!UNPROVEN_REFUSALS.has(recorded.reason)) return { retry: recorded.reason || 'not_recorded' };
      result = 'unproven';
      from = String(recorded.reason).slice(0, 40);
    } else {
      result = 'created';
      // The row starts at 'lead'; a conversion that happened before it existed
      // advanced nothing, so replay the lead's current status (won, lost...).
      const { bridgeLeadFunnelStage } = require('../lead-funnel-bridge');
      if (lead.status) {
        const replay = await bridgeLeadFunnelStage(lead.id, lead.status, trx);
        // The bridge swallows its errors; a failed replay rolls the new row back.
        if (replay?.reason === 'error') throw Object.assign(new Error('stage replay failed'), { code: 'stage_replay' });
      }
    }
  } else if (action.type === 'relabel') {
    await trx('ad_service_attribution').where({ id: row.id }).update({
      lead_source: 'google_lsa',
      is_paid: true,
      lead_source_detail: RELABEL_DETAIL,
      attribution_basis: RELABEL_BASIS,
      updated_at: new Date(),
    });
  }
  return markLsaLead(trx, lsaLead, result, from);
}

// Phone-call leads matched to a call, the lead and the customer, not yet done,
// created in the last 90 days. A refill (above) completes the ids first.
async function relabelMatches() {
  const since = new Date(Date.now() - RELABEL_LOOKBACK_DAYS * 24 * 3600 * 1000);
  const rows = await db('lsa_leads')
    .where({ match_basis: 'phone_time' })
    .whereNotNull('lead_id')
    .whereNotNull('customer_id')
    .whereNotNull('call_log_id')
    .whereNull('relabeled_at')
    .where('lead_created_at', '>=', since)
    .orderBy('lead_created_at')
    .select('id', 'call_log_id', 'lead_id', 'customer_id', 'lead_created_at');
  const counts = { relabeled: 0, created: 0, kept: 0, retry: 0, failed: 0 };
  if (!rows.length) return counts;
  const calls = await db('call_log').whereIn('id', rows.map((r) => r.call_log_id))
    .select('id', 'twilio_call_sid', 'created_at', 'metadata', 'duration_seconds', 'recording_duration_seconds');
  const byId = new Map(calls.map((c) => [c.id, c]));
  for (const lsaLead of rows) {
    const call = byId.get(lsaLead.call_log_id) || null;
    const startedAt = call ? callStartedAt(call) : null;
    let out;
    try {
      out = await db.transaction((trx) => relabelInTransaction(trx, lsaLead, startedAt));
    } catch (err) {
      // Never the row's values: the step, code, constraint and table only.
      logger.error(`[google-lsa-leads] database ${dbErrorText('relabel', err)}`);
      counts.failed += 1;
      continue;
    }
    if (out.retry === 'error') {
      // The writer swallowed a database error: a failure, not a wait.
      logger.error('[google-lsa-leads] relabel writer error');
      counts.failed += 1;
    } else if (out.retry) {
      logger.warn(`[google-lsa-leads] relabel waits: ${out.retry}`);
      counts.retry += 1;
    } else if (out.result === 'relabeled' || out.result === 'created') {
      counts[out.result] += 1;
    } else {
      counts.kept += 1;
    }
  }
  return counts;
}

// A database error can echo the row it refused (the consumer's phone and name),
// so a DB failure is logged and thrown as its step, code, constraint and table
// only. Google's own errors go through errorText.
function dbErrorText(step, err) {
  const parts = [`step ${step}`];
  if (err?.code) parts.push(`code ${err.code}`);
  if (err?.constraint) parts.push(`constraint ${err.constraint}`);
  if (err?.table) parts.push(`table ${err.table}`);
  return parts.join(', ');
}

async function dbStep(step, run) {
  try {
    return await run();
  } catch (err) {
    const reason = dbErrorText(step, err);
    logger.error(`[google-lsa-leads] database ${reason}`);
    throw new Error(`database ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// The hourly job body (the scheduler wraps it in runExclusive('google-lsa-leads')).
// A failure throws an Error with a safe reason (Google's, or a database step,
// code and constraint), so job_health records it without any lead's data.
// ---------------------------------------------------------------------------
async function runLeadSync() {
  const customer = GoogleLsa.getCustomer();
  if (!customer) return { configured: false, leads: 0, matched: 0 };
  const account = GoogleLsa._private.customerId();
  const since = sinceString();
  const until = etDateString(new Date());

  let leadRows;
  try {
    leadRows = await customer.query(leadQuery(since, until));
  } catch (err) {
    const reason = errorText(err);
    logger.error(`[google-lsa-leads] read failed: ${reason}`);
    throw new Error(`read: ${reason}`);
  }
  // The call times only sharpen the match (it falls back to the lead's own
  // time), so a failed conversation read does not stop the leads being stored.
  let conversationRows = [];
  try {
    conversationRows = await customer.query(conversationQuery(since, until));
  } catch (err) {
    logger.warn(`[google-lsa-leads] conversation read failed, matching on the lead time: ${errorText(err)}`);
  }

  const calls = callsByLead(conversationRows);
  const leads = leadRows
    .map((row) => mapLead(row, calls.get(leadKey(row.local_services_lead?.resource_name)), account))
    .filter(Boolean);
  const stored = await dbStep('store', () => upsertLeads(leads));
  const counts = await dbStep('match', () => matchOpenLeads());
  const refilled = await dbStep('refill', () => refillMatches());
  const relabel = await dbStep('relabel', () => relabelMatches());
  logger.info(`[google-lsa-leads] Stored ${stored} leads (${since} to ${until}); matched ${counts.matched}, ambiguous ${counts.ambiguous}, unmatched ${counts.unmatched}, waiting ${counts.pending}, refilled ${refilled}; relabeled ${relabel.relabeled}, created ${relabel.created}, kept ${relabel.kept}, waiting ${relabel.retry}, failed ${relabel.failed}`);
  // A lead that failed is retried next run; the throw puts it in job_health.
  if (relabel.failed) throw new Error(`database step relabel, ${relabel.failed} lead(s) failed`);
  return { configured: true, leads: stored, ...counts, refilled, relabel };
}

module.exports = {
  runLeadSync,
  LSA_PROFILE_PHONE,
  isConfigured: GoogleLsa.isConfigured,
  _private: {
    parseAccountTime,
    last10,
    consumerPhone,
    leadKey,
    LSA_PROFILE_PHONE,
    mapLead,
    callsByLead,
    matchWindow,
    windowClosed,
    samePhone,
    isCandidateCall,
    chooseCandidate,
    leadQuery,
    conversationQuery,
    sinceString,
    upsertLeads,
    decideMatch,
    matchOpenLeads,
    resolveSharedCalls,
    startedInWindow,
    refillFields,
    refillMatches,
    relabelAction,
    relabelInTransaction,
    relabelMatches,
    RELABEL_BASIS,
    dbErrorText,
    callHeldByOther,
    findOnlyCustomer,
    MATCH_BEFORE_MS,
    MATCH_AFTER_MS,
  },
};

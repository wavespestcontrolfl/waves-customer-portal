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
 *     first_contact_at. A call with no trustworthy end (callEndedAtSql) counts for nothing;
 *   - an email a person sent (a Gmail SENT row, personSentFilter) to the lead's address;
 *   - an estimate sent (the lead's own 'estimate_sent' activity row, or its linked estimate's sent_at).
 * The call agent's own verdict (lead-contact-sync's third call clause) is NOT a person
 * and does not count here. Read-only: five batched queries for the whole cohort, never
 * one per lead.
 */

const db = require('../models/db');
const { phoneIdentityKey } = require('../utils/phone');
const { phoneIdentitySql } = require('./sms-response-policy');
const { operatorReplySql, smsDeliveredSql, personCallBackSql } = require('./staff-contact');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { callEndedAtSql, callStartedAtSql } = require('./sms-pending-conversations');
const { personSentFilter, extractEmailAddresses } = require('./email/email-customer-link');
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

// A phone key only when it names one line: 10 NANP digits, or a +-prefixed international
// number (the same bar as lead-contact-sync.js). A fragment names nobody.
function usablePhoneKey(raw) {
  const key = phoneIdentityKey(raw);
  if (!key) return null;
  if (/^\d{10}$/.test(key)) return key;
  return /^\+[1-9]\d{7,14}$/.test(key) ? key : null;
}

function leadEmail(raw) {
  const [first] = extractEmailAddresses(raw);
  return first || null;
}

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
    .select('os.created_at as at', conn.raw(`${peer} as peer`));
  return rows.map((row) => ({ key: `phone:${row.peer}`, at: asMs(row.at) }));
}

// Calls a person spoke on, on a lead phone OR the lead's own originating call sid.
async function personCalls(conn, peers, sids, since) {
  if (!peers.length && !sids.length) return [];
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
      .orWhereIn('cl.twilio_call_sid', sids))
    .select('cl.twilio_call_sid as sid', conn.raw(`${started} as at`), conn.raw(`${peerSql} as peer`));
  return rows.map((row) => ({ key: `phone:${row.peer}`, sid: row.sid ? String(row.sid) : null, at: asMs(row.at) }));
}

// Gmail SENT rows whose To/Cc/Bcc text carries one of the lead addresses. The text match is a
// prefilter; the parsed address list decides.
async function personEmails(conn, addresses, since) {
  if (!addresses.length) return [];
  const recipientText = "LOWER(CONCAT_WS(',', er.to_address, er.cc_address, er.bcc_address))";
  const rows = await conn('emails as er')
    .whereRaw(personSentFilter('er'))
    .where('er.received_at', '>', since)
    .whereRaw(`EXISTS (SELECT 1 FROM unnest(?::text[]) AS a(addr) WHERE strpos(${recipientText}, a.addr) > 0)`, [addresses])
    .select('er.to_address', 'er.cc_address', 'er.bcc_address', 'er.received_at as at');
  const wanted = new Set(addresses);
  return rows.flatMap((row) => extractEmailAddresses([row.to_address, row.cc_address, row.bcc_address].filter(Boolean).join(','))
    .filter((addr) => wanted.has(addr))
    .map((addr) => ({ key: `email:${addr}`, at: asMs(row.at) })));
}

// An estimate sent for the lead: its own 'estimate_sent' activity row, or the linked estimate
// (leads.estimate_id) carrying a send time. The quote wizard sends without an activity row.
async function estimateSends(conn, leadIds) {
  if (!leadIds.length) return [];
  const [activities, linked] = await Promise.all([
    conn('lead_activities').where('activity_type', 'estimate_sent').whereIn('lead_id', leadIds)
      .select('lead_id', 'created_at as at'),
    conn('leads as l').join('estimates as e', 'e.id', 'l.estimate_id').whereIn('l.id', leadIds).whereNotNull('e.sent_at')
      .select('l.id as lead_id', 'e.sent_at as at'),
  ]);
  return [...activities, ...linked].map((row) => ({ leadId: String(row.lead_id), at: asMs(row.at) }));
}

// ---- Judging (pure) --------------------------------------------------------

/**
 * @param {Array} cohort leads from reachCohort
 * @param {{texts, calls, emails, estimates}} evidence witness rows from the loaders above
 * @returns {Map<string, number|null>} lead id -> minutes from first_contact_at to the earliest
 *   person contact (0 when it came first), or null when no person ever reached the lead.
 */
function judgeReach(cohort, evidence) {
  const byKey = new Map();
  for (const w of [...evidence.texts, ...evidence.calls, ...evidence.emails]) {
    if (w.at != null) byKey.set(w.key, [...(byKey.get(w.key) || []), w]);
  }
  const estimatesByLead = new Map();
  for (const e of evidence.estimates) {
    if (e.at != null) estimatesByLead.set(e.leadId, [...(estimatesByLead.get(e.leadId) || []), e.at]);
  }
  const result = new Map();
  for (const lead of cohort) {
    const firstAt = asMs(lead.first_contact_at);
    const sid = lead.twilio_call_sid ? String(lead.twilio_call_sid) : null;
    const keys = [`phone:${usablePhoneKey(lead.phone)}`, `email:${leadEmail(lead.email)}`];
    // Contact must come after first_contact_at, except the call that created the lead.
    const times = keys.flatMap((key) => byKey.get(key) || [])
      .filter((w) => w.at > firstAt || (sid && w.sid === sid))
      .map((w) => w.at);
    times.push(...(estimatesByLead.get(String(lead.id)) || []).filter((at) => at >= firstAt));
    result.set(String(lead.id), times.length ? Math.max(0, (Math.min(...times) - firstAt) / MINUTE_MS) : null);
  }
  return result;
}

/**
 * Count a cohort: how many were reached within the window, and how many never were.
 * `leads` are rows with id, status, phone, email, first_contact_at, twilio_call_sid.
 * Returns { cohort, reachedWithin, reachedLater, neverReached, withinMinutes }.
 */
async function loadLeadReachStats(leads, { conn = db } = {}) {
  const cohort = reachCohort(leads);
  const stats = { cohort: cohort.length, reachedWithin: 0, reachedLater: 0, neverReached: 0, withinMinutes: REACH_WITHIN_MINUTES };
  if (!cohort.length) return stats;

  const since = new Date(Math.min(...cohort.map((l) => asMs(l.first_contact_at))));
  const peers = uniq(cohort.map((l) => usablePhoneKey(l.phone)));
  const addresses = uniq(cohort.map((l) => leadEmail(l.email)));
  const sids = uniq(cohort.map((l) => (l.twilio_call_sid ? String(l.twilio_call_sid) : null)));
  const [texts, calls, emails, estimates] = await Promise.all([
    personTexts(conn, peers, since),
    personCalls(conn, peers, sids, since),
    personEmails(conn, addresses, since),
    estimateSends(conn, cohort.map((l) => String(l.id))),
  ]);

  for (const minutes of judgeReach(cohort, { texts, calls, emails, estimates }).values()) {
    if (minutes == null) stats.neverReached += 1;
    else if (minutes <= REACH_WITHIN_MINUTES) stats.reachedWithin += 1;
    else stats.reachedLater += 1;
  }
  return stats;
}

module.exports = { loadLeadReachStats, judgeReach, reachCohort, REACH_WITHIN_MINUTES, _test: { usablePhoneKey, leadEmail } };
